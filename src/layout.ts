/**
 * `.microgit/` の置き場所を決める。shadow・logs・overlay のパスを返す関数は、
 * 呼ぶたびに古い 3 フォルダ（`.microgit_*`）の移行を先に済ませる（何度呼んでも同じ結果）。
 * 以下の長いコメントは、置き場所をまとめた理由と、移行の規則。
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * ワークスペースに出す生成物は `.microgit/` 1 つにまとめる（2026-10-07）。
 * 直下に shadow・logs・overlay が並ぶと、エクスプローラーで 3 フォルダ分の場所を取る。
 * 正本の Git オブジェクトは従来どおり親リポジトリの `.git/microgit/repos/` にあり、ここは作業ツリーとキャッシュだけ。
 *
 * 以前の `.microgit_shadow` / `.microgit_logs` / `.microgit_overlay` は、新しい場所が空なら丸ごと移す。
 * 新しい場所に同じ名前が既にあるときは、ぶつからないものだけ移し、残った古いフォルダは消さない。
 */
export const MICROGIT_ROOT_NAME = '.microgit';

/** 移行元の古いフォルダ名（5.1.1 より前）。キーは、移行先の `.microgit/` の下の名前（shadow・logs・overlay）と同じ。 */
export const LEGACY_MICROGIT_DIRS = {
    shadow: '.microgit_shadow',
    logs: '.microgit_logs',
    overlay: '.microgit_overlay',
} as const;

/** `.microgit/` のパス（作らない）。 */
export function microgitRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, MICROGIT_ROOT_NAME);
}

/** shadow のフォルダ `.microgit/shadow` のパス。呼ぶたびに、古い配置が残っていれば移す（migrateLegacyMicrogitLayout）。 */
export function shadowDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'shadow');
}

/** ログ類のフォルダ `.microgit/logs` のパス。古い配置が残っていれば移す。 */
export function logsDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'logs');
}

/** Overlay（層・ビュー・merge）のフォルダ `.microgit/overlay` のパス。古い配置が残っていれば移す。 */
export function overlayDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'overlay');
}

/** AI 編集でマークされたパスの一覧 `.microgit/logs/ai-pending.json` のパス（extension.ts の consumeAiPending が読み、見つけたパスを 1 件外して書き戻す。このリポジトリにパスを足す処理は無い）。 */
export function aiPendingPath(workspaceRoot: string): string {
    return path.join(logsDir(workspaceRoot), 'ai-pending.json');
}

/**
 * src を dest へ移す。dest が無ければ丸ごと移す（rename、だめならコピーして消す）。
 * dest があれば、dest に同名が無いものだけ 1 つずつ移し、同名は動かさない。移し終えて src が空になったら src を消す（空にならなければ残す）。
 */
function relocateTree(src: string, dest: string): void {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
            fs.renameSync(src, dest);
            return;
        } catch {
            fs.cpSync(src, dest, { recursive: true });
            fs.rmSync(src, { recursive: true, force: true });
            return;
        }
    }
    for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (fs.existsSync(to)) { continue; }
        try {
            fs.renameSync(from, to);
        } catch {
            fs.cpSync(from, to, { recursive: true });
            fs.rmSync(from, { recursive: true, force: true });
        }
    }
    if (fs.readdirSync(src).length === 0) {
        fs.rmdirSync(src);
    }
}

/** 古い 3 フォルダが残っていれば `.microgit/` の下へ移す。何度呼んでも同じ結果になる。 */
export function migrateLegacyMicrogitLayout(workspaceRoot: string): void {
    const root = microgitRoot(workspaceRoot);
    for (const [child, legacyName] of Object.entries(LEGACY_MICROGIT_DIRS)) {
        const src = path.join(workspaceRoot, legacyName);
        if (!fs.existsSync(src)) { continue; }
        fs.mkdirSync(root, { recursive: true });
        relocateTree(src, path.join(root, child));
    }
}
