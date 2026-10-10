import { execFileSync } from 'child_process';
import { timeSync, timeGit, noteWork } from './syncWorkLog';
import * as fs from 'fs';
import * as path from 'path';
import { durabilityGitArgs } from './durability';
import { flushPendingGitWrites } from './fastGit/pendingWrites';
import { shadowDir } from './layout';

export function sanitizeBranchKey(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function shadowWorkTreePath(mainRepoPath: string): string {
    return shadowDir(mainRepoPath);
}

export function bareGitDirPath(mainRepoPath: string, mainBranch: string): string {
    return path.join(mainRepoPath, '.git', 'microgit', 'repos', `${sanitizeBranchKey(mainBranch)}.git`);
}

export function parentMicroRefPrefix(mainBranch: string): string {
    return `refs/microgit/${sanitizeBranchKey(mainBranch)}`;
}

function runGitDir(gitDir: string, args: string[], workTree?: string): string {
    // shadow の bare への書き込み（update-ref など）も、設定した永続性の水準で行う（#11 の O-11）
    const fullArgs = [...durabilityGitArgs(), '--git-dir', gitDir, ...(workTree ? ['--work-tree', workTree] : []), ...args];
    timeSync('flushPendingGitWrites', () => flushPendingGitWrites()); // 速い記録が貯めている分を先に書き出させる（ADR-0015）
    return timeGit(args, () => execFileSync('git', fullArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }).toString());
}

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

/** bare の tip / tags を親リポジトリの refs/microgit/<branch>/ へ取り込む（オブジェクトも親へコピー） */
export function publishToParentRefs(
    mainRepoPath: string,
    mainBranch: string,
    log?: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void,
): void {
    const bare = bareGitDirPath(mainRepoPath, mainBranch);
    if (!fs.existsSync(bare)) { return; }

    const parentGit = path.join(mainRepoPath, '.git');
    const prefix = parentMicroRefPrefix(mainBranch);

    if (tryGitDir(bare, ['rev-parse', '--verify', 'refs/heads/micro-history']) === undefined) {
        return;
    }

    runGitDir(bare, [
        'push',
        '--force',
        parentGit,
        `refs/heads/micro-history:${prefix}/micro-history`,
    ]);

    const tags = (tryGitDir(bare, ['tag', '-l', 'mb-*']) ?? '')
        .trim()
        .split('\n')
        .filter(Boolean);
    noteWork('publish.mbTags', tags.length);
    for (const tag of tags) {
        if (!/^mb-\d+$/.test(tag)) { continue; }
        try {
            runGitDir(bare, [
                'push',
                '--force',
                parentGit,
                `refs/tags/${tag}:${prefix}/tags/${tag}`,
            ]);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log?.(`親 refs へタグ ${tag} の publish に失敗: ${message}`, 'WARN');
        }
    }
    log?.(`親 refs へ publish: ${prefix}/*`);
}

export type ImportOutcome = 'no-remote' | 'up-to-date' | 'initial' | 'fast-forward' | 'diverged' | 'error';

export interface ImportResult {
    outcome: ImportOutcome;
    /** outcome === 'diverged' のとき、取り込み先を指す新規タグ */
    forkTag?: string;
}

const STAGING_TIP_REF = 'refs/microgit-remote/incoming';
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

/** origin があるとき refs/microgit/* を push（MicroGit 導入済み同士の companion 同期） */
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
