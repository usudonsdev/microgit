/**
 * fsync の回数と時間を数える（#45）。記録が遅いとき、fsync（ディスクへの書き込みの確定）が遅いのか、
 * ファイルの作成などほかの所が遅いのかを見分けるため。
 */
import * as fs from 'fs';

/** fsync・fdatasync の累計（回数と、かかった合計ミリ秒）。プロセスの中で共有するグローバルな状態で、timedFdatasync・timedFsync が足す */
export const fsyncStats = { count: 0, ms: 0 };

/** fs.fdatasyncSync と同じ（ジャーナルの追記の確定）。回数と時間を fsyncStats に足す */
export function timedFdatasync(fd: number): void {
    const t = performance.now();
    try {
        fs.fdatasyncSync(fd);
    } finally {
        fsyncStats.count++;
        fsyncStats.ms += performance.now() - t;
    }
}

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
