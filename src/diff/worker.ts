/**
 * 差分を計算する子プロセスの入口（docs/structured-diff.md §4「別プロセスでの実行」）。VS Code に依存しない。
 * runner.ts が child_process.fork で起動し、1 件の依頼（WorkerRequest）を送る。結果（StructuredDiff）を 1 回返して終わる。
 * 信頼できないファイルを読むので、拡張機能ホストとは別のプロセスにし、メモリの上限（--max-old-space-size）と
 * 時間の上限（runner.ts が kill する）を付ける。ドライバの例外は ErrorDiff にして返す（落ちたら runner.ts が internal にする）。
 */
import * as fs from 'fs';
import { selectDriver } from './registry';
import { killRunningTools } from './image';
import { DiffContext, DiffFormatError, DiffLimitError, DiffLimits, ErrorDiff, ExternalTools, StructuredDiff } from './types';

export interface WorkerRequest {
    path: string;
    oldFile?: string;
    newFile?: string;
    limits: DiffLimits;
    tools: ExternalTools;
    tmpDir: string;
}

export async function runRequest(req: WorkerRequest): Promise<StructuredDiff> {
    const oldBytes = req.oldFile ? fs.readFileSync(req.oldFile) : undefined;
    const newBytes = req.newFile ? fs.readFileSync(req.newFile) : undefined;
    const head = (newBytes ?? oldBytes ?? Buffer.alloc(0)).subarray(0, 4096);
    const driver = selectDriver(req.path, head);
    const ctx: DiffContext = { limits: req.limits, tools: req.tools, tmpDir: req.tmpDir };
    try {
        return await driver.diff({ path: req.path, oldBytes, newBytes, oldFile: req.oldFile, newFile: req.newFile }, ctx);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const reason: ErrorDiff['reason'] = err instanceof DiffLimitError ? 'limit' : err instanceof DiffFormatError ? 'format' : 'internal';
        return {
            kind: 'error', driver: driver.id, driverVersion: driver.version, path: req.path,
            status: !oldBytes ? 'added' : !newBytes ? 'deleted' : 'modified',
            summary: reason === 'limit' ? `大きすぎて比べられない（${message}）` : reason === 'format' ? `読めない（${message}）` : `比べられなかった（${message}）`,
            warnings: [], reason, message,
        };
    }
}

if (require.main === module) {
    // 頼んだ側が止めた（時間切れ・取り消し）・切れたときは、動かしている ffmpeg も止めてから終わる（レビュー #10）
    const stop = () => { killRunningTools(); process.exit(1); };
    process.on('SIGTERM', stop);
    process.on('disconnect', stop);
    process.on('message', (req: WorkerRequest) => {
        runRequest(req).then(
            (result) => { process.send?.(result, () => process.exit(0)); },
            (err: unknown) => { process.send?.({ fatal: String(err) }, () => process.exit(1)); },
        );
    });
}
