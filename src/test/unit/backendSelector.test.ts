import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { AgentUnavailableError } from '../../kernel/agentConnection';
import { BackendSelector, BackendSetting, parseBackendSetting } from '../../kernel/backendSelector';
import { LaunchPlan } from '../../kernel/launchers';

/**
 * 命令の形 v1 を話す偽の agent（Node のスクリプト）。mount はしないが、起動・ready・probe・reset・
 * poweroff の流れと、版の食い違い・起動直後の終了・途中で落ちる場合を再現できる。
 *   FAKE_MODE=ok        普通に答える
 *   FAKE_MODE=v2        protocol 2 を名乗る
 *   FAKE_MODE=exit      すぐに終わる（unshare が uid_map で失敗したときの形。stderr に理由を出す）
 *   FAKE_MODE=noprobe   commit に EPERM で答える（mount できない環境の形）
 */
const FAKE_AGENT = `
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'exit') { process.stderr.write('unshare: write failed /proc/self/uid_map: Operation not permitted\\n'); process.exit(1); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'ready', ok: true, protocol: mode === 'v2' ? 2 : 1, agent: 'fake', kernel: 'fake' });
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.op === 'commit' && mode === 'noprobe') { out({ id: req.id, ok: false, error: 'mount overlay: operation not permitted', code: 'EPERM' }); return; }
  if (req.op === 'commit') { out({ id: req.id, ok: true, layer: req.layer, depth: 1 }); return; }
  if (req.op === 'stats') { out({ id: req.id, ok: true, layers: 0 }); return; }
  out({ id: req.id, ok: true });
  if (req.op === 'poweroff') { process.exit(0); }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-fake-agent-'));
const script = path.join(dir, 'fake-agent.js');
fs.writeFileSync(script, FAKE_AGENT);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakePlan(mode: string): LaunchPlan {
    return {
        ok: true,
        kind: 'linux-native',
        spec: { command: process.execPath, args: [script], env: { ...process.env, FAKE_MODE: mode }, description: `fake agent (${mode})` },
        notes: [],
    };
}

function selector(setting: BackendSetting, plan: () => LaunchPlan) {
    const logs: string[] = [];
    const notes: string[] = [];
    let planned = 0;
    const s = new BackendSelector({
        setting,
        plan: () => { planned++; return plan(); },
        tryRunGit: () => undefined,
        log: (m) => logs.push(m),
        notify: (m) => notes.push(m),
        kernelOptions: { bootTimeoutMs: 10_000, requestTimeoutMs: 10_000 },
    });
    return { s, logs, notes, planned: () => planned };
}

describe('設定の読み方', () => {
    test('auto / kernel / nodejs。ほかは auto', () => {
        assert.strictEqual(parseBackendSetting('kernel'), 'kernel');
        assert.strictEqual(parseBackendSetting('nodejs'), 'nodejs');
        for (const v of [undefined, '', 'KERNEL', 1]) { assert.strictEqual(parseBackendSetting(v), 'auto'); }
    });
});

describe('Backend Selector', () => {
    test('nodejs ではカーネル版を起動しない（起動の計画も立てない）', async () => {
        const t = selector('nodejs', () => fakePlan('ok'));
        assert.strictEqual(await t.s.ensureKernel(), undefined);
        assert.strictEqual(t.planned(), 0);
        assert.ok(!t.s.wantsKernel);
    });

    test('auto で使えれば起動し、2 回目は同じものを返す', async () => {
        const t = selector('auto', () => fakePlan('ok'));
        const k1 = await t.s.ensureKernel();
        const k2 = await t.s.ensureKernel();
        assert.ok(k1 && k1 === k2);
        assert.strictEqual(t.s.readyKernel(), k1);
        assert.match(await t.s.describe(), /backend=kernel/);
        await t.s.dispose();
    });

    test('同時に何度呼んでも、起動は 1 回', async () => {
        const t = selector('auto', () => fakePlan('ok'));
        const [a, b, c] = await Promise.all([t.s.ensureKernel(), t.s.ensureKernel(), t.s.ensureKernel()]);
        assert.ok(a && a === b && b === c);
        assert.strictEqual(t.planned(), 1);
        await t.s.dispose();
    });

    test('起動の計画が立たなければ Node 版。auto では利用者に知らせない', async () => {
        const t = selector('auto', () => ({ ok: false, reason: 'QEMU is not bundled' }));
        assert.strictEqual(await t.s.ensureKernel(), undefined);
        assert.strictEqual(t.s.failureReason, 'QEMU is not bundled');
        assert.deepStrictEqual(t.notes, []);
        assert.ok(!t.s.wantsKernel);
    });

    test('kernel では、使えなかった理由を利用者に知らせる', async () => {
        const t = selector('kernel', () => ({ ok: false, reason: 'kernel 5.10 is older than 5.11' }));
        await t.s.ensureKernel();
        assert.strictEqual(t.notes.length, 1);
        assert.match(t.notes[0], /5\.10/);
    });

    test('agent がすぐ終わったら（非特権の名前空間が止められている環境、補足 S-3）Node 版。理由に stderr が入る', async () => {
        const t = selector('auto', () => fakePlan('exit'));
        assert.strictEqual(await t.s.ensureKernel(), undefined);
        assert.match(t.s.failureReason ?? '', /uid_map/);
    });

    test('mount できなければ（probe の commit が失敗）Node 版', async () => {
        const t = selector('auto', () => fakePlan('noprobe'));
        assert.strictEqual(await t.s.ensureKernel(), undefined);
        assert.match(t.s.failureReason ?? '', /EPERM/);
    });

    test('命令の形の版が違えば使わない', async () => {
        const t = selector('auto', () => fakePlan('v2'));
        assert.strictEqual(await t.s.ensureKernel(), undefined);
        assert.match(t.s.failureReason ?? '', /protocol v2/);
    });

    test('動いていた agent が落ちたら、次の操作で起動し直す（2 回まで）', async () => {
        const t = selector('auto', () => fakePlan('ok'));
        for (let i = 0; i < 2; i++) {
            const k = await t.s.ensureKernel();
            assert.ok(k);
            t.s.reportError(new AgentUnavailableError('agent process exited'));
            // kill した agent の exit が届くのを待つ
            await new Promise((r) => setTimeout(r, 300));
            assert.strictEqual(t.s.readyKernel(), undefined);
        }
        const k3 = await t.s.ensureKernel();
        assert.ok(k3, '2 回目の起動し直しまでは使える');
        t.s.reportError(new AgentUnavailableError('agent process exited'));
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(await t.s.ensureKernel(), undefined, '3 回目は諦める');
        assert.match(t.s.failureReason ?? '', /too many/);
    });
});
