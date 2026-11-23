/**
 * 画像の差分ドライバ（docs/structured-diff.md §3.3）。VS Code に依存しない。
 *
 * - PNG は自前で読む（png.ts）。ほかの形式（JPEG・GIF・BMP・WebP・TIFF）は ffmpeg で RGBA に直す。ffmpeg が無ければ比べられない、と返す
 * - 大きさが同じなら画素ごとに比べる。RGBA のどれかの差が PIXEL_THRESHOLD（JPEG・WebP は LOSSY_PIXEL_THRESHOLD）を超えた画素を
 *   「変わった」とする（書き出し直したときの細かい揺れを変更に数えないため）
 * - 変わった画素を格子（既定 16×16 画素）にまとめ、隣り合うます目を 1 つの領域にして、外接する矩形を返す。多すぎたら近いものから合わせる
 * - 表示用に、旧・新の縮小画像と、差を赤で重ねた画像（heat）を PNG の data URI で付ける
 *
 * ffmpeg の呼び出し（runTool）は動画のドライバ（video.ts）も使う。シェルを通さず引数の配列で呼び、時間と出力の大きさに上限を付ける。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { DiffContext, DiffDriver, DiffFormatError, DiffInput, DiffLimitError, ErrorDiff, ImageDiff, Rect, baseOf, extOf } from './types';
import { RgbaImage, decodePng, isPng, pngDataUri } from './png';

const EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff']);

/** RGBA のどれかの差がこれを超えたら、その画素は変わった（0〜255）。JPEG の再圧縮の揺れはたいていこれ以下 */
export const PIXEL_THRESHOLD = 16;
/**
 * 非可逆の形式（JPEG・WebP）での閾値。JPEG の色差の間引きで、輪郭の画素の色は書き出し直すたびに大きく揺れる
 * （testsrc2 の 320×240 を品質 2 → 4 で書き直すと、16 を超える画素が 0.55%、最大 35。品質 2 → 8 では最大 60、40 を超えるのは 0.08%）
 */
export const LOSSY_PIXEL_THRESHOLD = 40;
const LOSSY_EXTS = new Set(['jpg', 'jpeg', 'webp']);
/** 返す矩形の数の上限 */
const MAX_REGIONS = 50;
/** 表示用の縮小画像の最大の幅・高さ */
const PREVIEW_MAX_W = 480;
const PREVIEW_MAX_H = 480;

// ---------- 外部のツール ----------

/** ツールが時間内に終わらなかった */
export class ToolTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolTimeoutError';
    }
}

export interface RunToolOptions {
    timeoutMs: number;
    /** 標準出力の上限（バイト）。超えたら止める */
    maxBytes: number;
    /** true なら、上限を超えたときに失敗にせず、そこまでを返す（truncated が true） */
    truncateOk?: boolean;
}

/** 外部のツールを引数の配列で呼ぶ（シェルは通さない）。標準出力を返す。失敗したら標準エラーの末尾を付けて投げる */
export function runTool(file: string, args: string[], opt: RunToolOptions): Promise<{ stdout: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        runningTools.add(child);
        child.on('exit', () => runningTools.delete(child));
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opt.timeoutMs);
        child.stdout.on('data', (b: Buffer) => {
            if (truncated) { return; }
            if (size + b.length > opt.maxBytes) {
                chunks.push(b.subarray(0, opt.maxBytes - size));
                size = opt.maxBytes;
                truncated = true;
                child.kill('SIGKILL');
                return;
            }
            chunks.push(b);
            size += b.length;
        });
        child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-2000); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) { reject(new ToolTimeoutError(`${path.basename(file)} が ${Math.round(opt.timeoutMs / 1000)} 秒で終わらなかった`)); return; }
            if (truncated) {
                if (opt.truncateOk) { resolve({ stdout: Buffer.concat(chunks), truncated }); return; }
                reject(new DiffLimitError(`${path.basename(file)} の出力が大きすぎる`));
                return;
            }
            if (code !== 0) { reject(new DiffFormatError(`${path.basename(file)} が失敗した（${stderr.trim().split('\n').pop() ?? code}）`)); return; }
            resolve({ stdout: Buffer.concat(chunks), truncated: false });
        });
    });
}

/** ffmpeg に渡す前置きの引数 */
// -protocol_whitelist file：入力にできるのはローカルのファイルだけ。細工したファイル（再生リストや concat の形式）が
// 別のファイルや URL を読み込ませるのを防ぐ（レビュー #9）
export const FFMPEG_PRE = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file'];

/** 動いている外部ツールのプロセス。worker.ts が止められるときに道連れにする（レビュー #10） */
export const runningTools = new Set<ReturnType<typeof spawn>>();

/** 動いている外部ツールを全部止める */
export function killRunningTools(): void {
    for (const c of runningTools) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
    runningTools.clear();
}

/** 版の中身を置いたファイル。worker.ts が作っていなければ tmpDir に書く */
export async function inputFile(given: string | undefined, bytes: Buffer, ctx: DiffContext, p: string): Promise<string> {
    if (given) { return given; }
    const ext = extOf(p).replace(/[^a-z0-9]/g, '');
    const f = path.join(ctx.tmpDir, `in-${randomBytes(6).toString('hex')}${ext ? '.' + ext : ''}`);
    await fs.promises.writeFile(f, bytes);
    return f;
}

/** ffmpeg が無いときの結果 */
export function toolMissing(driver: DiffDriver, input: DiffInput, what: string): ErrorDiff {
    const message = `${what}を比べるには ffmpeg が要る（PATH に入れるか、設定で場所を指定する）`;
    return { ...baseOf(driver, input), kind: 'error', reason: 'tool', message, summary: message };
}

// ---------- 画素の計算（video.ts も使う） ----------

/** 箱型のフィルタで縮小する。maxW・maxH に収まるように、縦横の比を保つ。小さければそのまま */
export function downscale(img: RgbaImage, maxW: number, maxH: number): RgbaImage {
    const s = Math.min(1, maxW / img.width, maxH / img.height);
    if (s >= 1) { return img; }
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const out = new Uint8Array(w * h * 4);
    const sx = img.width / w;
    const sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
            let r = 0, g = 0, b = 0, a = 0;
            for (let yy = y0; yy < y1; yy++) {
                let o = (yy * img.width + x0) * 4;
                for (let xx = x0; xx < x1; xx++, o += 4) {
                    r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; a += img.data[o + 3];
                }
            }
            const n = (y1 - y0) * (x1 - x0);
            const q = (y * w + x) * 4;
            out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = a / n;
        }
    }
    return { width: w, height: h, data: out };
}

/** 同じ大きさの 2 枚の、変わった画素の印（1 が変わった）と、その数。exact は全画素が完全に同じか */
export function changeMask(a: RgbaImage, b: RgbaImage, threshold = PIXEL_THRESHOLD): { mask: Uint8Array; changed: number; exact: boolean } {
    const n = a.width * a.height;
    const mask = new Uint8Array(n);
    let changed = 0;
    let exact = true;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]),
            Math.abs(a.data[o + 2] - b.data[o + 2]), Math.abs(a.data[o + 3] - b.data[o + 3]));
        if (d !== 0) { exact = false; }
        if (d > threshold) { mask[i] = 1; changed++; }
    }
    return { mask, changed, exact };
}

/** 新版を暗くし、変わった画素を赤で重ねた縮小画像 */
export function heatImage(newImg: RgbaImage, mask: Uint8Array, maxW: number, maxH: number): RgbaImage {
    const small = downscale(newImg, maxW, maxH);
    const w = small.width;
    const h = small.height;
    const sx = newImg.width / w;
    const sy = newImg.height / h;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
            let c = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) { c += mask[yy * newImg.width + xx]; }
            }
            const q = (y * w + x) * 4;
            const gray = (small.data[q] * 0.3 + small.data[q + 1] * 0.59 + small.data[q + 2] * 0.11) * 0.4 + 20;
            // 1 画素でも変わっていれば見えるように、赤の濃さは 0.6 から始める
            const t = c === 0 ? 0 : 0.6 + 0.4 * (c / ((y1 - y0) * (x1 - x0)));
            out[q] = gray * (1 - t) + 255 * t;
            out[q + 1] = gray * (1 - t);
            out[q + 2] = gray * (1 - t);
            out[q + 3] = 255;
        }
    }
    return { width: w, height: h, data: out };
}

/** 変わった画素を矩形にまとめる。格子のます目ごとに変わった画素の外接矩形を取り、隣り合う（斜めも）ます目を 1 つにする */
export function changedRegions(mask: Uint8Array, width: number, height: number, maxRegions = MAX_REGIONS): Rect[] {
    // 大きな画像でもます目が多くなりすぎないように、格子は最小 16 画素、長い辺で 256 ます目まで
    let cell = Math.max(16, Math.ceil(Math.max(width, height) / 256));
    for (;;) {
        const rects = regionsOnGrid(mask, width, height, cell);
        // 合わせる手間（個数の 3 乗）を抑えるため、多すぎるときは格子を粗くしてやり直す
        if (rects.length <= maxRegions * 4 || cell >= Math.max(width, height)) { return mergeNearest(rects, maxRegions); }
        cell *= 2;
    }
}

function regionsOnGrid(mask: Uint8Array, width: number, height: number, cell: number): Rect[] {
    const gw = Math.ceil(width / cell);
    const gh = Math.ceil(height / cell);
    const minX = new Int32Array(gw * gh).fill(-1);
    const minY = new Int32Array(gw * gh);
    const maxX = new Int32Array(gw * gh);
    const maxY = new Int32Array(gw * gh);
    for (let y = 0; y < height; y++) {
        const gy = Math.floor(y / cell);
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) { continue; }
            const g = gy * gw + Math.floor(x / cell);
            if (minX[g] < 0) { minX[g] = x; minY[g] = y; maxX[g] = x; maxY[g] = y; continue; }
            if (x < minX[g]) { minX[g] = x; }
            if (x > maxX[g]) { maxX[g] = x; }
            if (y > maxY[g]) { maxY[g] = y; }
        }
    }
    const seen = new Uint8Array(gw * gh);
    const rects: Rect[] = [];
    const stack: number[] = [];
    for (let g0 = 0; g0 < gw * gh; g0++) {
        if (minX[g0] < 0 || seen[g0]) { continue; }
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        stack.push(g0);
        seen[g0] = 1;
        while (stack.length) {
            const g = stack.pop()!;
            x0 = Math.min(x0, minX[g]); y0 = Math.min(y0, minY[g]); x1 = Math.max(x1, maxX[g]); y1 = Math.max(y1, maxY[g]);
            const cx = g % gw;
            const cy = (g - cx) / gw;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) { continue; }
                    const ng = ny * gw + nx;
                    if (minX[ng] >= 0 && !seen[ng]) { seen[ng] = 1; stack.push(ng); }
                }
            }
        }
        rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return rects;
}

/** 矩形の間のすき間（重なれば 0） */
function gap(a: Rect, b: Rect): number {
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    return Math.hypot(dx, dy);
}

function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function mergeNearest(rects: Rect[], max: number): Rect[] {
    const r = rects.slice();
    while (r.length > max) {
        let bi = 0, bj = 1, best = Infinity;
        for (let i = 0; i < r.length; i++) {
            for (let j = i + 1; j < r.length; j++) {
                const d = gap(r[i], r[j]);
                if (d < best) { best = d; bi = i; bj = j; }
            }
        }
        r[bi] = union(r[bi], r[bj]);
        r.splice(bj, 1);
    }
    return r.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ---------- 画像を読む ----------

/** PNG は自前で、ほかは ffmpeg で RGBA にする。ffmpeg が要るのに無ければ undefined */
async function decodeImage(bytes: Buffer, given: string | undefined, input: DiffInput, ctx: DiffContext): Promise<RgbaImage | undefined> {
    if (isPng(bytes)) { return decodePng(bytes, ctx.limits.maxPixels); }
    if (!ctx.tools.ffmpegPath || !ctx.tools.ffprobePath) { return undefined; }
    const file = await inputFile(given, bytes, ctx, input.path);
    const probe = await runTool(ctx.tools.ffprobePath, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'json', file], { timeoutMs: 30_000, maxBytes: 1 << 20 });
    let w = 0;
    let h = 0;
    try {
        const s = (JSON.parse(probe.stdout.toString('utf8')) as { streams?: { width?: number; height?: number }[] }).streams?.[0];
        w = s?.width ?? 0;
        h = s?.height ?? 0;
    } catch { /* 下で形式の誤りにする */ }
    if (!(w > 0 && h > 0)) { throw new DiffFormatError('画像の大きさが読めない'); }
    if (w * h > ctx.limits.maxPixels) { throw new DiffLimitError(`画像が大きすぎる（${w}×${h}）`); }
    const expected = w * h * 4;
    const out = await runTool(ctx.tools.ffmpegPath, [...FFMPEG_PRE, '-noautorotate', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
        { timeoutMs: 60_000, maxBytes: expected });
    if (out.stdout.length !== expected) { throw new DiffFormatError('画像を読めなかった（ffmpeg の出力の大きさが合わない）'); }
    return { width: w, height: h, data: new Uint8Array(out.stdout.buffer, out.stdout.byteOffset, expected) };
}

const sizeText = (i: RgbaImage) => `${i.width}×${i.height}`;
const preview = (i: RgbaImage) => pngDataUri(downscale(i, PREVIEW_MAX_W, PREVIEW_MAX_H));

export const imageDriver: DiffDriver = {
    id: 'image',
    version: 1,
    label: '画像',
    matches: (p) => EXTS.has(extOf(p)),
    async diff(input: DiffInput, ctx: DiffContext): Promise<ImageDiff | ErrorDiff> {
        const base = baseOf(imageDriver, input);
        const oldImg = input.oldBytes ? await decodeImage(input.oldBytes, input.oldFile, input, ctx) : undefined;
        const newImg = input.newBytes ? await decodeImage(input.newBytes, input.newFile, input, ctx) : undefined;
        if ((input.oldBytes && !oldImg) || (input.newBytes && !newImg)) { return toolMissing(imageDriver, input, 'PNG 以外の画像'); }
        const result: ImageDiff = {
            ...base, kind: 'image', summary: '', regions: [], changedRatio: 0,
            oldSize: oldImg && { w: oldImg.width, h: oldImg.height },
            newSize: newImg && { w: newImg.width, h: newImg.height },
        };
        if (!oldImg || !newImg) {
            const img = (oldImg ?? newImg)!;
            result.summary = `${oldImg ? '削除' : '追加'}（${sizeText(img)}）`;
            result.changedRatio = 1;
            result.previews = oldImg ? { old: preview(img) } : { new: preview(img) };
            return result;
        }
        if (oldImg.width !== newImg.width || oldImg.height !== newImg.height) {
            result.sizeChanged = true;
            result.changedRatio = 1;
            result.summary = `大きさが変わった（${sizeText(oldImg)} → ${sizeText(newImg)}）`;
            result.previews = { old: preview(oldImg), new: preview(newImg) };
            return result;
        }
        const lossy = LOSSY_EXTS.has(extOf(input.path)) && !(isPng(input.oldBytes) && isPng(input.newBytes));
        const { mask, changed, exact } = changeMask(oldImg, newImg, lossy ? LOSSY_PIXEL_THRESHOLD : PIXEL_THRESHOLD);
        const total = oldImg.width * oldImg.height;
        result.changedRatio = changed / total;
        result.previews = { old: preview(oldImg), new: preview(newImg) };
        if (changed === 0) {
            result.status = 'unchanged';
            const bytesDiffer = !input.oldBytes!.equals(input.newBytes!);
            result.summary = exact
                ? (bytesDiffer ? '変更なし（画素は同じ。メタデータだけ変わった）' : '変更なし（画素は同じ）')
                : '変更なし（画素の差はわずか。圧縮し直しによる揺れと思われる）';
            return result;
        }
        result.regions = changedRegions(mask, oldImg.width, oldImg.height);
        result.previews.heat = pngDataUri(heatImage(newImg, mask, PREVIEW_MAX_W, PREVIEW_MAX_H));
        const pct = result.changedRatio * 100;
        const pctText = pct < 0.1 ? '0.1% 未満' : `${pct.toFixed(1)}%`;
        result.summary = `${result.regions.length} か所が変わった（画素の ${pctText}）`;
        return result;
    },
};
