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

export const LEGACY_MICROGIT_DIRS = {
    shadow: '.microgit_shadow',
    logs: '.microgit_logs',
    overlay: '.microgit_overlay',
} as const;

export function microgitRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, MICROGIT_ROOT_NAME);
}

export function shadowDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'shadow');
}

export function logsDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'logs');
}

export function overlayDir(workspaceRoot: string): string {
    migrateLegacyMicrogitLayout(workspaceRoot);
    return path.join(microgitRoot(workspaceRoot), 'overlay');
}

export function aiPendingPath(workspaceRoot: string): string {
    return path.join(logsDir(workspaceRoot), 'ai-pending.json');
}

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
