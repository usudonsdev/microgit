/**
 * 旧設定 microgit.* から vereve.* への引き継ぎの計画（settingsMigration.ts）を確かめる単体テスト。VS Code を使わない。
 * 観点：旧だけにあるものはコピー / 新に既にあれば上書きしない / 範囲ごとに別々 / 旧が無ければ何もしない /
 * 扱う範囲に含まれないものは書かない / 引き継ぎ対象が package.json の設定と一致 / 通知の文面。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, test } from 'node:test';
import { MIGRATED_SETTING_NAMES, planSettingsMigration, settingsMigrationMessage } from '../../settingsMigration';

describe('旧設定 microgit.* から vereve.* への引き継ぎ', () => {
    test('旧キーだけに値があれば、同じ範囲の新キーへそのままコピーする', () => {
        const writes = planSettingsMigration(
            ['global', 'workspace'],
            { overlayBackend: { global: 'nodejs' }, 'kernel.memoryMb': { workspace: 512 }, showSaveStatus: { global: true } },
            {},
        );
        assert.deepStrictEqual(writes, [
            { key: 'vereve.showSaveStatus', scope: 'global', value: true },
            { key: 'vereve.overlayBackend', scope: 'global', value: 'nodejs' },
            { key: 'vereve.kernel.memoryMb', scope: 'workspace', value: 512 },
        ]);
    });

    test('新キーに既に値があれば上書きしない（false や 空文字 でも「ある」とみなす）', () => {
        const writes = planSettingsMigration(
            ['global'],
            { showSaveStatus: { global: true }, 'kernel.qemuPath': { global: 'C:/qemu.exe' }, durability: { global: 'process' } },
            { showSaveStatus: { global: false }, 'kernel.qemuPath': { global: '' } },
        );
        assert.deepStrictEqual(writes, [{ key: 'vereve.durability', scope: 'global', value: 'process' }]);
    });

    test('範囲ごとに判断する（グローバルの新キーがあっても、ワークスペースの旧キーは引き継ぐ）', () => {
        const writes = planSettingsMigration(
            ['global', 'workspace'],
            { durability: { global: 'process', workspace: 'power' } },
            { durability: { global: 'power' } },
        );
        assert.deepStrictEqual(writes, [{ key: 'vereve.durability', scope: 'workspace', value: 'power' }]);
    });

    test('扱う範囲に入っていないもの（ワークスペースが開いていないとき）は書かない', () => {
        const writes = planSettingsMigration(['global'], { durability: { workspace: 'power' } }, {});
        assert.deepStrictEqual(writes, []);
    });

    test('旧キーが無ければ何も書かない / 引き継ぎ対象に無い名前は無視する', () => {
        assert.deepStrictEqual(planSettingsMigration(['global', 'workspace'], {}, {}), []);
        assert.deepStrictEqual(planSettingsMigration(['global'], { notASetting: { global: 1 } }, {}), []);
    });

    test('引き継ぎ対象は package.json の設定 vereve.* と過不足なく一致する', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
        const declared = Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace(/^vereve\./, '')).sort();
        assert.deepStrictEqual([...MIGRATED_SETTING_NAMES].sort(), declared);
    });

    test('通知は、件数が 0 なら出さず、あれば件数とキーを入れる', () => {
        assert.strictEqual(settingsMigrationMessage([]), undefined);
        const m = settingsMigrationMessage([
            { key: 'vereve.durability', scope: 'global', value: 'process' },
            { key: 'vereve.durability', scope: 'workspace', value: 'power' },
        ])!;
        assert.ok(m.includes('2 件') && m.includes('vereve.durability') && m.includes('verEve'));
    });
});
