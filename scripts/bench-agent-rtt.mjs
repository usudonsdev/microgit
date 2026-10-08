// VS Code の外で、agent との commit の往復を測る（#61 の切り分け。計測用ブランチだけ）。
//
// 使い方: npm run compile && node scripts/bench-agent-rtt.mjs (--agent <agent のパス> | --plan <拡張機能のフォルダ>) [--n 300]
//   --agent  Linux で `unshare -Urm <agent>` と話す（VM なし）
//   --plan   拡張機能と同じ起動計画（src/kernel/launchers.ts の planLaunch）で起動する。Windows なら同梱の QEMU と
//            名前付きパイプ。<拡張機能のフォルダ> は VSIX を展開した extension/ など（resources/kernel を含むもの）
//
// 本物の AgentConnection（out/kernel/agentConnection.js）を使い、保存のベンチと同じくらいの小さいファイル（約 250 バイト）を、
// 親の層の上に 1 枚ずつ積む（深さ 30 ごとに reset）。最後の 100 回の中央値を出す。
// 往復 = send（書き出しまで）+ wire（書き出し〜応答の行を受け取るまで − guest）+ guest + resume（受け取り〜処理に戻るまで）
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { AgentConnection, requestTiming } = require(path.join(ROOT, 'out/kernel/agentConnection.js'));
const { planLaunch, findInPath } = require(path.join(ROOT, 'out/kernel/launchers.js'));

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const N = Number(arg('--n') ?? 300);

let spec;
if (arg('--agent')) {
    spec = { command: 'unshare', args: ['-Urm', arg('--agent')], description: 'unshare' };
} else if (arg('--plan')) {
    const exists = (p) => fs.existsSync(p);
    const plan = planLaunch({
        platform: process.platform, arch: process.arch, osRelease: os.release(), extensionPath: path.resolve(arg('--plan')),
        env: process.env, settings: {}, logDir: os.tmpdir(), exists, which: (c) => findInPath(c, process.env, process.platform, exists),
    });
    if (!plan.ok) { console.error(`起動の計画が立たない: ${plan.reason}`); process.exit(2); }
    spec = plan.spec;
} else {
    console.error('usage: bench-agent-rtt.mjs (--agent <path> | --plan <extension folder>) [--n 300]');
    process.exit(2);
}

const conn = new AgentConnection(spec, 60_000);
const ready = await conn.waitReady(60_000);
console.log(`launch: ${spec.description}  agent=${ready.agent} kernel=${ready.kernel}`);

const rows = [];
let parent = '';
for (let i = 0; i < N; i++) {
    const layer = `c${i}`;
    const body = `// file${i % 20}.ts\n${'x'.repeat(200)}\n// save ${i}\n`;
    const op = ['writeb64', `bench/dir${i % 4}/file${i % 20}.ts`, Buffer.from(body).toString('base64'), '644'];
    const t0 = performance.now();
    const res = await conn.call({ op: 'commit', layer, parent, ops: [op] });
    const t1 = performance.now();
    const tm = requestTiming(res);
    const guest = res.elapsedUs / 1000;
    rows.push({ rt: t1 - t0, guest, send: tm.sentAt - t0, wire: tm.arrivedAt - tm.sentAt - guest, resume: t1 - tm.arrivedAt });
    parent = layer;
    if (i % 30 === 29) { await conn.call({ op: 'reset' }); parent = ''; }
}
await conn.dispose();

const last = rows.slice(-100);
const med = (k) => { const s = last.map((r) => r[k]).sort((a, b) => a - b); return s[Math.floor(s.length / 2)].toFixed(3); };
const p95 = (k) => { const s = last.map((r) => r[k]).sort((a, b) => a - b); return s[Math.floor((s.length - 1) * 0.95)].toFixed(3); };
console.log(`n=${last.length} p50 ms: roundTrip ${med('rt')}  guest ${med('guest')}  send ${med('send')}  wire ${med('wire')} (p95 ${p95('wire')})  resume ${med('resume')}`);
