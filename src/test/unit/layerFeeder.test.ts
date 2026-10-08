import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { AgentConnection } from '../../kernel/agentConnection';
import { LayerFeeder } from '../../kernel/layerFeeder';

type Request = Record<string, unknown>;

function repositoryWithLargeFile(): { root: string; head: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-feeder-test-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(100 * 1024, 0x61));
    git('add', 'large.bin');
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'large'], { cwd: root });
    return { root, head: git('rev-parse', 'HEAD') };
}

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

function fakeAgent(maxFrameBytes: number | undefined, requests: Request[]): AgentConnection {
    return {
        spec: { command: 'fake', args: [], description: 'fake', maxFrameBytes },
        call: async (request: Request) => {
            requests.push(request);
            return request.op === 'commit' ? { ok: true, depth: 1 } : { ok: true };
        },
    } as unknown as AgentConnection;
}

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

describe('LayerFeeder の層づくりの内訳（#61）', () => {
    const timedAgent = (res: Record<string, unknown>): AgentConnection => ({
        spec: { command: 'fake', args: [], description: 'fake' },
        call: async (request: Request) => (request.op === 'commit' ? { ok: true, depth: 1, ...res } : { ok: true }),
    } as unknown as AgentConnection);

    test('通信は往復から agent の中の時間を引いたもの。agent の段階の残りは guest.other', async () => {
        const { root, head } = repositoryWithLargeFile();
        try {
            const feeder = new LayerFeeder(timedAgent({ elapsedUs: 5000, phasesUs: { mount: 1500, ops: 2000, unmount: 1000 } }), tryRunGit);
            const p = (await feeder.ensure(root, head)).phases!;
            assert.strictEqual(p.guest, 5);
            assert.strictEqual(p['guest.mount'], 1.5);
            assert.strictEqual(p['guest.ops'], 2);
            assert.strictEqual(p['guest.unmount'], 1);
            assert.strictEqual(p['guest.other'], 0.5);
            assert.strictEqual(p.transport, p.roundTrip - p.guest);
            assert.ok(p.prepare >= 0 && p.stage >= 0 && p.roundTrip >= 0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('elapsedUs を返さない agent では、ホスト側の段階だけを残す', async () => {
        const { root, head } = repositoryWithLargeFile();
        try {
            const feeder = new LayerFeeder(timedAgent({}), tryRunGit);
            const p = (await feeder.ensure(root, head)).phases!;
            assert.deepStrictEqual(Object.keys(p).sort(), ['prepare', 'roundTrip', 'stage']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
