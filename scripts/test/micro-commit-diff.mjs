#!/usr/bin/env node
/**
 * マイクロコミットの差分テスト（#32）：Git の CLI の実装（microCommit.ts）と速い実装（fastMicroCommit.ts）に
 * 同じ保存の列を流し、毎回の結果（unchanged / rewound / created、コミットのハッシュ、タグ）と、
 * HEAD・micro-history・タグ mb-*・index（パス・モード・blob）が 1 ビットも違わないことを確かめる。
 * 最後に両方で git fsck --strict。
 *
 * 使い方: npm run compile && node scripts/test/micro-commit-diff.mjs [--saves 400] [--crlf]
 *
 * --crlf：Windows 版 Git の既定（core.autocrlf=true）の上に、shadow と同じ info/attributes（変換を止める、ADR-0012）を置き、
 * 中身を CRLF の改行で書く。両方とも CRLF のまま記録すること（blob に CR が残ること）も確かめる。
 *
 * 保存の列に入れるもの：ファイルの書き換え、新しいファイル（深いフォルダ、日本語の名前、空白入りの名前）、
 * 2 回前の中身に戻す（同じパスの同じ中身 → rewound/file）、直前の編集の取り消し（同じ tree → rewound/tree）、
 * 中身を変えずに保存（unchanged）、先端以外からの保存（新しいタグ mb-N）、途中での「過去に戻る」操作
 * （Git の CLI で detached HEAD と index を動かす。速い実装が外からの変更に気づくか）。
 * 日時は保存ごとに 1 秒ずつ進めて固定する（git log の並びが日時で決まるため）。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { recordMicroCommitViaGitCli } = require(path.join(ROOT, 'out', 'microCommit.js'));
const { FastMicroCommitter, FastPathUnsupported } = require(path.join(ROOT, 'out', 'fastMicroCommit.js'));

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const SAVES = Number(arg('--saves', '400'));
const CRLF = process.argv.includes('--crlf');
const { SHADOW_ATTRIBUTES } = require(path.join(ROOT, 'out', 'shadowStore.js'));
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const BASE = 1_800_000_000;
const envAt = (n) => ({
    ...process.env,
    GIT_AUTHOR_NAME: 'MicroGit', GIT_AUTHOR_EMAIL: 'microgit@local',
    GIT_COMMITTER_NAME: 'MicroGit', GIT_COMMITTER_EMAIL: 'microgit@local',
    GIT_AUTHOR_DATE: `${BASE + n} +0900`, GIT_COMMITTER_DATE: `${BASE + n} +0900`,
});

const git = (dir, args, env) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env });
const cli = {
    run: (cwd, args, o) => git(cwd, args, o?.env),
    tryRun: (cwd, args) => { try { return git(cwd, args); } catch { return undefined; } },
};

function makeRepo(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `microgit-diff-${name}-`));
    git(os.tmpdir(), ['init', '-q', '-b', 'micro-history', dir]);
    git(dir, ['config', 'core.autocrlf', CRLF ? 'true' : 'false']);
    if (CRLF) {
        fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), SHADOW_ATTRIBUTES);
    }
    git(dir, ['config', 'user.name', 'Diff']);
    git(dir, ['config', 'user.email', 'diff@local']);
    return dir;
}

const A = makeRepo('cli');
const B = makeRepo('fast');
const fast = new FastMicroCommitter(B, () => true);
let fallbacks = 0;

function write(rel, content) {
    if (CRLF) { content = content.replace(/\r?\n/g, '\r\n'); }
    for (const d of [A, B]) {
        const p = path.join(d, ...rel.split('/'));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
}

const names = ['a.txt', 'src/main.ts', 'src/deep/er/x.ts', 'docs/メモ.md', 'with space/file name.txt', 'z/y/x/w.txt', 'b.txt'];
const hist = new Map();
const state = { tagA: 'mb-1', tagB: 'mb-1' };
const counts = {};
let lastEdit;

let deltas = 0;
function check(n, label, oa, ob) {
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    // 速い記録だけが付ける「親からの変化」（delta、#37）は比べる前に外し、別に中身を確かめる
    const { delta, ...obCore } = ob;
    if (!same(oa, obCore)) { throw new Error(`#${n} ${label}: 結果が違う\n cli : ${JSON.stringify(oa)}\n fast: ${JSON.stringify(obCore)}`); }
    if (delta) {
        deltas++;
        // git diff-tree で見た親からの変化が、delta の 1 ファイルだけで、中身とモードも同じか
        const raw = cli.run(B, ['diff-tree', '-r', '--no-renames', '-z', delta.parent, ob.commit]).split('\0').filter(Boolean);
        const changes = [];
        for (let i = 0; i < raw.length; i += 2) { changes.push({ meta: raw[i], path: raw[i + 1] }); }
        if (delta.parent !== oa.parent) { throw new Error(`#${n} ${label}: delta の親が違う`); }
        if (changes.length !== 1 || delta.files.length !== 1 || changes[0].path !== delta.files[0].path) {
            throw new Error(`#${n} ${label}: delta と diff-tree が違う: ${JSON.stringify(changes)} / ${delta.files.map((f) => f.path)}`);
        }
        const [, newMode, , newSha, status] = changes[0].meta.slice(1).split(' ');
        const blob = execFileSync('git', ['cat-file', 'blob', newSha], { cwd: B });
        if (!blob.equals(delta.files[0].content) || newMode !== delta.files[0].mode || !['A', 'M'].includes(status)) {
            throw new Error(`#${n} ${label}: delta の中身・モードが違う（${newMode} ${status}）`);
        }
    }
    const snap = (d) => ({
        head: cli.tryRun(d, ['rev-parse', 'HEAD'])?.trim(),
        sym: cli.tryRun(d, ['symbolic-ref', '-q', 'HEAD'])?.trim(),
        refs: cli.tryRun(d, ['for-each-ref', '--format=%(refname) %(objectname)'])?.trim(),
        index: cli.run(d, ['ls-files', '-s']).trim(),
    });
    const sa = snap(A); const sb = snap(B);
    if (!same(sa, sb)) { throw new Error(`#${n} ${label}: 状態が違う\n cli : ${JSON.stringify(sa)}\n fast: ${JSON.stringify(sb)}`); }
}

function save(n, rel, label) {
    const input = (dir, tag) => ({
        shadowRepoPath: dir, relativeFilePath: rel, currentTag: tag,
        message: () => `micro: saved ${rel} (#${n})\n\nMain-Head: ${'a'.repeat(40)}`, commitEnv: envAt(n),
    });
    const oa = recordMicroCommitViaGitCli(cli, input(A, state.tagA));
    let ob;
    try {
        ob = fast.record(input(B, state.tagB));
    } catch (e) {
        if (!(e instanceof FastPathUnsupported)) { throw e; }
        fallbacks++;
        ob = recordMicroCommitViaGitCli(cli, input(B, state.tagB));
        fast.invalidate();
    }
    if (oa.tag) { state.tagA = oa.tag; }
    if (ob.tag) { state.tagB = ob.tag; }
    counts[`${label}:${oa.kind}${oa.reason ? '/' + oa.reason : ''}`] = (counts[`${label}:${oa.kind}${oa.reason ? '/' + oa.reason : ''}`] ?? 0) + 1;
    check(n, `${label} ${rel}`, oa, ob);
}

// 最初のファイル
write('a.txt', 'first\n');
save(0, 'a.txt', 'first');

for (let n = 1; n < SAVES; n++) {
    const r = rand();
    const rel = names[Math.floor(rand() * names.length)];
    const h = hist.get(rel) ?? [];
    if (r < 0.08 && h.length >= 3) {
        const c = h[h.length - 3]; h.push(c); write(rel, c); save(n, rel, 'revert-file');
    } else if (r < 0.12 && h.length >= 1) {
        write(rel, h[h.length - 1]); save(n, rel, 'same-content');
    } else if (r < 0.2 && lastEdit && (hist.get(lastEdit)?.length ?? 0) >= 2) {
        // 直前の編集を取り消す（Ctrl+Z）。ほかのファイルが変わっていなければ tree 全体が 1 つ前のコミットと一致する（rewound/tree）
        const hh = hist.get(lastEdit);
        const c = hh[hh.length - 2]; hh.push(c); write(lastEdit, c); save(n, lastEdit, 'undo');
        lastEdit = undefined;
    } else if (r < 0.24) {
        // 過去に戻る操作（Git の CLI で。両方同じ操作）：少し前のコミットへ detached HEAD にして、作業ツリーと index も合わせる
        const log = cli.run(A, ['log', '--format=%H', '-n', '8']).trim().split('\n');
        const target = log[Math.min(log.length - 1, 1 + Math.floor(rand() * (log.length - 1)))];
        for (const d of [A, B]) {
            git(d, ['checkout', '-q', '--detach', target]);
        }
        // 作業ツリーの中身を覚え直す
        hist.clear();
        for (const p of cli.run(A, ['ls-files']).trim().split('\n').filter(Boolean)) {
            hist.set(p, [fs.readFileSync(path.join(A, ...p.split('/')), 'utf8')]);
        }
        counts.travel = (counts.travel ?? 0) + 1;
    } else {
        const c = `${h[h.length - 1] ?? ''}line ${n} ${rel}\n`; h.push(c); hist.set(rel, h); write(rel, c); save(n, rel, 'edit'); lastEdit = rel;
    }
}

for (const d of [A, B]) { git(d, ['fsck', '--strict', '--no-progress']); }
if (CRLF) {
    for (const d of [A, B]) {
        const blob = execFileSync('git', ['cat-file', 'blob', 'HEAD:a.txt'], { cwd: d });
        if (!blob.includes(Buffer.from('\r\n'))) { throw new Error(`${d}: CRLF が LF に変えて記録された`); }
    }
    console.log('CRLF のまま記録された（両方）');
}
console.log(JSON.stringify({ saves: SAVES, fallbacks, deltas, stats: fast.stats, counts }, null, 1));
console.log('OK: CLI の実装と速い実装で、毎回の結果と HEAD・ref・index が一致し、git fsck --strict も通った');
fs.rmSync(A, { recursive: true, force: true });
fs.rmSync(B, { recursive: true, force: true });
