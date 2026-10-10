/**
 * Node.js 版の層を、速い記録の「親からの変化」（delta）から作る道（#66）が、Git から作る道と
 * 同じ層・メタデータ・DAG・ビューを作ることを確かめる。
 *
 * やり方: 本物の速い記録（FastMicroCommitter）で保存を記録し、同じコミットを
 *   - overlay A: delta の道（exportCommitLayerWithSource に delta を渡す）
 *   - overlay B: Git の道（delta を渡さない。今までの exportCommitLayer と同じ）
 * の 2 つの .microgit/overlay に書き出して、フォルダの中身をバイト単位で、dag.json を内容とバイトで比べる。
 * delta の道では Git を起動せず、速い記録が貯めている Git のファイル（ADR-0015）も書き出させないことも確かめる。
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { FastMicroCommitter } from '../../fastMicroCommit';
import { flushPendingGitWrites, registerPendingFlusher } from '../../fastGit/pendingWrites';
import { MicroCommitDelta, MicroCommitOutcome } from '../../microCommit';
import {
    exportCommitLayerWithSource,
    ensureOverlayDirs,
    layerDir,
    layerEntriesFromDelta,
    layerMetaPath,
    OverlayPaths,
    readDag,
    removeTree,
    viewDir,
} from '../../overlay';

const roots: string[] = [];
after(() => {
    // fs.rmSync({ recursive }) は Windows の Node 25.1.0 で日本語のディレクトリを消すと落ちる（overlay.ts の removeTree）
    for (const r of roots) { try { removeTree(r); } catch { /* 一時フォルダ */ } }
});

function tempDir(name: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `microgit-delta-${name}-`));
    roots.push(d);
    return d;
}

const gitRaw = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** Git を起動した回数（delta の道では 0 のはず） */
let gitCalls = 0;
/** 拡張機能の runGit と同じく、Git を起動する前に貯めている分を書き出させる */
const runGit = (cwd: string, args: string[]): string => {
    gitCalls++;
    flushPendingGitWrites(cwd);
    return gitRaw(cwd, args);
};
const tryRunGit = (cwd: string, args: string[]): string | undefined => {
    try { return runGit(cwd, args); } catch { return undefined; }
};

/** フォルダの中身（ディレクトリとファイルのバイト列）を、相対パス順の一覧にする */
function snapshotTree(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) { return ['<none>']; }
    const walk = (d: string, prefix: string) => {
        for (const name of fs.readdirSync(d).sort()) {
            const abs = path.join(d, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            const st = fs.lstatSync(abs);
            if (st.isDirectory()) {
                out.push(`D ${rel}`);
                walk(abs, rel);
            } else if (st.isFile()) {
                out.push(`F ${rel} ${fs.readFileSync(abs).toString('base64')}`);
            } else {
                out.push(`? ${rel}`);
            }
        }
    };
    walk(dir, '');
    return out;
}

function assertSameLayer(a: OverlayPaths, b: OverlayPaths, commit: string, label: string): void {
    assert.deepStrictEqual(snapshotTree(layerDir(a, commit)), snapshotTree(layerDir(b, commit)), `${label}: 層の中身`);
    assert.strictEqual(
        fs.readFileSync(layerMetaPath(layerDir(a, commit)), 'utf8'),
        fs.readFileSync(layerMetaPath(layerDir(b, commit)), 'utf8'),
        `${label}: 層のメタデータ`,
    );
    assert.deepStrictEqual(snapshotTree(viewDir(a, commit)), snapshotTree(viewDir(b, commit)), `${label}: ビュー`);
    const da = readDag(a);
    const db = readDag(b);
    assert.deepStrictEqual(da.nodes[commit], db.nodes[commit], `${label}: DAG のノード`);
    assert.deepStrictEqual(da, db, `${label}: DAG 全体`);
    assert.strictEqual(fs.readFileSync(a.dagFile, 'utf8'), fs.readFileSync(b.dagFile, 'utf8'), `${label}: dag.json のバイト列`);
}

type Shadow = { repo: string; fast: FastMicroCommitter; unregister: () => void; tag: string; n: number };

/**
 * 隠しリポジトリと同じ形のリポジトリを作る。最初のコミットは Git の CLI で作り、実行できるファイル（100755）を入れる
 * （Windows は core.filemode=false なので、速い記録は親のモードを引き継ぐ。Linux・macOS は実行ビットを見る）
 */
function makeShadow(): Shadow {
    const repo = tempDir('repo');
    gitRaw(os.tmpdir(), ['init', '-q', '-b', 'micro-history', repo]);
    for (const [k, v] of [['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['user.name', 'T'], ['user.email', 't@example.invalid']]) {
        gitRaw(repo, ['config', k, v]);
    }
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'keep v1\n');
    fs.mkdirSync(path.join(repo, 'bin'));
    fs.writeFileSync(path.join(repo, 'bin', 'run.sh'), '#!/bin/sh\necho v1\n');
    fs.chmodSync(path.join(repo, 'bin', 'run.sh'), 0o755);
    gitRaw(repo, ['add', '.']);
    gitRaw(repo, ['update-index', '--chmod=+x', 'bin/run.sh']);
    gitRaw(repo, ['commit', '-q', '-m', 'seed']);
    gitRaw(repo, ['tag', 'mb-1']);
    // fsync 有効（拡張機能の既定 durability=power と同じ）。このときだけ Git のファイルの書き出しを遅らせる（ADR-0015）
    const fast = new FastMicroCommitter(repo, () => true);
    // 拡張機能と同じく、Git を読む処理の前に書き出させる関所に登録する
    const unregister = registerPendingFlusher(() => { if (fast.hasPending) { fast.flush(); } });
    return { repo, fast, unregister, tag: 'mb-1', n: 0 };
}

function save(s: Shadow, rel: string, content: Buffer | string): MicroCommitOutcome {
    const abs = path.join(s.repo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    s.n++;
    const outcome = s.fast.record({
        shadowRepoPath: s.repo,
        relativeFilePath: rel,
        currentTag: s.tag,
        message: () => `micro: saved ${rel} (#${s.n})`,
        commitEnv: {
            ...process.env,
            GIT_AUTHOR_NAME: 'MicroGit', GIT_AUTHOR_EMAIL: 'microgit@local',
            GIT_COMMITTER_NAME: 'MicroGit', GIT_COMMITTER_EMAIL: 'microgit@local',
        },
    });
    if (outcome.kind !== 'unchanged') { s.tag = outcome.tag; }
    return outcome;
}

describe('Node.js 版の層を delta から作る（#66）', () => {
    test('delta の道と Git の道で、層・メタデータ・ビュー・DAG がバイト単位で同じ', () => {
        const s = makeShadow();
        try {
            const viaDelta = ensureOverlayDirs(tempDir('ws-delta'));
            const viaGit = ensureOverlayDirs(tempDir('ws-git'));
            const seed = gitRaw(s.repo, ['rev-parse', 'HEAD']).trim();
            // 最初のコミット（親なし）は両方とも Git の道
            for (const p of [viaDelta, viaGit]) {
                const r = exportCommitLayerWithSource(s.repo, p, seed, undefined, 'mb-1', runGit, tryRunGit);
                assert.strictEqual(r.source, 'git');
            }

            const big = Buffer.alloc(3 * 1024 * 1024 + 7);
            for (let i = 0; i < big.length; i++) { big[i] = (i * 31 + 7) & 0xff; }
            const steps: Array<[string, string, Buffer | string]> = [
                ['モード 755 のファイルの上書き', 'bin/run.sh', '#!/bin/sh\necho v2\n'],
                ['日本語の名前・入れ子のフォルダ（新しいファイル）', 'docs/設計/メモ.md', '# メモ\n日本語の本文\n'],
                ['深い入れ子のフォルダ', 'src/a/b/c/deep.ts', 'export const x = 1;\n'],
                ['上書き', 'keep.txt', 'keep v2\n'],
                ['空のファイル', 'empty.txt', ''],
                ['日本語の名前の上書き', 'docs/設計/メモ.md', '# メモ\n書き直した\r\nCRLF も混ぜる\r\n'],
                ['1 MiB を超えるファイル', 'assets/big.bin', big],
                ['空のファイルに中身を入れる', 'empty.txt', 'now not empty'],
                ['モード 755 のファイルを空にする', 'bin/run.sh', ''],
                ['入れ子の上書き', 'src/a/b/c/deep.ts', 'export const x = 2;\n'],
            ];
            let deltas = 0;
            for (const [label, rel, content] of steps) {
                const outcome = save(s, rel, content);
                assert.strictEqual(outcome.kind, 'created', `${label}: 新しい記録になる`);
                if (outcome.kind !== 'created') { continue; }
                assert.ok(outcome.delta, `${label}: 速い記録が delta を付ける`);
                if (rel === 'bin/run.sh') { assert.strictEqual(outcome.delta!.files[0].mode, '100755', `${label}: モード`); }

                // delta の道：Git を起動せず、貯めている Git のファイルも書き出させない
                const before = gitCalls;
                assert.ok(s.fast.hasPending, `${label}: 書き出し前は貯まっている`);
                const a = exportCommitLayerWithSource(s.repo, viaDelta, outcome.commit, outcome.parent, outcome.tag, runGit, tryRunGit, outcome.delta);
                assert.strictEqual(a.source, 'delta', `${label}: delta の道を使う`);
                assert.strictEqual(gitCalls, before, `${label}: delta の道で Git を起動しない`);
                assert.ok(s.fast.hasPending, `${label}: delta の道は貯めている分を書き出させない（ADR-0015）`);
                deltas++;

                // Git の道（今までの作り方）
                const b = exportCommitLayerWithSource(s.repo, viaGit, outcome.commit, outcome.parent, outcome.tag, runGit, tryRunGit);
                assert.strictEqual(b.source, 'git');
                assert.ok(!s.fast.hasPending, 'Git の道は書き出させる');
                assert.deepStrictEqual(a.changedFiles, b.changedFiles, `${label}: changedFiles`);
                assertSameLayer(viaDelta, viaGit, outcome.commit, label);
                // 層の中身は保存した内容そのもの
                assert.ok(
                    fs.readFileSync(path.join(layerDir(viaDelta, outcome.commit), ...rel.split('/'))).equals(Buffer.from(content)),
                    `${label}: 層の中身が保存した内容`,
                );
            }
            assert.strictEqual(deltas, steps.length);
            assert.deepStrictEqual(snapshotTree(viaDelta.root), snapshotTree(viaGit.root), 'overlay のフォルダ全体');
        } finally {
            s.unregister();
        }
    });

    test('delta の親が違う・delta が無い・親が無いときは Git の道に落ち、結果は Git の道と同じ', () => {
        const s = makeShadow();
        try {
            const seed = gitRaw(s.repo, ['rev-parse', 'HEAD']).trim();
            const outcome = save(s, 'keep.txt', 'changed\n');
            assert.strictEqual(outcome.kind, 'created');
            if (outcome.kind !== 'created') { return; }
            assert.ok(outcome.delta);
            const reference = ensureOverlayDirs(tempDir('ws-ref'));
            exportCommitLayerWithSource(s.repo, reference, seed, undefined, 'mb-1', runGit, tryRunGit);
            exportCommitLayerWithSource(s.repo, reference, outcome.commit, outcome.parent, outcome.tag, runGit, tryRunGit);

            const cases: Array<[string, MicroCommitDelta | undefined]> = [
                ['delta の親が違う', { ...outcome.delta!, parent: 'f'.repeat(40) }],
                ['delta が無い', undefined],
            ];
            for (const [label, delta] of cases) {
                const p = ensureOverlayDirs(tempDir('ws-fallback'));
                exportCommitLayerWithSource(s.repo, p, seed, undefined, 'mb-1', runGit, tryRunGit);
                const r = exportCommitLayerWithSource(s.repo, p, outcome.commit, outcome.parent, outcome.tag, runGit, tryRunGit, delta);
                assert.strictEqual(r.source, 'git', label);
                assertSameLayer(p, reference, outcome.commit, label);
            }

            // 親が無い（parentHash が undefined）なら、delta があっても Git の道（ls-tree の全ファイルを書く）
            const p = ensureOverlayDirs(tempDir('ws-noparent'));
            const r = exportCommitLayerWithSource(s.repo, p, outcome.commit, undefined, outcome.tag, runGit, tryRunGit, outcome.delta);
            assert.strictEqual(r.source, 'git');
            assert.deepStrictEqual([...r.changedFiles].sort(), ['bin/run.sh', 'keep.txt']);
        } finally {
            s.unregister();
        }
    });

    test('使えない delta の形は layerEntriesFromDelta が断る', () => {
        const parent = 'a'.repeat(40);
        const file = { path: 'x.txt', mode: '100644' as const, content: Buffer.from('x') };
        assert.ok(layerEntriesFromDelta({ parent, files: [file] }, parent));
        assert.strictEqual(layerEntriesFromDelta(undefined, parent), undefined);
        assert.strictEqual(layerEntriesFromDelta({ parent, files: [file] }, undefined), undefined);
        assert.strictEqual(layerEntriesFromDelta({ parent, files: [file] }, 'b'.repeat(40)), undefined);
        assert.strictEqual(layerEntriesFromDelta({ parent, files: [] }, parent), undefined, 'ファイルが無い');
        assert.strictEqual(layerEntriesFromDelta({ parent, files: [file, { ...file, path: 'y.txt' }] }, parent), undefined, '2 つ以上');
        for (const bad of ['', '/abs', 'C:/x', '../x', 'a/../x', 'a//b', './x', 'a/.']) {
            assert.strictEqual(layerEntriesFromDelta({ parent, files: [{ ...file, path: bad }] }, parent), undefined, `安全でないパス ${bad}`);
        }
        for (const mode of ['120000', '160000', '040000']) {
            const f = { ...file, mode } as unknown as MicroCommitDelta['files'][number];
            assert.strictEqual(layerEntriesFromDelta({ parent, files: [f] }, parent), undefined, `モード ${mode}`);
        }
        const notBuffer = { ...file, content: 'x' } as unknown as MicroCommitDelta['files'][number];
        assert.strictEqual(layerEntriesFromDelta({ parent, files: [notBuffer] }, parent), undefined, '中身が Buffer でない');
    });
});
