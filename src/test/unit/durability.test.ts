/**
 * 永続性の水準（durability.ts の power と process）を確かめる単体テスト。VS Code を使わない。
 * 観点：既定と不明な値は power で、Git に fsync の引数を付ける。process では引数を足さない。
 * power の引数を付けても、保存 1 回と同じ Git の手順（add・write-tree・commit-tree・update-ref）が通る。
 * 水準の理由は durability.ts の冒頭に書いてある（#11、docs/adr/0002-durability.md）。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。Git の実行ファイルが要る。
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';
import { durabilityGitArgs, getDurability, setDurability } from '../../durability';

// 各テストの後で水準を既定（power）に戻す。setDurability(undefined) は power になる。
afterEach(() => setDurability(undefined));

test('既定（設定なし・不明な値）は power で、ばらのオブジェクトと ref を fsync する', () => {
    for (const v of [undefined, '', 'fast', 123]) {
        setDurability(v);
        assert.strictEqual(getDurability(), 'power');
        assert.deepStrictEqual(durabilityGitArgs(), ['-c', 'core.fsync=loose-object,reference', '-c', 'core.fsyncMethod=batch']);
    }
});

test('process では Git の既定のまま（引数を足さない）', () => {
    setDurability('process');
    assert.strictEqual(getDurability(), 'process');
    assert.deepStrictEqual(durabilityGitArgs(), []);
});

test('power の引数を付けても、保存と同じ Git の手順（add・write-tree・commit-tree・update-ref）が通る', () => {
    setDurability('power');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-durability-'));
    try {
        const env = {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
        };
        const git = (...args: string[]) => execFileSync('git', [...durabilityGitArgs(), ...args], { cwd: dir, env, encoding: 'utf8' });
        git('init', '-q');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
        git('add', '--', 'a.txt');
        const tree = git('write-tree').trim();
        const commit = git('commit-tree', tree, '-m', 'm').trim();
        git('update-ref', 'refs/heads/micro-history', commit);
        assert.strictEqual(git('rev-parse', 'refs/heads/micro-history').trim(), commit);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
