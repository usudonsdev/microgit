/**
 * LayerFeeder（kernel/layerFeeder.ts）のフレーム分割を確かめる単体テスト。実際の agent は使わず、送った要求を記録する偽の agent で見る。
 * 観点：1 行の上限（maxFrameBytes）がある通り道では、中身を stage に分けて commit は writeupload だけを送る。
 * 上限が無ければ従来どおり writeb64 を 1 回で送る。ファイル数が多く commit のメタデータも上限を超えるときは stageOp に分ける。
 * 一時的な Git リポジトリを作って使うので、git の実行ファイルが要る。
 * 実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { AgentConnection } from '../../kernel/agentConnection';
import { LayerFeeder } from '../../kernel/layerFeeder';

/** agent に送る要求（JSON の 1 行）。op で種類が分かる。 */
type Request = Record<string, unknown>;

/** 100 KiB のファイルを 1 つ含む一時リポジトリを作り、その場所と HEAD のハッシュを返す。 */
function repositoryWithLargeFile(): { root: string; head: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-feeder-test-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(100 * 1024, 0x61));
    git('add', 'large.bin');
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'large'], { cwd: root });
    return { root, head: git('rev-parse', 'HEAD') };
}

/** 700 個の名前の長いファイルを含む一時リポジトリを作り、その場所と HEAD のハッシュを返す。commit のメタデータが 1 行の上限を超える形。 */
function repositoryWithManyFiles(): { root: string; head: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-feeder-many-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    for (let i = 0; i < 700; i++) {
        fs.writeFileSync(path.join(root, `file-${String(i).padStart(4, '0')}-${'x'.repeat(48)}.txt`), String(i));
    }
    git('add', '.');
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'many'], { cwd: root });
    return { root, head: git('rev-parse', 'HEAD') };
}

/** 送られた要求を requests に記録し、commit には成功を返す偽の AgentConnection。maxFrameBytes で 1 行の上限の有無を決める（undefined なら上限なし）。 */
function fakeAgent(maxFrameBytes: number | undefined, requests: Request[]): AgentConnection {
    return {
        spec: { command: 'fake', args: [], description: 'fake', maxFrameBytes },
        call: async (request: Request) => {
            requests.push(request);
            return request.op === 'commit' ? { ok: true, depth: 1 } : { ok: true };
        },
    } as unknown as AgentConnection;
}

/** git を呼び、失敗したら undefined を返す（stderr は捨てる）。LayerFeeder に渡す。 */
const tryRunGit = (cwd: string, args: string[]): string | undefined => {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return undefined;
    }
};

describe('LayerFeeder のフレーム分割', () => {
    test('上限がある通り道では stage に分け、commit は writeupload だけを送る', async () => {
        const { root, head } = repositoryWithLargeFile();
        try {
            const requests: Request[] = [];
            const feeder = new LayerFeeder(fakeAgent(48 * 1024, requests), tryRunGit);
            await feeder.ensure(root, head);

            const stages = requests.filter((r) => r.op === 'stage');
            assert.ok(stages.length > 1);
            assert.ok(stages.every((r) => JSON.stringify(r).length < 48 * 1024));
            const commit = requests.find((r) => r.op === 'commit')!;
            const ops = commit.ops as string[][];
            assert.strictEqual(ops[0][0], 'writeupload');
            assert.ok(!JSON.stringify(commit).includes('writeb64'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('上限が無い通り道は従来どおり writeb64 を1回で送る', async () => {
        const { root, head } = repositoryWithLargeFile();
        try {
            const requests: Request[] = [];
            const feeder = new LayerFeeder(fakeAgent(undefined, requests), tryRunGit);
            await feeder.ensure(root, head);

            assert.strictEqual(requests.filter((r) => r.op === 'stage').length, 0);
            const commit = requests.find((r) => r.op === 'commit')!;
            assert.strictEqual((commit.ops as string[][])[0][0], 'writeb64');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('ファイル数が多くcommitのメタデータも上限を超える場合はstageOpに分ける', async () => {
        const { root, head } = repositoryWithManyFiles();
        try {
            const requests: Request[] = [];
            const feeder = new LayerFeeder(fakeAgent(48 * 1024, requests), tryRunGit);
            await feeder.ensure(root, head);

            const stagedOps = requests.filter((r) => r.op === 'stageOp');
            assert.strictEqual(stagedOps.length, 700);
            assert.ok(stagedOps.every((r) => JSON.stringify(r).length < 48 * 1024));
            const commit = requests.find((r) => r.op === 'commit')!;
            assert.strictEqual(typeof commit.opsUpload, 'string');
            assert.strictEqual(commit.ops, undefined);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
