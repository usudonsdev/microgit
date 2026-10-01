/**
 * Boundary Guard（#16、要件 SR-1・SR-2・FR-3・O-14）。
 *
 * ゲスト（最小 VM の中、または VM なしの agent）は信用しない（SR-1）。ゲストから受け取った
 * 「あるコミット時点のファイルの一覧」と「ファイルの中身」は、ワークスペースに書く前に、ここで必ず検証する。
 * ゲストがワークスペースに直接書く経路は無い（FR-3）。書くのはホストで、書く前にこのモジュールを通す。
 *
 * このモジュールは VS Code に依存しない（単体テストで確かめるため）。
 *
 * 検証すること:
 *   1. パスの形          相対、`/` 区切り、空・`.`・`..` の段なし、NUL・`\`・制御文字なし、長さの上限
 *   2. 触ってはいけない場所  `.git`（大文字小文字・末尾のドットや空白・8.3 の短い名前・macOS が無視する文字を含めて）と、
 *                        MicroGit の作業フォルダ（.microgit_shadow / .microgit_logs / .microgit_overlay）
 *   3. 種類              ファイルとディレクトリだけ。シンボリックリンクやデバイスは受け付けない
 *   4. ホストで表せるか（O-14）  Windows の予約名・使えない文字・末尾のドットや空白、
 *                        大文字小文字や Unicode の正規化だけが違う名前のぶつかり（大文字小文字を区別しない FS）
 *   5. 中身              受け取った中身の sha256 が一覧の値と一致するか、大きさの上限
 *   6. 書き込み先        途中のディレクトリが、ワークスペースの外を指すリンク（シンボリックリンク・ジャンクション）でないか
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type HostTraits = {
    /** Windows の名前の規則を当てるか */
    windowsNames: boolean;
    /** 大文字小文字を区別しない FS か（Windows・macOS の既定） */
    caseInsensitive: boolean;
    /** Unicode の正規化形（NFC と NFD）を区別しない FS か（macOS の APFS・HFS+） */
    normalizationInsensitive: boolean;
};

export function hostTraitsFor(platform: NodeJS.Platform): HostTraits {
    return {
        windowsNames: platform === 'win32',
        caseInsensitive: platform === 'win32' || platform === 'darwin',
        normalizationInsensitive: platform === 'darwin',
    };
}

export type GuardLimits = {
    maxPathBytes: number;
    maxSegmentBytes: number;
    maxEntries: number;
    maxFileBytes: number;
};

export const DEFAULT_LIMITS: GuardLimits = {
    maxPathBytes: 4096,
    maxSegmentBytes: 255,
    maxEntries: 200_000,
    maxFileBytes: 512 * 1024 * 1024,
};

export type RejectReason =
    | 'malformed'
    | 'bad-path'
    | 'git-dir'
    | 'microgit-artifact'
    | 'unsupported-type'
    | 'windows-reserved-name'
    | 'windows-invalid-char'
    | 'windows-trailing-dot-or-space'
    | 'case-conflict'
    | 'too-long'
    | 'too-many-entries'
    | 'hash-mismatch'
    | 'too-large'
    | 'escapes-workspace'
    | 'type-conflict';

export type Rejection = { path: string; reason: RejectReason; detail?: string };

export type GuestFile = { path: string; sha256: string };

export type ValidatedView = {
    files: GuestFile[];
    directories: string[];
    rejected: Rejection[];
};

const ARTIFACT_DIRS = ['.microgit_shadow', '.microgit_logs', '.microgit_overlay'];

/** Windows で使えないファイル名（拡張子が付いても使えない。COM¹ などの上付き数字も含む） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * macOS の HFS+ が名前の比較で無視する文字（Git の is_hfs_dotgit と同じ考え方）。
 * これらを混ぜた `.g‌it` は、macOS では `.git` と同じディレクトリを指しうる。
 */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** 1 つの段が `.git` を指しうるか。Git 自身の防御（CVE-2014-9390 など）と同じ範囲を弾く */
export function isGitDirSegment(segment: string): boolean {
    const folded = segment
        .replace(HFS_IGNORABLE, '')
        .normalize('NFC')
        .toLowerCase()
        // Windows は末尾のドットと空白を無視する（".git." や ".git " は ".git"）
        .replace(/[. ]+$/, '');
    // NTFS の 8.3 形式の短い名前（".git" の短い名前は "GIT~1"）。"git~2" 以降もありうる
    return folded === '.git' || /^git~\d+$/.test(folded);
}

/** 相対パスの形を確かめる。問題があれば理由を返す */
export function checkPathShape(rel: string, limits: GuardLimits = DEFAULT_LIMITS): RejectReason | undefined {
    if (typeof rel !== 'string' || rel === '') { return 'bad-path'; }
    if (Buffer.byteLength(rel, 'utf8') > limits.maxPathBytes) { return 'too-long'; }
    if (rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) { return 'bad-path'; }
    for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.' || seg === '..') { return 'bad-path'; }
        if (Buffer.byteLength(seg, 'utf8') > limits.maxSegmentBytes) { return 'too-long'; }
    }
    return undefined;
}

/** パスがホストに書いてよい場所・名前かを確かめる（形は checkPathShape で確かめ済みとする） */
export function checkPathPolicy(rel: string, traits: HostTraits): { reason: RejectReason; detail?: string } | undefined {
    const segments = rel.split('/');
    if (segments.some(isGitDirSegment)) { return { reason: 'git-dir' }; }
    const first = traits.caseInsensitive ? segments[0].toLowerCase() : segments[0];
    if (ARTIFACT_DIRS.includes(first)) { return { reason: 'microgit-artifact' }; }
    if (traits.windowsNames) {
        for (const seg of segments) {
            if (WINDOWS_INVALID_CHARS.test(seg)) { return { reason: 'windows-invalid-char', detail: seg }; }
            if (/[. ]$/.test(seg)) { return { reason: 'windows-trailing-dot-or-space', detail: seg }; }
            if (WINDOWS_RESERVED.test(seg)) { return { reason: 'windows-reserved-name', detail: seg }; }
        }
    }
    return undefined;
}

/** 大文字小文字・正規化を区別しない FS で、同じものを指す名前をそろえるための鍵 */
export function collisionKey(rel: string, traits: HostTraits): string {
    let key = rel;
    if (traits.normalizationInsensitive) { key = key.normalize('NFC'); }
    if (traits.caseInsensitive) { key = key.toLowerCase(); }
    return key;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * agent の view の一覧（`d<TAB>path` / `f<TAB>path<TAB>sha256` / `l...` / `o...`）を検証する。
 * 受け付けたファイルとディレクトリと、弾いたものの理由を返す。弾いたものは書かない。
 * ディレクトリが弾かれたら、その下にあるものもすべて弾く。
 */
export function validateViewEntries(
    lines: readonly string[],
    traits: HostTraits,
    limits: GuardLimits = DEFAULT_LIMITS,
): ValidatedView {
    const files: GuestFile[] = [];
    const directories: string[] = [];
    const rejected: Rejection[] = [];
    if (lines.length > limits.maxEntries) {
        return { files, directories, rejected: [{ path: '', reason: 'too-many-entries', detail: String(lines.length) }] };
    }

    const rejectedDirs: string[] = [];
    const seen = new Map<string, string>();
    const underRejected = (rel: string) => rejectedDirs.some((d) => rel.startsWith(d + '/'));
    const reject = (rel: string, reason: RejectReason, detail?: string, isDir = false) => {
        rejected.push({ path: rel, reason, detail });
        if (isDir) { rejectedDirs.push(rel); }
    };

    // 親を先に見るため、パスの順に並べる（agent はバイト順で返すが、ゲストは信用しない）
    const parsed = lines.map((line) => line.split('\t')).sort((a, b) => (a[1] ?? '') < (b[1] ?? '') ? -1 : 1);
    for (const parts of parsed) {
        const [type, rel, sha] = parts;
        if (typeof rel !== 'string' || !['d', 'f', 'l', 'o'].includes(type)) {
            reject(String(rel ?? ''), 'malformed', parts.join('\\t').slice(0, 200));
            continue;
        }
        const shape = checkPathShape(rel, limits);
        if (shape) { reject(rel, shape, undefined, type === 'd'); continue; }
        if (underRejected(rel)) { reject(rel, 'bad-path', 'parent was rejected', type === 'd'); continue; }
        const policy = checkPathPolicy(rel, traits);
        if (policy) { reject(rel, policy.reason, policy.detail, type === 'd'); continue; }
        if (type === 'l' || type === 'o') {
            // MicroGit が記録するのは保存したファイルだけで、シンボリックリンクやデバイスは層に入らない（#10）
            reject(rel, 'unsupported-type', type);
            continue;
        }
        if (type === 'f' && (parts.length !== 3 || !SHA256.test(sha ?? ''))) {
            reject(rel, 'malformed', 'file entry needs sha256');
            continue;
        }
        const key = collisionKey(rel, traits);
        const other = seen.get(key);
        if (other !== undefined) {
            reject(rel, 'case-conflict', other, type === 'd');
            continue;
        }
        seen.set(key, rel);
        if (type === 'd') {
            directories.push(rel);
        } else {
            files.push({ path: rel, sha256: sha });
        }
    }
    return { files, directories, rejected };
}

/** 受け取った中身が一覧の sha256 と一致し、大きさの上限以内かを確かめる */
export function verifyContent(file: GuestFile, data: Buffer, limits: GuardLimits = DEFAULT_LIMITS): Rejection | undefined {
    if (data.length > limits.maxFileBytes) {
        return { path: file.path, reason: 'too-large', detail: String(data.length) };
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== file.sha256) {
        return { path: file.path, reason: 'hash-mismatch', detail: actual };
    }
    return undefined;
}

/**
 * ワークスペースの rel に書いてよいか（書き込み先の途中にワークスペースの外を指すリンクが無いか）。
 * 既にある途中のディレクトリを実体のパス（realpath）に直し、ワークスペースの実体の中に収まるかを見る。
 * 無いディレクトリはこれから作る普通のディレクトリなので問題ない。
 */
export function isInsideWorkspace(workspaceRoot: string, rel: string): boolean {
    let realRoot: string;
    try {
        realRoot = fs.realpathSync.native(workspaceRoot);
    } catch {
        return false;
    }
    const segments = rel.split('/');
    let current = workspaceRoot;
    for (let i = 0; i < segments.length; i++) {
        current = path.join(current, segments[i]);
        let st: fs.Stats;
        try {
            st = fs.lstatSync(current);
        } catch {
            return true; // ここから先はまだ無い
        }
        const isLast = i === segments.length - 1;
        if (st.isSymbolicLink()) {
            // 途中のリンクはたどらない。最後の要素がリンクなら、書くときにリンクを消して普通のファイルにする
            if (!isLast) { return false; }
            continue;
        }
        if (!isLast) {
            let real: string;
            try {
                real = fs.realpathSync.native(current);
            } catch {
                return false;
            }
            const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
            const same = process.platform === 'win32' || process.platform === 'darwin'
                ? real.toLowerCase().startsWith(rootWithSep.toLowerCase())
                : real.startsWith(rootWithSep);
            if (!same) { return false; }
        }
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// ワークスペースへの反映（FR-3: 検証したものだけを、ホストが書く）

/** ワークスペースのファイルの sha256 を、大きさと更新時刻が同じなら計算し直さないためのキャッシュ */
export type WorkspaceHashCache = Record<string, { size: number; mtimeMs: number; sha256: string }>;

export type SyncFromGuestOptions = {
    workspaceRoot: string;
    /** agent の view の一覧（検証前） */
    viewLines: readonly string[];
    /**
     * これまでに MicroGit が記録したことのあるパス（shadow の履歴に出てきたもの）。
     * ここにあって view に無いファイルは、ワークスペースから消す。ここに無いファイル（利用者が
     * MicroGit を使わずに置いたもの）は、view に無くても消さない。
     */
    managedFiles: Iterable<string>;
    /** 中身を取ってくる。ホストのバックエンドが agent の readMany を呼ぶ */
    fetchFiles: (paths: string[]) => Promise<Map<string, Buffer>>;
    traits: HostTraits;
    limits?: GuardLimits;
    cache?: WorkspaceHashCache;
};

export type SyncFromGuestResult = {
    written: string[];
    deleted: string[];
    unchanged: number;
    rejected: Rejection[];
    /** 次回に渡すキャッシュ */
    cache: WorkspaceHashCache;
};

function sha256OfFile(abs: string): string {
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function lstatOrUndefined(p: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(p);
    } catch {
        return undefined;
    }
}

/**
 * 検証した view に合わせてワークスペースを書き換える（FR-3: ゲストは書かない。書くのはホストで、検証してから）。
 *
 * 順番（#16 の受け入れ条件「ゲストを強制終了させても、ワークスペースが壊れない」のため）:
 *   1. view を検証する（validateViewEntries）。弾いたパスは書きも消しもしない
 *   2. 計画する: 消すもの（managedFiles にあって view のファイルに無いもの）と、
 *      取ってくるもの（view のファイルのうち、ワークスペースの中身と sha256 が違うもの）を決める。ここまで FS は読むだけ
 *   3. 取ってくる: 中身を全部受け取り、sha256 が一覧と一致するかを確かめる。
 *      ゲストが途中で落ちたら（fetchFiles が例外）、ワークスペースには何もしないまま例外を返す
 *   4. 消す → 5. 書く。消すのを先にするのは、「ファイル p → ディレクトリ p/」のように、
 *      古いファイルを消してからでないと新しいファイルを置けない場合があるため（#21 の N-3 と同じ形）
 * 利用者のディレクトリを丸ごと消すことはしない。置き先が（MicroGit の管理外の）ディレクトリなら、そのファイルは諦めて知らせる。
 */
export async function syncWorkspaceFromGuest(opts: SyncFromGuestOptions): Promise<SyncFromGuestResult> {
    const limits = opts.limits ?? DEFAULT_LIMITS;
    const view = validateViewEntries(opts.viewLines, opts.traits, limits);
    const rejected = [...view.rejected];
    const rejectedPaths = new Set(rejected.map((r) => collisionKey(r.path, opts.traits)));
    const wanted = new Map(view.files.map((f) => [collisionKey(f.path, opts.traits), f]));
    const oldCache = opts.cache ?? {};
    const cache: WorkspaceHashCache = {};
    let unchanged = 0;

    // 2. 計画（読むだけ）
    const toDelete: string[] = [];
    for (const rel of new Set(opts.managedFiles)) {
        const key = collisionKey(rel, opts.traits);
        if (wanted.has(key) || rejectedPaths.has(key)) { continue; }
        if (checkPathShape(rel, limits) || checkPathPolicy(rel, opts.traits)) { continue; }
        if (!isInsideWorkspace(opts.workspaceRoot, rel)) {
            rejected.push({ path: rel, reason: 'escapes-workspace' });
            continue;
        }
        const st = lstatOrUndefined(path.join(opts.workspaceRoot, ...rel.split('/')));
        if (st && (st.isFile() || st.isSymbolicLink())) { toDelete.push(rel); }
    }

    const toFetch: GuestFile[] = [];
    for (const file of view.files) {
        if (!isInsideWorkspace(opts.workspaceRoot, file.path)) {
            rejected.push({ path: file.path, reason: 'escapes-workspace' });
            continue;
        }
        const st = lstatOrUndefined(path.join(opts.workspaceRoot, ...file.path.split('/')));
        if (st?.isFile()) {
            const abs = path.join(opts.workspaceRoot, ...file.path.split('/'));
            const cached = oldCache[file.path];
            const sha = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs ? cached.sha256 : sha256OfFile(abs);
            cache[file.path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
            if (sha === file.sha256) { unchanged++; continue; }
        }
        // ディレクトリがあっても、ここでは諦めない。中のファイルがすべて消す予定のもの（ディレクトリ p/ → ファイル p）なら、
        // 消したあとに空のディレクトリを片付けて置ける。書く直前（5.）に決める
        toFetch.push(file);
    }

    // 3. 取ってきて確かめる（ここで例外になっても、ワークスペースはまだ何も変わっていない）
    const verified: Array<{ file: GuestFile; data: Buffer }> = [];
    const contents = toFetch.length ? await opts.fetchFiles(toFetch.map((f) => f.path)) : new Map<string, Buffer>();
    for (const file of toFetch) {
        const data = contents.get(file.path);
        if (!data) {
            rejected.push({ path: file.path, reason: 'malformed', detail: 'guest did not return the content' });
            continue;
        }
        const bad = verifyContent(file, data, limits);
        if (bad) { rejected.push(bad); continue; }
        verified.push({ file, data });
    }

    // 4. 消す
    const deleted: string[] = [];
    for (const rel of toDelete) {
        const abs = path.join(opts.workspaceRoot, ...rel.split('/'));
        const st = lstatOrUndefined(abs);
        if (st && (st.isFile() || st.isSymbolicLink())) {
            fs.unlinkSync(abs);
            deleted.push(rel);
        }
    }

    // 5. 書く
    const written: string[] = [];
    for (const { file, data } of verified) {
        // 計画から今までのあいだに変わっていないか、書く直前にもう一度確かめる
        if (!isInsideWorkspace(opts.workspaceRoot, file.path)) {
            rejected.push({ path: file.path, reason: 'escapes-workspace' });
            continue;
        }
        if (!prepareParentDirectories(opts.workspaceRoot, file.path)) {
            rejected.push({ path: file.path, reason: 'type-conflict', detail: 'a file exists where a directory is needed' });
            continue;
        }
        const abs = path.join(opts.workspaceRoot, ...file.path.split('/'));
        const existing = lstatOrUndefined(abs);
        if (existing?.isDirectory()) {
            // 消したあともファイルが残っているディレクトリ（利用者のもの）は消さない
            if (!directoryHasNoFiles(abs)) {
                rejected.push({ path: file.path, reason: 'type-conflict', detail: 'a directory with files exists at this path in the workspace' });
                continue;
            }
            removeEmptyDirectories(abs);
        }
        // 最後の要素がリンクなら、リンク先に書かないようにリンク自体を消してから普通のファイルを置く
        if (existing?.isSymbolicLink()) { fs.unlinkSync(abs); }
        fs.writeFileSync(abs, data);
        const after = fs.statSync(abs);
        cache[file.path] = { size: after.size, mtimeMs: after.mtimeMs, sha256: file.sha256 };
        written.push(file.path);
    }

    return { written, deleted, unchanged, rejected, cache };
}

/** ディレクトリの中に（下の階層も含めて）ファイルが 1 つも無いか。リンクもファイルとして数える */
function directoryHasNoFiles(dir: string): boolean {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) { return false; }
        if (!directoryHasNoFiles(path.join(dir, entry.name))) { return false; }
    }
    return true;
}

/** ディレクトリだけでできた木を、下から消す（directoryHasNoFiles で確かめたあとに呼ぶ） */
function removeEmptyDirectories(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        removeEmptyDirectories(path.join(dir, entry.name));
    }
    fs.rmdirSync(dir);
}

/** rel の親ディレクトリを作る。途中に（消されずに残った）ファイルがあれば false */
function prepareParentDirectories(root: string, rel: string): boolean {
    const segments = rel.split('/').slice(0, -1);
    let current = root;
    for (const seg of segments) {
        current = path.join(current, seg);
        const st = lstatOrUndefined(current);
        if (st?.isDirectory()) { continue; }
        if (st) { return false; }
        fs.mkdirSync(current);
    }
    return true;
}
