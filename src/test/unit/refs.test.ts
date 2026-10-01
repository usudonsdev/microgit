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
        const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
        const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }).trim();
        try {
            git('init', '-q', '-b', 'micro-history');
            const viaGit = () => git('tag', '--points-at', 'HEAD', '-l', 'mb-*').split('\n').filter(Boolean)[0];
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
