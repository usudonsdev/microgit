/**
 * 旧 MicroGit（拡張 ID usudonsdev.microgit）が同時に有効かどうかの判定（6.0.0 の改名。docs/rename-vereve.md）。
 *
 * なぜ記録を止めるか：verEve は履歴の置き場（親の .git/microgit/repos/、作業ツリーの .microgit/、refs/microgit/*）を
 * 旧 MicroGit と共有する（既存の履歴を読めなくしないため、改名しなかった。docs/design-policy.md）。両方が有効だと、
 * 保存のたびに 2 つの拡張が同じ shadow リポジトリへマイクロコミットし、ロックの取り合い・二重コミット・ジャーナルの競合が起きる。
 * どちらかを止めるのは旧拡張の側を利用者に頼むしかない（拡張機能から他の拡張を無効化する API は無い）ので、
 * verEve が身を引く：記録を始めず、警告を出す。
 *
 * このファイルは vscode API を import しない（単体テストのため）。vscode.extensions.getExtension を lookup として渡してもらう。
 * getExtension は「インストールされていて、有効な」拡張だけを返す（無効化された拡張は返らない）ので、見つかった = 有効、と扱う。
 * まだ activate されていない（isActive が false）旧拡張も、いずれ activate して記録を始めるので、衝突とみなす。
 */

/** 旧拡張の拡張 ID（publisher.name）。 */
export const LEGACY_EXTENSION_ID = 'usudonsdev.microgit';

/** 利用者への警告の文面（先頭に [verEve] を付けて出す）。 */
export const LEGACY_CONFLICT_WARNING =
    '旧 MicroGit が有効です。旧拡張を無効化またはアンインストールしてから再読み込みしてください';

export interface LegacyConflict {
    /** true なら、verEve は記録を始めない。 */
    blocked: boolean;
    /** blocked のときだけ、利用者へ出す警告。 */
    warning?: string;
}

/** lookup（vscode.extensions.getExtension）で旧拡張を探し、有効なら blocked を返す。 */
export function evaluateLegacyConflict(lookup: (extensionId: string) => unknown): LegacyConflict {
    return lookup(LEGACY_EXTENSION_ID) === undefined
        ? { blocked: false }
        : { blocked: true, warning: LEGACY_CONFLICT_WARNING };
}
