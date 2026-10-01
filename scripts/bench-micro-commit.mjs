#!/usr/bin/env node
/**
 * マイクロコミット（保存 1 回の記録）の速さを、履歴を伸ばしながら測る（#32）。
 *
 * 使い方: npm run compile && node scripts/bench-micro-commit.mjs [--impls cli,fast,fast-nojournal,git] [--idle 20] [--durability power|process] [--files 200] [--saves 1000] [--checkpoints 10,100,300,1000] [--window 20] [--json out.json]
 *
 * 同じ「保存の列」を 3 つに流す。
 *   cli  : src/microCommit.ts の recordMicroCommitViaGitCli（5.0.0 までの拡張機能の保存と同じ Git の手順。永続性は ADR-0002 の既定 power）
 *   fast : src/fastMicroCommit.ts（Git のプロセスを起動せず、Git の形式を直接書く。#32。永続性は同じく fsync する）
 *   git  : ふつうの Git の使い方。git add <file> と git commit -q -m <msg>
 * 永続性（--durability、既定 power）は 3 つとも同じ条件にそろえる。
 *   power   : 電源断でも失わない。cli と git は -c core.fsync=loose-object,reference -c core.fsyncMethod=batch、fast はファイルごとに fsync
 *   process : fsync しない（Git の既定）
 * 保存の列：ファイル F 個の作業ツリーで、毎回 1 つのファイルを書き換える。10 回に 1 回は、2 回前の中身に戻す
 * （Ctrl+Z で戻したときの「同じ変更」の探索を通すため）。擬似乱数の種は固定。
 *
 * 測るもの（履歴の長さの区切りごとに、直前の window 回の分布）
 *   - 記録の時間（保存 1 回を記録し終えるまで）p50・p95
 *   - Git のプロセスの起動回数（microgit だけ）
 *   - 追いつける保存の頻度（1 秒 / 平均）。記録は列で順に処理するので、これを超える頻度で保存すると遅れが溜まる
 * 注意：保存の中身をファイルに書く時間は両方に含めない（エディタが書くもの）。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { recordMicroCommitViaGitCli } = require(path.join(ROOT, 'out', 'microCommit.js'));
const { durabilityGitArgs, setDurability } = require(path.join(ROOT, 'out', 'durability.js'));
const { FastMicroCommitter } = require(path.join(ROOT, 'out', 'fastMicroCommit.js'));

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const FILES = Number(arg('--files', '200'));
const SAVES = Number(arg('--saves', '1000'));
const CHECKPOINTS = arg('--checkpoints', '10,100,300,1000').split(',').map(Number).filter((n) => n <= SAVES);
const WINDOW = Number(arg('--window', '20'));
const JSON_OUT = arg('--json', '');
const IMPLS = arg('--impls', 'cli,fast,git').split(',');
// 拡張機能は保存が 300 ms 途切れたらジャーナルをチェックポイントする（ADR-0014）。ここでは IDLE 回ごとに、計測の外で行う
const IDLE = Number(arg('--idle', '20'));
const DURABILITY = arg('--durability', 'power');
setDurability(DURABILITY);

// 擬似乱数（種は固定）
let seed = 20261001;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const COMMIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'MicroGit', GIT_AUTHOR_EMAIL: 'microgit@local',
    GIT_COMMITTER_NAME: 'MicroGit', GIT_COMMITTER_EMAIL: 'microgit@local',
};

function makeRepo(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `microgit-bench-${name}-`));
    execFileSync('git', ['init', '-q', '-b', 'micro-history', dir]);
    execFileSync('git', ['-C', dir, 'config', 'core.autocrlf', 'false']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Bench']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'bench@local']);
    return dir;
}

// 拡張機能の runGit と同じ引数（core.quotepath=false と永続性の設定）。起動回数を数える
let spawns = 0;
const gitRunner = {
    run(cwd, args, options) {
        spawns++;
        return execFileSync('git', ['-c', 'core.quotepath=false', ...durabilityGitArgs(), ...args], {
            cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options?.env ?? process.env,
        }).toString();
    },
    tryRun(cwd, args) {
        try { return gitRunner.run(cwd, args); } catch { return undefined; }
    },
};

// 保存の列を作る
const initial = Array.from({ length: FILES }, (_, i) => `// file ${i}\n${'x'.repeat(200 + (i % 50) * 20)}\n`);
const history = new Map(); // path -> 中身の履歴
const saves = [];
for (let n = 0; n < SAVES; n++) {
    const i = Math.floor(rand() * FILES);
    const rel = `src/dir${i % 10}/file${i}.ts`;
    const h = history.get(rel) ?? [initial[i]];
    let content;
    if (n % 10 === 9 && h.length >= 3) {
        content = h[h.length - 3]; // 2 回前に戻す
    } else {
        content = `${h[h.length - 1]}// save ${n}\n`;
    }
    h.push(content);
    history.set(rel, h);
    saves.push({ rel, content });
}

function seedTree(dir) {
    for (let i = 0; i < FILES; i++) {
        const p = path.join(dir, 'src', `dir${i % 10}`, `file${i}.ts`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, initial[i]);
    }
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial'], { env: COMMIT_ENV });
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function run(name, record, prepare) {
    const dir = makeRepo(name);
    seedTree(dir);
    const ctx = prepare?.(dir);
    const samples = [];
    const results = [];
    let tag = 'mb-1';
    const kinds = {};
    for (let n = 0; n < saves.length; n++) {
        const { rel, content } = saves[n];
        fs.writeFileSync(path.join(dir, rel), content);
        spawns = 0;
        const t = process.hrtime.bigint();
        const r = record(dir, rel, n, tag, ctx);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        if (r.tag) { tag = r.tag; }
        kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        samples.push({ ms, spawns: ctx?.stats ? ctx.stats.gitSpawns - (ctx.lastSpawns ?? 0) : spawns, fsyncs: ctx?.stats?.lastPhases?.fsyncCount });
        if (ctx?.stats) { ctx.lastSpawns = ctx.stats.gitSpawns; }
        const done = n + 1;
        if (ctx?.checkpoint && done % IDLE === 0) { await ctx.checkpoint(); }
        if (CHECKPOINTS.includes(done)) {
            const w = samples.slice(-WINDOW);
            const ms = w.map((s) => s.ms);
            const row = {
                impl: name, history: done,
                p50: +pct(ms, 0.5).toFixed(1), p95: +pct(ms, 0.95).toFixed(1),
                spawnsMean: +mean(w.map((s) => s.spawns)).toFixed(1),
                savesPerSec: +(1000 / mean(ms)).toFixed(1),
                ...(w[0].fsyncs !== undefined ? { fsyncsMean: +mean(w.map((s) => s.fsyncs ?? 0)).toFixed(2) } : {}),
            };
            results.push(row);
            console.log(JSON.stringify(row));
        }
    }
    if (name !== 'git') {
        execFileSync('git', ['-C', dir, 'fsck', '--strict', '--no-progress'], { stdio: 'inherit' });
    }
    console.log(`${name}: ${JSON.stringify(kinds)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return results;
}

console.log(`durability=${DURABILITY} files=${FILES} saves=${SAVES} checkpoints=${CHECKPOINTS.join(',')} window=${WINDOW} git=${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()} ${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? ''}`);

const all = [];
if (IMPLS.includes('cli')) all.push(...await run('cli', (dir, rel, n, tag) => {
    const out = recordMicroCommitViaGitCli(gitRunner, {
        shadowRepoPath: dir,
        relativeFilePath: rel,
        currentTag: tag,
        message: () => `micro: saved ${rel} at save ${n}`,
        commitEnv: COMMIT_ENV,
    });
    return out;
}));

if (IMPLS.includes('fast')) all.push(...await run('fast', (dir, rel, n, tag, fc) => fc.record({
    shadowRepoPath: dir,
    relativeFilePath: rel,
    currentTag: tag,
    message: () => `micro: saved ${rel} at save ${n}`,
    commitEnv: COMMIT_ENV,
}), (dir) => new FastMicroCommitter(dir, () => DURABILITY === 'power')));

// ジャーナルを使わない速い実装（ADR-0014 の前：ファイルごとに fsync）。比べるため
if (IMPLS.includes('fast-nojournal')) all.push(...await run('fast-nojournal', (dir, rel, n, tag, fc) => fc.record({
    shadowRepoPath: dir,
    relativeFilePath: rel,
    currentTag: tag,
    message: () => `micro: saved ${rel} at save ${n}`,
    commitEnv: COMMIT_ENV,
}), (dir) => new FastMicroCommitter(dir, () => DURABILITY === 'power', { journal: false })));

if (IMPLS.includes('git')) all.push(...await run('git', (dir, rel, n) => {
    execFileSync('git', [...durabilityGitArgs(), 'add', '--', rel], { cwd: dir, stdio: 'ignore' });
    try {
        execFileSync('git', [...durabilityGitArgs(), 'commit', '-q', '-m', `saved ${rel} at save ${n}`], { cwd: dir, stdio: 'ignore', env: COMMIT_ENV });
        return { kind: 'created' };
    } catch {
        return { kind: 'nothing-to-commit' };
    }
}));

console.log('');
console.table([...all].sort((a, b) => a.history - b.history || a.impl.localeCompare(b.impl)));
if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ durability: DURABILITY, files: FILES, saves: SAVES, window: WINDOW, platform: `${os.platform()}-${os.arch()}`, results: all }, null, 2) + '\n');
}
