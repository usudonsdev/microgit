/**
 * 差分の計算を別プロセスで行う部分（runner.ts・worker.ts）の単体テスト。VS Code は使わない。
 * 観点：子プロセスで計算して結果が返る。同じ中身の組み合わせは 2 回目にキャッシュから返る。時間の上限で打ち切る。
 * 壊れた入力は error（format）になり、拡張機能の側は落ちない。キャッシュは件数の上限で古いものから消える。
 */
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { computeDiff, pruneCache } from '../../diff/runner';

describe('差分の計算（別プロセス）', () => {
    it('CSV を子プロセスで比べ、2 回目はキャッシュから返す', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vereve-cache-'));
        try {
            const req = { path: 'a.csv', oldBytes: Buffer.from('a,b\n1,2\n'), newBytes: Buffer.from('a,b\n1,3\n'), cacheDir };
            const d1 = await computeDiff(req);
            assert.equal(d1.kind, 'table');
            assert.equal(fs.readdirSync(cacheDir).length, 1);
            const d2 = await computeDiff({ ...req, path: 'b.csv' });
            assert.deepEqual({ ...d2, path: 'a.csv' }, d1);
            assert.equal(d2.path, 'b.csv');
        } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
    });
    it('壊れた xlsx は error（format）', async () => {
        const d = await computeDiff({ path: 'x.xlsx', oldBytes: Buffer.from('PK\x03\x04broken'), newBytes: Buffer.from('PK\x03\x04broken2') });
        assert.equal(d.kind, 'error');
        assert.equal(d.kind === 'error' && d.reason, 'format');
    });
    it('時間の上限で打ち切る', async () => {
        const big = Buffer.from(Array.from({ length: 200_000 }, (_, i) => `${i},${i * 7}`).join('\n'));
        const big2 = Buffer.from(Array.from({ length: 200_000 }, (_, i) => `${i},${i * 7 + (i % 3)}`).join('\n'));
        const d = await computeDiff({ path: 'big.csv', oldBytes: big, newBytes: big2, timeoutMs: 50 });
        assert.equal(d.kind, 'error');
        assert.equal(d.kind === 'error' && d.reason, 'timeout');
    });
    it('キャッシュは上限を超えたら古いものから消す', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vereve-prune-'));
        try {
            for (let i = 0; i < 5; i++) {
                const f = path.join(dir, `${i}.json`);
                fs.writeFileSync(f, '{}');
                fs.utimesSync(f, new Date(1000 * i), new Date(1000 * i));
            }
            pruneCache(dir, 3);
            assert.deepEqual(fs.readdirSync(dir).sort(), ['2.json', '3.json', '4.json']);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
