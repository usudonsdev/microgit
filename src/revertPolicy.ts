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

/**
 * 反映（巻き戻し・タイムトラベル）で、書きも消しもしないパス（エディタに未保存の編集があるファイル）を集める純関数。
 * 設計方針 §2.1.1 の B: ディスクの書き換え自体を止める。読み直さないだけ（selectDocumentsToRevert）だと、
 * ディスクとエディタが食い違い、保存で上書きすると巻き戻し結果が消えるため。
 * Git の checkout が dirty なファイルの上書きを拒むのと同じ向き。除外したパスは、保存すると新しい記録になる。
 */
export function selectDirtyPaths(docs: readonly OpenDocInfo[]): Set<string> {
    const out = new Set<string>();
    for (const d of docs) {
        if (d.rel && d.isDirty) { out.add(d.rel); }
    }
    return out;
}
