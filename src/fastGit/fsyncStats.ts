/**
 * fsync の回数と時間を数える（#45）。記録が遅いとき、fsync（ディスクへの書き込みの確定）が遅いのか、
 * ファイルの作成などほかの所が遅いのかを見分けるため。
 */
import * as fs from 'fs';

export const fsyncStats = { count: 0, ms: 0 };

/** fs.fsyncSync と同じ。回数と時間を fsyncStats に足す */
export function timedFsync(fd: number): void {
    const t = performance.now();
    try {
        fs.fsyncSync(fd);
    } finally {
        fsyncStats.count++;
        fsyncStats.ms += performance.now() - t;
    }
}
