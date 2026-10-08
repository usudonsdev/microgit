/**
 * agent（guest/agent）との接続（#14）。命令の形は docs/agent-protocol.md（v1）。
 *
 * agent の命令の通り道になるプロセス（QEMU、mac の microgit-vm、Linux の `unshare -Urm <agent>`）を子プロセスとして
 * 起動し、1 行 1 JSON で話す。通り道は 2 通り:
 *   - 子プロセスの stdin/stdout（既定。Linux の VM なし、Linux の QEMU、mac の microgit-vm）
 *   - 名前付きパイプ（spec.namedPipe。Windows の QEMU）。Windows 版 QEMU の stdio の chardev は、
 *     2026-09-26 の計測で
 *     ホスト → ゲストが毎秒 13 KB ほどしか出ず、1 MiB で中身が壊れた（bad base64）。`-chardev pipe` にすると
 *     1 MiB の commit が 26 ms、16 MiB が 2.3 秒で、往復で中身も一致した（docs/kernel-backend.md §4）
 * VS Code に依存しない（単体テスト・スクリプトから使うため）。
 */
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as readline from 'readline';
import { Readable, Writable } from 'stream';

export const PROTOCOL_VERSION = 1;

export type LaunchSpec = {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    /** 説明（ログと Overlay Status 用） */
    description: string;
    /**
     * 命令の通り道にする名前付きパイプ（Windows の `\\.\pipe\...`）。指定したら、子プロセスの stdin/stdout
     * ではなくこのパイプにつなぐ。子プロセス（QEMU）がパイプを作るまで、connectTimeoutMs のあいだつなぎ直す
     */
    namedPipe?: string;
    /**
     * 通り道が安全に運べる JSON 1 行の大きさ。macOS の Virtualization.framework では約 64 KiB を
     * 超えると停止するため、stage / readChunk へ切り替える判断に使う。省略時はプロトコル上限 128 MiB。
     */
    maxFrameBytes?: number;
};

export type AgentReady = {
    protocol?: number;
    agent?: string;
    kernel?: string;
    mountOptions?: string;
};

/** agent が ok: false で答えたときの例外。code は docs/agent-protocol.md §5 の記号 */
export class AgentError extends Error {
    constructor(public readonly op: string, public readonly code: string, message: string) {
        super(`${op} failed: ${message} (${code})`);
        this.name = 'AgentError';
    }
}

/** agent のプロセスが落ちた・つながらない・時間切れのときの例外 */
export class AgentUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentUnavailableError';
    }
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sentAt: number };

/**
 * 1 回の要求の時刻（performance.now()、#61 の計測用）。
 *   sentAt     要求を書き出し終えた時刻
 *   arrivedAt  応答の行を受け取った時刻（readline の line が呼ばれた時）
 * 応答のオブジェクトをキーにして持つ（応答の中身には混ぜない）
 */
export type RequestTiming = { sentAt: number; arrivedAt: number };
const requestTimings = new WeakMap<object, RequestTiming>();

/** request / call が返した応答の時刻。計測を持たない応答（偽の agent など）では undefined */
export function requestTiming(res: object): RequestTiming | undefined {
    return requestTimings.get(res);
}

function connectPipe(pipe: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.connect(pipe);
        s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
        s.once('error', reject);
    });
}

export class AgentConnection {
    private readonly child: ChildProcess;
    private output: Writable | undefined;
    private readonly connected: Promise<void>;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readyInfo: AgentReady | undefined;
    private readyWaiters: Array<{ resolve: (r: AgentReady) => void; reject: (e: Error) => void }> = [];
    private deadReason: string | undefined;
    /** 最後に出た stderr（起動に失敗した理由を知らせるため。例: unshare の uid_map のエラー） */
    private stderrTail = '';

    constructor(
        public readonly spec: LaunchSpec,
        private readonly requestTimeoutMs = 60_000,
        connectTimeoutMs = 30_000,
    ) {
        this.child = spawn(spec.command, spec.args, {
            stdio: [spec.namedPipe ? 'ignore' : 'pipe', spec.namedPipe ? 'ignore' : 'pipe', 'pipe'],
            env: spec.env ?? process.env,
            windowsHide: true,
        });
        this.child.on('error', (e) => this.markDead(`cannot start ${spec.command}: ${e.message}`));
        this.child.on('exit', (code, signal) => this.markDead(`agent process exited (code=${code} signal=${signal})`));
        this.child.stderr?.on('data', (d: Buffer) => {
            this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000);
        });

        if (spec.namedPipe) {
            this.connected = this.connectNamedPipe(spec.namedPipe, connectTimeoutMs);
        } else {
            this.attach(this.child.stdout!, this.child.stdin!);
            this.connected = Promise.resolve();
        }
        // 呼び出し側が待たなくても、未処理の reject にしない
        this.connected.catch(() => undefined);
    }

    private attach(input: Readable, output: Writable): void {
        this.output = output;
        output.on('error', () => { /* 相手が落ちたとき。exit / close で扱う */ });
        // 大きな応答（readMany）が来るので、行の長さに上限を設けない readline を使う
        readline.createInterface({ input, crlfDelay: Infinity }).on('line', (line) => this.onLine(line));
    }

    private async connectNamedPipe(pipe: string, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let lastError = '';
        while (Date.now() < deadline && this.deadReason === undefined) {
            try {
                const socket = await connectPipe(pipe);
                socket.on('close', () => this.markDead('named pipe closed'));
                this.attach(socket, socket);
                return;
            } catch (e) {
                // QEMU がまだパイプを作っていない（ENOENT）か、別の誰かがつないでいる（EBUSY など）
                lastError = e instanceof Error ? e.message : String(e);
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        const reason = this.deadReason ?? `cannot connect to ${pipe} within ${timeoutMs} ms: ${lastError}`;
        this.markDead(reason);
        this.child.kill();
        throw new AgentUnavailableError(reason);
    }

    get alive(): boolean {
        return this.deadReason === undefined;
    }

    get ready(): AgentReady | undefined {
        return this.readyInfo;
    }

    get lastStderr(): string {
        return this.stderrTail.trim();
    }

    private markDead(reason: string): void {
        if (this.deadReason !== undefined) { return; }
        this.deadReason = this.stderrTail.trim() ? `${reason}: ${this.stderrTail.trim().split('\n').slice(-3).join(' / ')}` : reason;
        const err = new AgentUnavailableError(this.deadReason);
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        for (const w of this.readyWaiters) { w.reject(err); }
        this.readyWaiters = [];
    }

    private onLine(line: string): void {
        const arrivedAt = performance.now();
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return; // ゲストの起動前に QEMU などが出す文字は無視する
        }
        if (msg.event === 'ready') {
            this.readyInfo = msg as AgentReady;
            for (const w of this.readyWaiters) { w.resolve(this.readyInfo); }
            this.readyWaiters = [];
            return;
        }
        const id = typeof msg.id === 'number' ? msg.id : -1;
        const p = this.pending.get(id);
        if (!p) { return; }
        this.pending.delete(id);
        clearTimeout(p.timer);
        requestTimings.set(msg, { sentAt: p.sentAt, arrivedAt });
        p.resolve(msg);
    }

    /** agent の ready を待ち、命令の形の版を確かめる */
    waitReady(timeoutMs: number): Promise<AgentReady> {
        if (this.deadReason !== undefined) { return Promise.reject(new AgentUnavailableError(this.deadReason)); }
        const check = (r: AgentReady) => {
            if (r.protocol !== PROTOCOL_VERSION) {
                throw new AgentUnavailableError(`agent speaks protocol v${r.protocol ?? '?'}, expected v${PROTOCOL_VERSION}`);
            }
            return r;
        };
        if (this.readyInfo) { return Promise.resolve(this.readyInfo).then(check); }
        return new Promise<AgentReady>((resolve, reject) => {
            const timer = setTimeout(() => reject(new AgentUnavailableError(`agent not ready within ${timeoutMs} ms`)), timeoutMs);
            this.readyWaiters.push({
                resolve: (r) => { clearTimeout(timer); resolve(r); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        }).then(check);
    }

    /** 命令を送り、応答をそのまま返す（ok が false でも例外にしない） */
    async request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
        await this.connected;
        if (this.deadReason !== undefined || !this.output) {
            throw new AgentUnavailableError(this.deadReason ?? 'not connected');
        }
        const id = this.nextId++;
        const output = this.output;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AgentUnavailableError(`timeout after ${this.requestTimeoutMs} ms: ${String(body.op)}`));
            }, this.requestTimeoutMs);
            const pending: Pending = { resolve, reject, timer, sentAt: 0 };
            this.pending.set(id, pending);
            output.write(JSON.stringify({ id, ...body }) + '\n');
            pending.sentAt = performance.now();
        });
    }

    /** 命令を送り、ok でなければ AgentError にする */
    async call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const res = await this.request(body);
        if (res.ok !== true) {
            throw new AgentError(String(body.op), String(res.code ?? 'EINTERNAL'), String(res.error ?? 'unknown error'));
        }
        return res;
    }

    /** 電源を切って終わるのを待つ（止まらなければ強制終了） */
    async dispose(timeoutMs = 5_000): Promise<void> {
        if (this.deadReason !== undefined) { return; }
        await this.request({ op: 'poweroff' }).catch(() => undefined);
        await new Promise<void>((resolve) => {
            if (this.child.exitCode !== null || this.child.signalCode !== null) { return resolve(); }
            const t = setTimeout(() => { this.child.kill(); resolve(); }, timeoutMs);
            this.child.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }

    /** すぐに終わらせる（VS Code の終了時など、待てないとき） */
    kill(): void {
        if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill(); }
    }
}
