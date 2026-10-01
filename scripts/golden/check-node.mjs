#!/usr/bin/env node
/**
 * OverlayFS ゴールデンテストを、現行の Node.js 仮想 Overlay（src/overlay.ts）で流して
 * カーネルの期待値（test/golden/overlayfs/*.golden）と突き合わせる（Issue #10）。
 *
 * 使い方: npm run golden:check          （食い違いが既知の一覧と同じなら exit 0）
 *         npm run golden:check -- --update-known   （既知の一覧を今の結果で書き直す）
 *
 * MicroGit の保存経路と同じ道を通す: ops を shadow Git の作業ツリーに当ててコミットし、
 * exportCommitLayer → ensureExpandedView で得たビューを比べる。ビューは 2 通り見る。
 *   saved:   保存時に expandViewAfterExport が親ビューから伸ばしたもの
 *   rebuilt: views/ を消して、レイヤだけから組み直したもの
 *
 * Node 実装がカーネルと食い違う点は node-known-diffs.txt に記録してある。
 * 結果がこのファイルと違えば失敗する（新しい食い違いが出たときも、既知のものが直ったときも気づける）。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { chainOf, parentOf, scenarios, validateScenarios } from './overlayfs-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_DIR = path.join(ROOT, 'test', 'golden', 'overlayfs');
const KNOWN_FILE = path.join(GOLDEN_DIR, 'node-known-diffs.txt');
const VIEW_OK_MARKER = '.microgit_view_ok';
const require = createRequire(import.meta.url);
const o = require(path.join(ROOT, 'out', 'overlay.js'));

const runGit = (cwd, args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const tryRunGit = (cwd, args) => {
    try { return runGit(cwd, args); } catch { return undefined; }
};
// 作者と日時を固定してコミットハッシュを毎回同じにする。
// Node 側の壊れ方（ツリーの `git show` 出力をファイルとして書く等）にハッシュが混ざるため
const COMMIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@example.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@example.invalid', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
const commit = (cwd, message) => execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: COMMIT_ENV,
});

function applyOp(dir, op) {
    const [kind, a, b] = op;
    const abs = (rel) => path.join(dir, ...rel.split('/'));
    switch (kind) {
        case 'write':
            fs.mkdirSync(path.dirname(abs(a)), { recursive: true });
            fs.writeFileSync(abs(a), b);
            break;
        case 'rm': fs.unlinkSync(abs(a)); break;
        case 'rmdir': fs.rmSync(abs(a), { recursive: true }); break;
        case 'mkdir': fs.mkdirSync(abs(a), { recursive: true }); break;
        case 'mv':
            fs.mkdirSync(path.dirname(abs(b)), { recursive: true });
            fs.renameSync(abs(a), abs(b));
            break;
        default: throw new Error(`unknown op: ${kind}`);
    }
}

/** record-kernel.mjs の dump と同じ形式（種別・パス・sha256、パスのバイト順） */
function dump(root) {
    const entries = [];
    const walk = (dir, prefix) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!prefix && ent.name === VIEW_OK_MARKER) { continue; }
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
            const abs = path.join(dir, ent.name);
            if (ent.isSymbolicLink()) {
                entries.push([rel, `l\t${rel}\t${fs.readlinkSync(abs)}`]);
            } else if (ent.isDirectory()) {
                entries.push([rel, `d\t${rel}`]);
                walk(abs, rel);
            } else if (ent.isFile()) {
                const sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
                entries.push([rel, `f\t${rel}\t${sha}`]);
            } else {
                entries.push([rel, `o\t${rel}`]);
            }
        }
    };
    walk(root, '');
    return entries
        .sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
        .map((e) => e[1]);
}

function readGolden(name) {
    const commits = [];
    // core.autocrlf=true の Windows では CRLF で取り出される
    for (const line of fs.readFileSync(path.join(GOLDEN_DIR, `${name}.golden`), 'utf8').replace(/\r\n/g, '\n').split('\n')) {
        if (!line || line.startsWith('# ')) { continue; }
        if (line.startsWith('## commit ')) { commits.push([]); continue; }
        commits[commits.length - 1].push(line);
    }
    return commits;
}

function viewOrError(build) {
    try {
        return dump(build());
    } catch (e) {
        // エラーコードは OS で変わる（ディレクトリの unlink は Windows で EPERM、Linux で EISDIR）ので
        // 一覧には「失敗した」ことだけ残す。種類は --verbose で見る
        if (process.argv.includes('--verbose')) { console.error(e); }
        return ['! error'];
    }
}

function diffLines(expected, actual) {
    const exp = new Set(expected);
    const act = new Set(actual);
    const key = (l) => l.replace(/^[-+] /, '').split('\t')[1] ?? l;
    return [
        ...expected.filter((l) => !act.has(l)).map((l) => `- ${l}`),
        ...actual.filter((l) => !exp.has(l)).map((l) => `+ ${l}`),
    ].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : x < y ? -1 : 1));
}

function runScenario(s) {
    const golden = readGolden(s.name);
    if (golden.length !== s.commits.length) {
        throw new Error(`${s.name}: golden has ${golden.length} commits, scenario has ${s.commits.length}. record-kernel.mjs で取り直す`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-golden-'));
    try {
        const repo = path.join(tmp, 'shadow');
        fs.mkdirSync(repo);
        runGit(repo, ['init', '-q']);
        runGit(repo, ['config', 'core.autocrlf', 'false']);
        const paths = o.ensureOverlayDirs(path.join(tmp, 'ws'));

        const hashes = [];
        const saved = [];
        s.commits.forEach((c, i) => {
            const parent = parentOf(s, i);
            if (parent >= 0 && parent !== i - 1) {
                runGit(repo, ['checkout', '-q', '-f', '--detach', hashes[parent]]);
                runGit(repo, ['clean', '-qfdx']);
            }
            for (const op of c.ops) { applyOp(repo, op); }
            runGit(repo, ['add', '-A']);
            commit(repo, `c${i + 1}`);
            const hash = runGit(repo, ['rev-parse', 'HEAD']).trim();
            hashes.push(hash);
            const layerPath = chainOf(s, i).map((n) => hashes[n]);
            saved.push(viewOrError(() => {
                o.exportCommitLayer(repo, paths, hash, parent >= 0 ? hashes[parent] : undefined, 'mb-1', runGit, tryRunGit);
                return o.ensureExpandedView(paths, layerPath).viewPath;
            }));
        });

        const rebuilt = s.commits.map((_, i) => viewOrError(() => {
            fs.rmSync(paths.views, { recursive: true, force: true });
            return o.ensureExpandedView(paths, chainOf(s, i).map((n) => hashes[n])).viewPath;
        }));

        const report = [];
        s.commits.forEach((_, i) => {
            for (const [mode, views] of [['saved', saved], ['rebuilt', rebuilt]]) {
                const d = diffLines(golden[i], views[i]);
                if (d.length) { report.push(`[${s.name}] commit ${i + 1} (${mode})`, ...d); }
            }
        });
        return report;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

validateScenarios();
const report = scenarios.flatMap(runScenario);
const text = [
    '# scripts/golden/check-node.mjs --update-known が生成。',
    '# 現行の Node.js 仮想 Overlay がカーネルの期待値と食い違う点（- は期待値にだけある行、+ は Node にだけある行）。',
    '# 各項目の原因と扱いは docs/overlayfs-golden-test.md を参照。',
    ...report,
].join('\n') + '\n';

if (process.argv.includes('--update-known')) {
    fs.writeFileSync(KNOWN_FILE, text);
    console.log(`wrote ${path.relative(ROOT, KNOWN_FILE)} (${report.filter((l) => l.startsWith('[')).length} mismatched views)`);
    process.exit(0);
}

const known = fs.existsSync(KNOWN_FILE) ? fs.readFileSync(KNOWN_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
if (known === text) {
    console.log(`OK: ${scenarios.length} scenarios, Node の食い違いは既知の一覧どおり（${report.filter((l) => l.startsWith('[')).length} 件）`);
    process.exit(0);
}
console.error('Node の結果が既知の一覧と違う。直ったのなら --update-known で一覧を更新する。\n');
const knownSet = new Set(known.split('\n'));
const textSet = new Set(text.split('\n'));
for (const l of known.split('\n')) { if (l && !textSet.has(l)) { console.error(`  消えた: ${l}`); } }
for (const l of text.split('\n')) { if (l && !knownSet.has(l)) { console.error(`  増えた: ${l}`); } }
process.exit(1);
