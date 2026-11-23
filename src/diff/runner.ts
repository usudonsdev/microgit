/**
 * 差分の計算を頼む側（拡張機能ホストから使う）。VS Code に依存しない（単体テストから呼べる）。
 * - ドライバを選び、(ドライバ, 版, 上限, 旧の中身の指紋, 新の中身の指紋) をキーにキャッシュを引く（docs/structured-diff.md §4）
 * - 無ければ一時フォルダに旧版・新版を書き、worker.ts を別プロセスで起動して計算させる。時間を超えたら kill して timeout
 * - 結果をキャッシュに書く（timeout と internal は書かない。次はもう一度試す）。キャッシュは数の上限を超えたら古いものから消す
 * 中身の指紋は sha256。同じ組み合わせの計算は 1 回で済む。
 */
import { fork } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectDriver } from './registry';
import { DEFAULT_LIMITS, DiffLimits, ErrorDiff, ExternalTools, StructuredDiff } from './types';
import type { WorkerRequest } from './worker';

export interface ComputeRequest {
    path: string;
    oldBytes?: Buffer;
    newBytes?: Buffer;
    /** キャッシュを置くフォルダ。無ければキャッシュしない */
    cacheDir?: string;
    limits?: Partial<DiffLimits>;
    tools?: ExternalTools;
    timeoutMs?: number;
    /** 子プロセスのメモリの上限（MB） */
    memoryMb?: number;
    /** 取り消し（利用者が通知の「キャンセル」を押した） */
    signal?: AbortSignal;
}

/** キャッシュに残す件数の上限 */
export const CACHE_MAX_ENTRIES = 300;

export function cacheKey(driverId: string, driverVersion: number, limits: DiffLimits, tools: ExternalTools, oldBytes?: Buffer, newBytes?: Buffer): string {
    const h = createHash('sha256');
    h.update(`${driverId}@${driverVersion}\n${JSON.stringify(limits)}\n${tools.ffmpegPath ? 'ffmpeg' : 'no-ffmpeg'}\n`);
    h.update(oldBytes ? createHash('sha256').update(oldBytes).digest('hex') : '-');
    h.update('\n');
    h.update(newBytes ? createHash('sha256').update(newBytes).digest('hex') : '-');
    return h.digest('hex').slice(0, 40);
}

export async function computeDiff(req: ComputeRequest): Promise<StructuredDiff> {
    const limits: DiffLimits = { ...DEFAULT_LIMITS, ...(req.limits ?? {}) };
    const tools = req.tools ?? {};
    const head = (req.newBytes ?? req.oldBytes ?? Buffer.alloc(0)).subarray(0, 4096);
    const driver = selectDriver(req.path, head);
    const key = cacheKey(driver.id, driver.version, limits, tools, req.oldBytes, req.newBytes);
    const cacheFile = req.cacheDir ? path.join(req.cacheDir, `${key}.json`) : undefined;
    if (cacheFile) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as StructuredDiff;
            // パスはキーに入れていない（同じ中身なら同じ結果）。表示用に今のパスにする
            return { ...cached, path: req.path };
        } catch { /* 無い・壊れている */ }
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vereve-diff-'));
    try {
        const ext = path.extname(req.path).replace(/[^.A-Za-z0-9]/g, '');
        const oldFile = req.oldBytes ? path.join(tmpDir, `old${ext}`) : undefined;
        const newFile = req.newBytes ? path.join(tmpDir, `new${ext}`) : undefined;
        if (oldFile) { fs.writeFileSync(oldFile, req.oldBytes!); }
        if (newFile) { fs.writeFileSync(newFile, req.newBytes!); }
        const work = fs.mkdtempSync(path.join(tmpDir, 'work-'));
        const result = await runWorker({ path: req.path, oldFile, newFile, limits, tools, tmpDir: work }, req, driver.id, driver.version);
        if (cacheFile && !(result.kind === 'error' && (result.reason === 'timeout' || result.reason === 'internal'))) {
            writeCache(req.cacheDir!, cacheFile, result);
        }
        return result;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function runWorker(wreq: WorkerRequest, req: ComputeRequest, driverId: string, driverVersion: number): Promise<StructuredDiff> {
    const status: ErrorDiff['status'] = !req.oldBytes ? 'added' : !req.newBytes ? 'deleted' : 'modified';
    const fail = (reason: ErrorDiff['reason'], message: string, summary: string): ErrorDiff => ({
        kind: 'error', driver: driverId, driverVersion, path: req.path, status, summary, warnings: [], reason, message,
    });
    return new Promise((resolve) => {
        const child = fork(path.join(__dirname, 'worker.js'), [], {
            execArgv: [`--max-old-space-size=${req.memoryMb ?? 2048}`],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            // 拡張機能ホストの環境変数（ELECTRON_RUN_AS_NODE を含む）を引き継ぐ。VS Code の中では process.execPath が
            // Electron なので、ELECTRON_RUN_AS_NODE=1 が無いと Node として動かない
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        let done = false;
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 4000) { stderr += d.toString(); } });
        const finish = (r: StructuredDiff) => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            req.signal?.removeEventListener('abort', onAbort);
            if (child.exitCode === null) { child.kill('SIGKILL'); }
            resolve(r);
        };
        const timeoutMs = req.timeoutMs ?? 120_000;
        const timer = setTimeout(() => finish(fail('timeout', `${Math.round(timeoutMs / 1000)} 秒で終わらなかった`, `時間がかかりすぎるので打ち切った（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
        const onAbort = () => finish(fail('timeout', '取り消した', '取り消した'));
        req.signal?.addEventListener('abort', onAbort);
        child.on('message', (m: StructuredDiff | { fatal: string }) => {
            if ('fatal' in m) { finish(fail('internal', m.fatal, `比べられなかった（${m.fatal}）`)); return; }
            finish(m);
        });
        child.on('exit', (code, signal) => {
            if (done) { return; }
            const oom = /heap out of memory|Allocation failed/i.test(stderr);
            finish(oom
                ? fail('limit', 'メモリの上限を超えた', '大きすぎて比べられない（メモリの上限を超えた）')
                : fail('internal', `計算のプロセスが終了した（${signal ?? code}）${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, '比べられなかった（計算のプロセスが異常終了した）'));
        });
        child.on('error', (err) => finish(fail('internal', err.message, `比べられなかった（${err.message}）`)));
        child.send(wreq);
    });
}

function writeCache(dir: string, file: string, result: StructuredDiff): void {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, file);
        pruneCache(dir);
    } catch { /* キャッシュに書けなくても結果は返す */ }
}

/** 数の上限を超えたら、更新時刻の古いものから消す */
export function pruneCache(dir: string, max = CACHE_MAX_ENTRIES): void {
    let files: { f: string; t: number }[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
    } catch { return; }
    if (files.length <= max) { return; }
    files.sort((a, b) => a.t - b.t);
    for (const { f } of files.slice(0, files.length - max)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
}
