/**
 * 動画の差分ドライバ（docs/structured-diff.md §3.2）。VS Code に依存しない。ffmpeg・ffprobe を使う（無ければ比べられない、と返す）。
 *
 * 手順：
 * 1. ffprobe で両方の版の長さ・大きさ・コマの速さ・コーデック・音声の有無を読む
 * 2. 両方を同じ間隔（遅いほうのコマの速さ。maxVideoFrames を超えるなら間引く）で、32×18 のグレーに縮めて復号する。これがコマの指紋
 * 3. 指紋の差（画素の差の平均と最大）が小さいコマを「同じ」とする。書き出し直し（圧縮の度合いを変えた）では同じのまま、
 *    字幕や図形を重ねたコマは違う、になるように閾値を決めた（FRAME_MEAN_THRESHOLD・FRAME_MAX_THRESHOLD）
 * 4. 2 つのコマの列を alignSequences で対応づけ、同じ・差し替え・追加・削除の区間にする
 * 5. 同じでない区間（最大 MAX_THUMB_SEGMENTS 個）は、真ん中のコマを 160 画素幅の PNG にして付ける。差し替えには差を赤で重ねた画像も
 * 6. 両方に音声があれば、モノラル 8 kHz に復号し、0.1 秒ごとの強さ（RMS）と零交差の割合（音の高さのおおよそ）を同じ方法で対応づける
 *
 * 入力は信頼できない：ffmpeg はシェルを通さず引数の配列で呼び（image.ts の runTool）、時間と出力の大きさに上限を付ける。
 */
import { DiffContext, DiffDriver, DiffInput, ErrorDiff, MediaInfo, VideoDiff, VideoSegment, AudioSegment, baseOf, extOf, DiffFormatError } from './types';
import { FFMPEG_PRE, ToolTimeoutError, changeMask, heatImage, inputFile, runTool, toolMissing } from './image';
import { decodePng, isPng, pngDataUri } from './png';

const EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'wmv', 'flv', '3gp']);

/** 指紋の大きさ（横 × 縦。16:9 に合わせたが、ほかの比でも縮めて使う） */
const FP_W = 32;
const FP_H = 18;
const FP = FP_W * FP_H;
/**
 * 指紋の画素の差の平均（0〜255）がこれ以下で、かつ最大が FRAME_MAX_THRESHOLD 以下なら同じコマ。
 * 書き出し直し（crf 18→30）の揺れは 160×90 で平均 1.2・最大 17、1280×720 で平均 0.2・最大 5。
 * 720p の字幕 1 行（36 ポイント）は平均 0.3 で埋もれるが、最大は 52 になる。だから平均と最大の両方で見る
 */
export const FRAME_MEAN_THRESHOLD = 3;
export const FRAME_MAX_THRESHOLD = 32;
/** 区間の代表のコマを付ける区間の数の上限 */
const MAX_THUMB_SEGMENTS = 30;
const THUMB_W = 160;
/** 音声の強さを測る窓（秒） */
const AUDIO_WIN_SEC = 0.1;
const AUDIO_RATE = 8000;

// ---------- 列の対応づけ ----------

export interface AlignSeg {
    type: 'equal' | 'modified' | 'inserted' | 'deleted';
    /** 旧の列の [a0, a1)、新の列の [b0, b1)。追加では a0 === a1（旧のどこに足されたか）、削除では b0 === b1 */
    a0: number;
    a1: number;
    b0: number;
    b1: number;
}

/**
 * 似ているかどうかしか分からない 2 つの列を対応づける（LCS は「等しい」が要るので使えない）。
 * 前から順に、同じなら進む。違ったら、先 window 個までの中で run 個続けて同じになる位置（同期点）を探し、
 * 旧・新の進んだ数の和が最小のものを選ぶ。旧だけ進めば削除、新だけなら追加、両方なら差し替え。
 * 見つからなければ 1 つずつ差し替えにして進む。そのときは前回調べた範囲を覚えておき、新しく窓に入った端だけを調べる
 * （全く違う動画でも O(N·window) で済むように）。
 */
export function alignSequences(n: number, m: number, sim: (i: number, j: number) => boolean, window: number, run: number): AlignSeg[] {
    const segs: AlignSeg[] = [];
    const push = (type: AlignSeg['type'], a0: number, a1: number, b0: number, b1: number) => {
        const last = segs[segs.length - 1];
        if (last && last.type === type && last.a1 === a0 && last.b1 === b0) { last.a1 = a1; last.b1 = b1; return; }
        segs.push({ type, a0, a1, b0, b1 });
    };
    /** (a, b) から run 個続けて同じか。途中でどちらかの列が終われば、そこまで同じなら良い */
    const runOk = (a: number, b: number) => {
        for (let t = 0; t < run; t++) {
            if (a + t >= n || b + t >= m) { return t > 0; }
            if (!sim(a + t, b + t)) { return false; }
        }
        return true;
    };
    let i = 0;
    let j = 0;
    let failedAt = -1; // 直前に同期点が見つからなかった i（j も同じだけ進んでいる）
    while (i < n && j < m) {
        if (sim(i, j)) { push('equal', i, i + 1, j, j + 1); i++; j++; failedAt = -1; continue; }
        const incremental = failedAt === i - 1;
        const wa = Math.min(window, n - 1 - i);
        const wb = Math.min(window, m - 1 - j);
        let best: [number, number] | undefined;
        let bestCost = Infinity;
        let bestSkew = Infinity;
        const tryAt = (di: number, dj: number) => {
            const cost = di + dj;
            const skew = Math.abs(di - dj);
            if (cost > bestCost || (cost === bestCost && skew >= bestSkew)) { return; }
            if (runOk(i + di, j + dj)) { best = [di, dj]; bestCost = cost; bestSkew = skew; }
        };
        if (incremental) {
            // 前回 (i-1, j-1) から調べた範囲の外：窓の端の行と列だけ
            if (wa === window) { for (let dj = 0; dj <= wb; dj++) { tryAt(wa, dj); } }
            if (wb === window) { for (let di = 0; di <= wa; di++) { tryAt(di, wb); } }
        } else {
            for (let s = 1; s <= wa + wb && s <= bestCost; s++) {
                for (let di = Math.max(0, s - wb); di <= Math.min(wa, s); di++) { tryAt(di, s - di); }
            }
        }
        if (best) {
            const [di, dj] = best;
            push(di > 0 && dj > 0 ? 'modified' : di > 0 ? 'deleted' : 'inserted', i, i + di, j, j + dj);
            i += di;
            j += dj;
            failedAt = -1;
        } else {
            push('modified', i, i + 1, j, j + 1);
            failedAt = i;
            i++;
            j++;
        }
    }
    if (i < n) { push('deleted', i, n, j, j); }
    if (j < m) { push('inserted', i, i, j, m); }
    return mergeSmallGaps(segs, 3);
}

/** 差し替えの間に挟まった、minGap 個より短い「同じ」をつないで 1 つの差し替えにする */
function mergeSmallGaps(segs: AlignSeg[], minGap: number): AlignSeg[] {
    const out: AlignSeg[] = [];
    for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const prev = out[out.length - 1];
        const next = segs[k + 1];
        if (s.type === 'equal' && prev?.type === 'modified' && next?.type === 'modified' && s.a1 - s.a0 < minGap) {
            prev.a1 = next.a1;
            prev.b1 = next.b1;
            k++;
            continue;
        }
        out.push({ ...s });
    }
    return out;
}

// ---------- ffprobe ----------

interface ProbeStream {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    nb_frames?: string;
    duration?: string;
}

function parseRate(s: string | undefined): number | undefined {
    if (!s) { return undefined; }
    const [a, b] = s.split('/').map(Number);
    const v = b ? a / b : a;
    return Number.isFinite(v) && v > 0 && v < 1000 ? v : undefined;
}

async function probe(file: string, ctx: DiffContext): Promise<MediaInfo> {
    const out = await runTool(ctx.tools.ffprobePath!, ['-hide_banner', '-loglevel', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { timeoutMs: 30_000, maxBytes: 4 << 20 });
    let j: { streams?: ProbeStream[]; format?: { duration?: string } };
    try { j = JSON.parse(out.stdout.toString('utf8')); } catch { throw new DiffFormatError('動画の情報を読めない'); }
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const a = j.streams?.find((s) => s.codec_type === 'audio');
    if (!v && !a) { throw new DiffFormatError('動画にも音声にも読める流れが無い'); }
    const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration);
    const fps = parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate);
    const frames = Number(v?.nb_frames);
    return {
        durationSec: Number.isFinite(dur) && dur > 0 ? dur : 0,
        width: v?.width,
        height: v?.height,
        fps,
        frames: Number.isFinite(frames) && frames > 0 ? frames : undefined,
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
        hasAudio: !!a,
    };
}

/** 長い処理の時間の上限：1 分 ＋ 動画の長さの 3 倍（最大 30 分） */
const decodeTimeout = (durSec: number) => Math.min(30 * 60_000, 60_000 + durSec * 3000);

// ---------- コマの指紋 ----------

async function fingerprints(file: string, info: MediaInfo, rate: number, ctx: DiffContext): Promise<{ data: Uint8Array; count: number; truncated: boolean }> {
    const { stdout, truncated } = await runTool(ctx.tools.ffmpegPath!, [...FFMPEG_PRE, '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', `fps=fps=${rate.toFixed(6)},scale=${FP_W}:${FP_H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { timeoutMs: decodeTimeout(info.durationSec), maxBytes: ctx.limits.maxVideoFrames * FP, truncateOk: true });
    const count = Math.floor(stdout.length / FP);
    return { data: new Uint8Array(stdout.buffer, stdout.byteOffset, count * FP), count, truncated };
}

function frameSim(a: Uint8Array, b: Uint8Array): (i: number, j: number) => boolean {
    const limit = FRAME_MEAN_THRESHOLD * FP;
    return (i, j) => {
        let sum = 0;
        const oa = i * FP;
        const ob = j * FP;
        for (let k = 0; k < FP; k++) {
            const d = Math.abs(a[oa + k] - b[ob + k]);
            if (d > FRAME_MAX_THRESHOLD) { return false; }
            sum += d;
            if (sum > limit) { return false; }
        }
        return true;
    };
}

// ---------- 代表のコマ ----------

async function thumb(file: string, t: number, ctx: DiffContext): Promise<Buffer | undefined> {
    try {
        const { stdout } = await runTool(ctx.tools.ffmpegPath!, [...FFMPEG_PRE, '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1',
            '-vf', `scale=${THUMB_W}:-2`, '-f', 'image2pipe', '-vcodec', 'png', '-'], { timeoutMs: 60_000, maxBytes: 8 << 20 });
        return isPng(stdout) ? stdout : undefined;
    } catch (e) {
        if (e instanceof ToolTimeoutError) { throw e; }
        return undefined;
    }
}

const uri = (b: Buffer | undefined) => (b ? `data:image/png;base64,${b.toString('base64')}` : undefined);

/** 差し替えの区間の、差を赤で重ねた画像。大きさが違えば付けない */
function thumbHeat(a: Buffer, b: Buffer): string | undefined {
    try {
        const ia = decodePng(a, 4_000_000);
        const ib = decodePng(b, 4_000_000);
        if (ia.width !== ib.width || ia.height !== ib.height) { return undefined; }
        // 動画の圧縮の揺れは静止画より大きいので、閾値を上げる
        const { mask } = changeMask(ia, ib, 32);
        return pngDataUri(heatImage(ib, mask, THUMB_W, 1000));
    } catch {
        return undefined;
    }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let k = 0;
    const worker = async () => { while (k < items.length) { await fn(items[k++]); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ---------- 音声 ----------

interface Envelope { rms: Float32Array; zcr: Float32Array }

async function audioEnvelope(file: string, info: MediaInfo, ctx: DiffContext): Promise<Envelope> {
    // 長さが分からないときは 2 時間ぶんまで
    const maxSec = info.durationSec > 0 ? info.durationSec + 5 : 7200;
    const { stdout } = await runTool(ctx.tools.ffmpegPath!, [...FFMPEG_PRE, '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', '1', '-ar', String(AUDIO_RATE), '-f', 's16le', '-'],
    { timeoutMs: decodeTimeout(info.durationSec), maxBytes: Math.ceil(maxSec * AUDIO_RATE * 2), truncateOk: true });
    const win = AUDIO_RATE * AUDIO_WIN_SEC;
    const samples = Math.floor(stdout.length / 2);
    const count = Math.floor(samples / win);
    const rms = new Float32Array(count);
    const zcr = new Float32Array(count);
    for (let w = 0; w < count; w++) {
        let sq = 0;
        let zc = 0;
        let prev = 0;
        for (let k = 0; k < win; k++) {
            const s = stdout.readInt16LE((w * win + k) * 2);
            sq += s * s;
            if (k > 0 && (s >= 0) !== (prev >= 0)) { zc++; }
            prev = s;
        }
        rms[w] = Math.sqrt(sq / win);
        zcr[w] = zc / win;
    }
    return { rms, zcr };
}

/** 強さと零交差の割合が近ければ同じ窓。両方ほぼ無音なら同じ */
function audioSim(a: Envelope, b: Envelope): (i: number, j: number) => boolean {
    return (i, j) => {
        const ra = a.rms[i];
        const rb = b.rms[j];
        if (ra < 300 && rb < 300) { return true; }
        if (Math.abs(ra - rb) > 0.2 * Math.max(ra, rb) + 150) { return false; }
        const za = a.zcr[i];
        const zb = b.zcr[j];
        return Math.abs(za - zb) <= 0.2 * Math.max(za, zb) + 0.01;
    };
}

// ---------- 要約 ----------

/** 秒を m:ss（1 時間以上は h:mm:ss）にする。tenths なら小数 1 桁を付ける */
export function formatTime(sec: number, tenths = false): string {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const ss = tenths ? (Math.floor(s * 10) / 10).toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function rangeText(a: number, b: number): string {
    let x = formatTime(a);
    let y = formatTime(b);
    if (x === y) { x = formatTime(a, true); y = formatTime(b, true); }
    return `${x}〜${y}`;
}

function describe(segs: AlignSeg[], interval: number, what: string): string[] {
    const parts: string[] = [];
    for (const s of segs) {
        if (s.type === 'modified') { parts.push(`${rangeText(s.a0 * interval, s.a1 * interval)} を差し替え`); }
        if (s.type === 'deleted') { parts.push(`${rangeText(s.a0 * interval, s.a1 * interval)} を削除`); }
        if (s.type === 'inserted') {
            const len = (s.b1 - s.b0) * interval;
            parts.push(`${formatTime(s.a0 * interval, true)} に ${len < 10 ? `${len.toFixed(1)} 秒` : formatTime(len)}を追加`);
        }
    }
    const shown = parts.slice(0, 4);
    if (parts.length > 4) { shown.push(`ほか ${parts.length - 4} か所`); }
    return shown.map((p, k) => (k === 0 && what ? what + p : p));
}

function infoText(i: MediaInfo): string {
    const size = i.width && i.height ? `、${i.width}×${i.height}` : '';
    return `${formatTime(i.durationSec)}${size}`;
}

// ---------- ドライバ ----------

function toSegment(s: AlignSeg, interval: number, oldDur: number, newDur: number): VideoSegment {
    const seg: VideoSegment = { type: s.type };
    const clip = (t: number, d: number) => Math.round(Math.min(t, d > 0 ? d : t) * 1000) / 1000;
    if (s.type !== 'inserted') {
        seg.oldStart = clip(s.a0 * interval, oldDur);
        seg.oldEnd = clip(s.a1 * interval, oldDur);
        seg.oldFrames = [s.a0, s.a1];
    }
    if (s.type !== 'deleted') {
        seg.newStart = clip(s.b0 * interval, newDur);
        seg.newEnd = clip(s.b1 * interval, newDur);
        seg.newFrames = [s.b0, s.b1];
    }
    return seg;
}

export const videoDriver: DiffDriver = {
    id: 'video',
    version: 1,
    label: '動画',
    matches: (p) => EXTS.has(extOf(p)),
    async diff(input: DiffInput, ctx: DiffContext): Promise<VideoDiff | ErrorDiff> {
        if (!ctx.tools.ffmpegPath || !ctx.tools.ffprobePath) { return toolMissing(videoDriver, input, '動画'); }
        try {
            return await diffVideo(input, ctx);
        } catch (e) {
            const base = baseOf(videoDriver, input);
            if (e instanceof ToolTimeoutError) {
                return { ...base, kind: 'error', reason: 'timeout', message: e.message, summary: '時間がかかりすぎて比べられなかった' };
            }
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                return toolMissing(videoDriver, input, '動画');
            }
            throw e;
        }
    },
};

async function diffVideo(input: DiffInput, ctx: DiffContext): Promise<VideoDiff> {
    const base = baseOf(videoDriver, input);
    const oldFile = input.oldBytes ? await inputFile(input.oldFile, input.oldBytes, ctx, input.path) : undefined;
    const newFile = input.newBytes ? await inputFile(input.newFile, input.newBytes, ctx, input.path) : undefined;
    const oldInfo = oldFile ? await probe(oldFile, ctx) : undefined;
    const newInfo = newFile ? await probe(newFile, ctx) : undefined;
    const result: VideoDiff = { ...base, kind: 'video', summary: '', oldInfo, newInfo, sampleIntervalSec: 0, segments: [] };

    // 追加・削除：全体を 1 つの区間にして、真ん中のコマを付ける
    if (!oldInfo || !newInfo) {
        const info = (oldInfo ?? newInfo)!;
        const file = (oldFile ?? newFile)!;
        const fps = info.fps ?? 25;
        result.sampleIntervalSec = 1 / fps;
        const frames = info.frames ?? Math.round(info.durationSec * fps);
        const seg: VideoSegment = oldInfo
            ? { type: 'deleted', oldStart: 0, oldEnd: info.durationSec, oldFrames: [0, frames] }
            : { type: 'inserted', newStart: 0, newEnd: info.durationSec, newFrames: [0, frames] };
        if (info.width) {
            const t = uri(await thumb(file, info.durationSec / 2, ctx));
            if (oldInfo) { seg.thumbOld = t; } else { seg.thumbNew = t; }
        }
        result.segments = [seg];
        result.summary = `${oldInfo ? '削除' : '追加'}（${infoText(info)}）`;
        return result;
    }

    const parts: string[] = [];
    const hasVideo = !!oldInfo.width && !!newInfo.width;
    if (hasVideo) {
        // 両方を同じ間隔で比べる。速さが違えば遅いほうに合わせ、コマの数の上限を超えるなら間引く
        let rate = Math.min(oldInfo.fps ?? 25, newInfo.fps ?? 25);
        const maxDur = Math.max(oldInfo.durationSec, newInfo.durationSec);
        if (maxDur * rate > ctx.limits.maxVideoFrames) {
            rate = (ctx.limits.maxVideoFrames * 0.95) / maxDur;
            result.warnings.push(`コマが多いので、${(1 / rate).toFixed(2)} 秒ごとに間引いて比べた`);
        }
        const interval = 1 / rate;
        result.sampleIntervalSec = interval;
        const [fa, fb] = await Promise.all([fingerprints(oldFile!, oldInfo, rate, ctx), fingerprints(newFile!, newInfo, rate, ctx)]);
        if (fa.truncated || fb.truncated) {
            result.warnings.push('コマの数が上限を超えたので、途中までを比べた');
            result.truncated = true;
        }
        if (fa.count === 0 || fb.count === 0) { throw new DiffFormatError('動画のコマを読めなかった'); }
        // 同期点を探す範囲は 30 秒（最大 1,000 コマ）、同期とみなす連続は 0.5 秒（3〜15 コマ）
        const window = Math.min(1000, Math.ceil(30 / interval));
        const run = Math.max(3, Math.min(15, Math.round(0.5 / interval)));
        const aligned = alignSequences(fa.count, fb.count, frameSim(fa.data, fb.data), window, run);
        let changed = aligned.filter((s) => s.type !== 'equal');
        if (changed.length > ctx.limits.maxChanges) {
            changed = changed.slice(0, ctx.limits.maxChanges);
            result.truncated = true;
        }
        result.segments = aligned.filter((s) => s.type === 'equal' || changed.includes(s))
            .map((s) => toSegment(s, interval, oldInfo.durationSec, newInfo.durationSec));
        parts.push(...describe(changed, interval, ''));

        const withThumb = result.segments.filter((s) => s.type !== 'equal').slice(0, MAX_THUMB_SEGMENTS);
        if (changed.length > MAX_THUMB_SEGMENTS) { result.warnings.push(`代表のコマは最初の ${MAX_THUMB_SEGMENTS} か所だけ付けた`); }
        await pool(withThumb, 4, async (s) => {
            const a = s.oldStart !== undefined ? await thumb(oldFile!, (s.oldStart + s.oldEnd!) / 2, ctx) : undefined;
            const b = s.newStart !== undefined ? await thumb(newFile!, (s.newStart + s.newEnd!) / 2, ctx) : undefined;
            s.thumbOld = uri(a);
            s.thumbNew = uri(b);
            if (s.type === 'modified' && a && b) { s.heat = thumbHeat(a, b); }
        });
    } else if (oldInfo.width || newInfo.width) {
        parts.push(oldInfo.width ? '映像を削除' : '映像を追加');
    }

    // 音声
    if (oldInfo.hasAudio && newInfo.hasAudio) {
        try {
            const [ea, eb] = await Promise.all([audioEnvelope(oldFile!, oldInfo, ctx), audioEnvelope(newFile!, newInfo, ctx)]);
            const al = alignSequences(ea.rms.length, eb.rms.length, audioSim(ea, eb), 300, 5);
            const segs: AudioSegment[] = al.map((s) => {
                const seg: AudioSegment = { type: s.type };
                const t = (k: number) => Math.round(k * AUDIO_WIN_SEC * 1000) / 1000;
                if (s.type !== 'inserted') { seg.oldStart = t(s.a0); seg.oldEnd = t(s.a1); }
                if (s.type !== 'deleted') { seg.newStart = t(s.b0); seg.newEnd = t(s.b1); }
                return seg;
            });
            result.audio = { segments: segs };
            const ach = al.filter((s) => s.type !== 'equal');
            if (ach.length > 0) { parts.push(...describe(ach, AUDIO_WIN_SEC, '音声の ').slice(0, 2)); }
        } catch (e) {
            if (e instanceof ToolTimeoutError) { throw e; }
            result.audio = { segments: [], note: `音声を読めなかった（${(e as Error).message}）` };
        }
    } else if (oldInfo.hasAudio !== newInfo.hasAudio) {
        const d = oldInfo.hasAudio ? oldInfo.durationSec : newInfo.durationSec;
        result.audio = {
            segments: [oldInfo.hasAudio ? { type: 'deleted', oldStart: 0, oldEnd: d } : { type: 'inserted', newStart: 0, newEnd: d }],
            note: oldInfo.hasAudio ? '新版には音声が無い' : '新版で音声が付いた',
        };
        parts.push(oldInfo.hasAudio ? '音声を削除' : '音声を追加');
    }

    if (parts.length === 0) {
        result.status = 'unchanged';
        result.summary = hasVideo ? '変更なし（コマは同じ）' : '変更なし（音声は同じ）';
    } else {
        result.summary = parts.join('、');
    }
    return result;
}
