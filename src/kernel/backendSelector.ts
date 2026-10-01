/**
 * Backend Selector（#14、要件 FR-5・NFR-5）。
 *
 * 設定 microgit.overlayBackend:
 *   auto（既定）: カーネル版を試し、使えなければ Node 版（利用者には知らせない。出力にだけ理由を残す）
 *   kernel      : カーネル版を使う。使えなければ Node 版にするが、理由を利用者に知らせる
 *   nodejs      : Node 版だけ。仮想マシンも agent も起動しない
 *
 * カーネル版は必要になるまで起動しない（最初の保存か、過去に戻る操作のとき）。VS Code を開いただけで
 * 仮想マシンを動かさないため。起動に失敗したら、そのセッションのあいだは Node 版を使う。
 * 動いていた agent が落ちたら、あと MAX_RESTARTS 回まで起動し直す。
 *
 * VS Code に依存しない。ログと利用者への通知は deps で受け取る。
 */
import { AgentUnavailableError } from './agentConnection';
import { KernelBackendOptions, KernelOverlayBackend } from './kernelBackend';
import { LaunchPlan } from './launchers';

export type BackendSetting = 'auto' | 'kernel' | 'nodejs';

export function parseBackendSetting(value: unknown): BackendSetting {
    return value === 'kernel' || value === 'nodejs' ? value : 'auto';
}

export type SelectorDeps = {
    setting: BackendSetting;
    plan: () => LaunchPlan;
    tryRunGit: (cwd: string, args: string[]) => string | undefined;
    log: (message: string, level?: 'INFO' | 'WARN' | 'ERROR') => void;
    /** setting が kernel で、カーネル版が使えなかったときに利用者に知らせる */
    notify?: (message: string) => void;
    kernelOptions?: Partial<KernelBackendOptions>;
};

const MAX_RESTARTS = 2;

export class BackendSelector {
    private kernel: KernelOverlayBackend | undefined;
    private starting: Promise<KernelOverlayBackend | undefined> | undefined;
    private failure: string | undefined;
    private restarts = 0;
    private disposed = false;

    constructor(private readonly deps: SelectorDeps) { }

    get setting(): BackendSetting {
        return this.deps.setting;
    }

    /** カーネル版を使うつもりがあるか（nodejs でなく、まだ諦めていない） */
    get wantsKernel(): boolean {
        return this.deps.setting !== 'nodejs' && this.failure === undefined && !this.disposed;
    }

    /** 今すぐ使えるカーネル版（起動を待たない） */
    readyKernel(): KernelOverlayBackend | undefined {
        return this.kernel?.alive ? this.kernel : undefined;
    }

    /** カーネル版を起動して（起動中ならそれを待って）返す。使えなければ undefined */
    ensureKernel(): Promise<KernelOverlayBackend | undefined> {
        if (!this.wantsKernel) { return Promise.resolve(undefined); }
        if (this.kernel?.alive) { return Promise.resolve(this.kernel); }
        if (this.kernel && !this.kernel.alive) {
            // 動いていた agent が落ちた
            this.kernel = undefined;
            if (this.restarts >= MAX_RESTARTS) {
                this.fail('agent stopped too many times');
                return Promise.resolve(undefined);
            }
            this.restarts++;
            this.deps.log(`[Kernel] agent が止まったので起動し直す（${this.restarts}/${MAX_RESTARTS}）`, 'WARN');
        }
        if (!this.starting) {
            this.starting = this.start().finally(() => { this.starting = undefined; });
        }
        return this.starting;
    }

    private async start(): Promise<KernelOverlayBackend | undefined> {
        const plan = this.deps.plan();
        if (!plan.ok) {
            this.fail(plan.reason);
            return undefined;
        }
        this.deps.log(`[Kernel] 起動: ${plan.spec.description}${plan.notes.length ? `（${plan.notes.join('、')}）` : ''}`);
        try {
            const backend = await KernelOverlayBackend.start(plan.spec, plan.kind, this.deps.tryRunGit, this.deps.kernelOptions);
            if (this.disposed) {
                await backend.dispose();
                return undefined;
            }
            this.kernel = backend;
            this.deps.log(`[Kernel] 使える: agent=${backend.info?.agent} kernel=${backend.info?.kernel} (${plan.kind})`);
            return backend;
        } catch (e) {
            this.fail(e instanceof Error ? e.message : String(e));
            return undefined;
        }
    }

    /** カーネル版を諦めて Node 版にする（このセッションのあいだ） */
    fail(reason: string): void {
        if (this.failure !== undefined) { return; }
        this.failure = reason;
        const kernel = this.kernel;
        this.kernel = undefined;
        kernel?.kill();
        const message = `カーネル版の Overlay を使えないので Node.js 版を使う: ${reason}`;
        this.deps.log(`[Kernel] ${message}`, this.deps.setting === 'kernel' ? 'WARN' : 'INFO');
        if (this.deps.setting === 'kernel') { this.deps.notify?.(message); }
    }

    /** カーネル版の操作が失敗したときに呼ぶ。agent が落ちた・つながらないなら、次の操作で起動し直す */
    reportError(e: unknown): void {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.log(`[Kernel] 操作に失敗（Node.js 版で続ける）: ${message}`, 'WARN');
        if (e instanceof AgentUnavailableError) {
            this.kernel?.kill();
        }
    }

    get failureReason(): string | undefined {
        return this.failure;
    }

    async describe(): Promise<string> {
        const lines = [`overlayBackend=${this.deps.setting}`];
        if (this.deps.setting === 'nodejs') {
            lines.push('kernel backend is disabled by setting');
        } else if (this.failure !== undefined) {
            lines.push(`kernel backend unavailable: ${this.failure}`);
        } else if (this.kernel) {
            lines.push(await this.kernel.describe());
        } else {
            const plan = this.deps.plan();
            lines.push(plan.ok ? `kernel backend not started yet (would use ${plan.spec.description})` : `kernel backend unavailable: ${plan.reason}`);
        }
        return lines.join('\n');
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const kernel = this.kernel;
        this.kernel = undefined;
        await kernel?.dispose();
    }

    /** VS Code の終了時など、待てないとき */
    kill(): void {
        this.disposed = true;
        this.kernel?.kill();
        this.kernel = undefined;
    }
}
