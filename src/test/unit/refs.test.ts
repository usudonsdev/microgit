/**
 * HEAD を指すタグを求める関数（fastGit/refs.ts の firstTagAtHead と resolveGitDir）を、実際の git tag --points-at HEAD と比べる単体テスト（#37）。
 * 一時的な Git リポジトリで、タグが無い・複数ある・HEAD が進んだ・packed-refs に移した・loose が packed を上書きした・
 * detached HEAD の各場面で、Git と同じ答えになるかを確かめる。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る。git の実行ファイルが要る）。
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { firstTagAtHead, resolveGitDir } from '../../fastGit/refs';

describe('HEAD を指すタグ（git tag --points-at HEAD と同じ、#37）', () => {
    test('タグなし・複数・HEAD が進む・packed-refs・loose が packed を上書き・detached で、Git と同じ答え', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-refs-'));
        // 一時リポジトリでコミットできるように、作者を環境変数で与える。
        const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
        // 一時リポジトリに対して git を -C で呼ぶ（出力は trim する）。
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }).trim();
        try {
            git('init', '-q', '-b', 'micro-history');
            // 比べる相手：git tag --points-at HEAD の答えの最初の 1 つ（mb-* に限る。名前の順）。
            const viaGit = () => git('tag', '--points-at', 'HEAD', '-l', 'mb-*').split('\n').filter(Boolean)[0];
            // firstTagAtHead の答えが、viaGit と同じかを確かめる。
            const check = (label: string) => assert.strictEqual(firstTagAtHead(resolveGitDir(dir)), viaGit(), label);

            fs.writeFileSync(path.join(dir, 'a'), '1');
            git('add', 'a');
            git('commit', '-qm', '1');
            check('タグなし');
            git('tag', 'mb-2');
            git('tag', 'mb-10');
            git('tag', 'other');
            check('同じコミットに mb-2・mb-10・other（名前の順で mb-10）');
            fs.writeFileSync(path.join(dir, 'a'), '2');
            git('add', 'a');
            git('commit', '-qm', '2');
            check('HEAD が進んでタグから外れた');
            git('tag', 'mb-3');
            git('pack-refs', '--all');
            check('packed-refs に移ったタグ');
            git('tag', '-f', 'mb-3', 'HEAD~1');
            check('loose のタグが packed を上書き');
            git('checkout', '-q', '--detach', 'HEAD~1');
            check('detached HEAD');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
