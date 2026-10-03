#!/usr/bin/env node
/**
 * 停電を模した試験（ADR-0014、#38）。速い記録をジャーナルつきで動かし、Git のファイルを失わせてから、
 * 起動時の作り直し（recoverJournals）で「停電がなかった場合」と同じ履歴に戻り、git fsck --strict が通ることを確かめる。
 *
 * 使い方: npm run compile && node scripts/test/micro-commit-crash.mjs [--saves 60] [--seed 1]
 *
 * 場面
 *  1. lost-writes  ：最後のチェックポイント以降に書いた Git のファイルを、消す・中身を空にする・残すの 3 通りで傷め、
 *                   ref を古い値に戻し（書き込みが失われた）、新しい ref は消し、index も消す
 *  2. torn-tail    ：最後の保存の記録がジャーナルの途中で切れ、その保存の Git のファイルも書かれていない
 *                   → その保存の前の状態に戻る（その保存は記録されなかった）
 *  3. external     ：オブジェクトだけ失われ、ref はほかの処理（過去に戻る操作など）が別の値に進めてある → ref は触らない
 *  4. checkpoint   ：途中でチェックポイントしてから停電。チェックポイント済みのジャーナルは消えていて、その後の分だけ作り直す
 * どの場面も、作り直したあとにもう 1 回保存できること（作り直した index から正しい tree ができること）も確かめる。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FastMicroCommitter } = require(path.join(ROOT, 'out', 'fastMicroCommit.js'));
const { recoverJournals, journalDir } = require(path.join(ROOT, 'out', 'fastGit', 'journal.js'));

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const SAVES = Number(arg('--saves', '60'));
let seed = Number(arg('--seed', '1'));
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'MicroGit', GIT_AUTHOR_EMAIL: 'microgit@local', GIT_COMMITTER_NAME: 'MicroGit', GIT_COMMITTER_EMAIL: 'microgit@local' };
const git = (dir, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: ENV });

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-crash-'));
    git(os.tmpdir(), 'init', '-q', '-b', 'micro-history', dir);
    git(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    return dir;
}

const NAMES = ['a.txt', 'src/main.ts', 'src/deep/x.ts', 'docs/メモ.md', 'b.txt'];
let tag = 'mb-1';
let n = 0;
/** 1 回保存する（記録の結果を返す） */
function save(dir, fc) {
    const rel = NAMES[Math.floor(rand() * NAMES.length)];
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''}line ${n}\n`);
    const out = fc.record({ shadowRepoPath: dir, relativeFilePath: rel, currentTag: tag, message: () => `save ${n}`, commitEnv: ENV });
    if (out.tag) { tag = out.tag; }
    n++;
    return out;
}

/** .git の中のファイル（ジャーナルは除く）の、中身と更新時刻のスナップショット */
function snapshot(dir) {
    const g = path.join(dir, '.git');
    const out = new Map();
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (p === journalDir(g)) { continue; }
            if (e.isDirectory()) { walk(p); } else { out.set(path.relative(g, p), Object.assign(fs.readFileSync(p), { mtime: fs.statSync(p).mtime })); }
        }
    };
    walk(g);
    return out;
}

/** 書き込みが失われたことにする：前の中身と前の更新時刻に戻す（前が無ければ消す） */
function revert(file, old) {
    if (!old) { fs.rmSync(file); return; }
    fs.writeFileSync(file, old);
    fs.utimesSync(file, old.mtime, old.mtime);
}

/** 停電を模す：before より後に書かれた（増えた・変わった）Git のファイルを傷める */
function simulateLoss(dir, before, opts) {
    const g = path.join(dir, '.git');
    const after = snapshot(dir);
    let damaged = 0;
    for (const [rel, data] of after) {
        const old = before.get(rel);
        if (old && old.equals(data)) { continue; }
        const file = path.join(g, rel);
        const isObject = /^objects[\\/][0-9a-f]{2}[\\/]/.test(rel);
        const isRef = /^refs[\\/]/.test(rel) || rel === 'HEAD';
        if (isObject) {
            if (opts.keepObjects) { continue; }
            const r = rand();
            fs.chmodSync(file, 0o644);
            if (r < 0.5) { fs.rmSync(file); damaged++; } else if (r < 0.75) { fs.writeFileSync(file, ''); damaged++; }
        } else if (isRef && !opts.keepRefs) {
            revert(file, old);
            damaged++;
        } else if (/^logs[\\/]/.test(rel) && !opts.keepRefs) {
            // reflog も fsync しないので、古いまま・途中で切れる・残る のどれもありうる
            const r = rand();
            if (r < 0.4) {
                revert(file, old);
                damaged++;
            } else if (r < 0.8) {
                fs.writeFileSync(file, data.subarray(0, Math.max(old ? old.length : 0, Math.floor(data.length * 0.9))));
                damaged++;
            }
        } else if (rel === 'index' && !opts.keepIndex) {
            revert(file, old);
            damaged++;
        }
    }
    return damaged;
}

const refsOf = (dir) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)').trim();
const results = [];
function check(label, cond, detail = '') {
    results.push(`${cond ? 'ok' : 'NG'} ${label}${detail ? `  ${detail}` : ''}`);
    if (!cond) { process.exitCode = 1; }
}

/** 作り直したあと：期待どおりの ref、fsck、もう 1 回保存できて tree が index どおりか */
function verifyAfter(label, dir, expectedRefs, report) {
    check(`${label}: ref が期待どおり`, refsOf(dir) === expectedRefs, JSON.stringify(report));
    try {
        git(dir, 'fsck', '--strict', '--no-progress', '--no-dangling');
        check(`${label}: git fsck --strict`, true);
    } catch (e) {
        check(`${label}: git fsck --strict`, false, String(e.stderr ?? e).slice(0, 300));
    }
    // 作り直した状態から保存を続けられる（新しい committer＝再起動）。保存した tree に、HEAD の全ファイルが残っているか
    const filesBefore = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort();
    const fc = new FastMicroCommitter(dir, () => true);
    const out = save(dir, fc);
    fc.flush(); // Git で読む前に書き出す（ADR-0015。拡張機能では関所がする）
    const filesAfter = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n');
    check(`${label}: 作り直したあとも保存でき、ファイルが消えない`, out.kind !== undefined && filesBefore.every((f) => filesAfter.includes(f)), `${out.kind}`);
    git(dir, 'fsck', '--strict', '--no-progress', '--no-dangling');
}

// ---------------- 1. lost-writes
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    save(dir, fc); // 最初の 1 回で ref とジャーナルができる
    await fc.checkpoint();
    const before = snapshot(dir);
    let fsyncOk = true;
    for (let i = 0; i < SAVES; i++) {
        const out = save(dir, fc);
        if (out.kind === 'created' && fc.stats.lastPhases.fsyncCount !== 1) { fsyncOk = false; }
    }
    check('lost-writes: 保存 1 回の fsync は 1 回（新しいコミットのとき）', fsyncOk);
    fc.flush(); // 貯めていた分を書き出してから、それを停電で失わせる
    const expected = refsOf(dir);
    const damaged = simulateLoss(dir, before, {});
    const report = recoverJournals(path.join(dir, '.git'));
    check('lost-writes: 傷めたファイルがある', damaged > 0, `damaged=${damaged}`);
    verifyAfter('lost-writes', dir, expected, report);
}

// ---------------- 2. torn-tail
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    for (let i = 0; i < 10; i++) { save(dir, fc); }
    fc.flush();
    const expected = refsOf(dir); // 最後の保存の前
    const before = snapshot(dir);
    const jfile = path.join(journalDir(path.join(dir, '.git')), fs.readdirSync(journalDir(path.join(dir, '.git')))[0]);
    const sizeBefore = fs.statSync(jfile).size;
    save(dir, fc); // この保存の記録を途中で切る
    const sizeAfter = fs.statSync(jfile).size;
    simulateLoss(dir, before, { keepIndex: false });
    // この保存の Git のファイルは書かれなかったことにする（ジャーナルの後に書くので、ジャーナルが途中なら書かれていない）
    const g = path.join(dir, '.git');
    for (const [rel] of snapshot(dir)) {
        if (!before.has(rel) && /^objects[\\/]/.test(rel)) { fs.chmodSync(path.join(g, rel), 0o644); fs.rmSync(path.join(g, rel)); }
    }
    fs.truncateSync(jfile, sizeBefore + Math.floor((sizeAfter - sizeBefore) / 2));
    const report = recoverJournals(g);
    check('torn-tail: 書きかけの最後の記録を捨てた', report.truncatedTails === 1, JSON.stringify(report));
    verifyAfter('torn-tail', dir, expected, report);
}

// ---------------- 3. external
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    save(dir, fc);
    await fc.checkpoint();
    const before = snapshot(dir);
    for (let i = 0; i < 20; i++) { save(dir, fc); }
    // ほかの処理（過去に戻る操作など）が、ブランチを 5 つ前のコミットに戻した（Git のコマンドで、確定している）
    fc.flush();
    const target = git(dir, 'rev-parse', 'HEAD~5').trim();
    git(dir, 'update-ref', 'refs/heads/micro-history', target);
    const expected = refsOf(dir);
    simulateLoss(dir, before, { keepRefs: true, keepIndex: true });
    const report = recoverJournals(path.join(dir, '.git'));
    check('external: ほかの処理が書き換えた ref は触らない', git(dir, 'rev-parse', 'refs/heads/micro-history').trim() === target, JSON.stringify(report));
    verifyAfter('external', dir, expected, report);
}

// ---------------- 4. checkpoint
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    for (let i = 0; i < 20; i++) { save(dir, fc); }
    await fc.checkpoint();
    const jdir = journalDir(path.join(dir, '.git'));
    // チェックポイントの最後に、次のジャーナルのファイルを空で作っておく（名前の確定を保存の外でするため）
    const left = fs.readdirSync(jdir).filter((f) => fs.statSync(path.join(jdir, f)).size > 0);
    check('checkpoint: チェックポイントしたジャーナルは消えた（次の空のファイルだけ残る）', left.length === 0 && fs.readdirSync(jdir).length === 1, fs.readdirSync(jdir).join(','));
    // チェックポイントの前に、ほかの書き手（作り直し、Git のコマンド）が、控えたオブジェクトを読み取り専用（0444）で
    // 書き直していても、チェックポイントが失敗しない（CI の Linux で、裏で始まったチェックポイントが、作り直しの
    // あとで続きを走らせ、書き込みで開けずに EACCES になった）
    {
        const out = save(dir, fc);
        fc.flush(); // 書き出して、ジャーナルに控えさせる（ADR-0015）
        const objects = execFileSync('git', ['-C', dir, 'ls-tree', '-r', out.commit ?? 'HEAD'], { encoding: 'utf8' });
        for (const h of [git(dir, 'rev-parse', 'HEAD').trim(), ...objects.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2])]) {
            const f = path.join(dir, '.git', 'objects', h.slice(0, 2), h.slice(2));
            if (fs.existsSync(f)) { fs.chmodSync(f, 0o444); }
        }
        let err = '';
        try { await fc.checkpoint(); } catch (e) { err = String(e); }
        check('checkpoint: 控えたオブジェクトがほかの書き手に読み取り専用にされていても、チェックポイントが通る', err === '', err);
    }
    const before = snapshot(dir);
    for (let i = 0; i < 20; i++) { save(dir, fc); }
    fc.flush();
    const expected = refsOf(dir);
    simulateLoss(dir, before, {});
    const report = recoverJournals(path.join(dir, '.git'));
    check('checkpoint: チェックポイントの後の 20 件だけ読んだ', report.entries === 20, JSON.stringify(report));
    verifyAfter('checkpoint', dir, expected, report);
}

// ---------------- 5. concurrent（停電ではなく、裏のチェックポイントと保存が重なる場面）
// 5.0.0 の公開前の確認（run 36941251753、windows-latest）で、裏のチェックポイントがブランチのファイルを開いて
// 確定させている間に保存がそのファイルを上書きし、Windows の rename が EPERM になった（その保存は Git のコマンドで
// 記録された）。チェックポイントを始めてから、イベントループを回しつつ保存を重ねても、速い記録が失敗しないこと
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    let errors = 0;
    let first = '';
    for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 3; i++) { save(dir, fc); }
        let done = false;
        const p = fc.checkpoint().then(() => { done = true; });
        // チェックポイントが終わるまで（最大 100 回）、イベントループを 1 回回すごとに保存する。
        // 保存がこれほど続くと、チェックポイントは追いつかない（実際の保存の間隔はもっと長い）ので、回数で止める。
        // 直す前のコードでは、手元の Windows で 4 回のうち 2 回目から EPERM になった
        for (let k = 0; k < 100 && !done; k++) {
            await new Promise((r) => setImmediate(r));
            try { save(dir, fc); } catch (e) { errors++; first ||= String(e); }
        }
        await p;
    }
    check('concurrent: チェックポイントと重なった保存も、速い記録で書ける', errors === 0, `errors=${errors} ${first.slice(0, 200)}`);
    git(dir, 'fsck', '--strict', '--no-progress', '--no-dangling');
}

// ---------------- 6. deferred（ADR-0015：Git のファイルを書き出す前に停電した）
// 保存のときはジャーナルに書くだけで、Git のファイルは貯めておく。書き出す前に停電すると、ディスクにはジャーナルしか無い。
// 停電した瞬間の写し（dir を丸ごと写したもの）をジャーナルから作り直し、書き出した場合と同じ履歴になるかを確かめる
{
    const dir = makeRepo();
    const fc = new FastMicroCommitter(dir, () => true);
    save(dir, fc);
    await fc.checkpoint(); // ここまでは書き出して確定済み
    for (let i = 0; i < 30; i++) { save(dir, fc); }
    check('deferred: 30 回分の Git のファイルを、まだ書き出していない', fc.hasPending && fc.stats.materializations === 1);
    const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-crash-copy-'));
    fs.cpSync(dir, crashed, { recursive: true }); // 停電した瞬間のディスク
    fc.flush();
    const expected = refsOf(dir); // 停電しなかった場合
    const report = recoverJournals(path.join(crashed, '.git'));
    check('deferred: ジャーナルの 30 件から作り直した', report.entries === 30 && report.indexReset, JSON.stringify(report));
    verifyAfter('deferred', crashed, expected, report);
}

console.log(results.join('\n'));
console.log(process.exitCode ? 'NG' : 'OK: 停電を模した 5 つの場面で、作り直したあとの履歴が期待どおりで git fsck --strict が通り、チェックポイントと重なった保存も速い記録で書けた');
