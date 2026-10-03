/**
 * まだ書き出していない Git のファイルの「関所」（ADR-0015、#49）。
 *
 * 速い記録は、保存のときはジャーナルに書いて確定させるだけで、Git の形式のファイル（オブジェクト・index・ref）は
 * メモリに貯めておき、保存が落ち着いてから書き出す。そのため、隠しリポジトリを Git のコマンドや直接のファイル読みで
 * 見る処理は、その前に flushPendingGitWrites() を呼んで、貯めている分を書き出させる。
 *
 * 書き出す側（拡張機能の速い記録）は registerPendingFlusher で登録する。貯めている分が無ければ何もしないので、
 * Git を起動する場所すべてで、気にせず呼んでよい（費用は登録した関数を呼ぶだけ）。
 */
const flushers = new Set<(target?: string) => void>();

/** 書き出す関数を登録する。target は読む場所（Git を起動する作業フォルダや Git のディレクトリ）。戻り値を呼ぶと登録を外す */
export function registerPendingFlusher(flush: (target?: string) => void): () => void {
    flushers.add(flush);
    return () => { flushers.delete(flush); };
}

/**
 * 貯めている Git のファイルを書き出させる。Git の履歴を読む・書く処理の前に呼ぶ。
 * target を渡すと、その場所に関係する分だけ（ふつうのリポジトリへの Git の呼び出しで、隠しリポジトリを書き出さない）。
 * 渡さなければ全部
 */
export function flushPendingGitWrites(target?: string): void {
    for (const flush of flushers) { flush(target); }
}
