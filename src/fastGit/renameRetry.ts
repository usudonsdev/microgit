/**
 * 上書きの rename を、Windows で少し待ってやり直す。
 *
 * Windows では、ほかのプロセス（ウイルス対策、検索のインデックス、エディタなど）が置き換え先のファイルを
 * 開いていると、上書きの rename（MoveFileEx）が EPERM・EACCES・EBUSY で失敗する。開いているのは一瞬なので、
 * Git for Windows も同じように、少し待ってやり直している（compat/mingw.c の mingw_rename）。
 *
 * 同じプロセスの中の非同期の処理が開いているファイルには効かない（待っている間はその処理も進まない）。
 * そちらはジャーナルのチェックポイントで、上書きされうるファイルを同期で確定させて防ぐ（journal.ts）。
 */
import * as fs from 'fs';

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** 待つ時間（ミリ秒）。合わせて約 0.2 秒 */
const DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 80];

export const renameRetryStats = { retries: 0 };

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function renameReplaceSync(from: string, to: string): void {
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? '';
            if (process.platform !== 'win32' || !RETRY_CODES.has(code) || i >= DELAYS_MS.length) { throw e; }
            renameRetryStats.retries++;
            sleepSync(DELAYS_MS[i]);
        }
    }
}
