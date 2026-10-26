/**
 * 保存のたびのステータスバーの一時メッセージ（saveStatus.ts の saveStatusMessage）を確かめる単体テスト（#68）。VS Code を使わない。
 * 観点：設定が false（既定）なら、記録でも同一変更でも何も出さない。true なら、記録（created）と
 * 同一変更のため HEAD のみ復帰（rewound）の文言を、これまでどおりに返す。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import { describe, test } from 'node:test';
import { saveStatusMessage } from '../../saveStatus';

/** テスト用のコミットのハッシュ。表示には先頭 7 文字（abc1234）だけが使われる。 */
const hash = 'abc1234def5678';

describe('保存のたびのステータスバーの一時メッセージ（#68）', () => {
    test('設定が false（既定）なら、記録でも同一変更でも出さない', () => {
        assert.strictEqual(saveStatusMessage(false, { kind: 'created', commit: hash, tag: 'mb-1' }), undefined);
        assert.strictEqual(saveStatusMessage(false, { kind: 'rewound', commit: hash }), undefined);
    });

    test('設定が true なら、これまでどおりの文言を返す', () => {
        assert.strictEqual(
            saveStatusMessage(true, { kind: 'created', commit: hash, tag: 'mb-1' }),
            '[verEve] 記録 abc1234 · mb-1'
        );
        assert.strictEqual(
            saveStatusMessage(true, { kind: 'rewound', commit: hash }),
            '[verEve] 同一変更のため HEAD のみ復帰 abc1234'
        );
    });
});
