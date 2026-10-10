/**
 * 保存のたびにステータスバーへ出す一時メッセージの判断と文言（#68）。
 *
 * 合格の基準は「保存のときに、利用者がマイクロコミットされていることに気づかない」ことなので、
 * 既定では何も出さない。設定 microgit.showSaveStatus を true にすると、これまでどおり出す。
 *
 * VS Code に依存しない（単体テストで確かめるため）。
 */

export type SaveStatusResult =
    | { kind: 'created'; commit: string; tag: string }
    | { kind: 'rewound'; commit: string };

/** 出す文字列。出さないときは undefined */
export function saveStatusMessage(show: boolean, result: SaveStatusResult): string | undefined {
    if (!show) { return undefined; }
    const short = result.commit.substring(0, 7);
    return result.kind === 'created'
        ? `[MicroGit] 記録 ${short} · ${result.tag}`
        : `[MicroGit] 同一変更のため HEAD のみ復帰 ${short}`;
}
