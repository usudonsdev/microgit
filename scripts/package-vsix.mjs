#!/usr/bin/env node
/**
 * プラットフォーム別の VSIX を作る（#19）。公開（vsce publish）はしない。
 *
 * 使い方: node scripts/package-vsix.mjs --artifacts <成果物のフォルダ> --out <出力先> [--targets win32-x64,...] [--skip-sources]
 *   <成果物のフォルダ> は package.yml が actions/download-artifact で落としたもの（名前ごとにフォルダ）:
 *     microgit-guest-x86_64/{Image,init}   microgit-guest-arm64/{Image,init}   （guest.yml）
 *     microgit-qemu-win32-x64/qemu-win/     microgit-qemu-win32-x64-sources/*.src.rpm   （qemu-windows.yml）
 *     microgit-mac-helper/microgit-vm       （darwin-arm64）
 *   Go（agent のライセンスを入れるため）と curl（GPL の部品のソースを取るため）が要る。
 *
 * ターゲット（既定: win32-x64,linux-x64,linux-arm64,darwin-arm64,universal）:
 *   win32-x64    同梱の QEMU ＋ x86_64 の最小ゲスト（カーネルと agent）
 *   linux-x64    x86_64 の agent（VM なし、unshare -Urm）
 *   linux-arm64  arm64 の agent
 *   universal    カーネル版の部品なし（Node.js 版だけ）。--target を付けずに作るので、Marketplace では
 *                上のどれにも当たらない環境（Intel Mac、Windows on Arm など）に配られる（vsce の文書）
 *   darwin-arm64 microgit-vm ＋ arm64 の最小ゲスト（Virtualization.framework）
 *
 * ターゲットごとに resources/kernel/ を空にして、そのプラットフォームの部品だけを置いてから `vsce package` する。
 * 置き場所は src/kernel/launchers.ts の planLaunch が探す「同梱の置き場所」と同じ。
 * できた VSIX は中身を読み直して、要るものがあり、要らないもの（ソース・開発用のスクリプト・他のターゲットの部品）が
 * 無く、実行ファイルに実行ビットが付いているかを確かめる。
 * あわせて、GPL・LGPL の部品のソース（Linux カーネル・QEMU の tarball、DLL のソース RPM）と、使った設定・
 * ビルド手順を <出力先>/sources に集める（NFR-7。THIRD_PARTY_NOTICES.md）。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const artifacts = path.resolve(arg('--artifacts', 'artifacts'));
const out = path.resolve(arg('--out', 'dist'));
const targets = arg('--targets', 'win32-x64,linux-x64,linux-arm64,darwin-arm64,universal').split(',');
const skipSources = process.argv.includes('--skip-sources');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const kernelRes = path.join(ROOT, 'resources', 'kernel');
const cache = path.join(ROOT, '.cache', 'package-vsix');
const vsceBin = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = (file) => Object.fromEntries(fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const kernel = env('guest/kernel/version.env');
const qemu = env('windows/qemu/version.env');

function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) { copyTree(s, d); } else { fs.copyFileSync(s, d); }
    }
}

function need(p) {
    if (!fs.existsSync(p)) { throw new Error(`成果物が無い: ${p}`); }
    return p;
}

function copyFile(src, dst, mode) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(need(src), dst);
    // 成果物（upload-artifact）を通すと実行ビットが落ちる。VSIX（zip）にはここで付けたモードが入る
    if (mode) { fs.chmodSync(dst, mode); }
}

/** 取ってきて sha256 を照らす（一致しなければ止める） */
function fetchVerified(url, sha, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
        execFileSync('curl', ['-fsSL', '-o', `${dest}.tmp`, url], { stdio: 'inherit' });
        fs.renameSync(`${dest}.tmp`, dest);
    }
    const got = sha256(dest);
    if (got !== sha) { throw new Error(`${path.basename(dest)} の sha256 が違う: ${got}（期待 ${sha}）`); }
    return dest;
}

const kernelTarball = () => fetchVerified(
    `https://cdn.kernel.org/pub/linux/kernel/v${kernel.KERNEL_VERSION.split('.')[0]}.x/linux-${kernel.KERNEL_VERSION}.tar.xz`,
    kernel.KERNEL_SHA256, path.join(cache, `linux-${kernel.KERNEL_VERSION}.tar.xz`));
const qemuTarball = () => fetchVerified(
    `https://download.qemu.org/qemu-${qemu.QEMU_VERSION}.tar.xz`,
    qemu.QEMU_SHA256, path.join(cache, `qemu-${qemu.QEMU_VERSION}.tar.xz`));

/** ライセンスの文書を resources/kernel/licenses に置く */
let licenseCache;
function licenses() {
    if (licenseCache) { return licenseCache; }
    const dir = path.join(cache, 'licenses');
    fs.rmSync(dir, { recursive: true, force: true });
    // Linux カーネル（GPL-2.0、ユーザー空間との境界は Linux-syscall-note）
    const linuxDir = path.join(dir, 'linux');
    fs.mkdirSync(linuxDir, { recursive: true });
    const top = `linux-${kernel.KERNEL_VERSION}`;
    const files = ['COPYING', 'LICENSES/preferred/GPL-2.0', 'LICENSES/exceptions/Linux-syscall-note'];
    execFileSync('tar', ['-xJf', kernelTarball(), '-C', linuxDir, '--strip-components=1', ...files.map((f) => `${top}/${f}`)]);
    // Go（agent に静的にリンクされる標準ライブラリとランタイム。BSD-3-Clause）
    const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
    const goVersion = execFileSync('go', ['env', 'GOVERSION'], { encoding: 'utf8' }).trim();
    if (goVersion !== `go${kernel.GO_VERSION}`) {
        console.warn(`注意: Go ${goVersion} のライセンスを入れる（agent は go${kernel.GO_VERSION} でビルドされている）`);
    }
    copyFile(path.join(goroot, 'LICENSE'), path.join(dir, 'go', 'LICENSE'));
    licenseCache = dir;
    return dir;
}

/** ターゲットごとに resources/kernel に置くもの。戻り値は VSIX の中にあるべきファイル（実行ビットが要るもの） */
const G = (arch, file) => path.join(artifacts, `microgit-guest-${arch}`, file);
const layouts = {
    'win32-x64': () => {
        copyTree(need(path.join(artifacts, 'microgit-qemu-win32-x64', 'qemu-win')), path.join(kernelRes, 'win32-x64', 'qemu'));
        copyFile(G('x86_64', 'Image'), path.join(kernelRes, 'guest', 'x86_64', 'Image'));
        copyTree(path.join(licenses(), 'linux'), path.join(kernelRes, 'licenses', 'linux'));
        copyTree(path.join(licenses(), 'go'), path.join(kernelRes, 'licenses', 'go'));
        return {
            expect: ['win32-x64/qemu/qemu-system-x86_64.exe', 'win32-x64/qemu/share/bios-256k.bin', 'win32-x64/qemu/licenses/packages.tsv',
                'win32-x64/qemu/licenses/qemu/COPYING', 'guest/x86_64/Image', 'licenses/linux/COPYING', 'licenses/go/LICENSE'],
            executables: [],
        };
    },
    'linux-x64': () => {
        copyFile(G('x86_64', 'init'), path.join(kernelRes, 'linux-x64', 'microgit-agent'), 0o755);
        copyTree(path.join(licenses(), 'go'), path.join(kernelRes, 'licenses', 'go'));
        return { expect: ['linux-x64/microgit-agent', 'licenses/go/LICENSE'], executables: ['linux-x64/microgit-agent'] };
    },
    'linux-arm64': () => {
        copyFile(G('arm64', 'init'), path.join(kernelRes, 'linux-arm64', 'microgit-agent'), 0o755);
        copyTree(path.join(licenses(), 'go'), path.join(kernelRes, 'licenses', 'go'));
        return { expect: ['linux-arm64/microgit-agent', 'licenses/go/LICENSE'], executables: ['linux-arm64/microgit-agent'] };
    },
    'darwin-arm64': () => {
        copyFile(path.join(artifacts, 'microgit-mac-helper', 'microgit-vm'), path.join(kernelRes, 'darwin-arm64', 'microgit-vm'), 0o755);
        copyFile(G('arm64', 'Image'), path.join(kernelRes, 'guest', 'arm64', 'Image'));
        copyTree(path.join(licenses(), 'linux'), path.join(kernelRes, 'licenses', 'linux'));
        copyTree(path.join(licenses(), 'go'), path.join(kernelRes, 'licenses', 'go'));
        return { expect: ['darwin-arm64/microgit-vm', 'guest/arm64/Image', 'licenses/linux/COPYING', 'licenses/go/LICENSE'], executables: ['darwin-arm64/microgit-vm'] };
    },
    universal: () => ({ expect: [], executables: [] }),
};

/** zip の中央ディレクトリを読んで、名前とモード（UNIX の属性）の一覧を返す（依存を増やさないため自前で読む） */
function zipEntries(file) {
    const buf = fs.readFileSync(file);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error(`${file} は zip ではない`); }
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) { throw new Error(`${file} の中央ディレクトリが壊れている`); }
        const madeBy = buf.readUInt16LE(p + 4) >> 8;
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const attr = buf.readUInt32LE(p + 38);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries.push({ name, size, mode: madeBy === 3 ? (attr >>> 16) & 0o777 : undefined });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** VSIX の中身を確かめる。問題があれば理由の一覧を返す */
function checkVsix(file, layout) {
    const entries = zipEntries(file);
    const names = new Set(entries.map((e) => e.name));
    const problems = [];
    for (const f of ['extension/package.json', 'extension/out/extension.js', 'extension/LICENCE.md', 'extension/THIRD_PARTY_NOTICES.md']) {
        if (!names.has(f)) { problems.push(`無い: ${f}`); }
    }
    for (const f of layout.expect) {
        if (!names.has(`extension/resources/kernel/${f}`)) { problems.push(`無い: resources/kernel/${f}`); }
    }
    // 入ってよいものの一覧（それ以外はすべて問題）。以前は「入っていてはいけないもの」の一覧で確かめていたが、
    // CI で成果物を落としたフォルダ（artifacts/、GCC のソース RPM など 140 MB）が入ったのを見逃した（#19）
    const allowed = [
        /^\[Content_Types\]\.xml$/, /^extension\.vsixmanifest$/,
        /^extension\/(package\.json|readme\.md|changelog\.md|LICENCE\.md|THIRD_PARTY_NOTICES\.md)$/,
        /^extension\/media\/[^/]+\.svg$/,
        /^extension\/out\/(kernel\/)?[^/]+\.js$/,
        /^extension\/resources\/kernel\//,
    ];
    const allowedTop = new Set(layout.expect.map((f) => f.split('/')[0]).concat(layout.expect.length ? ['licenses'] : []));
    for (const e of entries) {
        if (!allowed.some((re) => re.test(e.name))) { problems.push(`入ってよいものの一覧に無い: ${e.name}`); }
        const m = /^extension\/resources\/kernel\/([^/]+)\//.exec(e.name);
        if (m && !allowedTop.has(m[1])) { problems.push(`他のターゲットの部品: ${e.name}`); }
    }
    // 同梱の部品を除いた拡張機能そのもの（out、README など）は 1 MB に収まるはず（2026-09-26 に約 0.3 MB）
    const extensionBytes = entries.filter((e) => !e.name.startsWith('extension/resources/kernel/')).reduce((a, e) => a + e.size, 0);
    if (extensionBytes > 1_000_000) { problems.push(`同梱の部品を除いた中身が大きすぎる: ${extensionBytes} バイト`); }
    for (const f of layout.executables) {
        const e = entries.find((x) => x.name === `extension/resources/kernel/${f}`);
        if (!e || e.mode === undefined || (e.mode & 0o111) !== 0o111) {
            problems.push(`実行ビットが無い: ${f}（mode ${e?.mode?.toString(8) ?? '記録なし'}）`);
        }
    }
    if (!names.has('extension.vsixmanifest')) { problems.push('extension.vsixmanifest が無い'); }
    return { problems, entries };
}

fs.mkdirSync(out, { recursive: true });
const results = [];
let failed = false;
for (const target of targets) {
    if (!layouts[target]) { throw new Error(`知らないターゲット: ${target}`); }
    fs.rmSync(kernelRes, { recursive: true, force: true });
    const layout = layouts[target]();
    const file = path.join(out, `microgit-${pkg.version}-${target}.vsix`);
    fs.rmSync(file, { force: true });
    const args = [vsceBin, 'package', '--no-dependencies', '-o', file];
    // universal は --target を付けない。Marketplace では、専用の VSIX が無いプラットフォームに配られる
    if (target !== 'universal') { args.push('--target', target); }
    console.log(`\n== ${target}`);
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    const { problems, entries } = checkVsix(file, layout);
    for (const p of problems) { console.error(`  NG ${p}`); }
    failed ||= problems.length > 0;
    const bytes = fs.statSync(file).size;
    results.push({
        target,
        file: path.basename(file),
        bytes,
        sha256: sha256(file),
        entries: entries.length,
        kernelParts: entries.filter((e) => e.name.startsWith('extension/resources/kernel/')).reduce((a, e) => a + e.size, 0),
        problems,
    });
}
fs.rmSync(kernelRes, { recursive: true, force: true });

// GPL・LGPL の部品のソース（NFR-7）: tarball（ハッシュを照合）、DLL のソース RPM、使った設定・ビルド手順
if (!skipSources) {
    const sources = path.join(out, 'sources');
    fs.rmSync(sources, { recursive: true, force: true });
    fs.mkdirSync(sources, { recursive: true });
    fs.copyFileSync(kernelTarball(), path.join(sources, path.basename(kernelTarball())));
    fs.copyFileSync(qemuTarball(), path.join(sources, path.basename(qemuTarball())));
    const srpms = path.join(artifacts, 'microgit-qemu-win32-x64-sources');
    if (targets.includes('win32-x64')) {
        copyTree(need(srpms), path.join(sources, 'qemu-win32-dlls'));
        fs.copyFileSync(need(path.join(artifacts, 'microgit-qemu-win32-x64', 'qemu-win', 'licenses', 'packages.tsv')),
            path.join(sources, 'qemu-win32-dlls', 'packages.tsv'));
    }
    for (const f of ['guest/kernel', 'guest/build.sh', 'guest/agent', 'windows/qemu/build.sh', 'windows/qemu/version.env', 'mac/microgit-vm', 'mac/build.sh']) {
        const src = path.join(ROOT, f);
        const dst = path.join(sources, 'microgit-build', f);
        if (fs.statSync(src).isDirectory()) { copyTree(src, dst); } else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    }
    const list = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); } else { list.push(`${sha256(p)}  ${path.relative(sources, p).split(path.sep).join('/')}`); }
    });
    walk(sources);
    fs.writeFileSync(path.join(sources, 'SHA256SUMS'), list.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n') + '\n');
}

fs.writeFileSync(path.join(out, 'vsix.json'), JSON.stringify(results, null, 2) + '\n');
console.log('');
console.table(results.map((r) => ({ target: r.target, bytes: r.bytes, MB: (r.bytes / 1e6).toFixed(2), 'kernel parts': r.kernelParts, entries: r.entries, ok: r.problems.length === 0 })));
// NFR-3：プラットフォーム別の VSIX 1 つあたり一桁 MB（10,000,000 バイト未満）
for (const r of results.filter((x) => x.bytes >= 10_000_000)) {
    console.warn(`NFR-3 の目安（一桁 MB）を超えた: ${r.file} ${r.bytes} バイト`);
}
if (failed) {
    console.error('VSIX の中身に問題がある（上の NG）');
    process.exit(1);
}
