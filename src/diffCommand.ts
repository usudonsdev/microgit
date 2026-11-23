/**
 * コマンド vereve.showStructuredDiff：マイクロ履歴の 1 つの保存で何が変わったかを、形式を理解して見せる（docs/structured-diff.md）。
 * - 引数（コミット、パス）が無ければ、最近の保存とファイルを選ばせる
 * - 比べるのは、その保存（コミット）と 1 つ前の保存（最初の親）の、そのファイルの中身。どちらも shadow の Git の blob で、正本のバイト列そのもの
 * - テキストは VS Code の差分エディタ（vereve-blob: の仮想文書）で開く。それ以外は diff/runner.ts に計算させ、diffView.ts で表示する
 * - 計算は別プロセスで、時間の上限（vereve.diff.timeoutSeconds）付き。通知の「キャンセル」で止められる。結果は .microgit/diff-cache にキャッシュする
 * Git の呼び出しは deps.git（extension.ts の runGit 系。速い記録の書き出しを先に吐き出させる。ADR-0015）を通す。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { computeDiff } from './diff/runner';
import { selectDriver } from './diff/registry';
import { DiffView } from './diffView';
import { findInPath } from './kernel/launchers';
import type { StructuredDiff } from './diff/types';
import { MICROGIT_ROOT_NAME } from './layout';

export interface DiffCommandDeps {
    /** ワークスペースの根（開いていなければ undefined） */
    rootPath(): string | undefined;
    /** shadow の作業ツリー（.microgit/shadow） */
    shadowPath(rootPath: string): string;
    /** shadow で Git を動かして標準出力（文字列）を返す。失敗は例外 */
    git(cwd: string, args: string[]): Promise<string>;
    /** shadow の blob を読む。無ければ undefined */
    readBlob(cwd: string, rev: string, relPath: string): Promise<Buffer | undefined>;
    log(message: string, level?: 'INFO' | 'WARN' | 'ERROR'): void;
}

/** コミット・パスに使ってよい文字か（Git の引数に渡す前に確かめる） */
const SAFE_REV = /^[0-9a-f]{7,64}$/;

export const BLOB_SCHEME = 'vereve-blob';

export function registerStructuredDiff(context: vscode.ExtensionContext, deps: DiffCommandDeps): { view: DiffView; last: () => StructuredDiff | undefined } {
    const view = new DiffView();
    let lastDiff: StructuredDiff | undefined;
    context.subscriptions.push({ dispose: () => view.dispose() });

    // テキストの差分エディタ用の仮想文書。vereve-blob:/<パス>?<コミット>（コミットが空なら空の文書）
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, {
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            const root = deps.rootPath();
            const rev = uri.query;
            const rel = uri.path.replace(/^\//, '');
            if (!root || !rev || !SAFE_REV.test(rev)) { return ''; }
            const b = await deps.readBlob(deps.shadowPath(root), rev, rel);
            return b ? b.toString('utf8') : '';
        },
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vereve.showStructuredDiff', async (hashArg?: string, relArg?: string) => {
        const root = deps.rootPath();
        if (!root) { vscode.window.showWarningMessage('ワークスペースを開いてから差分を見てください。'); return; }
        const shadow = deps.shadowPath(root);
        if (!fs.existsSync(shadow)) { vscode.window.showWarningMessage('[verEve] マイクロ履歴がまだありません。'); return; }
        let hash = typeof hashArg === 'string' ? hashArg : undefined;
        if (!hash) { hash = await pickCommit(deps, shadow); if (!hash) { return; } }
        if (!SAFE_REV.test(hash)) { vscode.window.showErrorMessage('不正なコミットの指定です。'); return; }
        const changed = await changedFiles(deps, shadow, hash);
        if (changed.length === 0) { vscode.window.showInformationMessage('[verEve] この保存で変わったファイルはありません。'); return; }
        let target = typeof relArg === 'string' ? changed.find((c) => c.path === relArg) : undefined;
        if (!target) {
            if (changed.length === 1) { target = changed[0]; } else {
                const pick = await vscode.window.showQuickPick(
                    changed.map((c) => ({ label: c.path, description: c.status === 'A' ? '追加' : c.status === 'D' ? '削除' : '変更', item: c })),
                    { placeHolder: '差分を見るファイル' },
                );
                if (!pick) { return; }
                target = pick.item;
            }
        }
        const parent = await firstParent(deps, shadow, hash);
        const oldBytes = parent && target.status !== 'A' ? await deps.readBlob(shadow, parent, target.path) : undefined;
        const newBytes = target.status !== 'D' ? await deps.readBlob(shadow, hash, target.path) : undefined;
        const head = (newBytes ?? oldBytes ?? Buffer.alloc(0)).subarray(0, 4096);
        const driver = selectDriver(target.path, head);
        const shortHash = hash.slice(0, 7);
        if (driver.id === 'text') {
            const left = vscode.Uri.from({ scheme: BLOB_SCHEME, path: '/' + target.path, query: oldBytes && parent ? parent : '' });
            const right = vscode.Uri.from({ scheme: BLOB_SCHEME, path: '/' + target.path, query: newBytes ? hash : '' });
            await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(target.path)}（${shortHash} の保存）`);
            return;
        }
        const cfg = vscode.workspace.getConfiguration();
        const timeoutSec = Math.max(5, cfg.get<number>('vereve.diff.timeoutSeconds', 120));
        const tools = resolveTools(cfg.get<string>('vereve.diff.ffmpegPath', ''));
        const cacheDir = path.join(root, MICROGIT_ROOT_NAME, 'diff-cache');
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `[verEve] ${path.posix.basename(target.path)} の差分を計算しています`,
            cancellable: true,
        }, async (_p, token) => {
            const ac = new AbortController();
            const sub = token.onCancellationRequested(() => ac.abort());
            try {
                return await computeDiff({ path: target!.path, oldBytes, newBytes, cacheDir, tools, timeoutMs: timeoutSec * 1000, signal: ac.signal });
            } finally { sub.dispose(); }
        });
        lastDiff = result;
        deps.log(`[差分] ${target.path} @ ${shortHash}: ${result.kind} ${result.summary}`);
        view.show({
            title: `${target.path}`,
            subtitle: `${parent ? parent.slice(0, 7) : '（なし）'} → ${shortHash} の保存`,
            diff: result,
            driverLabel: driver.label,
        });
    }));

    // テスト用（package.json には出さない）：最後に表示した差分の結果を返す
    context.subscriptions.push(vscode.commands.registerCommand('vereve.internal.lastStructuredDiff', () => lastDiff));
    return { view, last: () => lastDiff };
}

/** ffmpeg と ffprobe の場所。設定があればそれ（ffprobe は同じフォルダ）、無ければ PATH から探す */
export function resolveTools(setting: string): { ffmpegPath?: string; ffprobePath?: string } {
    const exe = process.platform === 'win32' ? '.exe' : '';
    if (setting) {
        const dir = path.dirname(setting);
        const probe = path.join(dir, `ffprobe${exe}`);
        return { ffmpegPath: fs.existsSync(setting) ? setting : undefined, ffprobePath: fs.existsSync(probe) ? probe : undefined };
    }
    const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    return {
        ffmpegPath: findInPath('ffmpeg', process.env, process.platform, exists),
        ffprobePath: findInPath('ffprobe', process.env, process.platform, exists),
    };
}

async function pickCommit(deps: DiffCommandDeps, shadow: string): Promise<string | undefined> {
    let out = '';
    try {
        out = await deps.git(shadow, ['log', '-n', '200', '-z', '--pretty=format:%H%x01%s%x01%ct%x01%D']);
    } catch { /* まだコミットが無い */ }
    const items = out.split('\0').filter(Boolean).map((r) => {
        const [h, subject, ct, refs] = r.split('\x01');
        const tag = /tag: (mb-\d+)/.exec(refs ?? '')?.[1];
        return { label: subject || h.slice(0, 7), description: `${tag ? tag + ' ' : ''}${h.slice(0, 7)}`, detail: new Date(Number(ct) * 1000).toLocaleString(), hash: h };
    });
    if (items.length === 0) { vscode.window.showInformationMessage('[verEve] マイクロ履歴がまだありません。'); return undefined; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: '差分を見る保存（新しい順）', matchOnDescription: true });
    return pick?.hash;
}

interface ChangedFile { path: string; status: 'A' | 'M' | 'D' }

/** その保存で変わったファイル（最初の親との差。最初の保存なら全部が追加） */
async function changedFiles(deps: DiffCommandDeps, shadow: string, hash: string): Promise<ChangedFile[]> {
    const out = await deps.git(shadow, ['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '--name-status', '-z', hash]);
    const parts = out.split('\0').filter((x) => x !== '');
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const st = parts[i][0];
        const p = parts[i + 1];
        if (p.startsWith(`${MICROGIT_ROOT_NAME}/`)) { continue; }
        files.push({ path: p, status: st === 'A' ? 'A' : st === 'D' ? 'D' : 'M' });
    }
    return files;
}

async function firstParent(deps: DiffCommandDeps, shadow: string, hash: string): Promise<string | undefined> {
    try {
        const out = (await deps.git(shadow, ['rev-list', '--parents', '-n', '1', hash])).trim().split(/\s+/);
        return out[1] && SAFE_REV.test(out[1]) ? out[1] : undefined;
    } catch { return undefined; }
}
