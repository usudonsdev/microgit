/**
 * 反映後に読み直す文書の選び方（revertPolicy.ts の selectDocumentsToRevert）を確かめる単体テスト。
 * 観点：dirty（未保存）な文書は読み直さない（未保存の編集を黙って捨てない）、変わっていない文書・ワークスペース外は対象外、
 * 変わっていて dirty でないものだけ読み直す。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import { describe, test } from 'node:test';
import { selectDirtyPaths, selectDocumentsToRevert } from '../../revertPolicy';

describe('selectDocumentsToRevert', () => {
    const touched = new Set(['a.ts', 'b.ts', 'c.ts']);

    test('dirty な文書は読み直さず skippedDirty に入れる', () => {
        const docs = [
            { rel: 'a.ts', isDirty: false },
            { rel: 'b.ts', isDirty: true },
        ];
        const r = selectDocumentsToRevert(docs, touched);
        assert.deepStrictEqual(r.revert.map((d) => d.rel), ['a.ts']);
        assert.deepStrictEqual(r.skippedDirty.map((d) => d.rel), ['b.ts']);
    });

    test('反映で変わっていない文書とワークスペース外の文書は、dirty でも対象外', () => {
        const docs = [
            { rel: 'x.ts', isDirty: true },
            { rel: 'y.ts', isDirty: false },
            { rel: undefined, isDirty: true },
        ];
        const r = selectDocumentsToRevert(docs, touched);
        assert.deepStrictEqual(r.revert, []);
        assert.deepStrictEqual(r.skippedDirty, []);
    });

    test('全部 dirty なら 1 つも読み直さない', () => {
        const docs = [{ rel: 'a.ts', isDirty: true }, { rel: 'c.ts', isDirty: true }];
        const r = selectDocumentsToRevert(docs, touched);
        assert.strictEqual(r.revert.length, 0);
        assert.strictEqual(r.skippedDirty.length, 2);
    });
});

describe('selectDirtyPaths（反映から外すパス。設計方針 §2.1.1 の B）', () => {
    test('未保存の編集がある文書のパスだけ集める。ワークスペース外・保存済みは含めない', () => {
        const docs = [
            { rel: 'a.ts', isDirty: true },
            { rel: 'b.ts', isDirty: false },
            { rel: undefined, isDirty: true },
            { rel: 'dir/c.ts', isDirty: true },
        ];
        assert.deepStrictEqual([...selectDirtyPaths(docs)].sort(), ['a.ts', 'dir/c.ts']);
    });

    test('開いている文書が無ければ空', () => {
        assert.strictEqual(selectDirtyPaths([]).size, 0);
    });
});
