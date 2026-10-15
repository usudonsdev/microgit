/**
 * 画面の更新の合流と、Git 拡張の変更通知の重複の除去（refreshGate.ts の RefreshCoalescer・ChangeDedupe・headSignature）を確かめる単体テスト（#73）。
 * 観点：走っている間の依頼は 1 回にまとめて、終わってから 1 回だけやり直す。結果を捨てた依頼も新しい結果が出てから解決する。
 * 古い更新は表示を上書きしない（isCurrent）。invalidate で走っている更新を捨てる。失敗しても次の依頼は動く。
 * HEAD の印（headSignature）が同じなら変わっていないと数える。VS Code は使わない。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { ChangeDedupe, headSignature, RefreshCoalescer } from '../../refreshGate';

/** 次のイベントループ（setImmediate）まで待つ。非同期の依頼がどこまで進んだかを見るために使う。 */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('画面の更新を 1 つずつ・最新だけにする（#73）', () => {
    it('走っている間に来た依頼は 1 回にまとめ、終わってから 1 回だけやり直す', async () => {
        let runs = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const c = new RefreshCoalescer(async () => { runs++; if (runs === 1) { await gate; } });
        const p1 = c.request();
        await tick();
        const p2 = c.request();
        const p3 = c.request();
        const p4 = c.request();
        release();
        await Promise.all([p1, p2, p3, p4]);
        assert.equal(runs, 2); // 1 回目 + まとめた 1 回
    });

    it('結果を捨てた更新の依頼も、やり直しの結果が出てから解決する（古い内容のままグラフを開かない）', async () => {
        const events: string[] = [];
        let n = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const c = new RefreshCoalescer(async (isCurrent) => {
            const id = n++;
            if (id === 0) { await gate; }
            events.push(`run${id}:${isCurrent() ? 'applied' : 'dropped'}`);
        });
        const p1 = c.request().then(() => { events.push('resolved1'); });
        await tick();
        const p2 = c.request().then(() => { events.push('resolved2'); }); // 1 回目が走っている間の依頼 → 1 回目の結果は捨てられる
        release();
        await Promise.all([p1, p2]);
        assert.deepEqual(events, ['run0:dropped', 'run1:applied', 'resolved1', 'resolved2']);
    });

    it('古い更新が後から終わっても、世代が進んでいれば isCurrent が false になり、表示を上書きしない', async () => {
        const applied: string[] = [];
        let n = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const c = new RefreshCoalescer(async (isCurrent) => {
            const id = `run${++n}`;
            if (n === 1) { await gate; } // 1 回目は遅れて終わる
            if (isCurrent()) { applied.push(id); }
        });
        const p1 = c.request();
        await tick();
        const p2 = c.request(); // 1 回目の途中で次の依頼
        release();
        await Promise.all([p1, p2]);
        assert.deepEqual(applied, ['run2']); // run1 は捨てられ、最新の run2 だけ
    });

    it('invalidate すると走っている更新の結果が捨てられる', async () => {
        const applied: number[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const c = new RefreshCoalescer(async (isCurrent) => { await gate; if (isCurrent()) { applied.push(1); } });
        const p = c.request();
        await tick();
        c.invalidate();
        release();
        await p;
        assert.deepEqual(applied, []);
    });

    it('更新が失敗しても依頼は解決し、次の依頼は動く', async () => {
        let n = 0;
        const c = new RefreshCoalescer(async () => { n++; if (n === 1) { throw new Error('x'); } });
        await c.request();
        await c.request();
        assert.equal(n, 2);
    });
});

describe('Git 拡張の onDidChange の重複を捨てる（#73）', () => {
    it('HEAD の印が同じなら変わっていない、違えば変わった', () => {
        const d = new ChangeDedupe();
        const a = headSignature({ name: 'main', commit: 'aaa', type: 0 });
        assert.equal(d.changed('r', a), true);
        assert.equal(d.changed('r', a), false);
        assert.equal(d.changed('r', headSignature({ name: 'main', commit: 'bbb', type: 0 })), true);
        assert.equal(d.changed('r', headSignature({ name: 'dev', commit: 'bbb', type: 0 })), true);
        assert.equal(d.changed('other', a), true); // 別のリポジトリは別に数える
    });
});
