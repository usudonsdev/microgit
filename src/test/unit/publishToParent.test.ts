import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { registerPendingFlusher } from '../../fastGit/pendingWrites';
import { PublishQueue } from '../../publishQueue';
import { bareGitDirPath, ensureShadowRepoForBranch, parentMicroRefPrefix, publishToParentRefs } from '../../shadowStore';

/**
 * 親のリポジトリへの共有（#72）。Git の起動を非同期にし、push を 1 回にまとめても、
 * 親にできる refs/microgit/<ブランチ>/…（名前と指す先）が前とまったく同じになることを確かめる。
 */

const BRANCH = 'main';
// 2 つのリポジトリで同じコミット（同じハッシュ）を作るため、日時と名前を固定する
const ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(args: string[], input?: string): string {
    return execFileSync('git', args, { encoding: 'utf8', env: ENV, input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/**
 * 直す前の publishToParentRefs（5.1.3）をそのまま写したもの。比べるためだけに使う。
 * rev-parse --verify → micro-history を push → tag -l mb-* → mb-<数字> を 1 本ずつ push（すべて同期）
 */
function legacyPublish(mainRepoPath: string, mainBranch: string, log?: (m: string, l?: string) => void): void {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    if (!fs.existsSync(bare)) { return; }
    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);
    const run = (args: string[]) => git(['--git-dir', bare, ...args]);
    try { run(['rev-parse', '--verify', 'refs/heads/micro-history']); } catch { return; }
    run(['push', '--force', parentGit, `refs/heads/micro-history:${prefix}/micro-history`]);
    let tagsOut = '';
    try { tagsOut = run(['tag', '-l', 'mb-*']); } catch { tagsOut = ''; }
    for (const tag of tagsOut.split('\n').filter(Boolean)) {
        if (!/^mb-\d+$/.test(tag)) { continue; }
        try {
            run(['push', '--force', parentGit, `refs/tags/${tag}:${prefix}/tags/${tag}`]);
        } catch (err: unknown) {
            log?.(`タグ ${tag} の publish に失敗: ${String(err)}`, 'WARN');
        }
    }
}

function parentRefs(mainRepoPath: string): string {
    return git(['-C', mainRepoPath, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/microgit/']);
}

function makeMain(root: string, name: string): string {
    const main = path.join(root, name);
    fs.mkdirSync(main, { recursive: true });
    git(['init', '-q', '-b', 'main', main]);
    return main;
}

/** bare にコミットを 1 つ作る（plumbing。中身と親と日時で、どちらのリポジトリでも同じハッシュになる） */
function commit(bare: string, content: string, parent?: string): string {
    const blob = git(['--git-dir', bare, 'hash-object', '-w', '--stdin'], content);
    const tree = git(['--git-dir', bare, 'mktree'], `100644 blob ${blob}\tf.txt\n`);
    return git(['--git-dir', bare, 'commit-tree', tree, '-m', content, ...(parent ? ['-p', parent] : [])]);
}

/** 2 つのメインのリポジトリ（A：直す前の方法、B：直した後の方法）に、同じ操作をする */
function both(mains: string[], fn: (bare: string) => void): void {
    for (const m of mains) { fn(bareGitDirPath(m, BRANCH)); }
}

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-publish-'));
}

describe('親 refs への共有（#72）：直す前と同じ refs ができる', () => {
    test('マイクロ履歴とタグ（複数・分岐・mb-<数字> 以外・消したタグ・動かしたタグ・packed-refs・巻き戻し）で同じ', async () => {
        const root = tmpRoot();
        try {
            const a = makeMain(root, 'a');
            const b = makeMain(root, 'b');
            const mains = [a, b];
            for (const m of mains) { ensureShadowRepoForBranch(m, BRANCH); }

            const ids: Record<string, string> = {};
            both(mains, (bare) => {
                ids.c1 = commit(bare, 'c1');
                ids.c2 = commit(bare, 'c2', ids.c1);
                ids.c3 = commit(bare, 'c3', ids.c2);
                ids.c4 = commit(bare, 'c4', ids.c3);
                ids.f1 = commit(bare, 'f1', ids.c2); // 分岐（micro-history からはたどれない）
                git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', ids.c4]);
                git(['--git-dir', bare, 'tag', 'mb-1', ids.c1]);
                git(['--git-dir', bare, 'tag', 'mb-2', ids.f1]);
                git(['--git-dir', bare, 'tag', 'mb-10', ids.c3]);
                git(['--git-dir', bare, 'tag', 'mb-x', ids.c4]); // mb-<数字> ではないので共有しない
                git(['--git-dir', bare, 'tag', 'other', ids.c4]); // mb-* ではないので共有しない
            });

            const p = parentMicroRefPrefix(BRANCH);
            const check = async (label: string, expected: string[]) => {
                legacyPublish(a);
                await publishToParentRefs(b, BRANCH);
                assert.strictEqual(parentRefs(b), parentRefs(a), `${label}：直す前と直した後で親の refs が違う`);
                assert.deepStrictEqual(parentRefs(b).split('\n').sort(), expected.sort(), `${label}：期待する refs の一覧と違う`);
            };
            // 引数の数を合わせるための小さな包み
            function legacyPublish(m: string) { legacyPublishFn(m, BRANCH); }

            await check('はじめての共有', [
                `${p}/micro-history ${ids.c4}`,
                `${p}/tags/mb-1 ${ids.c1}`,
                `${p}/tags/mb-10 ${ids.c3}`,
                `${p}/tags/mb-2 ${ids.f1}`,
            ]);

            both(mains, (bare) => {
                ids.c5 = commit(bare, 'c5', ids.c4);
                git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', ids.c5]);
                git(['--git-dir', bare, 'tag', '-d', 'mb-2']); // 消したタグ：親では消さずに残る（前と同じ）
                git(['--git-dir', bare, 'tag', '-f', 'mb-1', ids.c4]); // 動かしたタグ（強制で上書き）
                git(['--git-dir', bare, 'tag', 'mb-3', ids.c5]);
                git(['--git-dir', bare, 'pack-refs', '--all']); // ref のファイルを packed-refs から読む道
            });
            await check('消した・動かした・足したタグと packed-refs', [
                `${p}/micro-history ${ids.c5}`,
                `${p}/tags/mb-1 ${ids.c4}`,
                `${p}/tags/mb-10 ${ids.c3}`,
                `${p}/tags/mb-2 ${ids.f1}`,
                `${p}/tags/mb-3 ${ids.c5}`,
            ]);

            both(mains, (bare) => {
                git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', ids.c2]); // 巻き戻し（fast-forward でない）
                git(['--git-dir', bare, 'tag', 'mb-4', ids.c2]); // loose が packed-refs と並ぶ
            });
            await check('巻き戻し（強制）と loose・packed の混在', [
                `${p}/micro-history ${ids.c2}`,
                `${p}/tags/mb-1 ${ids.c4}`,
                `${p}/tags/mb-10 ${ids.c3}`,
                `${p}/tags/mb-2 ${ids.f1}`,
                `${p}/tags/mb-3 ${ids.c5}`,
                `${p}/tags/mb-4 ${ids.c2}`,
            ]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('micro-history が無ければ何も共有しない・bare が無ければ何もしない（前と同じ）', async () => {
        const root = tmpRoot();
        try {
            const a = makeMain(root, 'a');
            const b = makeMain(root, 'b');
            await publishToParentRefs(b, BRANCH); // bare が無い
            assert.strictEqual(parentRefs(b), '');
            for (const m of [a, b]) {
                ensureShadowRepoForBranch(m, BRANCH);
                const bare = bareGitDirPath(m, BRANCH);
                git(['--git-dir', bare, 'tag', 'mb-1', commit(bare, 'x')]); // タグだけある
            }
            legacyPublishFn(a, BRANCH);
            await publishToParentRefs(b, BRANCH);
            assert.strictEqual(parentRefs(a), '');
            assert.strictEqual(parentRefs(b), '');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('タグが多くてコマンドラインに収まらないときは、push を分けても同じ refs', async () => {
        const root = tmpRoot();
        try {
            const a = makeMain(root, 'a');
            const b = makeMain(root, 'b');
            for (const m of [a, b]) {
                ensureShadowRepoForBranch(m, BRANCH);
                const bare = bareGitDirPath(m, BRANCH);
                let prev: string | undefined;
                for (let i = 1; i <= 25; i++) {
                    prev = commit(bare, `c${i}`, prev);
                    git(['--git-dir', bare, 'tag', `mb-${i}`, prev]);
                }
                git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', prev!]);
            }
            legacyPublishFn(a, BRANCH);
            await publishToParentRefs(b, BRANCH, undefined, { maxRefspecChars: 300 }); // 300 文字ごと（6 回ほどの push）
            assert.strictEqual(parentRefs(b), parentRefs(a));
            assert.strictEqual(parentRefs(b).split('\n').length, 26);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('reftable の隠しリポジトリ（ファイルで ref を読めない）でも、Git に任せて同じ refs', async (t) => {
        const root = tmpRoot();
        try {
            const a = makeMain(root, 'a');
            const b = makeMain(root, 'b');
            for (const m of [a, b]) {
                const bare = bareGitDirPath(m, BRANCH);
                fs.mkdirSync(path.dirname(bare), { recursive: true });
                try {
                    git(['init', '-q', '--bare', '--ref-format=reftable', bare]);
                } catch {
                    t.skip('この Git は reftable を作れない');
                    return;
                }
                ensureShadowRepoForBranch(m, BRANCH);
                const c1 = commit(bare, 'c1');
                const c2 = commit(bare, 'c2', c1);
                git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c2]);
                git(['--git-dir', bare, 'tag', 'mb-1', c1]);
                git(['--git-dir', bare, 'tag', 'mb-7', c2]);
                git(['--git-dir', bare, 'tag', 'mb-y', c2]);
            }
            legacyPublishFn(a, BRANCH);
            await publishToParentRefs(b, BRANCH);
            assert.strictEqual(parentRefs(b), parentRefs(a));
            assert.strictEqual(parentRefs(b).split('\n').length, 3);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('タグの失敗は警告のログだけで、ほかの ref は更新する。micro-history の失敗は例外', async () => {
        const root = tmpRoot();
        try {
            const m = makeMain(root, 'm');
            ensureShadowRepoForBranch(m, BRANCH);
            const bare = bareGitDirPath(m, BRANCH);
            const c1 = commit(bare, 'c1');
            git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c1]);
            git(['--git-dir', bare, 'tag', 'mb-1', c1]);
            git(['--git-dir', bare, 'tag', 'mb-2', c1]);
            const p = parentMicroRefPrefix(BRANCH);
            const refDir = path.join(m, '.git', ...p.split('/'));

            // 親の mb-1 が他の Git に掴まれている（.lock がある）
            fs.mkdirSync(path.join(refDir, 'tags'), { recursive: true });
            fs.writeFileSync(path.join(refDir, 'tags', 'mb-1.lock'), '');
            const logs: { m: string; l?: string }[] = [];
            await publishToParentRefs(m, BRANCH, (msg, l) => logs.push({ m: msg, l }));
            assert.deepStrictEqual(parentRefs(m).split('\n'), [`${p}/micro-history ${c1}`, `${p}/tags/mb-2 ${c1}`]);
            assert.ok(logs.some((x) => x.l === 'WARN' && x.m.includes('mb-1')), 'mb-1 の失敗が警告に出ていない');
            fs.rmSync(path.join(refDir, 'tags', 'mb-1.lock'));

            // micro-history が掴まれている
            const c2 = commit(bare, 'c2', c1);
            git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c2]);
            fs.writeFileSync(path.join(refDir, 'micro-history.lock'), '');
            await assert.rejects(publishToParentRefs(m, BRANCH), /micro-history/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('壊れたタグが 1 本あっても、micro-history とほかのタグは共有され、壊れたタグだけ警告になる（前と同じ）', async () => {
        const root = tmpRoot();
        try {
            const m = makeMain(root, 'm');
            ensureShadowRepoForBranch(m, BRANCH);
            const bare = bareGitDirPath(m, BRANCH);
            const c1 = commit(bare, 'c1');
            git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c1]);
            git(['--git-dir', bare, 'tag', 'mb-1', c1]);
            git(['--git-dir', bare, 'tag', 'mb-2', c1]);
            // 存在しないオブジェクトを指すタグ（クラッシュなどで起こりうる）。まとめた push は、これ 1 本で全部が失敗する
            fs.mkdirSync(path.join(bare, 'refs', 'tags'), { recursive: true });
            fs.writeFileSync(path.join(bare, 'refs', 'tags', 'mb-9'), `${'ab'.repeat(20)}\n`);
            const p = parentMicroRefPrefix(BRANCH);
            const logs: { m: string; l?: string }[] = [];
            await publishToParentRefs(m, BRANCH, (msg, l) => logs.push({ m: msg, l }));
            assert.deepStrictEqual(parentRefs(m).split('\n'), [`${p}/micro-history ${c1}`, `${p}/tags/mb-1 ${c1}`, `${p}/tags/mb-2 ${c1}`]);
            assert.ok(logs.some((x) => x.l === 'WARN' && x.m.includes('mb-9')), 'mb-9 の失敗が警告に出ていない');
            assert.ok(!logs.some((x) => x.l === 'WARN' && x.m.includes('mb-1 ')), '壊れていないタグまで警告になっている');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('micro-history の共有に失敗したら、タグには進まない（前と同じ）', async () => {
        const root = tmpRoot();
        try {
            const m = makeMain(root, 'm');
            ensureShadowRepoForBranch(m, BRANCH);
            const bare = bareGitDirPath(m, BRANCH);
            const c1 = commit(bare, 'c1');
            git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c1]);
            git(['--git-dir', bare, 'tag', 'mb-1', c1]);
            // 親の micro-history が他の Git に掴まれている（.lock がある）
            const refDir = path.join(m, '.git', ...parentMicroRefPrefix(BRANCH).split('/'));
            fs.mkdirSync(refDir, { recursive: true });
            fs.writeFileSync(path.join(refDir, 'micro-history.lock'), '');
            await assert.rejects(publishToParentRefs(m, BRANCH), /micro-history/);
            assert.strictEqual(parentRefs(m).trim(), '', 'micro-history が失敗したのに、タグが親に入っている');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('ref を読む前・Git を起動する前に、速い記録の貯めている分を書き出させる（ADR-0015）', async () => {
        const root = tmpRoot();
        try {
            const m = makeMain(root, 'm');
            ensureShadowRepoForBranch(m, BRANCH);
            const bare = bareGitDirPath(m, BRANCH);
            const c1 = commit(bare, 'c1');
            // 貯めている分の代わり：書き出しを頼まれたときに初めて micro-history とタグをファイルに書く
            let flushed = 0;
            const off = registerPendingFlusher(() => {
                if (flushed++ === 0) {
                    git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', c1]);
                    git(['--git-dir', bare, 'tag', 'mb-1', c1]);
                }
            });
            try {
                await publishToParentRefs(m, BRANCH);
            } finally {
                off();
            }
            const p = parentMicroRefPrefix(BRANCH);
            assert.ok(flushed >= 2, `書き出しの呼び出しが ${flushed} 回（ref を読む前と push の前の 2 回以上のはず）`);
            assert.deepStrictEqual(parentRefs(m).split('\n'), [`${p}/micro-history ${c1}`, `${p}/tags/mb-1 ${c1}`]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('共有の間もイベントループが回る（前の同期の方法より、止まる時間が短い）', async () => {
        const root = tmpRoot();
        try {
            const m = makeMain(root, 'm');
            ensureShadowRepoForBranch(m, BRANCH);
            const bare = bareGitDirPath(m, BRANCH);
            let prev: string | undefined;
            for (let i = 1; i <= 5; i++) {
                prev = commit(bare, `c${i}`, prev);
                git(['--git-dir', bare, 'tag', `mb-${i}`, prev]);
            }
            git(['--git-dir', bare, 'update-ref', 'refs/heads/micro-history', prev!]);

            /** fn の間の、タイマーの間隔のいちばん長いもの（イベントループが止まった長さの目安） */
            const maxGap = async (fn: () => Promise<void> | void): Promise<number> => {
                let last = performance.now();
                let gap = 0;
                const iv = setInterval(() => {
                    const now = performance.now();
                    gap = Math.max(gap, now - last);
                    last = now;
                }, 1);
                await new Promise((r) => setTimeout(r, 20));
                last = performance.now();
                gap = 0;
                await fn();
                gap = Math.max(gap, performance.now() - last);
                clearInterval(iv);
                return gap;
            };
            const legacyGap = await maxGap(() => legacyPublishFn(m, BRANCH));
            // 2 回目の共有（すべて up to date）でも、前の方法は 2 + 6 回 Git を同期で起動する
            const legacyGap2 = await maxGap(() => legacyPublishFn(m, BRANCH));
            const newGap = await maxGap(async () => { await publishToParentRefs(m, BRANCH); });
            console.log(`イベントループが止まった最長：前の方法 ${legacyGap.toFixed(0)} / ${legacyGap2.toFixed(0)} ms、直した後 ${newGap.toFixed(0)} ms`);
            assert.ok(newGap < legacyGap2, `直した後（${newGap.toFixed(0)} ms）が前の方法（${legacyGap2.toFixed(0)} ms）より短くない`);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

function legacyPublishFn(mainRepoPath: string, mainBranch: string): void {
    legacyPublish(mainRepoPath, mainBranch);
}

describe('共有の列（PublishQueue、#72）', () => {
    /** 手で終わらせられる仕事 */
    function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        return { promise, resolve };
    }
    const tick = () => new Promise((r) => setImmediate(r));

    test('走っている間に何度頼まれても、終わってからもう 1 回だけ、最後の内容で走る', async () => {
        const started: number[] = [];
        const gates: ReturnType<typeof deferred>[] = [];
        const q = new PublishQueue<number>(async (j) => {
            started.push(j);
            const g = deferred();
            gates.push(g);
            await g.promise;
        }, () => { /* なし */ });
        q.schedule(1);
        await tick();
        assert.deepStrictEqual(started, [1]);
        q.schedule(2);
        q.schedule(3);
        q.schedule(4);
        await tick();
        assert.deepStrictEqual(started, [1], '走っている間に次が始まった（重なった）');
        gates[0].resolve();
        await tick(); await tick();
        assert.deepStrictEqual(started, [1, 4], '終わったあと、最後の内容（4）で 1 回だけ走るはず');
        gates[1].resolve();
        await q.whenIdle();
        assert.deepStrictEqual(started, [1, 4]);
    });

    test('同時に走る仕事は常に 1 つ。利用者のコマンド（runExclusive）は前の共有が終わってから走り、結果を返す', async () => {
        let running = 0;
        let maxRunning = 0;
        const order: string[] = [];
        const work = async (name: string) => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            order.push(`${name}:start`);
            await new Promise((r) => setTimeout(r, 5));
            order.push(`${name}:end`);
            running--;
        };
        const q = new PublishQueue<string>(work, () => { /* なし */ });
        q.schedule('auto1');
        const manual = q.runExclusive(async () => { await work('manual'); return 42; });
        q.schedule('auto2'); // コマンドの後ろに並ぶ
        assert.strictEqual(await manual, 42);
        await q.whenIdle();
        assert.strictEqual(maxRunning, 1);
        assert.deepStrictEqual(order, ['auto1:start', 'auto1:end', 'manual:start', 'manual:end', 'auto2:start', 'auto2:end']);
    });

    test('別のブランチの頼みは合流させず、両方走る。同じブランチの頼みは合流する', async () => {
        const started: string[] = [];
        const first = deferred();
        const q = new PublishQueue<string>(async (job) => {
            started.push(job);
            if (job === 'x:1') { await first.promise; }
        }, () => { /* なし */ }, (waiting, requested) => waiting.split(':')[0] === requested.split(':')[0]);
        q.schedule('x:1');
        await tick(); // x:1 が走り始めて止まっている
        q.schedule('a:1');
        q.schedule('a:2'); // 同じブランチ a の頼み → a:1 に合流して a:2 になる
        q.schedule('b:1'); // 別のブランチ → 合流しない
        q.schedule('b:2'); // b の待っている頼みに合流する
        first.resolve();
        await q.whenIdle();
        assert.deepStrictEqual(started, ['x:1', 'a:2', 'b:2']);
    });

    test('閉じた列は isClosed が true になる（拡張機能が activate し直されたら作り直すため）', async () => {
        const q = new PublishQueue<number>(async () => { /* なし */ }, () => { /* なし */ });
        assert.strictEqual(q.isClosed, false);
        await q.close();
        assert.strictEqual(q.isClosed, true);
    });

    test('エラーはログに渡すだけで、列は止まらない。runExclusive の失敗は呼んだ側に返る', async () => {
        const errors: unknown[] = [];
        const done: number[] = [];
        const q = new PublishQueue<number>(async (j) => {
            if (j === 1) { throw new Error('boom'); }
            done.push(j);
        }, (e) => errors.push(e));
        q.schedule(1);
        await q.whenIdle();
        await assert.rejects(q.runExclusive(async () => { throw new Error('manual'); }), /manual/);
        q.schedule(2);
        await q.whenIdle();
        assert.strictEqual(errors.length, 1);
        assert.deepStrictEqual(done, [2]);
    });

    test('close：まだ始まっていない共有は捨て、走っている共有は終わるまで待つ。そのあとは頼まれても走らない', async () => {
        const started: number[] = [];
        const finished: number[] = [];
        const gate = deferred();
        const q = new PublishQueue<number>(async (j) => {
            started.push(j);
            if (j === 1) { await gate.promise; }
            finished.push(j);
        }, () => { /* なし */ });
        q.schedule(1);
        await tick();
        q.schedule(2); // まだ始まっていない
        let closed = false;
        const c = q.close().then(() => { closed = true; });
        await tick();
        assert.strictEqual(closed, false, '走っている共有を待たずに close が終わった');
        gate.resolve();
        await c;
        q.schedule(3);
        await q.whenIdle();
        assert.deepStrictEqual(started, [1]);
        assert.deepStrictEqual(finished, [1]);
    });
});
