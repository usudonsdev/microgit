import * as assert from 'assert';
import { describe, test } from 'node:test';
import { SaveTimer, SaveTimingLog } from '../../saveTiming';

describe('保存 1 回の段階ごとの時間（#37）', () => {
    test('mark は直前の印からの時間をその段階に足し、skip は区間を飛ばす', () => {
        let t = 100;
        const timer = new SaveTimer(100, () => t);
        t = 105; timer.mark('queue');
        t = 106; timer.mark('policy');
        t = 110; timer.mark('commit');
        timer.recorded();
        t = 130; timer.skip();
        t = 131; timer.mark('commit'); // 同じ段階は足し合わせる
        t = 140; timer.mark('layer');
        timer.restorable();
        t = 150;
        const r = timer.finish('created');
        assert.deepStrictEqual(r.stages, { queue: 5, policy: 1, commit: 5, layer: 9 });
        assert.strictEqual(r.recordedMs, 10);
        assert.strictEqual(r.restorableMs, 40);
        assert.strictEqual(r.totalMs, 50);
        assert.strictEqual(r.result, 'created');
    });

    test('直近の記録から段階ごとの p50・p95 を出し、容量を超えたら古いものから捨てる', () => {
        const log = new SaveTimingLog(3);
        for (const v of [10, 20, 30, 40]) {
            log.add({ stages: { commit: v }, totalMs: v * 2, result: 'created' });
        }
        const s = log.summary();
        assert.strictEqual(s.count, 3);
        const commit = s.rows.find((r) => r.name === 'commit')!;
        assert.deepStrictEqual([commit.n, commit.p50, commit.p95], [3, 30, 30]);
        const total = s.rows.find((r) => r.name === 'total')!;
        assert.deepStrictEqual([total.p50, total.p95], [60, 60]);
        assert.match(log.describe(), /直近 3 回（created 3）/);
    });

    test('層づくりの内訳は layer の行のすぐ下に出し、内訳の無い保存は数に入れない（#61）', () => {
        const log = new SaveTimingLog(10);
        log.add({ stages: { layer: 30 }, totalMs: 40, result: 'created', layerPhases: { transport: 20, 'guest.mount': 2 } });
        log.add({ stages: { layer: 34 }, totalMs: 44, result: 'created', layerPhases: { transport: 24, 'guest.mount': 4 } });
        log.add({ stages: { layer: 12 }, totalMs: 20, result: 'created' }); // Node.js 版の層（内訳なし）
        const names = log.summary().rows.map((r) => r.name);
        const at = names.indexOf('layer');
        assert.deepStrictEqual(names.slice(at, at + 3), ['layer', '  transport', '  guest.mount']);
        const transport = log.summary().rows.find((r) => r.name === '  transport')!;
        assert.deepStrictEqual([transport.n, transport.p50], [2, 20]);
        assert.match(log.describe(), / {2}transport/);
    });
});
