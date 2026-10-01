/**
 * Git の index（.git/index）を読み書きする（#32）。版 2 と 3 だけを扱う（4 は扱わず、呼ぶ側が Git の CLI に任せる）。
 *
 * 書くときは拡張（TREE・UNTR・FSMN など）を落とす。どれも Git が必要なら作り直す「キャッシュ」なので、
 * 落としても中身の意味は変わらない（split index の link 拡張だけは中身が変わるので、あれば扱わない）。
 * 書き方は Git と同じく index.lock を排他で作り、書いてから名前を変える。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type IndexEntry = {
    ctimeSec: number; ctimeNsec: number;
    mtimeSec: number; mtimeNsec: number;
    dev: number; ino: number; mode: number; uid: number; gid: number; size: number;
    hash: string;
    /** 下位 12 ビット（名前の長さ）以外：assume-valid・extended・stage */
    flags: number;
    /** 版 3 の拡張フラグ（skip-worktree・intent-to-add） */
    extendedFlags: number;
    path: string;
};

export type GitIndex = { version: number; entries: IndexEntry[] };

export class UnsupportedIndexError extends Error { }

export function readIndex(file: string): GitIndex {
    if (!fs.existsSync(file)) { return { version: 2, entries: [] }; }
    const buf = fs.readFileSync(file);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'DIRC') { throw new UnsupportedIndexError('index の形が違う'); }
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) { throw new UnsupportedIndexError(`index の版 ${version} は扱わない`); }
    const count = buf.readUInt32BE(8);
    const entries: IndexEntry[] = [];
    let p = 12;
    for (let i = 0; i < count; i++) {
        const start = p;
        const e: IndexEntry = {
            ctimeSec: buf.readUInt32BE(p), ctimeNsec: buf.readUInt32BE(p + 4),
            mtimeSec: buf.readUInt32BE(p + 8), mtimeNsec: buf.readUInt32BE(p + 12),
            dev: buf.readUInt32BE(p + 16), ino: buf.readUInt32BE(p + 20), mode: buf.readUInt32BE(p + 24),
            uid: buf.readUInt32BE(p + 28), gid: buf.readUInt32BE(p + 32), size: buf.readUInt32BE(p + 36),
            hash: buf.toString('hex', p + 40, p + 60),
            flags: buf.readUInt16BE(p + 60) & ~0x0fff,
            extendedFlags: 0,
            path: '',
        };
        p += 62;
        if (e.flags & 0x4000) {
            if (version < 3) { throw new UnsupportedIndexError('版 2 に拡張フラグ'); }
            e.extendedFlags = buf.readUInt16BE(p);
            p += 2;
        }
        const nul = buf.indexOf(0, p);
        e.path = buf.toString('utf8', p, nul);
        p = nul + 1;
        // 1〜8 バイトの NUL で、エントリの長さを 8 の倍数にそろえる
        while ((p - start) % 8 !== 0) { p++; }
        entries.push(e);
    }
    // 拡張を見る（link＝split index は扱わない）
    while (p + 8 <= buf.length - 20) {
        const sig = buf.toString('ascii', p, p + 4);
        const size = buf.readUInt32BE(p + 4);
        if (sig === 'link' || sig === 'sdir') { throw new UnsupportedIndexError(`index の拡張 ${sig} は扱わない`); }
        p += 8 + size;
    }
    return { version, entries };
}

/** Git の index の並び：パスのバイト列、同じなら stage */
export function compareIndexEntries(a: IndexEntry, b: IndexEntry): number {
    const c = Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
    return c !== 0 ? c : ((a.flags >> 12) & 3) - ((b.flags >> 12) & 3);
}

export function serializeIndex(index: GitIndex): Buffer {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(12);
    head.write('DIRC', 0, 'ascii');
    const needsV3 = index.entries.some((e) => e.extendedFlags !== 0);
    const version = needsV3 ? 3 : 2;
    head.writeUInt32BE(version, 4);
    head.writeUInt32BE(index.entries.length, 8);
    parts.push(head);
    for (const e of index.entries) {
        const name = Buffer.from(e.path, 'utf8');
        const extended = e.extendedFlags !== 0;
        const fixed = 62 + (extended ? 2 : 0);
        const len = fixed + name.length;
        const padded = len + (8 - (len % 8));
        const b = Buffer.alloc(padded);
        const u32 = (v: number, o: number) => b.writeUInt32BE(v >>> 0, o);
        u32(e.ctimeSec, 0); u32(e.ctimeNsec, 4); u32(e.mtimeSec, 8); u32(e.mtimeNsec, 12);
        u32(e.dev, 16); u32(e.ino, 20); u32(e.mode, 24); u32(e.uid, 28); u32(e.gid, 32); u32(e.size, 36);
        b.write(e.hash, 40, 'hex');
        const flags = (e.flags & 0xb000) | (extended ? 0x4000 : 0) | Math.min(name.length, 0x0fff);
        b.writeUInt16BE(flags, 60);
        if (extended) { b.writeUInt16BE(e.extendedFlags, 62); }
        name.copy(b, fixed);
        parts.push(b);
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}

/** index.lock を排他で作って書き、名前を変える。ほかの Git が書いている最中なら例外（呼ぶ側は CLI に任せる） */
export function writeIndex(file: string, index: GitIndex, options: { fsync: boolean }): void {
    const lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o644);
    try {
        try {
            fs.writeSync(fd, serializeIndex(index));
            if (options.fsync) { fs.fsyncSync(fd); }
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(lock, file);
    } catch (e) {
        fs.rmSync(lock, { force: true });
        throw e;
    }
}

/** ファイルの stat から index のエントリを作る（git add と同じ項目。32 ビットに切り詰める） */
export function entryFromStat(relPath: string, absPath: string, hash: string, mode: number): IndexEntry {
    const st = fs.statSync(absPath, { bigint: true });
    const sec = (ns: bigint) => Number((ns / 1_000_000_000n) & 0xffffffffn);
    const nsec = (ns: bigint) => Number(ns % 1_000_000_000n);
    return {
        ctimeSec: sec(st.ctimeNs), ctimeNsec: nsec(st.ctimeNs),
        mtimeSec: sec(st.mtimeNs), mtimeNsec: nsec(st.mtimeNs),
        dev: Number(st.dev & 0xffffffffn), ino: Number(st.ino & 0xffffffffn),
        mode, uid: Number(st.uid & 0xffffffffn), gid: Number(st.gid & 0xffffffffn),
        size: Number(st.size & 0xffffffffn),
        hash, flags: 0, extendedFlags: 0, path: relPath,
    };
}

export function indexPath(gitDir: string): string {
    return path.join(gitDir, 'index');
}
