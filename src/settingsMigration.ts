/**
 * 旧 MicroGit（拡張 ID usudonsdev.microgit）の設定 `microgit.*` を、verEve の設定 `vereve.*` へ引き継ぐ計画を立てる（6.0.0 の改名。docs/rename-vereve.md）。
 *
 * なぜ要るか：拡張 ID が変わる（Marketplace では ID を変えられない）ので、利用者の settings.json に残った旧キーは、
 * 新しい拡張には読まれない。何もしないと、設定を変えていた人の設定が黙って既定値に戻る。
 *
 * このファイルは vscode API を import しない純関数だけにする（単体テストのため）。
 * 設定を実際に読み書きして通知する側は extension.ts の migrateLegacySettings。
 *
 * 規則（変えるときは docs/design-policy.md の改名の節も直す）：
 *  - 旧キーに値があり、同じ範囲（グローバル / ワークスペース）の新キーが未設定のときだけ、新キーへ値をそのままコピーする。
 *    新キーに利用者が既に書いた値は、絶対に上書きしない。
 *  - 旧キーは消さない。旧拡張が残っていても壊さない・利用者が自分で整理できるようにするため。
 *  - ワークスペースフォルダ単位の設定（workspaceFolderValue）は扱わない。マルチルートで範囲が曖昧になり、取り違えると
 *    別フォルダの設定を書き換えるため。必要なら利用者が手で直す（README の移行手順に書く）。
 */

/** 引き継ぐ設定の、接頭辞（microgit. / vereve.）を除いた名前。package.json の contributes.configuration と一致すること（単体テストが確かめる）。 */
export const MIGRATED_SETTING_NAMES = [
    'useOverlayCheckout',
    'showSaveStatus',
    'durability',
    'fastMicroCommit',
    'overlayBackend',
    'kernel.qemuPath',
    'kernel.accel',
    'kernel.memoryMb',
] as const;

export const LEGACY_SETTING_PREFIX = 'microgit.';
export const SETTING_PREFIX = 'vereve.';

/** 設定の範囲。グローバルは利用者の settings.json、ワークスペースは .vscode/settings.json（または .code-workspace）。 */
export type SettingScope = 'global' | 'workspace';

/** 1 つの設定キーについて、範囲ごとに書かれている値。書かれていなければ undefined（inspect の globalValue / workspaceValue と同じ意味）。 */
export interface ScopedValues {
    global?: unknown;
    workspace?: unknown;
}

/** 新キーへ書く 1 件。key は接頭辞つきの新しいキー（例 vereve.kernel.qemuPath）。 */
export interface SettingWrite {
    key: string;
    scope: SettingScope;
    value: unknown;
}

/**
 * 引き継ぎで書くべき設定の一覧を返す。
 * @param scopes 今回扱う範囲（ワークスペースが開いていないときは ['global'] だけにする）
 * @param oldValues 接頭辞を除いた名前 → 旧キーの値
 * @param newValues 接頭辞を除いた名前 → 新キーの値
 */
export function planSettingsMigration(
    scopes: readonly SettingScope[],
    oldValues: Readonly<Record<string, ScopedValues | undefined>>,
    newValues: Readonly<Record<string, ScopedValues | undefined>>,
): SettingWrite[] {
    const writes: SettingWrite[] = [];
    for (const name of MIGRATED_SETTING_NAMES) {
        for (const scope of scopes) {
            const before = oldValues[name]?.[scope];
            if (before === undefined) { continue; }
            if (newValues[name]?.[scope] !== undefined) { continue; }
            writes.push({ key: SETTING_PREFIX + name, scope, value: before });
        }
    }
    return writes;
}

/** 通知の文面。引き継いだ件数が 0 のときは undefined（何も通知しない）。 */
export function settingsMigrationMessage(writes: readonly SettingWrite[]): string | undefined {
    if (writes.length === 0) { return undefined; }
    const keys = [...new Set(writes.map((w) => w.key))].join('、');
    return `旧 MicroGit の設定 ${writes.length} 件を verEve の設定に引き継ぎました（${keys}）。旧い microgit.* の設定は残してあります。不要なら settings.json から消してください。`;
}
