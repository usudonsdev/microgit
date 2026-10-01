#!/usr/bin/env node
/**
 * この環境で、カーネル版を実際に起動できるか（できなければ Node 版に切り替わるか）を確かめる（#14、補足 S-3）。
 *
 * 使い方: npm run compile && node scripts/test/native-fallback.mjs [--expect kernel|fallback] [--reason <正規表現>] [--accel auto|whpx|tcg]
 *   拡張機能と同じ planLaunch（src/kernel/launchers.ts）と BackendSelector を、リポジトリのビルド結果
 *   （guest/out/<arch>/init、guest/out/x86_64/Image など）で動かす。
 *   --expect を付けると、結果が違えば exit 1。--reason は、Node 版に切り替わった理由がこの正規表現に合うかも確かめる。
 *
 * 期待する結果:
 *   WSL2 など、非特権のユーザー名前空間が使える Linux              → kernel（VM なし）
 *   GitHub Actions の Ubuntu 24.04（AppArmor で止められている）    → fallback（理由に uid_map が出る）
 *   Windows（guest/.cache/qemu-win に QEMU があれば）              → kernel（QEMU）
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { planLaunch, findInPath } = require(path.join(ROOT, 'out', 'kernel', 'launchers.js'));
const { BackendSelector } = require(path.join(ROOT, 'out', 'kernel', 'backendSelector.js'));

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const expect = arg('--expect');
const reasonPattern = arg('--reason');
// Windows の QEMU の動かし方（設定 microgit.kernel.accel と同じ）。whpx だけ・tcg だけを試して、どちらが使えるかを確かめる
const accel = arg('--accel');
const exists = (p) => fs.existsSync(p);
const plan = planLaunch({
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    extensionPath: ROOT,
    env: process.env,
    settings: accel ? { accel } : {},
    logDir: os.tmpdir(),
    exists,
    which: (cmd) => findInPath(cmd, process.env, process.platform, exists),
});
console.log('plan:', plan.ok ? `${plan.kind} — ${plan.spec.description}` : `unavailable — ${plan.reason}`);

const tryRunGit = (cwd, args) => { try { return execFileSync('git', args, { cwd, encoding: 'utf8' }); } catch { return undefined; } };
const selector = new BackendSelector({
    setting: 'auto',
    plan: () => plan,
    tryRunGit,
    log: (m, l) => console.log(`[${l ?? 'INFO'}] ${m}`),
});
const started = Date.now();
const kernel = await selector.ensureKernel();
const result = kernel ? 'kernel' : 'fallback';
console.log(`result: ${result} (${Date.now() - started} ms)${kernel ? '' : ` reason: ${selector.failureReason}`}`);
if (kernel) {
    console.log((await kernel.describe()).split('\n').map((l) => `  ${l}`).join('\n'));
}
await selector.dispose();

if (expect && expect !== result) {
    console.error(`期待は ${expect} だったが ${result} になった`);
    process.exit(1);
}
if (reasonPattern && !new RegExp(reasonPattern).test(selector.failureReason ?? '')) {
    console.error(`切り替わった理由が /${reasonPattern}/ に合わない: ${selector.failureReason}`);
    process.exit(1);
}
