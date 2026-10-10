import * as assert from 'assert';
import { describe, test } from 'node:test';
import { saveStatusMessage } from '../../saveStatus';

const hash = 'abc1234def5678';

describe('保存のたびのステータスバーの一時メッセージ（#68）', () => {
    test('設定が false（既定）なら、記録でも同一変更でも出さない', () => {
        assert.strictEqual(saveStatusMessage(false, { kind: 'created', commit: hash, tag: 'mb-1' }), undefined);
        assert.strictEqual(saveStatusMessage(false, { kind: 'rewound', commit: hash }), undefined);
    });

    test('設定が true なら、これまでどおりの文言を返す', () => {
        assert.strictEqual(
            saveStatusMessage(true, { kind: 'created', commit: hash, tag: 'mb-1' }),
            '[MicroGit] 記録 abc1234 · mb-1'
        );
        assert.strictEqual(
            saveStatusMessage(true, { kind: 'rewound', commit: hash }),
            '[MicroGit] 同一変更のため HEAD のみ復帰 abc1234'
        );
    });
});
