#!/usr/bin/env node
/**
 * OverlayFS ゴールデンテストの期待値を、本物の Linux カーネルで記録する（Issue #10）。
 *
 * 使い方: node scripts/golden/record-kernel.mjs [--check] [--sudo]
 *   Linux:   unshare -Urm で非特権のユーザー／mount 名前空間に入って実行する（カーネル 5.11 以降）
 *   Windows: wsl.exe 経由で同じことをする（WSL2 のディストリビューションが要る）
 *   --sudo:  sudo unshare -m で root として mount する。非特権のユーザー名前空間が止められている環境
 *            （GitHub Actions の Ubuntu 24.04 など。補足 S-3）で使う。mount オプションは同じ userxattr のまま
 *   --check: ファイルに書かずに、記録済みの *.golden と比べる。違えば差分を出して exit 1。
 *            別のカーネルバージョンでも同じ結果になるかを確かめる（補足 S-4）ために CI で使う
 * 出力: test/golden/overlayfs/<scenario>.golden と meta.json（--check のときは書かない）
 *
 * コミットのモデル（要件定義書 FR-2 の初期案そのまま）:
 *   コミット i は、祖先の層を lowerdir に積み、空の upperdir に ops を書き込んで unmount したもの。
 *   凍結した upperdir がそのまま次のコミットの lower になる。
 *   期待値は、祖先＋自分の層だけを lowerdir にした読み取り専用 mount（FR-2 の view）の中身。
 *
 * mount オプションは #12（O-13）で固定した値を明示する（MOUNT_OPTS）。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chainOf, scenarios, validateScenarios } from './overlayfs-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'test', 'golden', 'overlayfs');
// 固定する mount オプション（#12、O-13）。guest/agent/overlay.go の overlayOpts と同じにする。
// userxattr は非特権（ユーザー名前空間）で mount するのに必須。redirect_dir=on と metacopy=on は userxattr と同時には
// カーネルが受け付けない。index・metacopy・xino はカーネルの版や設定で既定値が変わりうるので明示する
const MOUNT_OPTS = 'userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function opToShell(op) {
    const [kind, a, b] = op;
    switch (kind) {
        case 'write': return `mkdir -p -- "$(dirname -- ${q(a)})" && printf '%s' ${q(b)} > ${q(a)}`;
        case 'rm': return `rm -- ${q(a)}`;
        case 'rmdir': return `rm -r -- ${q(a)}`;
        case 'mkdir': return `mkdir -p -- ${q(a)}`;
        case 'mv': return `mkdir -p -- "$(dirname -- ${q(b)})" && mv -T -- ${q(a)} ${q(b)}`;
        default: throw new Error(`unknown op: ${kind}`);
    }
}

function buildScript() {
    const lines = [
        'set -eu',
        'T=$(mktemp -d)',
        // workdir はユーザー名前空間の root 所有で残るので、名前空間の中で消す
        'trap \'rm -rf "$T"\' EXIT',
        // mount オプションからパスを落として、フラグだけを出す
        'opts() { grep " $1 overlay " /proc/mounts | cut -d" " -f4 | tr , "\\n" | grep -Ev "^(lowerdir|upperdir|workdir)=" | paste -sd, -; }',
        'dump() {',
        '  (cd "$1" && find . -mindepth 1 -print0 | LC_ALL=C sort -z | while IFS= read -r -d "" p; do',
        '    r=${p#./}',
        '    if [ -L "$p" ]; then printf "l\\t%s\\t%s\\n" "$r" "$(readlink -- "$p")"',
        '    elif [ -d "$p" ]; then printf "d\\t%s\\n" "$r"',
        '    elif [ -f "$p" ]; then printf "f\\t%s\\t%s\\n" "$r" "$(sha256sum < "$p" | cut -d" " -f1)"',
        '    else printf "o\\t%s\\n" "$r"',
        '    fi',
        '  done)',
        '}',
        'echo "@kernel $(uname -r)"',
    ];
    let first = true;
    for (const s of scenarios) {
        lines.push(`S="$T/${s.name}"`, 'mkdir -p "$S/base" "$S/m"', `echo "@scenario ${s.name}"`);
        s.commits.forEach((c, i) => {
            const chain = chainOf(s, i);
            // lowerdir は上の層が先
            const lowers = chain.slice(0, -1).reverse().map((n) => `$S/u${n}`).concat('$S/base').join(':');
            const views = chain.slice().reverse().map((n) => `$S/u${n}`).concat('$S/base').join(':');
            lines.push(
                `mkdir -p "$S/u${i}" "$S/w${i}"`,
                `mount -t overlay overlay -o "lowerdir=${lowers},upperdir=$S/u${i},workdir=$S/w${i},${MOUNT_OPTS}" "$S/m"`,
            );
            if (first) { lines.push('echo "@write-options $(opts "$S/m")"'); }
            lines.push(
                `(cd "$S/m" && ${c.ops.map(opToShell).join(' && ') || 'true'})`,
                'umount "$S/m"',
                `mount -t overlay overlay -o "lowerdir=${views},${MOUNT_OPTS}" "$S/m"`,
            );
            if (first) { lines.push('echo "@view-options $(opts "$S/m")"'); }
            lines.push(`echo "@commit ${i + 1}"`, 'dump "$S/m"', 'umount "$S/m"');
            first = false;
        });
    }
    lines.push('echo "@end"');
    return lines.join('\n') + '\n';
}

function runInLinuxNamespace(script) {
    let cmd;
    if (process.platform === 'linux' && process.argv.includes('--sudo')) {
        cmd = ['sudo', ['unshare', '-m', 'bash', '-s']];
    } else if (process.platform === 'linux') {
        cmd = ['unshare', ['-Urm', 'bash', '-s']];
    } else if (process.platform === 'win32') {
        cmd = ['wsl.exe', ['-e', 'unshare', '-Urm', 'bash', '-s']];
    } else {
        throw new Error(`Linux カーネルが要る（Linux か、WSL2 のある Windows で実行する）: platform=${process.platform}`);
    }
    const r = spawnSync(cmd[0], cmd[1], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) { throw r.error; }
    if (r.status !== 0 || !r.stdout.includes('@end')) {
        throw new Error(`カーネル側の記録に失敗した (exit ${r.status})\n${r.stderr}`);
    }
    return r.stdout;
}

function parse(stdout) {
    const meta = {};
    const goldens = new Map();
    let current;
    for (const line of stdout.split('\n')) {
        if (!line) { continue; }
        const m = /^@(\S+)(?: (.*))?$/.exec(line);
        if (!m) {
            current.push(line);
            continue;
        }
        const [, tag, value = ''] = m;
        if (tag === 'kernel') { meta.kernel = value; }
        else if (tag === 'write-options') { meta.writeMountOptions = value; }
        else if (tag === 'view-options') { meta.viewMountOptions = value; }
        else if (tag === 'scenario') { current = []; goldens.set(value, current); }
        else if (tag === 'commit') { current.push(`## commit ${value}`); }
    }
    return { meta, goldens };
}

const HEADER = '# scripts/golden/record-kernel.mjs が生成。手で直さない\n';

/** 記録済みの期待値と比べる。違うシナリオの差分を出し、1 つでも違えば false */
function matchesRecorded(goldens) {
    let same = true;
    const leftover = new Set(fs.readdirSync(OUT_DIR).filter((n) => n.endsWith('.golden')).map((n) => n.slice(0, -'.golden'.length)));
    for (const [name, lines] of goldens) {
        leftover.delete(name);
        const file = path.join(OUT_DIR, `${name}.golden`);
        // core.autocrlf=true の Windows では CRLF で取り出される
        const want = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
        const got = HEADER + lines.join('\n') + '\n';
        if (want === got) { continue; }
        same = false;
        const wantSet = new Set(want.split('\n'));
        const gotSet = new Set(got.split('\n'));
        console.error(`[${name}] 記録済みの期待値と違う`);
        for (const l of want.split('\n')) { if (l && !gotSet.has(l)) { console.error(`  - ${l}`); } }
        for (const l of got.split('\n')) { if (l && !wantSet.has(l)) { console.error(`  + ${l}`); } }
    }
    for (const name of leftover) {
        same = false;
        console.error(`[${name}] 期待値のファイルはあるが、シナリオが無い`);
    }
    return same;
}

validateScenarios();
const { meta, goldens } = parse(runInLinuxNamespace(buildScript()));

if (process.argv.includes('--check')) {
    const recordedMeta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'meta.json'), 'utf8'));
    console.log('recorded on:', { kernel: recordedMeta.kernel, writeMountOptions: recordedMeta.writeMountOptions });
    console.log('checked on: ', meta);
    if (!matchesRecorded(goldens)) {
        console.error('このカーネルでは、記録済みの期待値と違う結果になった');
        process.exit(1);
    }
    console.log(`OK: ${goldens.size} scenarios がこのカーネルでも記録済みの期待値どおり`);
    process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith('.golden')) { fs.rmSync(path.join(OUT_DIR, name)); }
}
for (const [name, lines] of goldens) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}.golden`), HEADER + lines.join('\n') + '\n');
}
fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({ ...meta, requestedMountOptions: MOUNT_OPTS, model: 'upper を凍結して次の lower にする（FR-2。#12 で保存ごとに層を作る方式に決定）' }, null, 2) + '\n',
);
console.log(`recorded ${goldens.size} scenarios`, meta);
