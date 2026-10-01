import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { ensureExecutable, makeExecutable } from '../../kernel/executable';

// Windows には POSIX の実行ビットが無い（拡張機能も Windows では呼ばない）
const posix = process.platform !== 'win32';

describe('同梱の実行ファイルの実行ビット（#19）', () => {
    test('実行ビットが無ければ付け、あれば何もしない', { skip: !posix && 'POSIX だけ' }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-exec-'));
        try {
            const file = path.join(dir, 'microgit-agent');
            fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
            assert.strictEqual(makeExecutable(file), true);
            assert.strictEqual(fs.statSync(file).mode & 0o777, 0o755);
            assert.strictEqual(makeExecutable(file), false);

            // 一部だけ付いている（所有者だけ）なら、残りも付ける
            fs.chmodSync(file, 0o744);
            assert.strictEqual(makeExecutable(file), true);
            assert.strictEqual(fs.statSync(file).mode & 0o777, 0o755);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('付けられなければ理由を返す（無いファイル）', () => {
        const logs: string[] = [];
        const reason = ensureExecutable(path.join(os.tmpdir(), 'microgit-no-such-file'), (m) => logs.push(m));
        assert.match(reason ?? '', /ENOENT/);
        assert.deepStrictEqual(logs, []);
    });

    test('付けたときだけ記録する', { skip: !posix && 'POSIX だけ' }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-exec-'));
        try {
            const file = path.join(dir, 'microgit-vm');
            fs.writeFileSync(file, '', { mode: 0o600 });
            const logs: string[] = [];
            assert.strictEqual(ensureExecutable(file, (m) => logs.push(m)), undefined);
            assert.strictEqual(ensureExecutable(file, (m) => logs.push(m)), undefined);
            assert.strictEqual(logs.length, 1);
            assert.match(logs[0], /実行ビットを付けた/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
