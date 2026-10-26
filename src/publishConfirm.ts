/**
 * Publish の前の確認ダイアログの文面を作る、vscode に依存しない純関数（単体テストのため ui.ts などから切り出した）。
 *
 * なぜ確認するか：microgit.publishMicroHistory は `git push origin refs/microgit/*` を行う。
 * `refs/microgit/*` には、今のブランチだけでなく **記録してきた全ブランチ** のマイクロ履歴
 * （保存のたびのファイルの中身。.gitignore で除外していても、記録の対象だったものは入りうる）が入る。
 * 利用者が「今のブランチを共有する」つもりで押すと、意図より広く外に出る（診断 S-15）ので、送る前に見せて同意を取る。
 * 確認を省く設定は、設計判断（共有の方針）が要るので、まだ作っていない（docs/design-policy.md）。
 */

/**
 * リモートの URL から、認証情報（https://user:token@host/... の user:token@ の部分）を取り除く。
 * ダイアログとログに PAT を出さないため。ssh の `git@host:path` 形式の `git@` は認証情報ではないので残す。
 */
export function maskRemoteUrl(url: string): string {
    return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1');
}

/** 確認ダイアログの本文。originUrl は maskRemoteUrl を通したものを渡す。 */
export function buildPublishConfirmMessage(originUrl: string, currentBranch: string): string {
    return [
        `origin（${originUrl}）へ、MicroGit の履歴 refs/microgit/* をすべて push します。`,
        `現在のブランチ（${currentBranch}）だけではなく、記録してきた全ブランチのマイクロ履歴が対象です。`,
        `履歴には、保存のたびのファイルの中身が入っています。送ったあとは、origin にアクセスできる人が読めます。`,
    ].join('\n');
}
