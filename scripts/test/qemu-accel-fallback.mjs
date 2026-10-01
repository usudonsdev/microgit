#!/usr/bin/env node
/**
 * QEMU の -accel を複数並べたとき、先頭のアクセラレータが使えなければ次（TCG）で起動するかを確かめる（#18）。
 *
 * 使い方: npm run compile && node scripts/test/qemu-accel-fallback.mjs     （Windows。guest/.cache/qemu-win と guest/out/x86_64/Image を使う）
 *
 * 拡張機能は -accel whpx,kernel-irqchip=off -accel tcg で起動し、WHPX（Windows ハイパーバイザー プラットフォーム）が
 * 使えない PC では TCG に切り替わることを期待している。しかし GitHub の Windows のランナーでも WHPX が使えてしまい、
 * 「使えない場合」を直接は試せない。そこで、Windows には存在しない KVM を先頭に置いた -accel kvm -accel tcg で、
 * QEMU の「前から順に試す」仕組みそのものを確かめる。
 * 確かめられるのは「知らないアクセラレータ」の分岐で、「WHPX の初期化に失敗する」分岐は同じ繰り返しの別の枝（直接は試していない）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AgentConnection } = require(path.join(ROOT, 'out', 'kernel', 'agentConnection.js'));
const { qemuArgs } = require(path.join(ROOT, 'out', 'kernel', 'launchers.js'));

const qemu = path.join(ROOT, 'guest', '.cache', 'qemu-win', 'qemu-system-x86_64.exe');
const image = path.join(ROOT, 'guest', 'out', 'x86_64', 'Image');
for (const p of [qemu, image]) {
    if (!fs.existsSync(p)) { console.error(`無い: ${p}`); process.exit(2); }
}
const pipe = `microgit-accel-fallback-${process.pid}`;
const base = qemuArgs(image, path.join(os.tmpdir(), 'microgit-accel-fallback-console.log'), { accel: 'tcg' }, { pipe });
const i = base.indexOf('-accel');
const args = [...base.slice(0, i), '-accel', 'kvm', '-accel', 'tcg', ...base.slice(i + 2)];

const agent = new AgentConnection({ command: qemu, args, namedPipe: `\\\\.\\pipe\\${pipe}`, description: 'kvm → tcg' }, 60_000);
const t0 = Date.now();
let ok = false;
try {
    const r = await agent.waitReady(60_000);
    await agent.call({ op: 'commit', layer: 'probe', parent: '', ops: [['write', 'a.txt', 'ok']] });
    console.log(`started with the next accelerator: kernel=${r.kernel} in ${Date.now() - t0} ms, commit ok`);
    ok = true;
} catch (e) {
    console.error(`failed: ${e.message}`);
}
const stderr = agent.lastStderr;
console.log(`QEMU stderr:\n${stderr.split(/\r?\n/).map((l) => `  ${l}`).join('\n')}`);
await agent.dispose();
if (!ok || !/falling back to tcg/.test(stderr)) {
    console.error('先頭のアクセラレータを飛ばして TCG で起動する、という動きを確かめられなかった');
    process.exit(1);
}
console.log('OK: 先頭のアクセラレータが使えないとき、QEMU は TCG で起動した');
