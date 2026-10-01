import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const OVERLAY_DIR = '.microgit_overlay';

/**
 * レイヤの形式（#21）。
 * v1: whiteout を層の中に `.wh.<名前>` という空ファイルで置いていた（AUFS／OCI 方式）。
 *     利用者の `.wh.` で始まるファイルと区別できず、そのファイルが消えた（N-5）。
 * v2: whiteout を層の外のメタデータ `<層のディレクトリ>.json` に持つ。層の中は利用者のファイルだけになる。
 *     メタデータは書き出しの最後に置くので、「メタデータがある＝書き出しが最後まで終わった層」でもある。
 */
export const LAYER_FORMAT_VERSION = 2;

type LayerMeta = {
    version: number;
    /** この層で消えたパス（`/` 区切りの相対パス）。下の層のファイルやディレクトリを隠す */
    whiteouts: string[];
};

/** 展開済みビューの完成マーカー（list / sync 対象外） */
const VIEW_OK_MARKER = '.microgit_view_ok';

export type OverlayDagNode = {
    hash: string;
    parents: string[];
    changedFiles: string[];
    branchTag?: string;
};

export type OverlayDag = {
    nodes: Record<string, OverlayDagNode>;
    managedFiles: string[];
    current?: string;
    currentTag?: string;
};

export type OverlayPaths = {
    root: string;
    meta: string;
    dagFile: string;
    layers: string;
    write: string;
    merge: string;
    views: string;
};

export type CheckoutMethod = 'full' | 'incremental' | 'cached-view';

export type CheckoutResult = {
    /** 常に Node.js ユーザー空間エンジン */
    backend: 'nodejs';
    method: CheckoutMethod;
    layerCount: number;
    fileCount: number;
    /** 今回新たに適用したレイヤ数（キャッシュヒット時は 0） */
    appliedLayers: number;
    viewHash?: string;
};

type CheckoutState = {
    backend: 'nodejs';
    layerPath: string[];
    writeBranchTag: string;
    viewHash?: string;
    at: string;
};

type GitRunner = (cwd: string, args: string[]) => string;
type GitTryRunner = (cwd: string, args: string[]) => string | undefined;

export function isOverlayCheckoutEnabled(getConfig: (key: string) => boolean | undefined): boolean {
    return getConfig('microgit.useOverlayCheckout') !== false;
}

export function getOverlayPaths(workspaceRoot: string): OverlayPaths {
    const root = path.join(workspaceRoot, OVERLAY_DIR);
    return {
        root,
        meta: path.join(root, 'meta'),
        dagFile: path.join(root, 'meta', 'dag.json'),
        layers: path.join(root, 'layers'),
        write: path.join(root, 'write'),
        merge: path.join(root, 'merge'),
        views: path.join(root, 'views'),
    };
}

export function ensureOverlayDirs(workspaceRoot: string): OverlayPaths {
    const paths = getOverlayPaths(workspaceRoot);
    for (const dir of [paths.root, paths.meta, paths.layers, paths.write, paths.merge, paths.views]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    if (!fs.existsSync(paths.dagFile)) {
        writeDag(paths, { nodes: {}, managedFiles: [] });
    }
    migrateLayerFormat(paths);
    return paths;
}

function formatFile(paths: OverlayPaths): string {
    return path.join(paths.meta, 'format.json');
}

/**
 * 古い形式のキャッシュを捨てる。レイヤとビューは shadow の Git から作り直せるキャッシュなので（#11: Git が正本）、
 * 捨てても履歴は失わない。ensureLayerExists / ensureExpandedView が必要になった時点で作り直す。
 * dag.json の managedFiles は、ワークスペースから消すべきファイルの判定に使うので残す。
 */
function migrateLayerFormat(paths: OverlayPaths): void {
    let version = 0;
    try {
        version = (JSON.parse(fs.readFileSync(formatFile(paths), 'utf8')) as { layerFormat?: number }).layerFormat ?? 0;
    } catch { /* 無ければ v1 以前として扱う */ }
    if (version >= LAYER_FORMAT_VERSION) { return; }

    for (const dir of [paths.layers, paths.views, paths.write]) {
        clearDirContents(dir);
    }
    resetMergeDir(paths);
    fs.mkdirSync(paths.merge, { recursive: true });
    fs.rmSync(path.join(paths.meta, 'checkout.json'), { force: true });
    const dag = readDag(paths);
    writeDag(paths, { ...dag, nodes: {} });
    fs.writeFileSync(formatFile(paths), JSON.stringify({ layerFormat: LAYER_FORMAT_VERSION }, null, 2), 'utf8');
}

export function readDag(paths: OverlayPaths): OverlayDag {
    try {
        if (!fs.existsSync(paths.dagFile)) {
            return { nodes: {}, managedFiles: [] };
        }
        const parsed = JSON.parse(fs.readFileSync(paths.dagFile, 'utf8')) as OverlayDag;
        return {
            nodes: parsed.nodes ?? {},
            managedFiles: Array.isArray(parsed.managedFiles) ? parsed.managedFiles : [],
            current: parsed.current,
            currentTag: parsed.currentTag,
        };
    } catch {
        return { nodes: {}, managedFiles: [] };
    }
}

export function writeDag(paths: OverlayPaths, dag: OverlayDag): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(paths.dagFile, JSON.stringify(dag, null, 2), 'utf8');
}

export function writeLayerDir(paths: OverlayPaths, branchTag: string): string {
    const dir = path.join(paths.write, branchTag);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function layerDir(paths: OverlayPaths, commitHash: string): string {
    return path.join(paths.layers, commitHash);
}

export function viewDir(paths: OverlayPaths, commitHash: string): string {
    return path.join(paths.views, commitHash);
}

/** 層のディレクトリ（layers/<hash> や write/<tag>）に対応するメタデータのパス（層の外に置く） */
export function layerMetaPath(layerDirPath: string): string {
    return `${layerDirPath.replace(/[\\/]+$/, '')}.json`;
}

export function readLayerMeta(layerDirPath: string): LayerMeta | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(layerMetaPath(layerDirPath), 'utf8')) as Partial<LayerMeta>;
        return {
            version: typeof parsed.version === 'number' ? parsed.version : LAYER_FORMAT_VERSION,
            whiteouts: Array.isArray(parsed.whiteouts) ? parsed.whiteouts.filter((w): w is string => typeof w === 'string') : [],
        };
    } catch {
        return undefined;
    }
}

export function writeLayerMeta(layerDirPath: string, whiteouts: Iterable<string>): void {
    const meta: LayerMeta = { version: LAYER_FORMAT_VERSION, whiteouts: Array.from(new Set(whiteouts)).sort() };
    fs.mkdirSync(path.dirname(layerMetaPath(layerDirPath)), { recursive: true });
    fs.writeFileSync(layerMetaPath(layerDirPath), JSON.stringify(meta, null, 2), 'utf8');
}

/** 層に「rel は消えた」という whiteout を足す */
export function addWhiteout(layerDirPath: string, rel: string): void {
    const meta = readLayerMeta(layerDirPath);
    writeLayerMeta(layerDirPath, [...(meta?.whiteouts ?? []), rel]);
}

/** 層から rel の whiteout を外す */
export function removeWhiteout(layerDirPath: string, rel: string): void {
    const meta = readLayerMeta(layerDirPath);
    if (!meta || !meta.whiteouts.includes(rel)) { return; }
    writeLayerMeta(layerDirPath, meta.whiteouts.filter((w) => w !== rel));
}

function isSkippedName(name: string): boolean {
    return name === '.git' || name === '.DS_Store' || name === VIEW_OK_MARKER;
}

export function isViewReady(paths: OverlayPaths, commitHash: string): boolean {
    return fs.existsSync(path.join(viewDir(paths, commitHash), VIEW_OK_MARKER));
}

function markViewReady(paths: OverlayPaths, commitHash: string): void {
    const dir = viewDir(paths, commitHash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, VIEW_OK_MARKER), commitHash, 'utf8');
}

function readCheckoutState(paths: OverlayPaths): CheckoutState | undefined {
    const stateFile = path.join(paths.meta, 'checkout.json');
    try {
        if (!fs.existsSync(stateFile)) { return undefined; }
        return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CheckoutState;
    } catch {
        return undefined;
    }
}

function writeCheckoutState(paths: OverlayPaths, state: CheckoutState): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(path.join(paths.meta, 'checkout.json'), JSON.stringify(state, null, 2), 'utf8');
}

/** primary parent を辿って root→target の1本パスを返す（兄弟を混ぜない） */
export function computePath(
    shadowRepoPath: string,
    targetHash: string,
    _runGit: GitRunner,
    tryRunGit: GitTryRunner,
): string[] {
    const pathHashes: string[] = [];
    let node: string | undefined = targetHash;
    const guard = new Set<string>();

    while (node && !guard.has(node)) {
        guard.add(node);
        pathHashes.unshift(node);
        const parentLine: string | undefined = tryRunGit(
            shadowRepoPath,
            ['rev-list', '--parents', '-n', '1', node],
        )?.trim();
        if (!parentLine) { break; }
        const parts: string[] = parentLine.split(/\s+/).filter(Boolean);
        const parent = parts.length > 1 ? parts[1] : undefined;
        node = parent;
    }
    return pathHashes;
}

/**
 * OverlayGit の「空間で時間を買う」核:
 * 各コミットの完全展開ビューを views/<hash>/ に永続化し、
 * 親ビュー + 差分レイヤで O(変更) で伸ばす。
 */
export function ensureExpandedView(
    paths: OverlayPaths,
    layerPath: string[],
): { viewPath: string; method: CheckoutMethod; appliedLayers: number; viewHash?: string } {
    fs.mkdirSync(paths.views, { recursive: true });

    if (layerPath.length === 0) {
        const emptyHash = '_empty';
        const dest = viewDir(paths, emptyHash);
        if (!isViewReady(paths, emptyHash)) {
            clearDirContents(dest);
            fs.mkdirSync(dest, { recursive: true });
            markViewReady(paths, emptyHash);
        }
        return { viewPath: dest, method: 'cached-view', appliedLayers: 0, viewHash: emptyHash };
    }

    const tip = layerPath[layerPath.length - 1];
    if (isViewReady(paths, tip)) {
        return {
            viewPath: viewDir(paths, tip),
            method: 'cached-view',
            appliedLayers: 0,
            viewHash: tip,
        };
    }

    // パス上で最も先端に近い既存ビューを親にする
    let parentIdx = -1;
    for (let i = layerPath.length - 2; i >= 0; i--) {
        if (isViewReady(paths, layerPath[i])) {
            parentIdx = i;
            break;
        }
    }

    const dest = viewDir(paths, tip);
    clearDirContents(dest);
    fs.mkdirSync(dest, { recursive: true });

    let appliedLayers = 0;
    let method: CheckoutMethod = 'full';

    if (parentIdx >= 0) {
        // view 構築は実体コピー（ハードリンクは小ファイル多数で逆に遅いことがある）
        copyTreeBytes(viewDir(paths, layerPath[parentIdx]), dest);
        for (let i = parentIdx + 1; i < layerPath.length; i++) {
            applyLayerOntoMerge(layerDir(paths, layerPath[i]), dest);
            appliedLayers++;
        }
        method = 'incremental';
    } else {
        for (const hash of layerPath) {
            applyLayerOntoMerge(layerDir(paths, hash), dest);
            appliedLayers++;
        }
        method = 'full';
    }

    markViewReady(paths, tip);
    return { viewPath: dest, method, appliedLayers, viewHash: tip };
}

/**
 * コミット直後: 親ビューがあれば差分レイヤだけで新ビューを展開して保持する。
 * （切替時に再構築しない = OverlayGit の時間短縮）
 * 親ビューが無い場合は不完全なビューを作らず、checkout 時のフルパス構築に任せる。
 */
export function expandViewAfterExport(
    paths: OverlayPaths,
    commitHash: string,
    parentHash: string | undefined,
): CheckoutMethod {
    if (isViewReady(paths, commitHash)) {
        return 'cached-view';
    }

    const dest = viewDir(paths, commitHash);

    if (parentHash && isViewReady(paths, parentHash)) {
        clearDirContents(dest);
        fs.mkdirSync(dest, { recursive: true });
        copyTreeBytes(viewDir(paths, parentHash), dest);
        applyLayerOntoMerge(layerDir(paths, commitHash), dest);
        markViewReady(paths, commitHash);
        return 'incremental';
    }

    if (!parentHash) {
        clearDirContents(dest);
        fs.mkdirSync(dest, { recursive: true });
        applyLayerOntoMerge(layerDir(paths, commitHash), dest);
        markViewReady(paths, commitHash);
        return 'full';
    }

    return 'full';
}

function writeLayerHasFiles(paths: OverlayPaths, writeBranchTag: string): boolean {
    const writeSrc = writeLayerDir(paths, writeBranchTag);
    // whiteout だけの書き込みレイヤも「空ではない」（v1 では whiteout だけだと空扱いになり、削除が無視されていた）
    return listFilesRecursive(writeSrc).length > 0 || (readLayerMeta(writeSrc)?.whiteouts.length ?? 0) > 0;
}

/** merge を消して（symlink/junction/実体いずれも）作り直せるようにする */
export function resetMergeDir(paths: OverlayPaths): void {
    // existsSync はリンク先を見るので、リンク先が消えたジャンクションを見落とす。lstat で判定する
    if (!lstatOrUndefined(paths.merge)) {
        return;
    }
    try {
        removeTree(paths.merge);
    } catch {
        clearDirContents(paths.merge);
        try { fs.rmdirSync(paths.merge); } catch { /* keep */ }
    }
}

/**
 * write レイヤが空なら merge を view へのディレクトリジャンクション/symlink にする（O(1) 載せ替え）。
 * write があるときだけ実ディレクトリへ展開してレイヤを載せる。
 */
export function pointMergeAtView(paths: OverlayPaths, viewPath: string): 'junction' | 'symlink' | 'link-tree' {
    resetMergeDir(paths);
    try {
        if (process.platform === 'win32') {
            fs.symlinkSync(viewPath, paths.merge, 'junction');
            return 'junction';
        }
        fs.symlinkSync(viewPath, paths.merge, 'dir');
        return 'symlink';
    } catch {
        fs.mkdirSync(paths.merge, { recursive: true });
        linkOrCopyTree(viewPath, paths.merge);
        return 'link-tree';
    }
}

/**
 * Node.js ユーザー空間 Overlay（OverlayFS 意味論）:
 * write が空なら merge=view ジャンクション、あるときだけ実体化して上書き。
 */
export function materializeMerge(
    paths: OverlayPaths,
    layerPath: string[],
    writeBranchTag: string,
): { fileCount: number; method: CheckoutMethod; appliedLayers: number; viewHash?: string } {
    const ensured = ensureExpandedView(paths, layerPath);
    const writeSrc = writeLayerDir(paths, writeBranchTag);

    if (!writeLayerHasFiles(paths, writeBranchTag)) {
        pointMergeAtView(paths, ensured.viewPath);
    } else {
        resetMergeDir(paths);
        fs.mkdirSync(paths.merge, { recursive: true });
        linkOrCopyTree(ensured.viewPath, paths.merge);
        applyLayerOntoMerge(writeSrc, paths.merge);
    }

    return {
        fileCount: listFilesRecursive(paths.merge).length,
        method: ensured.method,
        appliedLayers: ensured.appliedLayers,
        viewHash: ensured.viewHash,
    };
}

/** checkout の唯一の実装入口（常に Node.js + 展開ビュー） */
export function checkoutLayers(
    paths: OverlayPaths,
    layerPath: string[],
    writeBranchTag: string,
): CheckoutResult {
    const prev = readCheckoutState(paths);
    const tip = layerPath.length ? layerPath[layerPath.length - 1] : undefined;

    // 同一 tip・同一 write・write 空 → 何もしない（ジャンクション載せ替え済み）
    if (
        tip &&
        prev?.viewHash === tip &&
        prev.writeBranchTag === writeBranchTag &&
        isViewReady(paths, tip) &&
        fs.existsSync(paths.merge) &&
        !writeLayerHasFiles(paths, writeBranchTag)
    ) {
        const fileCount = listFilesRecursive(paths.merge).length;
        return {
            backend: 'nodejs',
            method: 'cached-view',
            layerCount: layerPath.length,
            fileCount,
            appliedLayers: 0,
            viewHash: tip,
        };
    }

    const materialized = materializeMerge(paths, layerPath, writeBranchTag);
    writeCheckoutState(paths, {
        backend: 'nodejs',
        layerPath,
        writeBranchTag,
        viewHash: materialized.viewHash,
        at: new Date().toISOString(),
    });
    return {
        backend: 'nodejs',
        method: tip && prev?.viewHash === tip ? 'cached-view' : materialized.method,
        layerCount: layerPath.length,
        fileCount: materialized.fileCount,
        appliedLayers: tip && prev?.viewHash === tip ? 0 : materialized.appliedLayers,
        viewHash: materialized.viewHash,
    };
}

export function describeOverlayEngine(): string {
    return `backend=nodejs space-for-time=views merge=junction-or-link platform=${process.platform}`;
}

/**
 * 同一ボリュームならハードリンク、ダメならコピー。
 * view→merge / 親view→子view の「載せ替え」を O(inode) に近づける。
 */
export function linkOrCopyFile(src: string, dest: string): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
    }
    try {
        fs.linkSync(src, dest);
    } catch {
        fs.copyFileSync(src, dest);
    }
}

/** ディレクトリツリーをハードリンク優先で載せ替え（ビューマーカーは除外） */
export function linkOrCopyTree(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }
    fs.mkdirSync(destDir, { recursive: true });

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(path.join(destDir, ...rel.split('/')), { recursive: true });
                walk(abs, rel);
            } else if (entry.isFile()) {
                linkOrCopyFile(abs, path.join(destDir, ...rel.split('/')));
            }
        }
    };
    walk(srcDir, '');
}

/** ディレクトリツリーをバイトコピー（ビュー展開用） */
export function copyTreeBytes(srcDir: string, destDir: string): void {
    if (!fs.existsSync(srcDir)) { return; }
    fs.mkdirSync(destDir, { recursive: true });

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(path.join(destDir, ...rel.split('/')), { recursive: true });
                walk(abs, rel);
            } else if (entry.isFile()) {
                const to = path.join(destDir, ...rel.split('/'));
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.copyFileSync(abs, to);
            }
        }
    };
    walk(srcDir, '');
}

/** 後方互換エイリアス */
export function copyTree(srcDir: string, destDir: string): void {
    copyTreeBytes(srcDir, destDir);
}

/**
 * レイヤを merge/view に適用する（whiteout ＋ 通常ファイル）。
 *
 * 順番が大事（#21 の N-3・N-4）:
 *   1. whiteout を先に全部当てる。ファイル `p` がディレクトリ `p/` に置き換わった層では、
 *      whiteout `p` と新しい `p/q.txt` が同じ層にある。`p/q.txt` を先に置こうとすると、
 *      下の層のファイル `p` が邪魔で失敗する。v1 は readdir の順番（NTFS では名前順、ext4 ではハッシュ順）に
 *      任せていたので、OS によって成否が変わりえた。
 *   2. ファイルを置く。置き先にディレクトリがあれば丸ごと消し、途中にファイルがあれば消す。
 *      上の層の非ディレクトリは下の層のディレクトリを丸ごと隠す、という OverlayFS の考え方に合わせる。
 * ハードリンク先を壊さないよう、上書き前に必ず unlink する（ビューはハードリンクで載せ替えることがある）。
 */
export function applyLayerOntoMerge(srcDir: string, mergeDir: string): void {
    for (const rel of readLayerMeta(srcDir)?.whiteouts ?? []) {
        removeMergePath(mergeDir, rel);
    }
    if (!fs.existsSync(srcDir)) { return; }

    const walk = (dir: string, relPrefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (isSkippedName(entry.name)) { continue; }
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                ensureDirectoryPath(mergeDir, rel);
                walk(abs, rel);
                continue;
            }
            if (!entry.isFile()) { continue; }

            const parentRel = relPrefix;
            if (parentRel) { ensureDirectoryPath(mergeDir, parentRel); }
            const to = path.join(mergeDir, ...rel.split('/'));
            const existing = lstatOrUndefined(to);
            if (existing?.isDirectory()) {
                removeTree(to);
            } else if (existing) {
                fs.unlinkSync(to);
            }
            // レイヤ実体は view と共有しない（後でレイヤを消しても merge/view が残るようコピー）
            fs.copyFileSync(abs, to);
        }
    };

    walk(srcDir, '');
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(p);
    } catch {
        return undefined;
    }
}

/**
 * p がディレクトリなら中身ごと、それ以外ならそれだけを消す。無ければ何もしない。
 *
 * fs.rmSync({ recursive: true }) を使わない理由（#21 の作業中に見つけた）: Windows 版の Node 25.1.0 では、
 * 日本語など ASCII 以外の名前のディレクトリを再帰削除すると、例外も出さずにプロセスが終了コード 127 で落ちる
 * （22.23.3・24.21.0 では起きない。2026-09-26 に確認）。拡張機能は VS Code の Electron の Node（22 系）で
 * 動くので今は影響しないが、層・ビュー・merge には利用者のディレクトリ名がそのまま入るので、Node の
 * バージョンに依存しない削除にしておく。
 * ジャンクションとシンボリックリンクはリンク自体を消し、リンク先には入らない（lstat で判定）。
 */
export function removeTree(p: string): void {
    const st = lstatOrUndefined(p);
    if (!st) { return; }
    if (st.isDirectory()) {
        for (const name of fs.readdirSync(p)) {
            removeTree(path.join(p, name));
        }
        fs.rmdirSync(p);
        return;
    }
    try {
        fs.unlinkSync(p);
    } catch (err) {
        // ディレクトリを指すリンクは、環境によって rmdir でないと消せない
        if (st.isSymbolicLink()) {
            fs.rmdirSync(p);
            return;
        }
        throw err;
    }
}

/** mergeDir の下に relDir までのディレクトリを作る。途中にファイルがあれば消してディレクトリにする */
function ensureDirectoryPath(mergeDir: string, relDir: string): void {
    let current = mergeDir;
    for (const part of relDir.split('/')) {
        current = path.join(current, part);
        const st = lstatOrUndefined(current);
        if (st?.isDirectory()) { continue; }
        if (st) { removeTree(current); }
        fs.mkdirSync(current);
    }
}

function removeMergePath(mergeDir: string, rel: string): void {
    const target = path.join(mergeDir, ...rel.split('/'));
    if (!lstatOrUndefined(target)) { return; }
    removeTree(target);
}

export function listFilesRecursive(rootDir: string): string[] {
    const result: string[] = [];
    if (!fs.existsSync(rootDir)) { return result; }

    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // v2 では `.wh.` で始まる名前も利用者の普通のファイル（#21 の N-5）
            if (isSkippedName(entry.name)) { continue; }
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(abs, rel);
            } else if (entry.isFile()) {
                result.push(rel.split(path.sep).join('/'));
            }
        }
    };
    walk(rootDir, '');
    return result;
}

export function clearDirContents(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
    }
    for (const entry of fs.readdirSync(dir)) {
        removeTree(path.join(dir, entry));
    }
}

export function copyMerge(srcDir: string, destDir: string): void {
    applyLayerOntoMerge(srcDir, destDir);
}

function filesContentEqual(a: string, b: string): boolean {
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) { return false; }
        if (sa.size === 0) { return true; }
        // 同一 inode（ハードリンク）なら中身比較不要
        if (sa.dev === sb.dev && sa.ino === sb.ino) { return true; }
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
        return false;
    }
}

type WorkspaceSyncCache = Record<string, { size: number; mtimeMs: number }>;

function syncCachePath(paths: OverlayPaths): string {
    return path.join(paths.meta, 'workspace-sync.json');
}

function readSyncCache(paths: OverlayPaths): WorkspaceSyncCache {
    try {
        const p = syncCachePath(paths);
        if (!fs.existsSync(p)) { return {}; }
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as WorkspaceSyncCache;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeSyncCache(paths: OverlayPaths, cache: WorkspaceSyncCache): void {
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.writeFileSync(syncCachePath(paths), JSON.stringify(cache), 'utf8');
}

/** Git のツリーの 1 エントリの変化（`git diff-tree --raw` の 1 行に当たる） */
export type TreeChange = {
    status: 'A' | 'M' | 'T' | 'D';
    /** 変化後のモード（D のときは変化前）。100644 / 100755 / 120000（シンボリックリンク）/ 160000（サブモジュール） */
    mode: string;
    /** 変化後のオブジェクト（D のときは変化前） */
    sha: string;
    path: string;
};

/** `git cat-file blob` で読むファイルの大きさの上限。execFileSync の既定（1 MiB）では足りない */
const MAX_BLOB_BYTES = 512 * 1024 * 1024;

/** Git のパスとして層に書いてよいか（空・絶対パス・`.`・`..` の段を拒否） */
function isSafeLayerPath(rel: string): boolean {
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) { return false; }
    return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function hasAncestorIn(rel: string, set: Set<string>): boolean {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
        if (set.has(parts.slice(0, i).join('/'))) { return true; }
    }
    return false;
}

/**
 * コミットが親から何を変えたかを読む（#21）。
 *
 * `-z` を使う理由（N-6）: `--name-only` などの普通の出力は、Git の既定設定（core.quotepath=true）では
 * 日本語など ASCII 以外のパスを `"\343\203\241..."` のようにエスケープする。それを本物のパスとして
 * `git show` に渡すと失敗し、v1 ではそのファイルを「削除された」ことにしていた。`-z` の出力は NUL 区切りで、
 * パスはエスケープされない。
 *
 * `--raw` を使う理由（N-3）: v1 は `git show <commit>:<path>` が成功したらファイルとみなしていたが、
 * パスがディレクトリ（tree）でも成功する。`--raw` ならモードと状態（A/M/T/D）が分かり、`-r` で
 * ツリーの中まで降りるので、出てくるのはファイル（blob）とサブモジュールだけになる。
 *
 * 親が無いコミットは、ツリーの全ファイルを「追加」として返す。
 */
export function listCommitChanges(
    shadowRepoPath: string,
    commitHash: string,
    parentHash: string | undefined,
    tryRunGit: GitTryRunner,
): TreeChange[] {
    const changes: TreeChange[] = [];
    if (!parentHash) {
        // 1 レコード = "<mode> <type> <sha>\t<path>"
        const out = tryRunGit(shadowRepoPath, ['ls-tree', '-r', '-z', commitHash]) ?? '';
        for (const rec of out.split('\0')) {
            const tab = rec.indexOf('\t');
            if (tab < 0) { continue; }
            const [mode, type, sha] = rec.slice(0, tab).split(' ');
            if (type !== 'blob') { continue; }
            changes.push({ status: 'A', mode, sha, path: rec.slice(tab + 1) });
        }
        return changes;
    }
    // 1 レコード = ":<旧mode> <新mode> <旧sha> <新sha> <状態>\0<path>\0"
    const out = tryRunGit(shadowRepoPath, [
        'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-commit-id', parentHash, commitHash,
    ]) ?? '';
    const tokens = out.split('\0');
    let i = 0;
    while (i < tokens.length) {
        const head = tokens[i];
        if (!head.startsWith(':') || i + 1 >= tokens.length) { i++; continue; }
        const rel = tokens[i + 1];
        i += 2;
        const [oldMode, newMode, oldSha, newSha, statusField] = head.slice(1).split(' ');
        const status = statusField?.charAt(0);
        if (status === 'D') {
            changes.push({ status: 'D', mode: oldMode, sha: oldSha, path: rel });
        } else if (status === 'A' || status === 'M' || status === 'T') {
            changes.push({ status, mode: newMode, sha: newSha, path: rel });
        }
    }
    return changes;
}

/**
 * コミットの変化を layers/<hash>/ に書き出す（レイヤ形式 v2）。
 * - 追加・変更・種類の変化（A/M/T）: ファイルの中身を丸ごと書く。シンボリックリンク（120000）はリンク先の文字列を
 *   中身とするファイルになる（Node 版はファイルしか作らない。Git の core.symlinks=false と同じ）。
 * - 削除（D）: whiteout をメタデータに記録する。ただし、祖先がこのコミットでファイルになったパスは記録しない。
 *   上の層のファイルが下の層のディレクトリを丸ごと隠すので不要で、書こうとするとファイルの下に
 *   ディレクトリを作ることになる（N-4）。
 * - サブモジュール（160000）と、層の外を指すパスは無視する。
 * メタデータは最後に書く。途中で止まった書き出しはメタデータが無いので、ensureLayerExists が作り直す。
 */
export function exportCommitLayer(
    shadowRepoPath: string,
    paths: OverlayPaths,
    commitHash: string,
    parentHash: string | undefined,
    branchTag: string | undefined,
    _runGit: GitRunner,
    tryRunGit: GitTryRunner,
): string[] {
    fs.mkdirSync(paths.layers, { recursive: true });
    fs.mkdirSync(paths.meta, { recursive: true });
    fs.mkdirSync(paths.views, { recursive: true });

    const dest = layerDir(paths, commitHash);
    fs.rmSync(layerMetaPath(dest), { force: true });
    removeTree(dest);
    fs.mkdirSync(dest, { recursive: true });

    const changes = listCommitChanges(shadowRepoPath, commitHash, parentHash, tryRunGit)
        .filter((c) => c.mode !== '160000' && isSafeLayerPath(c.path));
    const writtenPaths = new Set(changes.filter((c) => c.status !== 'D').map((c) => c.path));
    const whiteouts: string[] = [];

    for (const change of changes) {
        if (change.status === 'D') {
            if (!hasAncestorIn(change.path, writtenPaths)) {
                whiteouts.push(change.path);
            }
            continue;
        }
        // maxBuffer の既定は 1 MiB。v1 はそれより大きいファイルで ENOBUFS になり、「削除」扱いにしていた
        const content = execFileSync('git', ['cat-file', 'blob', change.sha], {
            cwd: shadowRepoPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            maxBuffer: MAX_BLOB_BYTES,
        });
        const outFile = path.join(dest, ...change.path.split('/'));
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, content);
    }
    writeLayerMeta(dest, whiteouts);

    const changedFiles = changes.map((c) => c.path);
    const dag = readDag(paths);
    const parents = parentHash ? [parentHash] : [];
    dag.nodes[commitHash] = {
        hash: commitHash,
        parents,
        changedFiles,
        branchTag,
    };
    const managed = new Set(dag.managedFiles);
    for (const f of changedFiles) { managed.add(f); }
    dag.managedFiles = Array.from(managed).sort();
    dag.current = commitHash;
    if (branchTag) { dag.currentTag = branchTag; }
    writeDag(paths, dag);

    // 空間で時間を買う: コミット時点でビューを展開保持
    expandViewAfterExport(paths, commitHash, parentHash);

    return changedFiles;
}

/** レイヤが無ければ shadow から書き出す（既存履歴の遅延バックフィル、古い形式を捨てた後の作り直し） */
export function ensureLayerExists(
    shadowRepoPath: string,
    paths: OverlayPaths,
    commitHash: string,
    runGit: GitRunner,
    tryRunGit: GitTryRunner,
): void {
    const dag = readDag(paths);
    const dest = layerDir(paths, commitHash);
    // メタデータは書き出しの最後に置くので、あれば完成した層（whiteout だけの層もここで判定できる）
    if (dag.nodes[commitHash] && readLayerMeta(dest)) {
        return;
    }

    const line = tryRunGit(shadowRepoPath, ['rev-list', '--parents', '-n', '1', commitHash])?.trim();
    const parts = line ? line.split(/\s+/).filter(Boolean) : [];
    const parentHash = parts.length > 1 ? parts[1] : undefined;
    const tag = tryRunGit(shadowRepoPath, ['tag', '--points-at', commitHash, '-l', 'mb-*'])?.trim()?.split('\n')[0];
    exportCommitLayer(shadowRepoPath, paths, commitHash, parentHash, tag, runGit, tryRunGit);
}

export function removeFromWriteLayer(
    paths: OverlayPaths,
    branchTag: string,
    relativeFilePath: string,
): void {
    const layer = path.join(paths.write, branchTag);
    const filePath = path.join(layer, ...relativeFilePath.split('/'));
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    removeWhiteout(layer, relativeFilePath);
}

/** 書き込みレイヤに whiteout を置いて「削除」を表現 */
export function whiteoutInWriteLayer(
    paths: OverlayPaths,
    branchTag: string,
    relativeFilePath: string,
): void {
    removeFromWriteLayer(paths, branchTag, relativeFilePath);
    addWhiteout(path.join(paths.write, branchTag), relativeFilePath);
}

/**
 * shadow 履歴に登場した全パスを収集（兄弟枝の取り残し削除用）。
 * `-z` でエスケープの無いパスを読む（#21 の N-6。v1 は日本語などのパスがエスケープされたまま入っていた）。
 */
export function collectShadowTrackedFiles(
    shadowRepoPath: string,
    tryRunGit: GitTryRunner,
): string[] {
    const out = tryRunGit(shadowRepoPath, [
        'log', '--all', '-z', '--pretty=format:', '--name-only',
    ]);
    if (!out) { return []; }
    return Array.from(new Set(
        out.split('\0').map((l) => l.replace(/^\n+/, '')).filter((l) => l && isSafeLayerPath(l))
    ));
}

/** ディレクトリの中に（下の階層も含めて）ファイルが 1 つも無いか。ディレクトリだけなら true */
function directoryHasNoFiles(dir: string): boolean {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) { return false; }
        if (!directoryHasNoFiles(path.join(dir, entry.name))) { return false; }
    }
    return true;
}

/**
 * ワークスペースの rel にファイルを置けるようにする。
 * - 途中のディレクトリが無ければ作る。途中にファイルがあれば置けない（false）
 * - rel にディレクトリがあれば、中にファイルが 1 つも無いときだけ消す（ディレクトリ p/ → ファイル p）。
 *   ファイルが残っていれば（利用者のファイル）置けない（false）
 */
function prepareWorkspaceTarget(workspaceRoot: string, rel: string): boolean {
    const parts = rel.split('/');
    let current = workspaceRoot;
    for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        const st = lstatOrUndefined(current);
        if (st?.isDirectory()) { continue; }
        if (st) { return false; }
        fs.mkdirSync(current);
    }
    const target = path.join(workspaceRoot, ...parts);
    const st = lstatOrUndefined(target);
    if (st?.isDirectory()) {
        if (!directoryHasNoFiles(target)) { return false; }
        removeTree(target);
    }
    return true;
}

/**
 * merge/ の内容をワークスペースへ同期する。
 * size+mtime キャッシュと inode 一致でフルリード比較を避ける。
 *
 * 順番は「消す → 書く」（#14 の差分テストで見つけた N-7）。以前は「書く → 消す」で、
 * ファイル p がディレクトリ p/ に置き換わった時点へ戻ると、まだ残っている古い p のせいで
 * mkdir が EEXIST になり、例外で止まっていた。逆向き（ディレクトリ p/ → ファイル p）は、
 * 中身を消したあとの空のディレクトリ p/ が邪魔で書けなかった。
 * 置けないもの（利用者のファイルやディレクトリとぶつかる）は書かずに conflicts で返す。
 */
export function syncMergeToWorkspace(
    workspaceRoot: string,
    paths: OverlayPaths,
    isSafeRepoRelativePath: (relPath: string, rootPath: string) => boolean,
    isMicroGitArtifactPath: (filePath: string, rootPath: string) => boolean,
    extraManagedFiles?: string[],
): { written: string[]; deleted: string[]; skipped: number; conflicts: string[] } {
    const dag = readDag(paths);
    const mergeFiles = new Set(listFilesRecursive(paths.merge));
    const managed = new Set(dag.managedFiles);
    for (const f of mergeFiles) { managed.add(f); }
    for (const f of extraManagedFiles ?? []) { managed.add(f); }

    const cache = readSyncCache(paths);
    const nextCache: WorkspaceSyncCache = {};
    const written: string[] = [];
    const deleted: string[] = [];
    const conflicts: string[] = [];
    let skipped = 0;

    // 1. 消す
    for (const rel of managed) {
        if (mergeFiles.has(rel)) { continue; }
        if (!isSafeRepoRelativePath(rel, workspaceRoot)) { continue; }
        const to = path.join(workspaceRoot, ...rel.split('/'));
        if (isMicroGitArtifactPath(to, workspaceRoot)) { continue; }
        if (fs.existsSync(to) && fs.statSync(to).isFile()) {
            fs.unlinkSync(to);
            deleted.push(rel);
        }
    }

    // 2. 書く
    for (const rel of mergeFiles) {
        if (!isSafeRepoRelativePath(rel, workspaceRoot)) { continue; }
        const from = path.join(paths.merge, ...rel.split('/'));
        const to = path.join(workspaceRoot, ...rel.split('/'));
        if (isMicroGitArtifactPath(to, workspaceRoot)) { continue; }

        let srcStat: fs.Stats;
        try {
            srcStat = fs.statSync(from);
            if (!srcStat.isFile()) { continue; }
        } catch {
            continue;
        }

        const cached = cache[rel];
        if (
            cached &&
            cached.size === srcStat.size &&
            cached.mtimeMs === srcStat.mtimeMs &&
            fs.existsSync(to)
        ) {
            try {
                const dstStat = fs.statSync(to);
                if (dstStat.isFile() && dstStat.size === srcStat.size) {
                    nextCache[rel] = cached;
                    skipped++;
                    continue;
                }
            } catch { /* fall through */ }
        }

        if (fs.existsSync(to) && filesContentEqual(from, to)) {
            nextCache[rel] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs };
            skipped++;
            continue;
        }

        if (!prepareWorkspaceTarget(workspaceRoot, rel)) {
            conflicts.push(rel);
            continue;
        }
        fs.copyFileSync(from, to);
        written.push(rel);
        nextCache[rel] = { size: srcStat.size, mtimeMs: srcStat.mtimeMs };
    }

    dag.managedFiles = Array.from(managed).sort();
    writeDag(paths, dag);
    writeSyncCache(paths, nextCache);
    return { written, deleted, skipped, conflicts };
}

export function updateDagCurrent(
    paths: OverlayPaths,
    commitHash: string,
    branchTag: string,
): void {
    const dag = readDag(paths);
    dag.current = commitHash;
    dag.currentTag = branchTag;
    writeDag(paths, dag);
}
