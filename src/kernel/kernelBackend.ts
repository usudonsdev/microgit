/**
 * カーネルの OverlayFS を使うバックエンド（#14）。
 *
 * - start(): agent を起動し、ready と「本当に mount できるか」（小さな層を 1 枚作って捨てる）を確かめる
 * - recordCommit(): 保存でできた shadow のコミットの層を、agent に作らせておく（次に戻るときに速い）
 * - checkout(): コミットの時点の一覧と中身を agent から受け取り、Boundary Guard を通してワークスペースに反映する
 *
 * ゲストは信用しない（SR-1）。ワークスペースに書くのは必ず boundaryGuard.syncWorkspaceFromGuest（FR-3）。
 * VS Code に依存しない（スクリプトの差分テストからも使うため）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { hostTraitsFor, HostTraits, Rejection, syncWorkspaceFromGuest, WorkspaceHashCache } from '../boundaryGuard';
import { AgentConnection, AgentError, AgentReady, LaunchSpec } from './agentConnection';
import { DEFAULT_FEEDER_OPTIONS, EnsureResult, FeederOptions, LayerFeeder } from './layerFeeder';

type GitTryRunner = (cwd: string, args: string[]) => string | undefined;

export type KernelBackendOptions = {
    bootTimeoutMs: number;
    requestTimeoutMs: number;
    feeder: FeederOptions;
    /** readMany 1 回で頼むパスの数（応答が 32 MiB を超えたら半分に分けて頼み直す） */
    readBatch: number;
    traits: HostTraits;
};

export const DEFAULT_KERNEL_OPTIONS: KernelBackendOptions = {
    bootTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
    feeder: DEFAULT_FEEDER_OPTIONS,
    readBatch: 256,
    traits: hostTraitsFor(process.platform),
};

export type CheckoutResult = {
    written: string[];
    deleted: string[];
    unchanged: number;
    rejected: Rejection[];
    ensure: EnsureResult;
    timings: { ensureMs: number; viewMs: number; syncMs: number; totalMs: number };
};

export class KernelOverlayBackend {
    private readonly feeder: LayerFeeder;
    private readonly startedAt = Date.now();
    private bootMs = 0;
    private lastCheckout: CheckoutResult | undefined;
    private commits = 0;

    private constructor(
        private readonly agent: AgentConnection,
        private readonly tryRunGit: GitTryRunner,
        private readonly options: KernelBackendOptions,
        public readonly kind: string,
    ) {
        this.feeder = new LayerFeeder(agent, tryRunGit, options.feeder);
    }

    /**
     * agent を起動して使えるか確かめる。使えなければ例外（呼び出し側は Node 版にフォールバックする）。
     * 「ready が来た」だけでは足りない。Ubuntu 23.10 以降のように非特権のユーザー名前空間が止められていると、
     * unshare がすぐ失敗してプロセスが終わる。VM でも、OverlayFS の mount に失敗することがありうる。
     * そこで小さな層を 1 枚作って捨てるところまでやる。
     */
    static async start(
        spec: LaunchSpec,
        kind: string,
        tryRunGit: GitTryRunner,
        options: Partial<KernelBackendOptions> = {},
    ): Promise<KernelOverlayBackend> {
        const opts = { ...DEFAULT_KERNEL_OPTIONS, ...options, feeder: { ...DEFAULT_FEEDER_OPTIONS, ...options.feeder } };
        const t0 = Date.now();
        const agent = new AgentConnection(spec, opts.requestTimeoutMs);
        try {
            await agent.waitReady(opts.bootTimeoutMs);
            await agent.call({ op: 'commit', layer: '__microgit_probe__', parent: '', ops: [['write', 'probe.txt', 'ok']] });
            await agent.call({ op: 'reset' });
        } catch (e) {
            agent.kill();
            throw e;
        }
        const backend = new KernelOverlayBackend(agent, tryRunGit, opts, kind);
        backend.bootMs = Date.now() - t0;
        return backend;
    }

    get alive(): boolean {
        return this.agent.alive;
    }

    get info(): AgentReady | undefined {
        return this.agent.ready;
    }

    /** 保存でできたコミットの層を作っておく */
    async recordCommit(shadowRepo: string, hash: string): Promise<EnsureResult> {
        const r = await this.feeder.ensure(shadowRepo, hash);
        this.commits++;
        return r;
    }

    /** agent の層を全部捨てる（テストや、層の置き場所が一杯のとき） */
    async resetLayers(): Promise<void> {
        await this.feeder.reset();
    }

    private async readFiles(layer: string, paths: string[]): Promise<Map<string, Buffer>> {
        const out = new Map<string, Buffer>();
        if (this.agent.spec.maxFrameBytes) {
            const chunkBytes = 24 * 1024;
            for (const file of paths) {
                const chunks: Buffer[] = [];
                let offset = 0;
                while (true) {
                    const res = await this.agent.call({ op: 'readChunk', layer, path: file, offset, limit: chunkBytes });
                    const chunk = Buffer.from(String(res.data ?? ''), 'base64');
                    chunks.push(chunk);
                    offset += chunk.length;
                    if (res.done === true) { break; }
                    if (chunk.length === 0) { throw new Error(`readChunk made no progress for ${file}`); }
                }
                out.set(file, Buffer.concat(chunks));
            }
            return out;
        }
        const readChunk = async (chunk: string[]): Promise<void> => {
            if (!chunk.length) { return; }
            try {
                const res = await this.agent.call({ op: 'readMany', layer, paths: chunk });
                for (const f of (res.files as Array<{ path: string; data: string }> | undefined) ?? []) {
                    out.set(f.path, Buffer.from(f.data, 'base64'));
                }
            } catch (e) {
                if (e instanceof AgentError && e.code === 'TOO_LARGE' && chunk.length > 1) {
                    const half = Math.ceil(chunk.length / 2);
                    await readChunk(chunk.slice(0, half));
                    await readChunk(chunk.slice(half));
                    return;
                }
                throw e;
            }
        };
        for (let i = 0; i < paths.length; i += this.options.readBatch) {
            await readChunk(paths.slice(i, i + this.options.readBatch));
        }
        return out;
    }

    /**
     * target の時点にワークスペースを合わせる。
     * managedFiles は MicroGit が記録したことのあるパス（ここにあって target に無いファイルだけ消す）。
     * cacheFile はワークスペースのファイルの sha256 のキャッシュの置き場所（無ければ作る）。
     */
    async checkout(opts: {
        workspaceRoot: string;
        shadowRepo: string;
        target: string;
        managedFiles: Iterable<string>;
        cacheFile?: string;
    }): Promise<CheckoutResult> {
        const t0 = Date.now();
        const ensure = await this.feeder.ensure(opts.shadowRepo, opts.target);
        const t1 = Date.now();
        const view = await this.agent.call({ op: 'view', layer: opts.target });
        const lines = (view.entries as string[] | undefined) ?? [];
        const t2 = Date.now();

        let cache: WorkspaceHashCache | undefined;
        if (opts.cacheFile) {
            try {
                cache = JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8')) as WorkspaceHashCache;
            } catch { /* 無ければ作る */ }
        }
        const synced = await syncWorkspaceFromGuest({
            workspaceRoot: opts.workspaceRoot,
            viewLines: lines,
            managedFiles: opts.managedFiles,
            fetchFiles: (paths) => this.readFiles(opts.target, paths),
            traits: this.options.traits,
            cache,
        });
        if (opts.cacheFile) {
            fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
            fs.writeFileSync(opts.cacheFile, JSON.stringify(synced.cache), 'utf8');
        }
        const t3 = Date.now();
        const result: CheckoutResult = {
            written: synced.written,
            deleted: synced.deleted,
            unchanged: synced.unchanged,
            rejected: synced.rejected,
            ensure,
            timings: { ensureMs: t1 - t0, viewMs: t2 - t1, syncMs: t3 - t2, totalMs: t3 - t0 },
        };
        this.lastCheckout = result;
        return result;
    }

    /** Overlay Status に出す説明 */
    async describe(): Promise<string> {
        const lines = [
            `backend=kernel (${this.kind})`,
            `agent=${this.info?.agent ?? '?'} protocol=${this.info?.protocol ?? '?'} kernel=${this.info?.kernel ?? '?'}`,
            `mountOptions=${this.info?.mountOptions ?? '?'}`,
            `launch=${this.agent.spec.description}`,
            `boot=${this.bootMs}ms uptime=${Math.round((Date.now() - this.startedAt) / 1000)}s commitsRecorded=${this.commits}`,
            `layers(host view)=${this.feeder.layerCount}`,
        ];
        // QEMU などが stderr に出したこと（WHPX が使えず TCG に切り替わった理由など）を最後の数行だけ見せる
        const stderr = this.agent.lastStderr;
        if (stderr) {
            lines.push(`launcher stderr: ${stderr.split(/\r?\n/).slice(-3).join(' / ')}`);
        }
        if (this.agent.alive) {
            try {
                const st = await this.agent.call({ op: 'stats' });
                lines.push(`layers(agent)=${String(st.layers ?? 0)} used=${String(st.usedBytes ?? 0)}B total=${String(st.totalBytes ?? 0)}B`);
            } catch (e) {
                lines.push(`stats failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        } else {
            lines.push('agent is not running');
        }
        if (this.lastCheckout) {
            const c = this.lastCheckout;
            lines.push(
                `lastCheckout: written=${c.written.length} deleted=${c.deleted.length} unchanged=${c.unchanged} rejected=${c.rejected.length} ` +
                `snapshot=${c.ensure.snapshot} depth=${c.ensure.depth} ensure=${c.timings.ensureMs}ms view=${c.timings.viewMs}ms sync=${c.timings.syncMs}ms`,
            );
        }
        return lines.join('\n');
    }

    async dispose(): Promise<void> {
        await this.agent.dispose();
    }

    kill(): void {
        this.agent.kill();
    }
}
