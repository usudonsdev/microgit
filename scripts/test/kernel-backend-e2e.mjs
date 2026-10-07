#!/usr/bin/env node
/**
 * カーネル版と Node 版のバックエンドの差分テスト（#14、#16 から持ち越した項目）。
 *
 * 使い方: npm run compile && node scripts/test/kernel-backend-e2e.mjs [--max-depth N] -- <agent を起動するコマンド...>
 *         npm run compile && node scripts/test/kernel-backend-e2e.mjs [--max-depth N] --plan
 *   --plan: 拡張機能と同じ起動計画（src/kernel/launchers.ts の planLaunch）で、リポジトリのビルド結果から起動する。
 *           --accel auto|whpx|tcg で Windows の QEMU の動かし方を指定できる（設定 microgit.kernel.accel と同じ）。
 *           Windows なら QEMU（名前付きパイプ）、Linux なら unshare -Urm。拡張機能と同じ経路を試せる
 *   <コマンド> の stdin/stdout が agent の命令の通り道になるもの（check-guest.mjs と同じ）。
 *     WSL2:      wsl.exe -e unshare -Urm /mnt/c/.../guest/out/x86_64/init
 *     Linux:     unshare -Urm guest/out/x86_64/init
 *     QEMU:      qemu-system-x86_64 ... -chardev stdio,id=proto,signal=off -device virtserialport,chardev=proto,name=microgit
 *
 * シナリオごとに shadow と同じ形の Git の履歴を作り、MicroGit の保存と同じように各コミットの層を
 * カーネル版に記録させる（recordCommit）。そのあと、いろいろな順番で各コミットに戻る操作をして、
 *   - カーネル版（KernelOverlayBackend.checkout → Boundary Guard → ワークスペース）
 *   - Node 版（ensureLayerExists → checkoutLayers → syncMergeToWorkspace）
 * のワークスペースのファイル（パスと sha256）が、Git のツリー（git ls-tree）と一致するかを比べる。
 * 最後に agent の層を全部捨て、キャッシュが空の状態から戻れること（写しの層、ADR-0003）も確かめる。
 * --max-depth を小さくすると（既定 2）、差分の層と写しの層の切り替えを何度も通る。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { parentOf, scenarios as goldenScenarios } from '../golden/overlayfs-scenarios.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlay = require(path.join(ROOT, 'out', 'overlay.js'));
const { KernelOverlayBackend } = require(path.join(ROOT, 'out', 'kernel', 'kernelBackend.js'));
const { catFileBatch } = require(path.join(ROOT, 'out', 'kernel', 'layerFeeder.js'));
const { planLaunch, findInPath } = require(path.join(ROOT, 'out', 'kernel', 'launchers.js'));

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep < 0 ? argv : argv.slice(0, sep);
let spec;
if (opts.includes('--plan')) {
    const exists = (p) => fs.existsSync(p);
    const plan = planLaunch({
        platform: process.platform, arch: process.arch, osRelease: os.release(), extensionPath: ROOT, env: process.env,
        settings: opts.includes('--accel') ? { accel: opts[opts.indexOf('--accel') + 1] } : {},
        logDir: os.tmpdir(), exists, which: (c) => findInPath(c, process.env, process.platform, exists),
    });
    if (!plan.ok) { console.error(`起動の計画が立たない: ${plan.reason}`); process.exit(2); }
    spec = plan.spec;
} else if (sep >= 0 && sep < argv.length - 1) {
    const [cmd, ...cmdArgs] = argv.slice(sep + 1);
    spec = { command: cmd, args: cmdArgs, description: [cmd, ...cmdArgs].join(' ') };
} else {
    console.error('usage: kernel-backend-e2e.mjs [--max-depth N] (--plan | -- <agent command...>)');
    process.exit(2);
}
const maxDepth = opts.includes('--max-depth') ? Number(opts[opts.indexOf('--max-depth') + 1]) : 2;

const runGit = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const tryRunGit = (cwd, args) => { try { return runGit(cwd, args); } catch { return undefined; } };
const COMMIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

/** ゴールデンテストのシナリオに、MicroGit でよく出る形（日本語名・バイナリ・大きいファイル）を足す */
const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
const bin = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0]);
const extraScenarios = [
    {
        name: 'e2e-japanese-binary-big',
        commits: [
            { ops: [['write', 'メモ.txt', 'v1'], ['writebin', 'bin/data.bin', bin], ['write', '資料/議事録.md', '# 1']] },
            { ops: [['writebin', 'big.bin', big], ['write', 'メモ.txt', 'v2']] },
            { ops: [['rmdir', '資料'], ['write', '資料', 'now a file']] },
            { parent: 0, ops: [['write', '枝.txt', 'branch'], ['rm', 'bin/data.bin']] },
        ],
    },
    {
        name: 'e2e-long-chain',
        // 深さの上限（--max-depth）を何度も越える長い鎖
        commits: Array.from({ length: 9 }, (_, i) => ({ ops: [['write', `f${i % 3}.txt`, `v${i}`], ...(i === 5 ? [['rm', 'f0.txt']] : [])] })),
    },
    {
        name: 'e2e-many-files',
        // Macでは中身だけでなく、commitのパス一覧も48 KiBを超えたらstageOpに分ける
        commits: [{
            ops: Array.from({ length: 700 }, (_, i) => ['write', `many/file-${String(i).padStart(4, '0')}-${'x'.repeat(48)}.txt`, `v${i}`]),
        }],
    },
];

function applyOp(dir, op) {
    const [kind, a, b] = op;
    const abs = (rel) => path.join(dir, ...rel.split('/'));
    switch (kind) {
        case 'write': fs.mkdirSync(path.dirname(abs(a)), { recursive: true }); fs.writeFileSync(abs(a), b); break;
        case 'writebin': fs.mkdirSync(path.dirname(abs(a)), { recursive: true }); fs.writeFileSync(abs(a), b); break;
        case 'rm': fs.unlinkSync(abs(a)); break;
        case 'rmdir': overlay.removeTree(abs(a)); break;
        case 'mkdir': fs.mkdirSync(abs(a), { recursive: true }); break;
        case 'mv': fs.mkdirSync(path.dirname(abs(b)), { recursive: true }); fs.renameSync(abs(a), abs(b)); break;
        default: throw new Error(`unknown op ${kind}`);
    }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Git のツリーのファイル（パス → sha256） */
function expectedFiles(repo, commit) {
    const out = runGit(repo, ['ls-tree', '-r', '-z', commit]);
    const entries = out.split('\0').filter(Boolean).map((rec) => {
        const tab = rec.indexOf('\t');
        const [, type, sha] = rec.slice(0, tab).split(' ');
        return { type, sha, path: rec.slice(tab + 1) };
    }).filter((e) => e.type === 'blob');
    const contents = catFileBatch(repo, entries.map((e) => e.sha));
    return new Map(entries.map((e) => [e.path, sha256(contents.get(e.sha))]));
}

/** ワークスペースのファイル（.microgit を除く） */
function workspaceFiles(root) {
    const out = new Map();
    const walk = (dir, prefix) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!prefix && (ent.name === '.microgit' || ent.name.startsWith('.microgit_'))) { continue; }
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(abs, rel); } else if (ent.isFile()) { out.set(rel, sha256(fs.readFileSync(abs))); }
        }
    };
    walk(root, '');
    return out;
}

function diffMaps(expected, actual) {
    const lines = [];
    for (const [p, h] of expected) {
        if (!actual.has(p)) { lines.push(`- ${p}`); } else if (actual.get(p) !== h) { lines.push(`~ ${p}`); }
    }
    for (const p of actual.keys()) { if (!expected.has(p)) { lines.push(`+ ${p}`); } }
    return lines.sort();
}

const isSafeRepoRelativePath = (rel) => !!rel && !path.isAbsolute(rel) && !path.normalize(rel).split(path.sep).includes('..');
const isMicroGitArtifactPath = (abs, root) => {
    const top = path.relative(root, abs).split(path.sep)[0];
    return top === '.microgit' || top.startsWith('.microgit_');
};

async function runScenario(backend, s, failures, stats) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-e2e-'));
    try {
        const repo = path.join(tmp, 'shadow');
        const wsKernel = path.join(tmp, 'ws-kernel');
        const wsNode = path.join(tmp, 'ws-node');
        for (const d of [repo, wsKernel, wsNode]) { fs.mkdirSync(d); }
        runGit(repo, ['init', '-q']);
        runGit(repo, ['config', 'core.autocrlf', 'false']);
        const nodePaths = overlay.ensureOverlayDirs(wsNode);

        const hashes = [];
        for (let i = 0; i < s.commits.length; i++) {
            const parent = parentOf(s, i);
            if (parent >= 0 && parent !== i - 1) {
                runGit(repo, ['checkout', '-q', '-f', '--detach', hashes[parent]]);
                runGit(repo, ['clean', '-qfdx']);
            }
            for (const op of s.commits[i].ops) { applyOp(repo, op); }
            runGit(repo, ['add', '-A']);
            execFileSync('git', ['commit', '-q', '--allow-empty', '-m', `c${i + 1}`], { cwd: repo, env: COMMIT_ENV, stdio: 'pipe' });
            const hash = runGit(repo, ['rev-parse', 'HEAD']).trim();
            hashes.push(hash);
            // MicroGit の保存と同じく、コミットのたびに層を記録させる
            const r = await backend.recordCommit(repo, hash);
            stats.recorded++;
            if (r.snapshot) { stats.snapshots++; }
        }

        const tracked = overlay.collectShadowTrackedFiles(repo, tryRunGit);
        const order = [...hashes.keys(), ...[...hashes.keys()].reverse(), ...hashes.keys()].filter((_, k, arr) => k === 0 || arr[k - 1] !== arr[k]);
        const check = async (i, label) => {
            const target = hashes[i];
            const expected = expectedFiles(repo, target);
            const res = await backend.checkout({ workspaceRoot: wsKernel, shadowRepo: repo, target, managedFiles: tracked, cacheFile: path.join(tmp, 'kernel-cache.json') });
            stats.checkouts++;
            stats.totalMs += res.timings.totalMs;
            if (res.rejected.length) { failures.push(`[${s.name}] ${label} commit ${i + 1}: kernel rejected ${JSON.stringify(res.rejected)}`); }
            const dk = diffMaps(expected, workspaceFiles(wsKernel));
            if (dk.length) { failures.push(`[${s.name}] ${label} commit ${i + 1}: kernel workspace differs from git`, ...dk.map((l) => `    ${l}`)); }

            const layerPath = overlay.computePath(repo, target, runGit, tryRunGit);
            for (const h of layerPath) { overlay.ensureLayerExists(repo, nodePaths, h, runGit, tryRunGit); }
            overlay.checkoutLayers(nodePaths, layerPath, 'mb-1');
            overlay.syncMergeToWorkspace(wsNode, nodePaths, isSafeRepoRelativePath, isMicroGitArtifactPath, tracked);
            const dn = diffMaps(expected, workspaceFiles(wsNode));
            if (dn.length) { failures.push(`[${s.name}] ${label} commit ${i + 1}: node workspace differs from git`, ...dn.map((l) => `    ${l}`)); }
        };
        for (const i of order) { await check(i, 'walk'); }
        // agent の層を全部捨てて、キャッシュが空の状態から戻る（VM の再起動と同じ）
        await backend.resetLayers();
        await check(hashes.length - 1, 'cold');
        await check(0, 'cold');
    } finally {
        overlay.removeTree(tmp);
    }
}

const started = Date.now();
const backend = await KernelOverlayBackend.start(
    spec,
    'e2e',
    tryRunGit,
    { feeder: { maxDepth, maxLayers: 64, maxCommitBytes: 90 * 1024 * 1024 } },
);
console.log(`agent ready: ${JSON.stringify(backend.info)} (${Date.now() - started} ms), maxDepth=${maxDepth}, via ${spec.description}`);
const failures = [];
const stats = { recorded: 0, snapshots: 0, checkouts: 0, totalMs: 0 };
try {
    for (const s of [...goldenScenarios, ...extraScenarios]) {
        await runScenario(backend, s, failures, stats);
    }
} finally {
    await backend.dispose();
}
console.log(JSON.stringify({ ...stats, avgCheckoutMs: Math.round(stats.totalMs / Math.max(1, stats.checkouts)) }));
if (failures.length) {
    console.error('\n食い違い:');
    for (const f of failures) { console.error(`  ${f}`); }
    process.exit(1);
}
console.log(`OK: ${goldenScenarios.length + extraScenarios.length} scenarios、カーネル版と Node 版のワークスペースがどちらも Git のツリーと一致`);
