#!/usr/bin/env node
/**
 * 最小ゲストの中で OverlayFS がどう動くかを、1 段ずつ見せるデモ（#18 ほか）。
 *
 * 使い方: node scripts/guest/demo.mjs [--step] [--console <ゲストのログファイル>] -- <コマンド> [引数...]
 *   --step     各段のあとで Enter を待つ
 *   --console  起動したあとに、ゲストのログ（hvc0）の最後の数行を見せる
 *   <コマンド> は check-guest.mjs と同じ（QEMU、mac/.build/microgit-vm、unshare -Urm <agent>）
 * Windows では windows/run-golden.ps1 -Demo が QEMU の引数まで組み立てる。
 *
 * 解説は docs/kernel-portability-walkthrough.md。
 */
import fs from 'fs';
import readline from 'readline';
import { AgentClient } from './agent-client.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
    console.error('usage: demo.mjs [--step] [--console <file>] -- <command> [args...]');
    process.exit(2);
}
const opts = argv.slice(0, sep);
const [cmd, ...cmdArgs] = argv.slice(sep + 1);
const stepMode = opts.includes('--step');
const consoleLog = opts.includes('--console') ? opts[opts.indexOf('--console') + 1] : undefined;

const timings = [];
let agent;
/** 層の名前はホストが決める（命令の形 v1）。MicroGit では Git のコミットのハッシュを使うが、デモでは番号 */
let nextLayer = 0;

function heading(n, title) {
    console.log(`\n========== ${n}. ${title} ==========`);
}

function say(...lines) {
    for (const l of lines) { console.log(`  ${l}`); }
}

async function pause() {
    if (!stepMode) { return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question('\n  (Enter で次へ) ', () => { rl.close(); resolve(); }));
}

async function commit(label, parent, ops) {
    say(`保存する（${label}）:`);
    for (const op of ops) {
        const text = {
            write: () => `書く     ${op[1]} ← "${op[2]}"`,
            rm: () => `消す     ${op[1]}`,
            rmdir: () => `フォルダごと消す ${op[1]}`,
            mkdir: () => `フォルダを作る ${op[1]}`,
            mv: () => `名前を変える ${op[1]} → ${op[2]}`,
        }[op[0]]();
        say(`  - ${text}`);
    }
    const layer = String(nextLayer++);
    const res = await agent.call({ op: 'commit', layer, parent: parent === -1 ? '' : parent, ops });
    timings.push(res.elapsedUs);
    say(`→ コミット #${layer} になった（層の深さ ${res.depth}、ゲストの中で ${(res.elapsedUs / 1000).toFixed(2)} ms）`);
    return { ...res, commit: layer };
}

/** コミット時点のファイル一覧を、中身と一緒に木の形で出す */
async function showTree(commitId, title) {
    const entries = (await agent.call({ op: 'view', layer: commitId })).entries ?? [];
    say(`${title}（コミット #${commitId} の時点）:`);
    if (!entries.length) {
        say('  （空）');
        return;
    }
    for (const line of entries) {
        const [type, rel] = line.split('\t');
        const depth = rel.split('/').length - 1;
        const name = rel.split('/').pop();
        const indent = '    ' + '  '.repeat(depth);
        if (type === 'd') {
            say(`${indent}${name}/`);
        } else if (type === 'f') {
            const { data } = await agent.call({ op: 'read', layer: commitId, path: rel });
            const content = Buffer.from(data, 'base64').toString('utf8');
            const shown = content.length > 40 ? `${content.slice(0, 40)}…` : content;
            say(`${indent}${name}  "${shown}"`);
        } else {
            say(`${indent}${name}  (${type})`);
        }
    }
}

async function main() {
    heading(0, '仮想マシンを起動する');
    say(`起動するコマンド: ${[cmd, ...cmdArgs].join(' ').slice(0, 160)}…`);
    const started = Date.now();
    agent = new AgentClient(cmd, cmdArgs);
    const ready = await agent.waitReady();
    say(`ゲストの準備ができた: Linux ${ready.kernel}、agent ${ready.agent}（${Date.now() - started} ms）`);
    if (consoleLog && fs.existsSync(consoleLog)) {
        const tail = fs.readFileSync(consoleLog, 'utf8').replace(/\r\n/g, '\n').trim().split('\n').slice(-4);
        say('ゲストのログ（最後の 4 行）:', ...tail.map((l) => `  | ${l}`));
    }
    say('このあとの命令はすべて、仮想マシンの中の本物の Linux カーネルの OverlayFS で実行される。');
    await pause();

    heading(1, '最初の保存');
    const c0 = await commit('1 回目', -1, [
        ['write', 'README.md', '# MicroGit デモ'],
        ['write', 'src/app.js', "console.log('v1')"],
        ['write', 'notes/todo.txt', 'あとでやる'],
    ]);
    say(`${c0.mountOptions ? `mount オプション: ${c0.mountOptions}` : ''}`);
    await showTree(c0.commit, '見えているファイル');
    await pause();

    heading(2, '書き換えと削除');
    say('一番上の新しい層に「変わったところ」だけが書かれる。', '消したファイルは、層に「消えた」という目印（whiteout）が置かれるだけで、下の層は触らない。');
    const c1 = await commit('2 回目', c0.commit, [
        ['write', 'src/app.js', "console.log('v2')"],
        ['rm', 'notes/todo.txt'],
    ]);
    await showTree(c1.commit, '見えているファイル');
    say('notes/ フォルダは残る。ファイルを 1 つずつ消したときは、フォルダ自体は消えない（カーネルの挙動）。');
    await pause();

    heading(3, '過去に戻る');
    say('コミット #0 の層は書き換えていないので、いつでもその時点の姿を見られる。');
    await showTree(c0.commit, '1 回目の保存の時点');
    await pause();

    heading(4, '枝分かれ（ブランチ）');
    say('コミット #0 の上に、別の新しい層を重ねる。#1 とは下の層を共有しているだけで、互いに影響しない。');
    const c2 = await commit('#0 から枝分かれ', c0.commit, [
        ['write', 'src/app.js', "console.log('feature')"],
        ['write', 'feature.txt', '新機能のメモ'],
    ]);
    await showTree(c1.commit, '本流（#1）');
    await showTree(c2.commit, '枝（#2）');
    await pause();

    heading(5, 'フォルダの名前を変える');
    say('下の層にあるフォルダの名前を変えようとすると、今の mount 設定（redirect_dir=nofollow）ではカーネルが断る（EXDEV）。', 'agent は、そのときは中身をコピーして元を消すことで代わりにやる。');
    const c3 = await commit('#1 の続き', c1.commit, [['mv', 'src', 'lib']]);
    say(`→ コピーで代わりにやった回数: ${c3.exdevRenames ?? 0}`);
    await showTree(c3.commit, '見えているファイル');
    await pause();

    heading(6, 'まとめ');
    const sorted = [...timings].sort((a, b) => a - b);
    say(`保存（コミット）${timings.length} 回、ゲストの中での時間: 最短 ${(sorted[0] / 1000).toFixed(2)} ms / 最長 ${(sorted[sorted.length - 1] / 1000).toFixed(2)} ms`);
    say('電源を切る。層はゲストのメモリ（tmpfs）にあるので、電源を切ると消える（保存先は今後決める: O-2）。');
    await agent.powerOff();
    say('終了');
}

main().catch(async (e) => {
    console.error(`\nエラー: ${e.message}`);
    if (agent && !agent.exited) { agent.child.kill(); }
    process.exit(1);
});
