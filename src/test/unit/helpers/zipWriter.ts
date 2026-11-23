/**
 * テスト用の最小の ZIP の書き出し（xlsx・docx・pptx の見本を作るため）。本体のコードでは使わない。
 * method 8（deflate）で書く。CRC32 は自前で計算する。
 */
import * as zlib from 'zlib';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(b: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) { c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

/** files（名前 → 中身）を ZIP にする。store が true なら圧縮しない */
export function makeZip(files: Record<string, string | Buffer>, store = false): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const comp = store ? data : zlib.deflateRawSync(data);
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const method = store ? 0 : 8;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, comp);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(method, 10);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(comp.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        centrals.push(cen, nameBuf);
        offset += 30 + nameBuf.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    const count = Object.keys(files).length;
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
