#!/usr/bin/env node
/**
 * 版（バージョン）の付け忘れ・食い違いを確かめる（docs/versioning.md）。
 *
 * 使い方: node scripts/check-versions.mjs [--strict]
 *   --strict  タグ（v*・agent-v*）が 1 つも見えないときも失敗にする（CI 用。actions/checkout は fetch-depth: 0 にする）
 *
 * 版を持つ部品は 2 つ（docs/versioning.md §1）:
 *   extension  拡張機能（アプリ）。版は package.json の version、記録は CHANGELOG.md、タグは v<版>
 *   agent      ゲストの中で命令を受けるサーバー（microgit-agent）。版は guest/agent/main.go の agentVersion、
 *              記録は guest/agent/CHANGELOG.md、タグは agent-v<版>
 *
 * 確かめること（部品ごと）:
 *   1. 版が x.y.z の形である
 *   2. 変更履歴に `## [x.y.z]` の見出しがある
 *   3. 今の版が、いちばん新しいタグの版より小さくない
 *   4. 今の版のタグがすでにある（＝公開済みの版のまま）なら、そのタグから「配るもの」が変わっていない。
 *      変わっていたら「版を上げ忘れている」として失敗する。コメントと空白だけの変更は数えない
 *   5. 各タグが指すコミットで、その部品の版がタグの版と一致する（タグの打ち間違いを見つける）
 * ほかに: package-lock.json の版が package.json と同じ。docs/agent-protocol.md に agent の版と protocol の版が書いてある。
 *
 * 罠: コメントを除く処理は、文字列（"…"・'…'・`…`）だけを見分ける簡単なもの。TS の正規表現リテラルの中の `//` などは
 * コメントの始まりと誤るので、その行の変更を見落としうる（まれ。気づいたら版を上げればよい）。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const errors = [];
const warnings = [];

/** git を引数の配列で起動し、標準出力を返す（シェルを通さない）。失敗したら null。 */
function git(args) {
    try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
        return null;
    }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** rev の時点の rel の中身。無ければ null。 */
const readAt = (rev, rel) => git(['show', `${rev}:${rel}`]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/** a と b（x.y.z）を比べ、a が小さければ負、同じなら 0、大きければ正。 */
function cmp(a, b) {
    const pa = a.match(SEMVER).slice(1).map(Number);
    const pb = b.match(SEMVER).slice(1).map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) { return pa[i] - pb[i]; } }
    return 0;
}

/**
 * ソースのコメントを除き、文字列の外の空白の並びを 1 つの空白にまとめる（Go・TS・JS・Swift 用）。
 * コメントの書き足し（#81）や gofmt の桁そろえだけの変更を「配るものの変更」と数えないため。
 */
function normalizeSource(text) {
    let out = '';
    let i = 0;
    let space = false;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const d = text[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && text[i] !== '\n') { i++; }
            space = true;
            continue;
        }
        if (c === '/' && d === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
            space = true;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            if (space && out) { out += ' '; }
            space = false;
            let j = i + 1;
            while (j < n && text[j] !== c) {
                if (text[j] === '\\' && c !== '`') { j++; }
                else if (text[j] === '\n' && c !== '`') { break; }
                j++;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (/\s/.test(c)) { space = true; i++; continue; }
        if (space && out) { out += ' '; }
        space = false;
        out += c;
        i++;
    }
    return out;
}

/** 比べる前の整え方。ソースはコメントと空白を除き、JSON は形をそろえる。それ以外はそのまま。 */
function normalize(rel, text) {
    if (text === null) { return null; }
    if (/\.(go|ts|js|mjs|swift)$/.test(rel)) { return normalizeSource(text); }
    if (rel.endsWith('.json')) {
        try { return JSON.stringify(JSON.parse(text)); } catch { return text; }
    }
    return text.replace(/\r\n/g, '\n');
}

/** パスが拡張機能の VSIX に入るもの（またはそれを作るもの）か。.vscodeignore と scripts/package-vsix.mjs に合わせる。 */
function extensionShips(p) {
    if (p.startsWith('src/test/')) { return false; }
    if (p.startsWith('src/') || p.startsWith('media/')) { return true; }
    if (['package.json', 'README-marketplace.md', 'LICENCE.md', 'THIRD_PARTY_NOTICES.md', '.vscodeignore'].includes(p)) { return true; }
    // 同梱の部品（ゲスト・Mac の起動ツール・Windows の QEMU）も VSIX に入るので、拡張機能の版も上げる
    return agentShips(p) || p === 'guest/build.sh' || p.startsWith('guest/kernel/')
        || p.startsWith('mac/microgit-vm/') || p === 'mac/build.sh'
        || p === 'windows/qemu/build.sh' || p === 'windows/qemu/version.env';
}
/** パスが agent のバイナリになるものか（テストと変更履歴は除く）。 */
function agentShips(p) {
    if (!p.startsWith('guest/agent/')) { return false; }
    return (p.endsWith('.go') && !p.endsWith('_test.go')) || p.endsWith('/go.mod') || p.endsWith('/go.sum');
}

const COMPONENTS = [
    {
        name: 'extension（拡張機能）',
        tagPrefix: 'v',
        changelog: 'CHANGELOG.md',
        versionAt: (rev) => {
            const t = rev ? readAt(rev, 'package.json') : read('package.json');
            try { return t === null ? null : JSON.parse(t).version; } catch { return null; }
        },
        ships: extensionShips,
    },
    {
        name: 'agent（ゲストのサーバー）',
        tagPrefix: 'agent-v',
        changelog: 'guest/agent/CHANGELOG.md',
        versionAt: (rev) => {
            const t = rev ? readAt(rev, 'guest/agent/main.go') : read('guest/agent/main.go');
            const m = t && t.match(/agentVersion\s*=\s*"([^"]+)"/);
            return m ? m[1] : null;
        },
        ships: agentShips,
    },
];

const tagList = git(['tag', '-l']);
if (tagList === null) { warnings.push('git が使えないので、タグとの比較を飛ばした'); }
const allTags = (tagList || '').split('\n').filter(Boolean);

for (const comp of COMPONENTS) {
    const version = comp.versionAt(null);
    if (!version || !SEMVER.test(version)) {
        errors.push(`${comp.name}: 版が x.y.z の形でない（${version}）`);
        continue;
    }
    if (!fs.existsSync(path.join(ROOT, comp.changelog))) {
        errors.push(`${comp.name}: 変更履歴 ${comp.changelog} が無い`);
    } else if (!read(comp.changelog).includes(`## [${version}]`)) {
        errors.push(`${comp.name}: ${comp.changelog} に「## [${version}]」の見出しが無い`);
    }

    const tags = allTags
        .filter((t) => t.startsWith(comp.tagPrefix) && SEMVER.test(t.slice(comp.tagPrefix.length)))
        .map((t) => ({ tag: t, version: t.slice(comp.tagPrefix.length) }))
        .sort((a, b) => cmp(a.version, b.version));
    if (!tags.length) {
        (strict ? errors : warnings).push(`${comp.name}: タグ ${comp.tagPrefix}* が見えない（git fetch --tags。CI は fetch-depth: 0）`);
        continue;
    }

    for (const { tag, version: tv } of tags) {
        const atTag = comp.versionAt(`${tag}^{commit}`);
        if (atTag !== tv) { errors.push(`${comp.name}: タグ ${tag} のコミットでの版が ${atTag}（タグと食い違う）`); }
    }

    const latest = tags[tags.length - 1];
    if (cmp(version, latest.version) < 0) {
        errors.push(`${comp.name}: 今の版 ${version} が、いちばん新しいタグ ${latest.tag} より小さい`);
        continue;
    }
    const released = tags.find((t) => t.version === version);
    if (!released) {
        console.log(`${comp.name}: ${version}（未公開。いちばん新しいタグは ${latest.tag}）`);
        continue;
    }
    const names = (git(['diff', '--name-only', `${released.tag}^{commit}`, 'HEAD']) || '').split('\n').filter(Boolean);
    const changed = names.filter(comp.ships).filter((p) => {
        const before = normalize(p, readAt(`${released.tag}^{commit}`, p));
        const now = normalize(p, fs.existsSync(path.join(ROOT, p)) ? read(p) : null);
        return before !== now;
    });
    if (changed.length) {
        errors.push(`${comp.name}: 公開済みの ${released.tag} から配るものが変わったのに、版が ${version} のまま。版を上げ、${comp.changelog} に書く:\n    ${changed.join('\n    ')}`);
    } else {
        console.log(`${comp.name}: ${version}（${released.tag} から配るものは変わっていない）`);
    }
}

// 部品どうし・文書との食い違い
const pkgVersion = JSON.parse(read('package.json')).version;
const lock = JSON.parse(read('package-lock.json'));
if (lock.version !== pkgVersion || lock.packages?.['']?.version !== pkgVersion) {
    errors.push(`package-lock.json の版（${lock.version} / ${lock.packages?.['']?.version}）が package.json（${pkgVersion}）と違う。npm install --package-lock-only で直す`);
}
const mainGo = read('guest/agent/main.go');
const agentVersion = mainGo.match(/agentVersion\s*=\s*"([^"]+)"/)?.[1];
const protocol = mainGo.match(/protocolVersion\s*=\s*(\d+)/)?.[1];
const protoDoc = read('docs/agent-protocol.md').split('\n').find((l) => l.startsWith('| 版 |')) || '';
if (!protoDoc.includes(`agent ${agentVersion}`) || !protoDoc.includes(`v${protocol}`)) {
    errors.push(`docs/agent-protocol.md の「版」の行に agent ${agentVersion} と v${protocol} が無い: ${protoDoc}`);
}

for (const w of warnings) { console.warn(`注意: ${w}`); }
if (errors.length) {
    for (const e of errors) { console.error(`NG: ${e}`); }
    console.error('\n版の決まりは docs/versioning.md');
    process.exit(1);
}
console.log('版の確認: OK');
