/**
 * Publish の前の確認ダイアログの文面を作る、vscode に依存しない純関数（単体テストのため ui.ts などから切り出した）。
 *
 * なぜ確認するか：vereve.publishMicroHistory は `git push origin refs/microgit/*` を行う。
 * `refs/microgit/*` には、今のブランチだけでなく **記録してきた全ブランチ** のマイクロ履歴
 * （保存のたびのファイルの中身。.gitignore で除外していても、記録の対象だったものは入りうる）が入る。
 * 利用者が「今のブランチを共有する」つもりで押すと、意図より広く外に出る（診断 S-15）ので、送る前に見せて同意を取る。
 * 確認を省く設定は、設計判断（共有の方針）が要るので、まだ作っていない（docs/design-policy.md）。
 */

/** 既知のトークンの形（GitHub の PAT など）。パスに埋め込まれていても伏せる */
const TOKEN_LIKE = /(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]+/g;

/**
 * リモートの URL を、ダイアログとログに出してよい形にする（PAT などの秘密を出さない）。
 * - クエリ（?...）とフラグメント（#...）は全部落とす（?token= など）
 * - `scheme://` の形：ユーザー情報は「最後の @ まで」を落とす。パスワードに生の @ や / が入っていても漏れない
 *   （代わりに、パスの中に @ がある URL は、その手前も落ちる。秘密を出さないことを優先する）。ssh://git@host の git@ も落ちる
 * - scp 形式（user@host:path）：ユーザー名だけなら残す（git@github.com:a/b.git）。user:tok@host:path のように : を含むなら全部落とす
 * - 既知のトークンの形がパスに残っていたら *** にする
 */
export function maskRemoteUrl(url: string): string {
    let u = url.trim().replace(/[?#].*$/s, '');
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(u);
    if (scheme) {
        const rest = u.slice(scheme[0].length);
        const at = rest.lastIndexOf('@');
        u = scheme[0] + (at >= 0 ? rest.slice(at + 1) : rest);
    } else {
        const at = u.lastIndexOf('@');
        if (at >= 0 && u.slice(0, at).includes(':')) {
            u = u.slice(at + 1);
        }
    }
    return u.replace(TOKEN_LIKE, '***');
}

/** 確認ダイアログの本文。originUrl は maskRemoteUrl を通したものを渡す。 */
export function buildPublishConfirmMessage(originUrl: string, currentBranch: string): string {
    return [
        `origin（${originUrl}）へ、verEve の履歴 refs/microgit/* をすべて push します。`,
        `現在のブランチ（${currentBranch}）だけではなく、記録してきた全ブランチのマイクロ履歴が対象です。`,
        `履歴には、保存のたびのファイルの中身が入っています。送ったあとは、origin にアクセスできる人が読めます。`,
    ].join('\n');
}
