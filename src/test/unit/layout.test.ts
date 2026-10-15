/**
 * 生成物の置き場所の移行（layout.ts の migrateLegacyMicrogitLayout と shadowDir・logsDir）を確かめる単体テスト。VS Code を使わない。
 * 観点：古い 3 フォルダ（.microgit_shadow・.microgit_logs・.microgit_overlay）を .microgit/ の下へ丸ごと移し、2 回目は何もしない。
 * 新しい場所に同じ名前のファイルがあれば上書きしない。ぶつからないものだけ移し、残った古いフォルダは消さない。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { logsDir, migrateLegacyMicrogitLayout, shadowDir } from '../../layout';

describe('生成物は .microgit の下にまとめる', () => {
    test('古い 3 フォルダを shadow / logs / overlay へ移す', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-layout-'));
        fs.mkdirSync(path.join(root, '.microgit_shadow'), { recursive: true });
        fs.writeFileSync(path.join(root, '.microgit_shadow', 'keep'), 's');
        fs.mkdirSync(path.join(root, '.microgit_logs'), { recursive: true });
        fs.writeFileSync(path.join(root, '.microgit_logs', 'timeline.log'), 'l');
        fs.mkdirSync(path.join(root, '.microgit_overlay', 'layers'), { recursive: true });
        fs.writeFileSync(path.join(root, '.microgit_overlay', 'layers', 'a'), 'o');

        migrateLegacyMicrogitLayout(root);

        assert.strictEqual(fs.readFileSync(path.join(shadowDir(root), 'keep'), 'utf8'), 's');
        assert.strictEqual(fs.readFileSync(path.join(logsDir(root), 'timeline.log'), 'utf8'), 'l');
        assert.strictEqual(fs.readFileSync(path.join(root, '.microgit', 'overlay', 'layers', 'a'), 'utf8'), 'o');
        assert.ok(!fs.existsSync(path.join(root, '.microgit_shadow')));
        assert.ok(!fs.existsSync(path.join(root, '.microgit_logs')));
        assert.ok(!fs.existsSync(path.join(root, '.microgit_overlay')));
        migrateLegacyMicrogitLayout(root);
        assert.strictEqual(fs.readFileSync(path.join(shadowDir(root), 'keep'), 'utf8'), 's');
    });

    test('新しい場所にある同名のファイルは上書きしない', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-layout-'));
        fs.mkdirSync(path.join(root, '.microgit', 'logs'), { recursive: true });
        fs.writeFileSync(path.join(root, '.microgit', 'logs', 'timeline.log'), 'new');
        fs.mkdirSync(path.join(root, '.microgit_logs'), { recursive: true });
        fs.writeFileSync(path.join(root, '.microgit_logs', 'timeline.log'), 'old');
        fs.writeFileSync(path.join(root, '.microgit_logs', 'extra.txt'), 'e');

        migrateLegacyMicrogitLayout(root);

        assert.strictEqual(fs.readFileSync(path.join(root, '.microgit', 'logs', 'timeline.log'), 'utf8'), 'new');
        assert.strictEqual(fs.readFileSync(path.join(root, '.microgit', 'logs', 'extra.txt'), 'utf8'), 'e');
        assert.ok(!fs.existsSync(path.join(root, '.microgit_logs', 'extra.txt')));
        assert.ok(fs.existsSync(path.join(root, '.microgit_logs', 'timeline.log')));
    });
});
