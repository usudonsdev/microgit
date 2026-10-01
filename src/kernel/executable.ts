/**
 * 同梱の実行ファイルに実行ビットが無ければ付ける（#19）。
 *
 * VSIX は zip で、Windows で作ると実行ビットが落ちる（vsce の文書）。Linux で作れば残り、VS Code は
 * 展開するときに zip に記録されたモードを付ける。それでも作り方を間違えたときに備え、起動の前に確かめる。
 * 拡張機能のフォルダは利用者のものなので、普通は付けられる。付けられなければ理由を返す（呼ぶ側は Node.js 版に切り替える）。
 *
 * VS Code に依存しない（単体テストで本物のファイルを使って確かめるため）。
 */
import * as fs from 'fs';

/** 付けたら true、もとから付いていたら false。付けられなければ例外 */
export function makeExecutable(file: string): boolean {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) === 0o111) { return false; }
    fs.chmodSync(file, mode | 0o755);
    return true;
}

/** LauncherDeps.ensureExecutable の形：付けられなければ理由を返す */
export function ensureExecutable(file: string, log?: (message: string) => void): string | undefined {
    try {
        if (makeExecutable(file)) { log?.(`[Kernel] 実行ビットを付けた: ${file}`); }
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
