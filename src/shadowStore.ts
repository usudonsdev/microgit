/**
 * 隠しリポジトリ（shadow）の置き場と、親リポジトリの refs/microgit/<branch>/ との行き来を受け持つ。
 * shadow は、作業ツリー側の .microgit/shadow/.git（gitfile）と、実体の bare（.git/microgit/repos/<branch>.git）の組。
 * 親の通常コミットにネスト .git が載らないようにするための形である。
 * 呼び出し側：保存・復元・同期の各処理。呼ぶ先：git コマンド、fastGit（ref の直読み）。
 * 前提：Git を起動する前に flushPendingGitWrites で、速い記録が貯めている分を書き出させる（ADR-0015）。
 * 履歴はマージしない（分岐のみ。docs/design-policy.md §4.1）。取り込みで手元の tip を上書きするのは fast-forward のときだけ。
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { durabilityGitArgs } from './durability';
import { flushPendingGitWrites } from './fastGit/pendingWrites';
import { listTags, readRef } from './fastGit/refs';
import { shadowDir } from './layout';
import { maskRemoteUrl } from './publishConfirm';

/** ブランチ名を、ディレクトリ名・ref 名に使える形にする。英数字と . _ - 以外は _ に置き換える（別の名前が同じ形になりうる）。 */
export function sanitizeBranchKey(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** shadow の作業ツリー（.microgit/shadow）の絶対パスを返す。 */
export function shadowWorkTreePath(mainRepoPath: string): string {
    return shadowDir(mainRepoPath);
}

/** 親ブランチごとの shadow の実体（bare リポジトリ）のパスを返す。親の .git の下にあり、作業ツリーには現れない。 */
export function bareGitDirPath(mainRepoPath: string, mainBranch: string): string {
    // 互換のため旧名のまま：bare の置き場（.git/microgit/repos）
    return path.join(mainRepoPath, '.git', 'microgit', 'repos', `${sanitizeBranchKey(mainBranch)}.git`);
}

/** 親リポジトリに共有するときの ref の接頭辞（refs/microgit/<ブランチ>）を返す。 */
export function parentMicroRefPrefix(mainBranch: string): string {
    // 互換のため旧名のまま：履歴 ref の名前空間。改名すると既存の履歴と、旧版を使う他の PC との共有が切れる（docs/design-policy.md の改名の節）
    return `refs/microgit/${sanitizeBranchKey(mainBranch)}`;
}

/**
 * bare を指して Git を同期的に起動し、標準出力を返す。失敗（非 0 終了）は例外になる。
 * 起動の直前に、貯めている ref の書き込みを先に書き出させる（ADR-0015）。
 */
function runGitDir(gitDir: string, args: string[], workTree?: string): string {
    // shadow の bare への書き込み（update-ref など）も、設定した永続性の水準で行う（#11 の O-11）
    const fullArgs = [...durabilityGitArgs(), '--git-dir', gitDir, ...(workTree ? ['--work-tree', workTree] : []), ...args];
    flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
    return execFileSync('git', fullArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }).toString();
}

/** runGitDir の、失敗しても例外にしない版。失敗したら undefined を返す（ref が無い場合の確認などに使う）。 */
function tryGitDir(gitDir: string, args: string[], workTree?: string): string | undefined {
    try {
        return runGitDir(gitDir, args, workTree);
    } catch {
        return undefined;
    }
}

/**
 * shadow の info/attributes に書く内容（#32、ADR-0012）。マイクロ履歴は、保存した中身をそのまま記録する。
 * 改行の変換（text・eol）、フィルタ（Git LFS など）、$Id$ の展開（ident）、文字コードの変換（working-tree-encoding）を、
 * ワークスペースの .gitattributes や利用者の Git の設定に関係なく止める（info/attributes がいちばん強い）。
 * これが無いと、Windows 版 Git の既定（core.autocrlf=true）で CRLF のファイルが LF に変えて記録され、
 * 過去に戻ると改行コードが変わってしまう。
 */
export const SHADOW_ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding\n';

/** この実行の中で準備を済ませた shadow（保存のたびに Git を起動しないため。#32） */
const ensured = new Set<string>();

/**
 * 作業ツリー内にネスト .git ディレクトリを置かず、
 * `.git/microgit/repos/<branch>.git`（bare）+ `.microgit/shadow/.git`（gitfile）で運用する。
 * Overlay の軽量 checkout はそのまま利用可能。
 */
export function ensureShadowRepoForBranch(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): string {
    const workTree = shadowWorkTreePath(mainRepoPath);
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    const gitMarkerPath = path.join(workTree, '.git');
    const rel0 = path.relative(workTree, bare).split(path.sep).join('/');
    // 2 回目からは、ファイルを見て確かめるだけ（Git を起動しない）
    if (
        ensured.has(bare) &&
        fs.existsSync(bare) &&
        fs.existsSync(gitMarkerPath) &&
        fs.statSync(gitMarkerPath).isFile() &&
        fs.readFileSync(gitMarkerPath, 'utf8') === `gitdir: ${rel0}\n`
    ) {
        return workTree;
    }
    fs.mkdirSync(workTree, { recursive: true });
    fs.mkdirSync(path.dirname(bare), { recursive: true });

    const gitMarker = path.join(workTree, '.git');

    // 旧来のネスト .git ディレクトリを bare へ移行
    if (fs.existsSync(gitMarker) && fs.statSync(gitMarker).isDirectory()) {
        if (!fs.existsSync(bare)) {
            fs.renameSync(gitMarker, bare);
            log?.(`レガシーなネスト .git を移行しました: ${bare}`);
        } else {
            fs.rmSync(gitMarker, { recursive: true, force: true });
            log?.('レガシーなネスト .git を削除（bare が既に存在）', 'WARN');
        }
    }

    if (!fs.existsSync(bare)) {
        flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
        execFileSync('git', ['init', '--bare', bare], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
        log?.(`bare シャドウを初期化: ${bare}`);
    }

    // worktree 側は gitfile のみ（相対パス）。親の通常コミットにネスト .git が載らない。
    const rel = path.relative(workTree, bare).split(path.sep).join('/');
    fs.writeFileSync(gitMarker, `gitdir: ${rel}\n`, 'utf8');

    // 作業ツリー設定を明示（Windows の絶対パスでも git が解決できるように）
    runGitDir(bare, ['config', 'core.bare', 'false']);
    runGitDir(bare, ['config', 'core.worktree', workTree]);

    // 保存した中身をそのまま記録する（ADR-0012）。利用者の Git の設定より shadow の設定が優先される
    runGitDir(bare, ['config', 'core.autocrlf', 'false']);
    const infoAttributes = path.join(bare, 'info', 'attributes');
    if (!fs.existsSync(infoAttributes) || fs.readFileSync(infoAttributes, 'utf8') !== SHADOW_ATTRIBUTES) {
        fs.mkdirSync(path.dirname(infoAttributes), { recursive: true });
        fs.writeFileSync(infoAttributes, SHADOW_ATTRIBUTES, 'utf8');
    }

    if (tryGitDir(bare, ['rev-parse', '--verify', 'refs/heads/micro-history']) === undefined) {
        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
    }

    ensured.add(bare);
    return workTree;
}

/** execGitAsync の結果。Git の失敗は例外でなく code（非 0）で表す。 */
interface GitResult {
    /** 終了コード。Git を起動できなかったときは -1 */
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Git を非同期に起動する（拡張機能ホストのイベントループを止めない。#72）。失敗しても reject せず、終了コードと出力を返す
 * （git push は一部の ref だけ失敗しても非 0 で終わるので、呼ぶ側が --porcelain の出力で ref ごとに判断する）
 */
const GIT_ASYNC_TIMEOUT_MS = 5 * 60 * 1000;
/** Git を非同期に起動し、終了コードと出力を返す（reject しない）。5 分で打ち切る。詳しくは直前の説明を参照。 */
function execGitAsync(args: string[]): Promise<GitResult> {
    return new Promise((resolve) => {
        execFile('git', args, {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
            // 止まった git で列が詰まらないように（push は最初の共有で全部のオブジェクトを送るので、長めに取る）
            timeout: GIT_ASYNC_TIMEOUT_MS,
        }, (err, stdout, stderr) => {
            const rawCode = (err as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
            const code = !err ? 0 : typeof rawCode === 'number' ? rawCode : -1;
            resolve({
                code,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? '') + (code === -1 && err ? err.message : ''),
            });
        });
    });
}

/** runGitDir の非同期版。起動の直前に、速い記録が貯めている分を必ず書き出させる（ADR-0015） */
function runGitDirAsync(gitDir: string, args: string[]): Promise<GitResult> {
    const fullArgs = [...durabilityGitArgs(), '--git-dir', gitDir, ...args];
    flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
    return execGitAsync(fullArgs);
}

/** shadow の履歴の先端（tip）を指すブランチ。親には <接頭辞>/micro-history として共有する。 */
const MICRO_HISTORY_REF = 'refs/heads/micro-history';

/** 親へ共有するタグ。前から mb-<数字> だけ（mb-* でも、それ以外の名前は共有しない） */
function isPublishableTag(tag: string): boolean {
    return /^mb-\d+$/.test(tag);
}

/**
 * 共有する元（micro-history があるか、共有する mb-<数字> のタグ）を調べる。
 * 前は rev-parse --verify と tag -l mb-* で Git を 2 回起動していた（#67 の計測で各約 48 ms、同期）。
 * ふつうは ref のファイル（loose と packed-refs）を直接読み、Git を起動しない（#32 と同じ考え）。
 * 呼ぶ前に flushPendingGitWrites を済ませていること（ADR-0015：貯めている ref はまだファイルに無い）。
 * reftable や SHA-256 など、ファイルで読めない形式のときだけ、Git（for-each-ref）に任せる
 */
async function listPublishSources(bare: string): Promise<{ hasTip: boolean; tags: string[] }> {
    if (!fs.existsSync(path.join(bare, 'reftable'))) {
        try {
            // readRef は 40 桁（SHA-1）のときだけ答える。答えが無ければ下の Git に任せて確かめる
            if (readRef(bare, MICRO_HISTORY_REF) !== undefined) {
                return { hasTip: true, tags: [...listTags(bare, 'mb-').keys()].filter(isPublishableTag).sort() };
            }
        } catch {
            // 読めない形（ディレクトリになったタグ名など）は Git に任せる
        }
    }
    const r = await runGitDirAsync(bare, ['for-each-ref', '--format=%(refname)', MICRO_HISTORY_REF, 'refs/tags/']);
    if (r.code !== 0) { return { hasTip: false, tags: [] }; }
    const names = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
        hasTip: names.includes(MICRO_HISTORY_REF),
        tags: names
            .filter((n) => n.startsWith('refs/tags/'))
            .map((n) => n.slice('refs/tags/'.length))
            .filter(isPublishableTag)
            .sort(),
    };
}

/**
 * git push --porcelain の ref ごとの結果（行の形は「<印>\t<元>:<先>\t<要約>」）。先の ref の名前 → 結果。
 * 印が ! のものは失敗（rejected / remote rejected）
 */
function parsePushPorcelain(stdout: string): Map<string, { ok: boolean; summary: string }> {
    const map = new Map<string, { ok: boolean; summary: string }>();
    for (const line of stdout.split('\n')) {
        const m = /^(.)\t([^\t]*):([^\t]*)\t(.*?)\r?$/.exec(line);
        if (!m) { continue; }
        map.set(m[3], { ok: m[1] !== '!', summary: m[4] });
    }
    return map;
}

/**
 * Windows のコマンドラインの長さの上限（32767 文字）を超えないように、refspec を分ける目安。
 * mb-<数字> のタグ 1 本の refspec は 50 文字ほどなので、ふつうは 1 回の push に収まる
 */
const PUSH_REFSPEC_CHARS = 24000;

/** refspec を、合計の文字数が maxChars を超えない塊に分ける（順序は保つ）。 */
function chunkRefspecs(specs: string[], maxChars: number): string[][] {
    const chunks: string[][] = [];
    let cur: string[] = [];
    let len = 0;
    for (const s of specs) {
        if (cur.length > 0 && len + s.length + 1 > maxChars) {
            chunks.push(cur);
            cur = [];
            len = 0;
        }
        cur.push(s);
        len += s.length + 1;
    }
    if (cur.length > 0) { chunks.push(cur); }
    return chunks;
}

/**
 * bare の tip / tags を親リポジトリの refs/microgit/<branch>/ へ取り込む（オブジェクトも親へコピー）。
 *
 * 親にできる ref は前と同じ：
 * - refs/heads/micro-history → <接頭辞>/micro-history（強制）
 * - refs/tags/mb-<数字> → <接頭辞>/tags/mb-<数字>（強制）。bare で消したタグは、親では消さずに残す
 *
 * 前は Git を同期（execFileSync）で 3 + タグの本数 回起動し、保存の 1.5 秒後に拡張機能ホストを毎回約 520 ms
 * 止めていた（#67 の計測、手元の Windows。push 1 回が約 210 ms）。いまは
 * - 元の ref はファイルを直接読む（listPublishSources。ふつうは Git を起動しない）
 * - micro-history を先に単独で push し（失敗したらタグへ進まない）、全部のタグを、明示した refspec を並べた
 *   1 回の push にまとめる（失敗したタグだけ 1 本ずつやり直す）。ワイルドカード
 *   （refs/tags/mb-*）にしないのは、mb-<数字> 以外の mb-* を共有しない今の決まりと、
 *   micro-history が無いときに何も共有しない動きを、そのまま保つため
 * - Git は非同期に起動する（イベントループを止めない）
 * ref ごとの成否は --porcelain の出力で見る。タグの失敗は前と同じく警告のログだけ、micro-history の失敗は例外
 */
export async function publishToParentRefs(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
    options?: { maxRefspecChars?: number },
): Promise<void> {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    if (!fs.existsSync(bare)) { return; }

    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);

    // ref のファイルを読む前に、速い記録が貯めている分を書き出させる（ADR-0015）。
    // このあと push を起動するまで await しない（その間に貯まる分は無い。push の直前にも runGitDirAsync がもう一度呼ぶ）
    flushPendingGitWrites();
    const { hasTip, tags } = await listPublishSources(bare);
    if (!hasTip) { return; }

    const tipDst = `${prefix}/micro-history`;
    const tipSpec = `${MICRO_HISTORY_REF}:${tipDst}`;
    const tagSpecs = tags.map((tag) => `refs/tags/${tag}:${prefix}/tags/${tag}`);
    const dstOf = (spec: string): string => spec.slice(spec.indexOf(':') + 1);

    /** spec を 1 回の push で送り、失敗した ref（先の名前 → 理由）を返す。ref ごとの成否は --porcelain の出力で見る */
    const pushSpecs = async (specs: string[]): Promise<Map<string, string>> => {
        const failed = new Map<string, string>();
        const r = await runGitDirAsync(bare, ['push', '--force', '--porcelain', parentGit, ...specs]);
        const status = parsePushPorcelain(r.stdout);
        for (const spec of specs) {
            const st = status.get(dstOf(spec));
            if (!st?.ok) { failed.set(dstOf(spec), st?.summary || r.stderr.trim() || `git push の終了コード ${r.code}`); }
        }
        return failed;
    };

    // micro-history を先に、単独で送る。失敗したらタグには進まない（前と同じ。同じ push に入れると、
    // micro-history が失敗してもタグだけ更新されてしまう）
    const tipFailed = await pushSpecs([tipSpec]);
    if (tipFailed.size > 0) {
        throw new Error(`親 refs へ micro-history の publish に失敗: ${[...tipFailed.values()][0]}`);
    }

    // タグはまとめて送る。壊れたタグが 1 本あるだけで全部が止まらないよう（まとめた push は、1 本でも
    // 取り込めないと全部失敗する）、失敗があれば、失敗した分だけ 1 本ずつやり直す。前は 1 本ずつ送っていて、
    // 壊れたタグは警告だけで、ほかのタグは共有されていた
    for (const chunk of chunkRefspecs(tagSpecs, options?.maxRefspecChars ?? PUSH_REFSPEC_CHARS)) {
        let failed = await pushSpecs(chunk);
        if (failed.size > 0 && chunk.length > 1) {
            const retry = chunk.filter((spec) => failed.has(dstOf(spec)));
            failed = new Map();
            for (const spec of retry) {
                for (const [dst, reason] of await pushSpecs([spec])) { failed.set(dst, reason); }
            }
        }
        for (const [dst, reason] of failed) {
            log?.(`親 refs へタグ ${dst.slice(`${prefix}/tags/`.length)} の publish に失敗: ${reason}`, 'WARN');
        }
    }
    log?.(`親 refs へ publish: ${prefix}/*`);
}

/** importFromParentRefs の結果の種類。no-remote は親に共有物が無い、initial は手元が空で採用、diverged は発散して mb-N タグで分岐を追加、error は失敗。 */
export type ImportOutcome = 'no-remote' | 'up-to-date' | 'initial' | 'fast-forward' | 'diverged' | 'error';

/** importFromParentRefs の戻り値。失敗しても例外にせず outcome に error を入れて返す。 */
export interface ImportResult {
    outcome: ImportOutcome;
    /** outcome === 'diverged' のとき、取り込み先を指す新規タグ */
    forkTag?: string;
}

/** 取り込み中の tip を、現在の tip に触れずに一時的に受ける ref。祖先判定のあとで消す。 */
const STAGING_TIP_REF = 'refs/microgit-remote/incoming';
/** 取り込み中の mb-* タグを一時的に受ける ref の接頭辞。adoptIncomingTags が採用したあとで消す。 */
const STAGING_TAG_PREFIX = 'refs/microgit-remote/tags';

/** a が b の祖先（a → b が fast-forward）なら true */
function isAncestor(gitDir: string, ancestorRef: string, descendantRef: string): boolean {
    try {
        flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
        execFileSync('git', ['--git-dir', gitDir, 'merge-base', '--is-ancestor', ancestorRef, descendantRef], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return true;
    } catch {
        return false;
    }
}

/** mb-* の次番号を払い出す（合流はしない前提の分岐専用タグ） */
function nextMbTag(gitDir: string): string {
    const stdout = tryGitDir(gitDir, ['tag', '-l', 'mb-*']) ?? '';
    let maxNum = 0;
    for (const tag of stdout.trim().split('\n').filter(Boolean)) {
        const m = tag.match(/^mb-(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxNum) { maxNum = n; }
        }
    }
    return `mb-${maxNum + 1}`;
}

/**
 * 一時領域に取り込んだ mb-* タグを bare の refs/tags へ採用する。
 * 同名タグが既に別コミットを指す場合は上書きせず、新番号で採番し直す（合流しない）。
 */
function adoptIncomingTags(gitDir: string, incomingTags: string[]): void {
    for (const tag of incomingTags) {
        const stagedRef = `${STAGING_TAG_PREFIX}/${tag}`;
        const stagedHash = tryGitDir(gitDir, ['rev-parse', '--verify', stagedRef])?.trim();
        if (!stagedHash) { continue; }
        const localHash = tryGitDir(gitDir, ['rev-parse', '--verify', `refs/tags/${tag}`])?.trim();
        if (!localHash) {
            runGitDir(gitDir, ['tag', tag, stagedHash]);
        } else if (localHash !== stagedHash) {
            runGitDir(gitDir, ['tag', nextMbTag(gitDir), stagedHash]);
        }
        tryGitDir(gitDir, ['update-ref', '-d', stagedRef]);
    }
}

/**
 * 親の refs/microgit/<branch>/ から bare へ取り込む（pull 後の他デバイス復元用）。
 *
 * 安全性方針（docs/design-policy.md §4.1）: マージはしない。分岐のみ・合流なし。
 * incoming は必ず一時 ref（refs/microgit-remote/*）へ受けてから祖先判定し、
 * refs/heads/micro-history（現在の作業 tip）は fast-forward のときだけ前進させる。
 * 発散している場合は tip に触れず、incoming 側を新規 mb-N タグとして追加するだけにする。
 */
export function importFromParentRefs(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): ImportResult {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    const workTree = shadowWorkTreePath(mainRepoPath);
    ensureShadowRepoForBranch(mainRepoPath, mainBranch, log);

    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);

    const incomingTip = tryRunParent(mainRepoPath, ['rev-parse', '--verify', `${prefix}/micro-history`]);
    if (!incomingTip) {
        log?.(`親に ${prefix}/micro-history がありません（未共有または未 publish）`);
        return { outcome: 'no-remote' };
    }
    const trimmedIncomingTip = incomingTip.trim();

    try {
        // 1) incoming は一時 ref に受ける。ここではまだ現在の tip に触れない。
        runGitDir(bare, ['fetch', parentGit, `+${prefix}/micro-history:${STAGING_TIP_REF}`]);

        const tagOut = tryRunParent(mainRepoPath, [
            'for-each-ref',
            '--format=%(refname:strip=3)',
            `${prefix}/tags`,
        ]) ?? '';
        const incomingTags = tagOut.trim().split('\n').filter((t) => /^mb-\d+$/.test(t));
        for (const tag of incomingTags) {
            try {
                runGitDir(bare, ['fetch', parentGit, `+${prefix}/tags/${tag}:${STAGING_TAG_PREFIX}/${tag}`]);
            } catch { /* ignore single tag */ }
        }

        const localTip = tryGitDir(bare, ['rev-parse', '--verify', 'refs/heads/micro-history'])?.trim();
        let outcome: ImportOutcome;
        let forkTag: string | undefined;

        if (!localTip) {
            // 初回 import: 手元にまだ何もないのでそのまま採用してよい
            runGitDir(bare, ['update-ref', 'refs/heads/micro-history', trimmedIncomingTip]);
            outcome = 'initial';
        } else if (localTip === trimmedIncomingTip) {
            outcome = 'up-to-date';
        } else if (isAncestor(bare, localTip, trimmedIncomingTip)) {
            // fast-forward: 手元の tip は incoming の祖先 → 前進させても失われるものはない
            runGitDir(bare, ['update-ref', 'refs/heads/micro-history', trimmedIncomingTip]);
            outcome = 'fast-forward';
        } else if (isAncestor(bare, trimmedIncomingTip, localTip)) {
            // 手元の方が新しい: incoming に新しい情報はないので tip はそのまま
            outcome = 'up-to-date';
        } else {
            // 発散: 上書きせず、incoming を新規 mb-N として分岐追加するだけ（合流しない）
            forkTag = nextMbTag(bare);
            runGitDir(bare, ['tag', forkTag, trimmedIncomingTip]);
            outcome = 'diverged';
        }

        adoptIncomingTags(bare, incomingTags);
        tryGitDir(bare, ['update-ref', '-d', STAGING_TIP_REF]);

        runGitDir(bare, ['symbolic-ref', 'HEAD', 'refs/heads/micro-history']);
        // 作業ツリーを（変更されたかもしれない）tip に合わせる
        tryGitDir(bare, ['checkout', '-f', 'micro-history'], workTree);

        if (outcome === 'diverged') {
            log?.(`履歴が発散していたため、新しい分岐として取り込みました: ${forkTag} (${trimmedIncomingTip.substring(0, 7)})`, 'WARN');
        } else {
            log?.(`親 refs から import: ${prefix}/* → bare (${outcome})`);
        }
        return { outcome, forkTag };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`親 refs からの import に失敗: ${message}`, 'ERROR');
        return { outcome: 'error' };
    }
}

/** 親リポジトリ（mainRepoPath）で Git を同期的に起動し、標準出力を返す。失敗したら undefined（例外にしない）。 */
function tryRunParent(mainRepoPath: string, args: string[]): string | undefined {
    try {
        flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
        return execFileSync('git', args, {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).toString();
    } catch {
        return undefined;
    }
}

/**
 * 親リポジトリの origin の **push 先** の URL を返す（`git remote get-url --push origin`。pushurl と insteadOf を適用した、実際に push される先）（無ければ undefined）。Publish の確認ダイアログに出す用。
 * 認証情報（https://user:token@...）が URL に入っていても出さないよう、取り除いてから返す。
 */
export function getOriginUrlForDisplay(mainRepoPath: string): string | undefined {
    const url = tryRunParent(mainRepoPath, ['remote', 'get-url', '--push', 'origin'])?.trim();
    return url ? maskRemoteUrl(url) : undefined;
}

/** origin があるとき refs/microgit/* を push（verEve 導入済み同士の companion 同期） */
/**
 * origin があるとき、親の refs/microgit/* を origin へ push する。成功なら true。
 * origin が無い・失敗のときは false を返し、例外にはしない（失敗はログに WARN で残す）。
 */
export function pushMicrogitRefsToOrigin(
    mainRepoPath: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): boolean {
    const origin = tryRunParent(mainRepoPath, ['config', '--get', 'remote.origin.url']);
    if (!origin?.trim()) {
        log?.('origin が無いため remote push をスキップ');
        return false;
    }
    try {
        flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
        execFileSync('git', ['push', 'origin', 'refs/microgit/*'], {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        log?.('origin へ refs/microgit/* を push しました');
        return true;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`origin への microgit refs push に失敗: ${message}`, 'WARN');
        return false;
    }
}

/** origin から refs/microgit/* を fetch */
/**
 * origin から refs/microgit/* を、親の同名の ref へ強制で fetch する。成功なら true。
 * origin が無い・失敗のときは false を返し、例外にはしない。
 */
export function fetchMicrogitRefsFromOrigin(
    mainRepoPath: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): boolean {
    const origin = tryRunParent(mainRepoPath, ['config', '--get', 'remote.origin.url']);
    if (!origin?.trim()) {
        log?.('origin が無いため remote fetch をスキップ');
        return false;
    }
    try {
        flushPendingGitWrites(); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
        execFileSync('git', ['fetch', 'origin', '+refs/microgit/*:refs/microgit/*'], {
            cwd: mainRepoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        log?.('origin から refs/microgit/* を fetch しました');
        return true;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`origin からの microgit refs fetch に失敗: ${message}`, 'WARN');
        return false;
    }
}
