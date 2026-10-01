/**
 * shadow の Git のコミットから、agent に OverlayFS の層を作らせる（#14、ADR-0001・ADR-0003）。
 *
 * 層は Git から作り直せるキャッシュ（ADR-0001）。層の名前は Git のコミットのハッシュ。
 *
 * ensure(C) の決め方（ADR-0003）:
 *   - C の層がもう agent にあれば何もしない
 *   - C の親 P の層があり、P の深さが maxDepth 未満なら、P との差分だけの層を P の上に作る
 *   - それ以外（キャッシュが空、親の層が無い、深すぎる）は、C の完全なツリーの「写しの層」を親なしで作る。
 *     祖先を順に積み直すことはしない（履歴が長くても 1 枚で済む）
 *   - agent の層の数が maxLayers に達したら、agent の層を全部捨ててから作る
 *
 * 差分の op:
 *   - 消えたパス（D）は ["rmdir", path]。agent の rmdir は無いパスでも失敗しない（RemoveAll）ので、
 *     層の見え方と Git のツリーが何かの理由でずれていても止まらない
 *   - 追加・変更・種類の変化（A/M/T）は ["writeb64", path, base64, mode]。100755 は "755"、
 *     シンボリックリンク（120000）はリンク先の文字列を中身とするファイル（Node 版と同じ。#10 §6）
 *   - 消す op を先に並べる（ファイル p → ディレクトリ p/ で、古い p を消してから p/q を置くため）
 *   - サブモジュール（160000）は無視する
 */
import { spawnSync } from 'child_process';
import { listCommitChanges, TreeChange } from '../overlay';
import { MicroCommitDelta } from '../microCommit';
import { AgentConnection, AgentError } from './agentConnection';

type GitTryRunner = (cwd: string, args: string[]) => string | undefined;

export type FeederOptions = {
    maxDepth: number;
    maxLayers: number;
    /** 1 回の commit で送る中身（base64 にする前）の上限。agent の 1 行の上限（128 MiB）に収める */
    maxCommitBytes: number;
};

export const DEFAULT_FEEDER_OPTIONS: FeederOptions = {
    maxDepth: 32,
    maxLayers: 256,
    maxCommitBytes: 90 * 1024 * 1024,
};

export type EnsureResult = {
    layer: string;
    /** 新しく作ったか（もうあったら false） */
    created: boolean;
    /** 写しの層として作ったか */
    snapshot: boolean;
    depth: number;
    /** 送った中身の大きさ（base64 にする前） */
    bytes: number;
    elapsedMs: number;
};

type Upload = { id: string; data: Buffer };
type BuiltOps = { ops: string[][]; uploads: Upload[]; bytes: number };

/** `git cat-file --batch` を 1 回起動して、複数のオブジェクトの中身を読む */
export function catFileBatch(repo: string, shas: string[]): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const unique = Array.from(new Set(shas));
    if (!unique.length) { return out; }
    const r = spawnSync('git', ['cat-file', '--batch'], {
        cwd: repo,
        input: unique.join('\n') + '\n',
        maxBuffer: 2 * 1024 * 1024 * 1024,
        windowsHide: true,
    });
    if (r.error) { throw r.error; }
    if (r.status !== 0) { throw new Error(`git cat-file --batch failed: ${r.stderr?.toString() ?? ''}`); }
    const buf = r.stdout as Buffer;
    let pos = 0;
    // 1 件 = "<sha> <type> <size>\n<中身>\n"（見つからなければ "<name> missing\n"）
    while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) { break; }
        const header = buf.subarray(pos, nl).toString('utf8');
        pos = nl + 1;
        const parts = header.split(' ');
        if (parts[1] === 'missing' || parts.length < 3) {
            throw new Error(`git object missing: ${parts[0]}`);
        }
        const size = Number(parts[2]);
        out.set(parts[0], buf.subarray(pos, pos + size));
        pos += size + 1;
    }
    return out;
}

function modeOf(change: TreeChange): '644' | '755' {
    return change.mode === '100755' ? '755' : '644';
}

function isSafeGitPath(rel: string): boolean {
    if (!rel || rel.startsWith('/') || rel.includes('\\')) { return false; }
    return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export class LayerFeeder {
    /** agent にある層（ハッシュ → 深さ）。agent の reset や再起動でずれたら clear する */
    private readonly known = new Map<string, number>();

    constructor(
        private readonly agent: AgentConnection,
        private readonly tryRunGit: GitTryRunner,
        private readonly options: FeederOptions = DEFAULT_FEEDER_OPTIONS,
    ) { }

    get layerCount(): number {
        return this.known.size;
    }

    has(hash: string): boolean {
        return this.known.has(hash);
    }

    /** agent の層を全部捨てる */
    async reset(): Promise<void> {
        this.known.clear();
        await this.agent.call({ op: 'reset' });
    }

    private firstParent(shadowRepo: string, hash: string): string | undefined {
        const line = this.tryRunGit(shadowRepo, ['rev-list', '--parents', '-n', '1', hash])?.trim();
        const parts = line ? line.split(/\s+/).filter(Boolean) : [];
        return parts.length > 1 ? parts[1] : undefined;
    }

    private buildOps(shadowRepo: string, changes: TreeChange[]): BuiltOps {
        const usable = changes.filter((c) => c.mode !== '160000' && isSafeGitPath(c.path));
        const removals = usable.filter((c) => c.status === 'D').map((c) => ['rmdir', c.path]);
        const writes = usable.filter((c) => c.status !== 'D');
        const contents = catFileBatch(shadowRepo, writes.map((c) => c.sha));
        let bytes = 0;
        const uploads: Upload[] = [];
        const writeOps = writes.map((c, index) => {
            const data = contents.get(c.sha)!;
            bytes += data.length;
            if (this.agent.spec.maxFrameBytes) {
                const id = `u-${index}-${c.sha}`;
                uploads.push({ id, data });
                return ['writeupload', c.path, id, modeOf(c)];
            }
            return ['writeb64', c.path, data.toString('base64'), modeOf(c)];
        });
        if (bytes > this.options.maxCommitBytes) {
            throw new Error(`layer content is ${bytes} bytes (limit ${this.options.maxCommitBytes}); falling back`);
        }
        return { ops: [...removals, ...writeOps], uploads, bytes };
    }

    private async stageUploads(uploads: Upload[]): Promise<void> {
        if (!uploads.length) { return; }
        // base64 と JSON の分を含めても planMac の 48 KiB に十分収まる。
        const chunkBytes = 24 * 1024;
        for (const upload of uploads) {
            if (upload.data.length === 0) {
                await this.agent.call({ op: 'stage', upload: upload.id, data: '', append: false });
                continue;
            }
            for (let offset = 0; offset < upload.data.length; offset += chunkBytes) {
                await this.agent.call({
                    op: 'stage',
                    upload: upload.id,
                    data: upload.data.subarray(offset, offset + chunkBytes).toString('base64'),
                    append: offset !== 0,
                });
            }
        }
    }

    private async commitRequest(layer: string, parent: string, ops: string[][]): Promise<Record<string, unknown>> {
        const direct = { op: 'commit', layer, parent, ops };
        const maxFrame = this.agent.spec.maxFrameBytes;
        if (!maxFrame || JSON.stringify(direct).length < maxFrame) { return direct; }

        const upload = `ops-${layer}`;
        for (let i = 0; i < ops.length; i++) {
            const request = { op: 'stageOp', upload, stagedOp: ops[i], append: i !== 0 };
            if (JSON.stringify(request).length >= maxFrame) {
                throw new Error(`staged operation is too large for a ${maxFrame}-byte frame`);
            }
            await this.agent.call(request);
        }
        return { op: 'commit', layer, parent, opsUpload: upload };
    }

    /**
     * 速い記録が知っている「親からの変化」（変わったファイルと中身）で、差分の層を作る。Git を起動しない（#37）。
     * 親の層が agent にあり、深さが上限未満で、層の数が上限未満のときだけ使える。使えなければ undefined を返す
     * （呼ぶ側は ensure に任せる。ensure は Git から作り、必要なら写しの層や作り直しもする）
     */
    async ensureFromDelta(hash: string, delta: MicroCommitDelta): Promise<EnsureResult | undefined> {
        const started = Date.now();
        const existing = this.known.get(hash);
        if (existing !== undefined) {
            return { layer: hash, created: false, snapshot: false, depth: existing, bytes: 0, elapsedMs: 0 };
        }
        const parentDepth = this.known.get(delta.parent);
        if (parentDepth === undefined || parentDepth >= this.options.maxDepth) { return undefined; }
        if (this.known.size >= this.options.maxLayers) { return undefined; }
        if (!delta.files.every((f) => isSafeGitPath(f.path))) { return undefined; }

        let bytes = 0;
        const uploads: Upload[] = [];
        const ops = delta.files.map((f, index) => {
            bytes += f.content.length;
            const mode = f.mode === '100755' ? '755' : '644';
            if (this.agent.spec.maxFrameBytes) {
                const id = `d-${index}-${hash}`;
                uploads.push({ id, data: f.content });
                return ['writeupload', f.path, id, mode];
            }
            return ['writeb64', f.path, f.content.toString('base64'), mode];
        });
        if (bytes > this.options.maxCommitBytes) { return undefined; }

        let res: Record<string, unknown>;
        try {
            await this.stageUploads(uploads);
            res = await this.agent.call(await this.commitRequest(hash, delta.parent, ops));
        } catch (e) {
            // 親の層が消えていた・同じ名前の層があった・置き場所が一杯：ensure に任せる（作り直しまでする）
            if (e instanceof AgentError && ['EEXIST', 'UNKNOWN_LAYER', 'ENOSPC'].includes(e.code)) { return undefined; }
            throw e;
        }
        const depth = Number(res.depth ?? parentDepth + 1);
        this.known.set(hash, depth);
        return { layer: hash, created: res.existed !== true, snapshot: false, depth, bytes, elapsedMs: Date.now() - started };
    }

    /** コミット hash の層が agent にあるようにする */
    async ensure(shadowRepo: string, hash: string): Promise<EnsureResult> {
        const started = Date.now();
        const existing = this.known.get(hash);
        if (existing !== undefined) {
            return { layer: hash, created: false, snapshot: false, depth: existing, bytes: 0, elapsedMs: 0 };
        }
        if (this.known.size >= this.options.maxLayers) {
            await this.reset();
        }

        const parent = this.firstParent(shadowRepo, hash);
        const parentDepth = parent ? this.known.get(parent) : undefined;
        const asDiff = parent !== undefined && parentDepth !== undefined && parentDepth < this.options.maxDepth;
        const changes = asDiff
            ? listCommitChanges(shadowRepo, hash, parent, this.tryRunGit)
            : listCommitChanges(shadowRepo, hash, undefined, this.tryRunGit);
        const { ops, uploads, bytes } = this.buildOps(shadowRepo, changes);

        let res: Record<string, unknown>;
        try {
            await this.stageUploads(uploads);
            res = await this.agent.call(await this.commitRequest(hash, asDiff ? parent : '', ops));
        } catch (e) {
            // EEXIST: 同じハッシュの層が違う親で既にある（ホストの記録と agent がずれた）。
            // UNKNOWN_LAYER: 親の層が agent に無い（agent が再起動した）。ENOSPC: 層の置き場所が一杯。
            // どれも agent の層を捨てて、写しの層として作り直す
            if (e instanceof AgentError && ['EEXIST', 'UNKNOWN_LAYER', 'ENOSPC'].includes(e.code)) {
                await this.reset();
                const snap = this.buildOps(shadowRepo, listCommitChanges(shadowRepo, hash, undefined, this.tryRunGit));
                await this.stageUploads(snap.uploads);
                res = await this.agent.call(await this.commitRequest(hash, '', snap.ops));
                const depth = Number(res.depth ?? 1);
                this.known.set(hash, depth);
                return { layer: hash, created: true, snapshot: true, depth, bytes: snap.bytes, elapsedMs: Date.now() - started };
            }
            throw e;
        }
        const depth = Number(res.depth ?? 1);
        this.known.set(hash, depth);
        return { layer: hash, created: res.existed !== true, snapshot: !asDiff, depth, bytes, elapsedMs: Date.now() - started };
    }
}
