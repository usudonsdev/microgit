/**
 * 読むだけの最小の ZIP（OOXML の xlsx・docx・pptx 用）。依存を増やさないため自前で持つ。
 *
 * 信頼できないファイルを読む（docs/structured-diff.md §4）ので：
 * - 項目の数・展開後の合計に上限（DiffLimits）。展開は zlib の maxOutputLength で止める（宣言された大きさを信用しない）
 * - 暗号化された項目、ZIP64、未対応の圧縮方式は DiffFormatError
 * - ディスクには何も書かない（パスの検証は不要）
 * 中央ディレクトリ（ファイル末尾の一覧）を正とする。ローカルヘッダの大きさは信用しない。
 */
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { DiffFormatError, DiffLimitError, DiffLimits } from './types';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export interface ZipEntry {
    name: string;
    method: number;
    flags: number;
    compressedSize: number;
    uncompressedSize: number;
    crc32: number;
    localHeaderOffset: number;
}

export class ZipReader {
    readonly entries = new Map<string, ZipEntry>();
    private used = 0;

    constructor(private readonly buf: Buffer, private readonly limits: Pick<DiffLimits, 'maxUncompressedBytes' | 'maxZipEntries'>) {
        const eocd = findEocd(buf);
        if (eocd < 0) { throw new DiffFormatError('ZIP の終わりの記録が見つからない（ZIP ではないか、壊れている）'); }
        const total = buf.readUInt16LE(eocd + 10);
        const cdSize = buf.readUInt32LE(eocd + 12);
        const cdOffset = buf.readUInt32LE(eocd + 16);
        if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            throw new DiffFormatError('ZIP64 には対応していない');
        }
        if (total > limits.maxZipEntries) { throw new DiffLimitError(`ZIP の項目が多すぎる（${total} 個）`); }
        if (cdOffset + cdSize > buf.length) { throw new DiffFormatError('ZIP の一覧がファイルの外を指している'); }
        let p = cdOffset;
        for (let i = 0; i < total; i++) {
            if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) { throw new DiffFormatError('ZIP の一覧が壊れている'); }
            const flags = buf.readUInt16LE(p + 8);
            const method = buf.readUInt16LE(p + 10);
            const crc32 = buf.readUInt32LE(p + 16);
            const compressedSize = buf.readUInt32LE(p + 20);
            const uncompressedSize = buf.readUInt32LE(p + 24);
            const nameLen = buf.readUInt16LE(p + 28);
            const extraLen = buf.readUInt16LE(p + 30);
            const commentLen = buf.readUInt16LE(p + 32);
            const localHeaderOffset = buf.readUInt32LE(p + 42);
            if (p + 46 + nameLen > buf.length) { throw new DiffFormatError('ZIP の項目名が壊れている'); }
            const rawName = buf.subarray(p + 46, p + 46 + nameLen);
            // bit 11 = UTF-8。立っていなくても OOXML の名前は ASCII なので UTF-8 で読んで困らない
            const name = rawName.toString('utf8');
            this.entries.set(name, { name, method, flags, compressedSize, uncompressedSize, crc32, localHeaderOffset });
            p += 46 + nameLen + extraLen + commentLen;
        }
    }

    has(name: string): boolean { return this.entries.has(name); }

    names(): string[] { return [...this.entries.keys()]; }

    /** 項目を展開して返す。無ければ undefined */
    read(name: string): Buffer | undefined {
        const e = this.entries.get(name);
        if (!e) { return undefined; }
        if (e.flags & 1) { throw new DiffFormatError(`暗号化された ZIP の項目は読めない: ${name}`); }
        const p = e.localHeaderOffset;
        if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== SIG_LOC) { throw new DiffFormatError(`ZIP の項目の見出しが壊れている: ${name}`); }
        const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
        const end = start + e.compressedSize;
        if (end > this.buf.length) { throw new DiffFormatError(`ZIP の項目がファイルの外にはみ出している: ${name}`); }
        const data = this.buf.subarray(start, end);
        const budget = this.limits.maxUncompressedBytes - this.used;
        if (budget <= 0) { throw new DiffLimitError('ZIP を展開した大きさが上限を超えた'); }
        let out: Buffer;
        if (e.method === 0) {
            out = Buffer.from(data);
        } else if (e.method === 8) {
            try {
                out = zlib.inflateRawSync(data, { maxOutputLength: Math.min(budget, 0x7fffffff) });
            } catch (err: unknown) {
                const code = (err as { code?: string }).code;
                if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer larger/i.test(String(err))) {
                    throw new DiffLimitError('ZIP を展開した大きさが上限を超えた');
                }
                throw new DiffFormatError(`ZIP の項目を展開できない: ${name}`);
            }
        } else {
            throw new DiffFormatError(`未対応の ZIP の圧縮方式 ${e.method}: ${name}`);
        }
        if (out.length > budget) { throw new DiffLimitError('ZIP を展開した大きさが上限を超えた'); }
        this.used += out.length;
        return out;
    }

    /** 項目を UTF-8 の文字列で返す（BOM は外す） */
    readText(name: string): string | undefined {
        const b = this.read(name);
        if (!b) { return undefined; }
        const s = b.toString('utf8');
        return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    }

    /**
     * 項目の中身の指紋。展開せずに CRC32 と大きさで比べる（同じ中身なら同じ。違う中身で同じになることはまれ）。
     * 解釈しなかった部品が変わったかどうか（otherParts）に使う
     */
    fingerprint(name: string): string | undefined {
        const e = this.entries.get(name);
        if (!e) { return undefined; }
        return `${e.crc32.toString(16)}:${e.uncompressedSize}`;
    }
}

function findEocd(buf: Buffer): number {
    const min = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) { return i; }
    }
    return -1;
}

/** 先頭が ZIP の印（PK\x03\x04）か */
export function looksLikeZip(head: Buffer): boolean {
    return head.length >= 4 && head.readUInt32LE(0) === SIG_LOC;
}

/**
 * 2 つの版の ZIP の項目を比べ、known（ドライバが解釈した部品）以外で変わったものを返す。
 * 片方が無い（追加・削除）ときは、もう片方の項目をすべて added / deleted にはしない（ファイルの追加・削除なので意味がない）
 */
export function otherPartChanges(
    oldZip: ZipReader | undefined,
    newZip: ZipReader | undefined,
    isKnown: (name: string) => boolean,
): { name: string; status: 'added' | 'deleted' | 'modified' }[] {
    if (!oldZip || !newZip) { return []; }
    const out: { name: string; status: 'added' | 'deleted' | 'modified' }[] = [];
    const names = new Set([...oldZip.names(), ...newZip.names()]);
    for (const n of [...names].sort()) {
        if (n.endsWith('/') || isKnown(n)) { continue; }
        const a = oldZip.fingerprint(n);
        const b = newZip.fingerprint(n);
        if (a === b) { continue; }
        out.push({ name: n, status: !a ? 'added' : !b ? 'deleted' : 'modified' });
    }
    return out;
}

/** バイト列の短い指紋（キャッシュ・同一判定用） */
export function hashBytes(b: Buffer): string {
    return createHash('sha256').update(b).digest('hex').slice(0, 32);
}
