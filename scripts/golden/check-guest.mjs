#!/usr/bin/env node
/**
 * ゴールデンテストを最小ゲストの agent（guest/agent）で流し、カーネルの期待値と照合する（Issue #10, #15, #17）。
 *
 * 使い方: node scripts/golden/check-guest.mjs [--json <結果の書き出し先>] -- <コマンド> [引数...]
 *   <コマンド> の stdin/stdout が agent の命令の通り道になるものなら何でもよい。
 *     QEMU:      qemu-system-aarch64 ... -chardev stdio,id=proto -device virtserialport,chardev=proto,name=microgit
 *     Mac:       mac/.build/microgit-vm --kernel Image
 *     VM なし:   unshare -Urm guest/out/arm64/init   （Linux。agent を PID 1 以外で起動すると stdin/stdout で答える）
 *
 * Node 実装（check-node.mjs）と違い、既知の食い違いは認めない。ゲストは本物のカーネルなので、一致しなければ失敗。
 * あわせて、起動から ready までの時間と、commit / view の所要時間を出す（#17 の計測項目）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AgentClient } from '../guest/agent-client.mjs';
import { chainOf, parentOf, scenarios, validateScenarios } from './overlayfs-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_DIR = path.join(ROOT, 'test', 'golden', 'overlayfs');
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 120000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
    console.error('usage: check-guest.mjs [--json out.json] -- <command> [args...]');
    process.exit(2);
}
const opts = argv.slice(0, sep);
const [cmd, ...cmdArgs] = argv.slice(sep + 1);
const jsonOut = opts.includes('--json') ? opts[opts.indexOf('--json') + 1] : undefined;

function readGolden(name) {
    const commits = [];
    const text = fs.readFileSync(path.join(GOLDEN_DIR, `${name}.golden`), 'utf8').replace(/\r\n/g, '\n');
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('# ')) { continue; }
        if (line.startsWith('## commit ')) { commits.push([]); continue; }
        commits[commits.length - 1].push(line);
    }
    return commits;
}

function percentile(values, p) {
    if (!values.length) { return 0; }
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** 命令の形の版。agent の hello / ready の protocol と合わなければ止める（docs/agent-protocol.md） */
const PROTOCOL = 1;

/**
 * 層そのもの（凍結した upper）に、OverlayFS の表現がこう入っているはず、という確認（#12）。
 * ゴールデンテストはマージ済みのビューしか比べないので、whiteout と opaque の表現はここで確かめる。
 * キーは「シナリオ名 → コミット番号（1 から）→ inspect に含まれるべき行」。
 */
const UPPER_EXPECT = {
    'delete-file': { 2: ['w\ta.txt'] },
    'delete-dir': { 2: ['w\td'] },
    'recreate-dir': { 2: ['O\td', 'f\td/z.txt'] },
    'rename-dir': { 2: ['w\td', 'd\te'] },
    // whiteout（消したファイル p）の上にディレクトリを作ると、カーネルはそのディレクトリを opaque にする
    'file-to-dir': { 2: ['O\tp', 'f\tp/q.txt'] },
};

async function main() {
    validateScenarios();
    const started = process.hrtime.bigint();
    const agent = new AgentClient(cmd, cmdArgs, { bootTimeoutMs: BOOT_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS });

    const ready = await agent.waitReady();
    const bootMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`ready: kernel=${ready.kernel} agent=${ready.agent} protocol=${ready.protocol} boot=${bootMs.toFixed(0)}ms`);
    if (ready.protocol !== PROTOCOL) {
        console.error(`agent の命令の形が v${ready.protocol ?? '?'}（このスクリプトは v${PROTOCOL}）。ゲストを作り直す`);
        await agent.powerOff();
        process.exit(1);
    }

    const commitUs = [];
    const viewUs = [];
    const failures = [];
    let mountOptions;
    let exdevRenames = 0;
    let upperChecks = 0;

    for (const s of scenarios) {
        const golden = readGolden(s.name);
        await agent.call({ op: 'reset' });
        for (let i = 0; i < s.commits.length; i++) {
            const parent = parentOf(s, i);
            // 層の名前はホストが決める（MicroGit では Git のコミットのハッシュ）。ここではコミットの番号
            const layer = `c${i + 1}`;
            const c = await agent.call({ op: 'commit', layer, parent: parent >= 0 ? `c${parent + 1}` : '', ops: s.commits[i].ops });
            commitUs.push(c.elapsedUs);
            mountOptions ??= c.mountOptions;
            exdevRenames += c.exdevRenames ?? 0;
            if (c.depth !== chainOf(s, i).length) {
                failures.push(`[${s.name}] commit ${i + 1}: depth ${c.depth}、期待 ${chainOf(s, i).length}`);
            }
            const want = UPPER_EXPECT[s.name]?.[i + 1];
            const inspected = (await agent.call({ op: 'inspect', layer })).entries ?? [];
            // redirect_dir=nofollow なので、redirect の付いたディレクトリはどの層にも無いはず
            const unexpected = inspected.filter((l) => l.startsWith('r\t')).concat((want ?? []).filter((l) => !inspected.includes(l)).map((l) => `（無い）${l}`));
            if (want) { upperChecks++; }
            if (unexpected.length) {
                failures.push(`[${s.name}] commit ${i + 1} の層（inspect: ${inspected.join(', ')}）`, ...unexpected.map((l) => `! ${l}`));
            }
            const v = await agent.call({ op: 'view', layer });
            viewUs.push(v.elapsedUs);
            const actual = v.entries ?? [];
            const expected = golden[i];
            const exp = new Set(expected);
            const act = new Set(actual);
            const diff = [
                ...expected.filter((l) => !act.has(l)).map((l) => `- ${l}`),
                ...actual.filter((l) => !exp.has(l)).map((l) => `+ ${l}`),
            ];
            if (diff.length) {
                failures.push(`[${s.name}] commit ${i + 1} (chain ${chainOf(s, i).map((n) => n + 1).join('>')})`, ...diff);
            }
        }
    }

    await agent.powerOff();

    const summary = {
        kernel: ready.kernel,
        agent: ready.agent,
        mountOptions,
        exdevRenames,
        upperChecks,
        bootMs: Math.round(bootMs),
        commitUs: { p50: percentile(commitUs, 50), p95: percentile(commitUs, 95), max: Math.max(...commitUs) },
        viewUs: { p50: percentile(viewUs, 50), p95: percentile(viewUs, 95), max: Math.max(...viewUs) },
        scenarios: scenarios.length,
        mismatchedViews: failures.filter((l) => l.startsWith('[')).length,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ ...summary, failures }, null, 2) + '\n'); }

    if (failures.length) {
        console.error('\nカーネルの期待値と食い違った（- は期待値にだけある行、+ はゲストにだけある行）:');
        for (const l of failures) { console.error(`  ${l}`); }
        process.exit(1);
    }
    console.log(`OK: ${scenarios.length} scenarios がゲストで期待値どおり`);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
