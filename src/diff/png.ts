/**
 * 最小の PNG の読み書き（画像・動画の差分ドライバ用）。依存を増やさないため自前で持つ。VS Code に依存しない。
 *
 * 読む：8 ビット・16 ビット（と 1・2・4 ビット）、色の種類 0（グレー）・2（RGB）・3（パレット）・4（グレー＋α）・6（RGBA）、
 * 5 種類のフィルタ、インターレース（Adam7）。結果は 8 ビットの RGBA。16 ビットは上位のバイトだけ使う。
 * 書く：8 ビットの RGBA、フィルタは 0（なし）だけ、zlib で圧縮。表示用の縮小画像に使う。
 *
 * 信頼できないファイルを読む（docs/structured-diff.md §4）ので：
 * - 画素の数（幅 × 高さ）を、展開する前に maxPixels と比べる
 * - 展開は zlib の maxOutputLength で、画像の大きさから計算した長さまでに止める（宣言を信用しない）
 * - チャンクの CRC は確かめない（壊れていても読める範囲で読む。差分の表示が目的なので）
 */
import * as zlib from 'zlib';
import { DiffFormatError, DiffLimitError } from './types';

/** 8 ビットの RGBA の画像。data は幅 × 高さ × 4 バイト、行は上から */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 先頭が PNG の印か */
export function isPng(b: Buffer | undefined): boolean {
    return !!b && b.length >= 8 && b.subarray(0, 8).equals(SIGNATURE);
}

/** Adam7 の 7 回の走査（開始の x・y と間隔） */
const ADAM7 = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;

/** PNG を RGBA に読む。maxPixels を超えたら DiffLimitError、壊れていたら DiffFormatError */
export function decodePng(buf: Buffer, maxPixels: number): RgbaImage {
    if (!isPng(buf)) { throw new DiffFormatError('PNG ではない'); }
    let p = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = -1;
    let interlace = 0;
    let palette: Buffer | undefined;
    let trns: Buffer | undefined;
    const idat: Buffer[] = [];
    while (p + 8 <= buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('latin1', p + 4, p + 8);
        const start = p + 8;
        const end = start + len;
        if (end > buf.length) { throw new DiffFormatError('PNG のチャンクがファイルの外まで続いている'); }
        const body = buf.subarray(start, end);
        if (type === 'IHDR') {
            if (len < 13) { throw new DiffFormatError('PNG の IHDR が短い'); }
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            depth = body[8];
            colorType = body[9];
            interlace = body[12];
            if (width === 0 || height === 0) { throw new DiffFormatError('PNG の幅か高さが 0'); }
            if (width * height > maxPixels) {
                throw new DiffLimitError(`画像が大きすぎる（${width}×${height}）`);
            }
            const okDepth: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!okDepth[colorType]?.includes(depth)) {
                throw new DiffFormatError(`未対応の PNG（色の種類 ${colorType}、${depth} ビット）`);
            }
            if (body[10] !== 0 || body[11] !== 0 || interlace > 1) { throw new DiffFormatError('未対応の PNG の圧縮・フィルタ・インターレースの方式'); }
        } else if (type === 'PLTE') {
            palette = body;
        } else if (type === 'tRNS') {
            trns = body;
        } else if (type === 'IDAT') {
            idat.push(body);
        } else if (type === 'IEND') {
            break;
        }
        p = end + 4;
    }
    if (colorType < 0) { throw new DiffFormatError('PNG の IHDR が無い'); }
    if (colorType === 3 && !palette) { throw new DiffFormatError('PNG のパレットが無い'); }
    if (idat.length === 0) { throw new DiffFormatError('PNG の画素のデータが無い'); }

    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType as 0 | 2 | 3 | 4 | 6];
    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const passes: { x0: number; y0: number; dx: number; dy: number; w: number; h: number }[] = [];
    if (interlace === 0) {
        passes.push({ x0: 0, y0: 0, dx: 1, dy: 1, w: width, h: height });
    } else {
        for (const [x0, y0, dx, dy] of ADAM7) {
            const w = Math.ceil((width - x0) / dx);
            const h = Math.ceil((height - y0) / dy);
            if (w > 0 && h > 0) { passes.push({ x0, y0, dx, dy, w, h }); }
        }
    }
    let expected = 0;
    for (const ps of passes) { expected += ps.h * (1 + Math.ceil((ps.w * bitsPerPixel) / 8)); }

    let raw: Buffer;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: Math.max(1, expected) });
    } catch (e) {
        throw new DiffFormatError(`PNG の画素のデータを展開できない（${(e as Error).message}）`);
    }
    if (raw.length < expected) { throw new DiffFormatError('PNG の画素のデータが足りない'); }

    const out = new Uint8Array(width * height * 4);
    let off = 0;
    for (const ps of passes) {
        const stride = Math.ceil((ps.w * bitsPerPixel) / 8);
        let prev: Uint8Array = new Uint8Array(stride);
        for (let y = 0; y < ps.h; y++) {
            const filter = raw[off];
            const line = new Uint8Array(raw.buffer, raw.byteOffset + off + 1, stride);
            unfilter(filter, line, prev, bpp);
            off += 1 + stride;
            const oy = ps.y0 + y * ps.dy;
            for (let x = 0; x < ps.w; x++) {
                const o = (oy * width + ps.x0 + x * ps.dx) * 4;
                writePixel(out, o, line, x, colorType, depth, palette, trns);
            }
            prev = line;
        }
    }
    return { width, height, data: out };
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
    const n = line.length;
    switch (filter) {
        case 0: return;
        case 1:
            for (let i = bpp; i < n; i++) { line[i] = (line[i] + line[i - bpp]) & 0xff; }
            return;
        case 2:
            for (let i = 0; i < n; i++) { line[i] = (line[i] + prev[i]) & 0xff; }
            return;
        case 3:
            for (let i = 0; i < n; i++) {
                const left = i >= bpp ? line[i - bpp] : 0;
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
            }
            return;
        case 4:
            for (let i = 0; i < n; i++) {
                const a = i >= bpp ? line[i - bpp] : 0;
                const b = prev[i];
                const c = i >= bpp ? prev[i - bpp] : 0;
                const pa = Math.abs(b - c);
                const pb = Math.abs(a - c);
                const pc = Math.abs(a + b - 2 * c);
                const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                line[i] = (line[i] + pred) & 0xff;
            }
            return;
        default:
            throw new DiffFormatError(`PNG のフィルタの種類が不正（${filter}）`);
    }
}

/** 行の x 番目の標本（チャンネル c）を 8 ビットにして返す */
function sample(line: Uint8Array, idx: number, depth: number): number {
    if (depth === 8) { return line[idx]; }
    if (depth === 16) { return line[idx * 2]; }
    const perByte = 8 / depth;
    const byte = line[Math.floor(idx / perByte)];
    const shift = 8 - depth * ((idx % perByte) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return Math.round((v * 255) / ((1 << depth) - 1));
}

/** パレットの番号・tRNS の比較に使う、拡大しない生の値 */
function rawSample(line: Uint8Array, idx: number, depth: number): number {
    if (depth === 8) { return line[idx]; }
    if (depth === 16) { return (line[idx * 2] << 8) | line[idx * 2 + 1]; }
    const perByte = 8 / depth;
    const byte = line[Math.floor(idx / perByte)];
    const shift = 8 - depth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
}

function writePixel(out: Uint8Array, o: number, line: Uint8Array, x: number, colorType: number, depth: number,
    palette: Buffer | undefined, trns: Buffer | undefined): void {
    switch (colorType) {
        case 0: {
            const g = sample(line, x, depth);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = trns && trns.length >= 2 && rawSample(line, x, depth) === trns.readUInt16BE(0) ? 0 : 255;
            return;
        }
        case 2: {
            out[o] = sample(line, x * 3, depth);
            out[o + 1] = sample(line, x * 3 + 1, depth);
            out[o + 2] = sample(line, x * 3 + 2, depth);
            let a = 255;
            if (trns && trns.length >= 6 && rawSample(line, x * 3, depth) === trns.readUInt16BE(0)
                && rawSample(line, x * 3 + 1, depth) === trns.readUInt16BE(2) && rawSample(line, x * 3 + 2, depth) === trns.readUInt16BE(4)) {
                a = 0;
            }
            out[o + 3] = a;
            return;
        }
        case 3: {
            const i = rawSample(line, x, depth);
            const pal = palette!;
            if (i * 3 + 2 < pal.length) {
                out[o] = pal[i * 3];
                out[o + 1] = pal[i * 3 + 1];
                out[o + 2] = pal[i * 3 + 2];
            }
            out[o + 3] = trns && i < trns.length ? trns[i] : 255;
            return;
        }
        case 4: {
            const g = sample(line, x * 2, depth);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = sample(line, x * 2 + 1, depth);
            return;
        }
        default: {
            out[o] = sample(line, x * 4, depth);
            out[o + 1] = sample(line, x * 4 + 1, depth);
            out[o + 2] = sample(line, x * 4 + 2, depth);
            out[o + 3] = sample(line, x * 4 + 3, depth);
        }
    }
}

// ---------- 書く ----------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(parts: Buffer[]): number {
    let c = 0xffffffff;
    for (const b of parts) {
        for (let i = 0; i < b.length; i++) { c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); }
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32([head.subarray(4), body]), 0);
    return Buffer.concat([head, body, crc]);
}

/** RGBA を PNG にする（8 ビット、フィルタなし） */
export function encodePng(img: RgbaImage): Buffer {
    const { width, height, data } = img;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** PNG の data URI にする */
export function pngDataUri(img: RgbaImage): string {
    return `data:image/png;base64,${encodePng(img).toString('base64')}`;
}
