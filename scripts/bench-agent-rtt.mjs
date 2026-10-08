// VS Code の外で、agent との commit の往復を測る（#61 の切り分け）。
// 使い方（Linux）: npm run compile && node scripts/bench-agent-rtt.mjs "$PWD" <agent のパス> [回数]
// 本物の AgentConnection（out/kernel/agentConnection.js）で `unshare -Urm <agent>` と話し、
// 保存のベンチと同じくらいの小さいファイル（約 250 バイト）を、親の層の上に 1 枚ずつ積む。
import { createRequire } from 'module';
import path from 'path';

const [worktree, agent, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 200);
const require = createRequire(import.meta.url);
const { AgentConnection } = require(path.join(worktree, 'out/kernel/agentConnection.js'));

const conn = new AgentConnection({ command: 'unshare', args: ['-Urm', agent], description: 'rtt' }, 60_000);
await conn.waitReady(10_000);

const rows = [];
let parent = '';
for (let i = 0; i < N; i++) {
    const layer = `c${i}`;
    const body = `// file${i % 20}.ts\n${'x'.repeat(200)}\n// save ${i}\n`;
    const op = ['writeb64', `bench/dir${i % 4}/file${i % 20}.ts`, Buffer.from(body).toString('base64'), '644'];
    const t0 = performance.now();
    const res = await conn.call({ op: 'commit', layer, parent, ops: [op] });
    const rt = performance.now() - t0;
    rows.push({ rt, guest: res.elapsedUs / 1000 });
    parent = layer;
    if (i % 30 === 29) { await conn.call({ op: 'reset' }); parent = ''; } // 層の深さ 32 で写しに切り替えるのに合わせる
}
await conn.dispose();

const last = rows.slice(-100);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * 0.95)]; };
const tr = last.map((r) => r.rt - r.guest);
console.log(`n=${last.length}  roundTrip p50 ${med(last.map((r) => r.rt)).toFixed(3)}  guest p50 ${med(last.map((r) => r.guest)).toFixed(3)}  transport p50 ${med(tr).toFixed(3)} p95 ${p95(tr).toFixed(3)} ms`);
