/**
 * 反映（巻き戻し・タイムトラベル）でディスクの中身が変わった文書のうち、エディタで読み直してよいものを選ぶ純関数。
 * vscode API に依存させないのは、単体テスト（VS Code を起動しない）で確かめるため。
 *
 * なぜ dirty な文書を読み直さないか: `workbench.action.files.revert` は未保存の編集を黙って捨てる。
 * 保存時の自動巻き戻し（rewound）は「保存したファイル以外」も書き換えるので、別タブで編集中のファイルの
 * 未保存の編集が、確認なしに消えていた（診断 S-15）。読み直さなければ、エディタの内容は残り、
 * 次に保存するときに VS Code が「ディスク上で新しくなっている」と衝突を知らせる（比較・上書きを利用者が選べる）。
 */

/** 開いている文書のうち、判断に要る情報だけ */
export interface OpenDocInfo {
    /** ワークスペース相対の POSIX パス。ワークスペース外なら undefined */
    rel: string | undefined;
    /** 未保存の編集があるか（vscode.TextDocument.isDirty） */
    isDirty: boolean;
}

export interface RevertSelection<T extends OpenDocInfo> {
    /** 読み直してよい文書（反映で変わり、未保存の編集が無い） */
    revert: T[];
    /** 反映で変わったが、未保存の編集があるため読み直さなかった文書 */
    skippedDirty: T[];
}

export function selectDocumentsToRevert<T extends OpenDocInfo>(docs: readonly T[], touched: ReadonlySet<string>): RevertSelection<T> {
    const revert: T[] = [];
    const skippedDirty: T[] = [];
    for (const d of docs) {
        if (!d.rel || !touched.has(d.rel)) { continue; }
        (d.isDirty ? skippedDirty : revert).push(d);
    }
    return { revert, skippedDirty };
}
