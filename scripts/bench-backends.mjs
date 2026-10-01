#!/usr/bin/env node
/**
 * Node.js 版とカーネル版のバックエンドの速さを比べる（#14、要件 NFR-2 の Phase 0 の受け入れ基準）。
 * 使い方: npm run compile && node scripts/bench-backends.mjs
 *   カーネル版は拡張機能と同じ起動計画（planLaunch）で、リポジトリのビルド結果から起動する
 *   （Linux は unshare -Urm、Windows は QEMU）。
 * 環境変数: FILES=200（最初のファイル数） COMMITS=40（保存の回数） SWITCHES=30（過去に戻る回数） SIZE=4096（1 ファイルのバイト数）
 *
 * 測るもの（どちらのバックエンドも、同じ shadow の Git の履歴から）:
 *   save:     保存 1 回ぶんの層の作成。Node 版は exportCommitLayer（層＋ビューの展開）、カーネル版は recordCommit
 *   checkout: 過去の 2 つのコミットを行き来する。Node 版は ensureLayerExists → checkoutLayers → syncMergeToWorkspace、
 *             カーネル版は checkout（層の用意 → view → Boundary Guard → ワークスペース）
 * shadow のコミットを作る Git の時間はどちらにも共通なので含めない。
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlay = require(path.join(ROOT, 'out', 'overlay.js'));
const { KernelOverlayBackend } = require(path.join(ROOT, 'out', 'kernel', 'kernelBackend.js'));
const { planLaunch, findInPath } = require(path.join(ROOT, 'out', 'kernel', 'launchers.js'));

const FILES = Number(process.env.FILES || 200);
const COMMITS = Number(process.env.COMMITS || 40);
const SWITCHES = Number(process.env.SWITCHES || 30);
const SIZE = Number(process.env.SIZE || 4096);

const runGit = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const tryRunGit = (cwd, args) => { try { return runGit(cwd, args); } catch { return undefined; } };
const env = { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@example.invalid', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@example.invalid' };
const safe = (rel) => !!rel && !path.isAbsolute(rel) && !rel.split('/').includes('..');
const artifact = (abs, root) => abs.startsWith(path.join(root, '.microgit_'));

function stats(ms) {
    const s = [...ms].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}
const timeMs = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

const exists = (p) => fs.existsSync(p);
const plan = planLaunch({
    platform: process.platform, arch: process.arch, osRelease: os.release(), extensionPath: ROOT, env: process.env,
    settings: {}, logDir: os.tmpdir(), exists, which: (c) => findInPath(c, process.env, process.platform, exists),
});
if (!plan.ok) { console.error(`カーネル版を起動できない: ${plan.reason}`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-bench-backends-'));
const repo = path.join(tmp, 'shadow');
fs.mkdirSync(repo);
runGit(repo, ['init', '-q']);
runGit(repo, ['config', 'core.autocrlf', 'false']);

// 最初のコミット（FILES 個）と、1 ファイルずつ書き換える保存（COMMITS 回）
for (let i = 0; i < FILES; i++) {
    const p = path.join(repo, `src/dir${i % 10}/file${i}.txt`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, randomBytes(SIZE / 2).toString('hex'));
}
runGit(repo, ['add', '-A']);
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
const hashes = [runGit(repo, ['rev-parse', 'HEAD']).trim()];
for (let c = 0; c < COMMITS; c++) {
    fs.writeFileSync(path.join(repo, `src/dir${c % 10}/file${c % FILES}.txt`), randomBytes(SIZE / 2).toString('hex'));
    runGit(repo, ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', `c${c}`], { cwd: repo, env });
    hashes.push(runGit(repo, ['rev-parse', 'HEAD']).trim());
}
const tracked = overlay.collectShadowTrackedFiles(repo, tryRunGit);

// ---- Node.js 版
const wsNode = path.join(tmp, 'ws-node');
fs.mkdirSync(wsNode);
const paths = overlay.ensureOverlayDirs(wsNode);
const nodeSave = [];
for (let i = 0; i < hashes.length; i++) {
    const t0 = process.hrtime.bigint();
    overlay.exportCommitLayer(repo, paths, hashes[i], i ? hashes[i - 1] : undefined, 'mb-1', runGit, tryRunGit);
    if (i) { nodeSave.push(timeMs(t0)); }
}
const nodeCheckout = [];
const targets = Array.from({ length: SWITCHES }, (_, k) => hashes[k % 2 ? hashes.length - 1 : Math.floor(hashes.length / 2)]);
for (const target of targets) {
    const t0 = process.hrtime.bigint();
    const layerPath = overlay.computePath(repo, target, runGit, tryRunGit);
    for (const h of layerPath) { overlay.ensureLayerExists(repo, paths, h, runGit, tryRunGit); }
    overlay.checkoutLayers(paths, layerPath, 'mb-1');
    overlay.syncMergeToWorkspace(wsNode, paths, safe, artifact, tracked);
    nodeCheckout.push(timeMs(t0));
}

// ---- カーネル版
const wsKernel = path.join(tmp, 'ws-kernel');
fs.mkdirSync(wsKernel);
const tBoot = process.hrtime.bigint();
const backend = await KernelOverlayBackend.start(plan.spec, plan.kind, tryRunGit);
const bootMs = timeMs(tBoot);
const kernelSave = [];
for (let i = 0; i < hashes.length; i++) {
    const t0 = process.hrtime.bigint();
    await backend.recordCommit(repo, hashes[i]);
    if (i) { kernelSave.push(timeMs(t0)); }
}
const kernelCheckout = [];
for (const target of targets) {
    const t0 = process.hrtime.bigint();
    await backend.checkout({ workspaceRoot: wsKernel, shadowRepo: repo, target, managedFiles: tracked, cacheFile: path.join(tmp, 'kc.json') });
    kernelCheckout.push(timeMs(t0));
}
await backend.dispose();
overlay.removeTree(tmp);

const result = {
    platform: `${process.platform}/${process.arch}`,
    kernelLaunch: plan.spec.description,
    files: FILES, commits: COMMITS, switches: SWITCHES, bytesPerFile: SIZE,
    kernelBootMs: Math.round(bootMs),
    saveMs: { nodejs: stats(nodeSave), kernel: stats(kernelSave) },
    checkoutMs: { nodejs: stats(nodeCheckout), kernel: stats(kernelCheckout) },
};
console.log(JSON.stringify(result, null, 2));
