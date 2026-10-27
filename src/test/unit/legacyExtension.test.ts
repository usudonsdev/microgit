/**
 * 旧 MicroGit との共存対策（legacyExtension.ts の evaluateLegacyConflict）を確かめる単体テスト。VS Code を使わない。
 * 観点：旧拡張が有効（lookup が見つける）なら記録を止めて警告 / 無ければ止めない / 探す ID が usudonsdev.microgit /
 * 旧拡張の ID が自分自身（package.json の publisher.name）と一致しない（一致すると自分自身を衝突とみなして一生動かない）。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';
import { LEGACY_CONFLICT_WARNING, LEGACY_EXTENSION_ID, evaluateLegacyConflict } from '../../legacyExtension';

describe('旧 MicroGit との共存対策', () => {
    test('旧拡張が有効なら、記録を止めて警告を返す（まだ activate されていなくても）', () => {
        for (const found of [{ isActive: true }, { isActive: false }]) {
            const result = evaluateLegacyConflict(() => found);
            assert.deepStrictEqual(result, { blocked: true, warning: LEGACY_CONFLICT_WARNING });
        }
        assert.ok(LEGACY_CONFLICT_WARNING.includes('旧 MicroGit が有効です'));
        assert.ok(LEGACY_CONFLICT_WARNING.includes('無効化またはアンインストール'));
        assert.ok(LEGACY_CONFLICT_WARNING.includes('再読み込み'));
    });

    test('旧拡張が無い（未インストール、または無効化済み）なら、止めない', () => {
        assert.deepStrictEqual(evaluateLegacyConflict(() => undefined), { blocked: false });
    });

    test('探す ID は usudonsdev.microgit だけ', () => {
        const asked: string[] = [];
        evaluateLegacyConflict((id) => { asked.push(id); return undefined; });
        assert.deepStrictEqual(asked, ['usudonsdev.microgit']);
        assert.strictEqual(LEGACY_EXTENSION_ID, 'usudonsdev.microgit');
    });

    test('旧拡張の ID は、この拡張自身の ID（publisher.name）と違う', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
        assert.notStrictEqual(`${pkg.publisher}.${pkg.name}`, LEGACY_EXTENSION_ID);
        assert.strictEqual(`${pkg.publisher}.${pkg.name}`, 'usudonsdev.vereve');
    });
});
