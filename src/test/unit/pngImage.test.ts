/**
 * PNG の読み書き（src/diff/png.ts）と画像の差分ドライバ（src/diff/image.ts）を確かめる単体テスト（docs/structured-diff.md §3.3）。
 * 観点：色の種類・ビットの深さ・フィルタ・インターレースを読める。画素の数の上限は展開の前に効く。展開しすぎない。
 * 画素が同じならメタデータだけの違いでも「変更なし」。変わった矩形の位置。大きさの変化。JPEG の書き出し直しの揺れは変更に数えない。
 * ffmpeg を使う項目は、PATH に ffmpeg が無ければ飛ばす。VS Code は使わない。
 */
import { strict as assert } from 'assert';
import { describe, it, before, after } from 'node:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { RgbaImage, decodePng, encodePng } from '../../diff/png';
import { changedRegions, imageDriver } from '../../diff/image';
import { DEFAULT_LIMITS, DiffContext, DiffFormatError, DiffLimitError, ErrorDiff, ImageDiff } from '../../diff/types';

/** PATH から実行ファイルを探す */
function findTool(name: string): string | undefined {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        const f = path.join(dir, name);
        if (fs.existsSync(f)) { return f; }
    }
    return undefined;
}
const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
const withFfmpeg = FFMPEG && FFPROBE ? it : it.skip;

function image(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): RgbaImage {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) { data.set(fill(x, y), (y * w + x) * 4); }
    }
    return { width: w, height: h, data };
}

const gradient = (w: number, h: number) => image(w, h, (x, y) => [(x * 7) & 255, (y * 5) & 255, (x * y) & 255, 255]);

/** 自前の PNG のチャンク（テストで壊れた・特殊な PNG を作るため） */
function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body, Buffer.alloc(4)]); // CRC は確かめないので 0 でよい
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(w: number, h: number, depth: number, color: number, interlace = 0): Buffer {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(w, 0);
    b.writeUInt32BE(h, 4);
    b[8] = depth;
    b[9] = color;
    b[12] = interlace;
    return chunk('IHDR', b);
}

/** Adam7 で RGBA 8 ビットの PNG を作る（フィルタは行ごとに 0〜4 を順に使う。読む側のフィルタも確かめる） */
function encodeAdam7(img: RgbaImage): Buffer {
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    const rows: Buffer[] = [];
    let row = 0;
    for (const [x0, y0, dx, dy] of passes) {
        const w = Math.ceil((img.width - x0) / dx);
        const h = Math.ceil((img.height - y0) / dy);
        if (w <= 0 || h <= 0) { continue; }
        let prev = Buffer.alloc(w * 4);
        for (let y = 0; y < h; y++) {
            const line = Buffer.alloc(w * 4);
            for (let x = 0; x < w; x++) {
                const o = ((y0 + y * dy) * img.width + x0 + x * dx) * 4;
                line.set(img.data.subarray(o, o + 4), x * 4);
            }
            const f = row++ % 5;
            rows.push(Buffer.from([f]), filterLine(f, line, prev));
            prev = line;
        }
    }
    return Buffer.concat([SIG, ihdr(img.width, img.height, 8, 6, 1), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function filterLine(f: number, line: Buffer, prev: Buffer): Buffer {
    const out = Buffer.alloc(line.length);
    for (let i = 0; i < line.length; i++) {
        const a = i >= 4 ? line[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let pred = 0;
        if (f === 1) { pred = a; }
        if (f === 2) { pred = b; }
        if (f === 3) { pred = (a + b) >> 1; }
        if (f === 4) {
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        out[i] = (line[i] - pred) & 255;
    }
    return out;
}

let tmp = '';
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vereve-png-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ctx = (tools = true): DiffContext => ({
    limits: DEFAULT_LIMITS,
    tools: tools ? { ffmpegPath: FFMPEG, ffprobePath: FFPROBE } : {},
    tmpDir: tmp,
});

function ffmpeg(args: string[]): void {
    execFileSync(FFMPEG!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** ffmpeg で PNG を RGBA に直したもの（正解として比べる） */
function ffmpegRgba(file: string): Buffer {
    return execFileSync(FFMPEG!, ['-nostdin', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 });
}

describe('PNG の読み書き', () => {
    it('書いて読むと同じ画素に戻る', () => {
        const img = image(37, 23, (x, y) => [x * 6, y * 11, (x + y) * 3, (x * 13) & 255]);
        const back = decodePng(encodePng(img), 1e6);
        assert.equal(back.width, 37);
        assert.equal(back.height, 23);
        assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
    });
    it('Adam7 のインターレースと 5 種類のフィルタを読む', () => {
        for (const [w, h] of [[1, 1], [3, 2], [13, 9], [33, 17]]) {
            const img = image(w, h, (x, y) => [x * 17 & 255, y * 29 & 255, (x ^ y) * 9 & 255, 200 + (x % 50)]);
            const back = decodePng(encodeAdam7(img), 1e6);
            assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data), `${w}×${h}`);
        }
    });
    it('パレットと tRNS、1 ビットのグレーを読む', () => {
        // 4×1 のパレット（2 ビット）。番号 1 は半透明
        const plte = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]));
        const trns = chunk('tRNS', Buffer.from([255, 128]));
        const raw = Buffer.from([0, 0b00011011]);
        const pal = Buffer.concat([SIG, ihdr(4, 1, 2, 3), plte, trns, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
        assert.deepEqual([...decodePng(pal, 100).data], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255]);
        const g1 = Buffer.concat([SIG, ihdr(3, 1, 1, 0), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0b10100000]))), chunk('IEND', Buffer.alloc(0))]);
        assert.deepEqual([...decodePng(g1, 100).data], [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    });
    withFfmpeg('ffmpeg が書いた各形式（グレー・RGB・パレット・α付き、8・16 ビット、各フィルタ）を、ffmpeg と同じ画素に読む', () => {
        const src = path.join(tmp, 'src.png');
        ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=67x41:rate=1', '-frames:v', '1', src]);
        const cases: [string, string[]][] = [
            ['gray', []], ['gray16be', []], ['rgb24', ['-pred', 'none']], ['rgb24', ['-pred', 'sub']], ['rgb24', ['-pred', 'up']],
            ['rgb24', ['-pred', 'avg']], ['rgb24', ['-pred', 'paeth']], ['rgb24', ['-pred', 'mixed']], ['rgb48be', []], ['rgba', []],
            ['rgba64be', []], ['ya8', []], ['ya16be', []], ['pal8', []], ['monob', []],
        ];
        for (const [fmt, extra] of cases) {
            const f = path.join(tmp, `c-${fmt}-${extra.join('')}.png`);
            ffmpeg(['-i', src, '-vf', fmt === 'ya8' || fmt === 'ya16be' ? `format=rgba,colorchannelmixer=aa=0.5,format=${fmt}` : `format=${fmt}`, ...extra, f]);
            const ours = decodePng(fs.readFileSync(f), 1e6);
            const want = ffmpegRgba(f);
            assert.equal(ours.width * ours.height * 4, want.length, fmt);
            let maxd = 0;
            for (let i = 0; i < want.length; i++) { maxd = Math.max(maxd, Math.abs(ours.data[i] - want[i])); }
            // 16 ビットは上位のバイトを使う。ffmpeg は丸めるので 1 違うことがある
            assert.ok(maxd <= 1, `${fmt} ${extra.join(' ')}: 差 ${maxd}`);
        }
    });
    it('画素の数の上限は、展開する前に効く', () => {
        // IDAT は中身が無くても、IHDR だけで断る
        const huge = Buffer.concat([SIG, ihdr(100_000, 100_000, 8, 6), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))]);
        assert.throws(() => decodePng(huge, 80_000_000), DiffLimitError);
    });
    it('宣言より大きく展開される IDAT（爆弾）は途中で止めて、壊れているとする', () => {
        const bomb = zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024));
        const png = Buffer.concat([SIG, ihdr(10, 10, 8, 6), chunk('IDAT', bomb), chunk('IEND', Buffer.alloc(0))]);
        assert.throws(() => decodePng(png, 1e6), DiffFormatError);
    });
    it('壊れた PNG は DiffFormatError', () => {
        assert.throws(() => decodePng(Buffer.from('not a png'), 1e6), DiffFormatError);
        const short = Buffer.concat([SIG, ihdr(10, 10, 8, 6), chunk('IDAT', zlib.deflateSync(Buffer.alloc(20))), chunk('IEND', Buffer.alloc(0))]);
        assert.throws(() => decodePng(short, 1e6), DiffFormatError);
        const badFilter = Buffer.concat([SIG, ihdr(1, 1, 8, 6), chunk('IDAT', zlib.deflateSync(Buffer.from([9, 1, 2, 3, 4]))), chunk('IEND', Buffer.alloc(0))]);
        assert.throws(() => decodePng(badFilter, 1e6), DiffFormatError);
    });
});

/** 画像を 1 組比べる */
async function run(oldBytes: Buffer | undefined, newBytes: Buffer | undefined, p = 'a.png', tools = true): Promise<ImageDiff | ErrorDiff> {
    return (await imageDriver.diff({ path: p, oldBytes, newBytes }, ctx(tools))) as ImageDiff | ErrorDiff;
}

describe('画像の差分ドライバ', () => {
    it('拡張子で当てはまる', () => {
        for (const p of ['a.png', 'b/c.JPG', 'x.jpeg', 'x.gif', 'x.bmp', 'x.webp', 'x.tif', 'x.tiff']) { assert.ok(imageDriver.matches(p, Buffer.alloc(0)), p); }
        assert.ok(!imageDriver.matches('a.mp4', Buffer.alloc(0)));
    });
    it('画素が同じで、メタデータだけ違う → 変更なし', async () => {
        const a = encodePng(gradient(40, 30));
        const text = chunk('tEXt', Buffer.from('Comment\0hello', 'latin1'));
        const b = Buffer.concat([a.subarray(0, 33), text, a.subarray(33)]); // IHDR の後ろに足す
        const r = (await run(a, b)) as ImageDiff;
        assert.equal(r.kind, 'image');
        assert.equal(r.status, 'unchanged');
        assert.match(r.summary, /メタデータだけ/);
        assert.equal(r.changedRatio, 0);
        assert.deepEqual(r.regions, []);
    });
    it('離れた 2 か所を変えると 2 つの矩形。位置と割合が合う', async () => {
        const a = gradient(200, 100);
        const b = { ...a, data: Uint8Array.from(a.data) };
        const paint = (x0: number, y0: number, w: number, h: number) => {
            for (let y = y0; y < y0 + h; y++) { for (let x = x0; x < x0 + w; x++) { b.data.set([255, 0, 255, 255], (y * 200 + x) * 4); } }
        };
        paint(10, 10, 20, 15);
        paint(150, 60, 30, 30);
        const r = (await run(encodePng(a), encodePng(b))) as ImageDiff;
        assert.equal(r.status, 'modified');
        assert.equal(r.regions.length, 2, JSON.stringify(r.regions));
        // 元の色が近い画素は数えないので、矩形は塗った範囲の中に収まる
        for (const [g, want] of [[r.regions[0], { x: 10, y: 10, w: 20, h: 15 }], [r.regions[1], { x: 150, y: 60, w: 30, h: 30 }]] as const) {
            assert.ok(g.x >= want.x && g.y >= want.y && g.x + g.w <= want.x + want.w && g.y + g.h <= want.y + want.h, JSON.stringify(g));
            assert.ok(g.w * g.h > want.w * want.h * 0.7, JSON.stringify(g));
        }
        assert.ok(r.changedRatio > 0.05 && r.changedRatio <= (300 + 900) / 20000, String(r.changedRatio));
        assert.match(r.summary, /^2 か所が変わった（画素の \d+\.\d%）$/);
        assert.match(r.previews!.heat!, /^data:image\/png;base64,/);
        assert.equal(decodePng(Buffer.from(r.previews!.old!.split(',')[1], 'base64'), 1e6).width, 200);
    });
    it('小さな差（閾値以下）は変更に数えない', async () => {
        const a = gradient(50, 50);
        const b = { ...a, data: a.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 10))) };
        const r = (await run(encodePng(a), encodePng(b))) as ImageDiff;
        assert.equal(r.status, 'unchanged');
        assert.match(r.summary, /わずか/);
    });
    it('大きさが変わった・追加・削除', async () => {
        const r = (await run(encodePng(gradient(64, 48)), encodePng(gradient(80, 60)))) as ImageDiff;
        assert.equal(r.sizeChanged, true);
        assert.equal(r.summary, '大きさが変わった（64×48 → 80×60）');
        assert.deepEqual(r.regions, []);
        assert.ok(r.previews?.old && r.previews.new);
        const add = (await run(undefined, encodePng(gradient(10, 10)))) as ImageDiff;
        assert.equal(add.status, 'added');
        assert.equal(add.summary, '追加（10×10）');
        const del = (await run(encodePng(gradient(10, 10)), undefined)) as ImageDiff;
        assert.equal(del.status, 'deleted');
    });
    it('縮小画像は 480 画素に収まる', async () => {
        const r = (await run(encodePng(gradient(1000, 300)), encodePng(gradient(1000, 300)))) as ImageDiff;
        const p = decodePng(Buffer.from(r.previews!.new!.split(',')[1], 'base64'), 1e7);
        assert.equal(p.width, 480);
        assert.equal(p.height, 144);
    });
    it('散らばった変更は矩形 50 個までにまとめる', () => {
        const w = 1000, h = 1000;
        const mask = new Uint8Array(w * h);
        for (let k = 0; k < 2000; k++) { mask[((k * 7919) % h) * w + ((k * 104729) % w)] = 1; }
        const rects = changedRegions(mask, w, h);
        assert.ok(rects.length <= 50 && rects.length > 0, String(rects.length));
        // どの変わった画素も、どれかの矩形に入っている
        for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) { continue; }
            const x = i % w, y = Math.floor(i / w);
            assert.ok(rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h));
        }
    });
    it('PNG 以外で ffmpeg が無ければ、ツールが要る、と返す', async () => {
        const r = (await run(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from([0xff, 0xd8, 0xff, 0xe1]), 'a.jpg', false)) as ErrorDiff;
        assert.equal(r.kind, 'error');
        assert.equal(r.reason, 'tool');
        assert.match(r.message, /ffmpeg/);
    });
    withFfmpeg('JPEG：書き出し直しは変更なし、四角を描くとその位置が変わる', async () => {
        const src = path.join(tmp, 's.png');
        ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', src]);
        const j1 = path.join(tmp, 'a.jpg');
        const j2 = path.join(tmp, 'b.jpg');
        const j3 = path.join(tmp, 'c.jpg');
        ffmpeg(['-i', src, '-q:v', '2', j1]);
        ffmpeg(['-i', src, '-q:v', '4', j2]);
        ffmpeg(['-i', src, '-vf', 'drawbox=x=200:y=40:w=60:h=50:color=black:t=fill', '-q:v', '2', j3]);
        const same = (await run(fs.readFileSync(j1), fs.readFileSync(j2), 'a.jpg')) as ImageDiff;
        assert.equal(same.kind, 'image');
        assert.equal(same.status, 'unchanged', same.summary);
        const box = (await run(fs.readFileSync(j1), fs.readFileSync(j3), 'a.jpg')) as ImageDiff;
        assert.equal(box.status, 'modified');
        assert.equal(box.regions.length, 1, JSON.stringify(box.regions));
        const g = box.regions[0];
        assert.ok(Math.abs(g.x - 200) <= 4 && Math.abs(g.y - 40) <= 4 && Math.abs(g.w - 60) <= 8 && Math.abs(g.h - 50) <= 8, JSON.stringify(g));
    });
    withFfmpeg('GIF・BMP・WebP も ffmpeg で読める', async () => {
        const src = path.join(tmp, 's2.png');
        ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=64x32:rate=1', '-frames:v', '1', src]);
        for (const ext of ['gif', 'bmp', 'webp']) {
            const f = path.join(tmp, `s2.${ext}`);
            ffmpeg(['-i', src, f]);
            const r = (await run(fs.readFileSync(f), fs.readFileSync(f), `x.${ext}`)) as ImageDiff;
            assert.equal(r.kind, 'image', ext);
            assert.deepEqual(r.newSize, { w: 64, h: 32 });
            assert.equal(r.status, 'unchanged');
        }
    });
});
