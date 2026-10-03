/**
 * マイクロコミットの速い実装（#32）。Git のプロセスを起動せず、Git の保存形式（オブジェクト・index・ref）を直接書く。
 *
 * 振る舞いは recordMicroCommitViaGitCli（microCommit.ts）と同じにする：
 *   - index に保存したファイルを足し、tree を作る
 *   - HEAD と同じ tree なら何もしない（unchanged）
 *   - 過去に同じ tree、または同じパスに同じ中身があったコミットがあれば、新しいコミットを作らず HEAD をそこへ戻す（rewound）
 *   - それ以外は commit を作り、micro-history を進め、先端のタグ mb-N を動かす（先端以外からなら mb-(最大+1) を足す）
 * 違うのは速さだけ。同じ保存の列を両方に流して、できたコミット・tree・ref・index が同じになることを
 * 差分テスト（scripts/test/micro-commit-diff.mjs）で確かめる。
 *
 * 「過去の同じ変更」の探索は、最初に 1 回だけ git log で索引を作り、以後は記録のたびに索引を足す。
 * Git の設定などがこの実装の前提から外れる（autocrlf、属性ファイル、sha256、reftable、index の版 4 など）ときは
 * FastPathUnsupported を投げる。呼ぶ側は Git の CLI の実装に任せる。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitIndex, IndexEntry, compareIndexEntries, entryFromStat, indexPath, readIndex, writeIndex } from './fastGit/gitIndex';
import { Ident, hashObject, looseObjectPath, ObjectType, ObjectWriteCache, parseGitDate, serializeCommit, serializeTree, TreeEntry, writeLooseObject } from './fastGit/objects';
import { Journal, RecoveryReport, recoverJournals } from './fastGit/journal';
import { listTags, logRefUpdate, readRef, readSymbolicHead, resolveGitDir, writeRef, writeSymbolicRef } from './fastGit/refs';
import { isSafeGitRef, MicroCommitDelta, MicroCommitInput, MicroCommitOutcome } from './microCommit';
import { SHADOW_ATTRIBUTES } from './shadowStore';
import { fsyncStats } from './fastGit/fsyncStats';

export class FastPathUnsupported extends Error { }

const BRANCH = 'refs/heads/micro-history';
const ZERO = '0'.repeat(40);

type Dir = { files: Map<string, { mode: string; hash: string }>; dirs: Map<string, Dir>; hash?: string };

/**
 * 1 回の記録で書くもの（ADR-0014）。計算のあいだはメモリに集め、最後に applyTxn でまとめて書く。
 * ジャーナルを使うときは、先にジャーナルに追記して確定させ（fsync 1 回）、そのあとで Git のファイルを確定させずに書く
 */
type Txn = {
    objects: Map<string, { type: ObjectType; body: Buffer }>;
    refs: Array<{ name: string; old: string | null; new: string; reflogIdent?: string; headPointsHere: boolean }>;
    head?: string;
    index: boolean;
};

/**
 * まだ書き出していない Git のファイル（ADR-0015）。ジャーナルには確定済み。保存が落ち着いたとき・ジャーナルが
 * たまったとき・隠しリポジトリを読む処理の前に materialize で書き出す。
 * refs の base は、最初の更新の前の値（書き出すときに、ほかの処理が書き換えていないかを確かめるため）
 */
type Pending = {
    objects: Map<string, { type: ObjectType; body: Buffer }>;
    refs: Map<string, { base: string | null; updates: Array<{ old: string | null; new: string; reflogIdent?: string; headPointsHere: boolean }> }>;
    head?: string;
    index: boolean;
    saves: number;
};

function newDir(): Dir { return { files: new Map(), dirs: new Map() }; }

type FileStamp = { mtimeMs: number; size: number; ino: number } | undefined;

/** ref の状態。HEAD・micro-history・タグのファイルとフォルダ・packed-refs の stat が変わっていなければ、読み直さない */
type RefState = { key: string; symbolic?: string; head?: string; branch?: string; tags: Map<string, string> };

function stamp(file: string): FileStamp {
    try {
        const st = fs.statSync(file);
        return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
    } catch {
        return undefined;
    }
}

const sameStamp = (a: FileStamp, b: FileStamp) =>
    a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino);

export type FastCommitStats = {
    reloads: number;
    indexReloads: number;
    gitSpawns: number;
    /** 書き出しを遅らせた分を書き出した回数と、書き出した保存の数（ADR-0015） */
    materializations: number;
    materializedSaves: number;
    /** 書き出すまでの間に、ほかの処理が ref や index を書き換えていたので、そちらを残した回数 */
    externalWins: number;
    /** 直近の record の段階ごとの時間（ms）。遅い段階を切り分けるため（#37） */
    lastPhases: Record<string, number>;
};

export class FastMicroCommitter {
    readonly gitDir: string;
    private config = new Map<string, string>();
    private index: GitIndex = { version: 2, entries: [] };
    private indexStamp: FileStamp;
    private root: Dir = newDir();
    /** 履歴の索引（最初に git log で作り、記録のたびに足す） */
    private commitTree = new Map<string, string>();
    private treeToCommit = new Map<string, string>();
    private fileIndex = new Map<string, Map<string, string>>();
    private loaded = false;
    /** info/attributes が変換を止めている（ADR-0012）。止めていれば .gitattributes があっても中身は変わらない */
    private attributesNeutral = false;
    /** HEAD のコミットの中身（パス → モードと blob）。新しいコミットが親から何を変えたかを出すのに使う */
    private headFlat: { commit: string; files: Map<string, string> } | undefined;
    /**
     * 最近作ったコミットの中身（パス → モードと blob）。同じ中身に戻した（rewound）あとの記録で、戻った先のコミットの
     * 中身を Git に読ませずに済ませる（Git を起動すると、その前に貯めている分の書き出しも要る。ADR-0015）。新しい順に最大 128 個
     */
    private recentFlats = new Map<string, Map<string, string>>();
    readonly stats: FastCommitStats = { reloads: 0, indexReloads: 0, gitSpawns: 0, materializations: 0, materializedSaves: 0, externalWins: 0, lastPhases: {} };
    private phaseAt = 0;
    /** 直前の印からここまでを、その段階の時間として記録する */
    private phase(name: string): void {
        const t = performance.now();
        this.stats.lastPhases[name] = (this.stats.lastPhases[name] ?? 0) + (t - this.phaseAt);
        this.phaseAt = t;
    }
    private objCache: ObjectWriteCache = { present: new Set(), dirs: new Set() };
    /** この記録で書くもの（record の中だけ） */
    private txn: Txn | undefined;
    /** このプロセスのジャーナル（最初の確定させる記録のときに開く） */
    private journal: Journal | undefined;
    private readonly useJournal: boolean;
    /** 最後の起動時の作り直しの結果（ADR-0014） */
    lastRecovery: RecoveryReport | undefined;
    private refState: RefState | undefined;
    /** あると分かった reflog のファイル */
    private reflogs = new Set<string>();
    /** まだ書き出していない Git のファイル（ADR-0015） */
    private pending: Pending | undefined;
    private readonly deferWrites: boolean;

    constructor(readonly workTree: string, private readonly fsync: () => boolean, options?: { journal?: boolean; deferWrites?: boolean }) {
        this.useJournal = options?.journal !== false;
        this.deferWrites = options?.deferWrites !== false;
        this.gitDir = resolveGitDir(workTree);
    }

    /** まだ書き出していない Git のファイルがあるか */
    get hasPending(): boolean { return this.pending !== undefined; }

    private git(args: string[]): string {
        // Git に履歴を読ませる前に、貯めている分を書き出す（まだ書いていないコミットを Git は知らない）
        this.materialize();
        this.stats.gitSpawns++;
        return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
            cwd: this.workTree, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 1 << 30,
        }).toString();
    }

    /** 設定を読み、この実装の前提を満たすかを確かめる（最初の 1 回と、履歴を読み直すとき） */
    private loadConfig(): void {
        this.config.clear();
        const out = this.git(['config', '--list', '-z']);
        for (const item of out.split('\0').filter(Boolean)) {
            const i = item.indexOf('\n');
            const key = (i < 0 ? item : item.slice(0, i)).toLowerCase();
            this.config.set(key, i < 0 ? 'true' : item.slice(i + 1));
        }
        const c = (k: string) => this.config.get(k);
        const falsy = (v: string | undefined) => v === undefined || /^(false|no|off|0)$/i.test(v);
        if ((c('extensions.objectformat') ?? 'sha1') !== 'sha1') { throw new FastPathUnsupported('objectFormat が sha1 でない'); }
        if (c('extensions.refstorage') === 'reftable') { throw new FastPathUnsupported('reftable'); }
        if (!falsy(c('core.sparsecheckout'))) { throw new FastPathUnsupported('sparse checkout'); }
        if (!falsy(c('core.splitindex'))) { throw new FastPathUnsupported('split index'); }
        // commit-tree は commit.gpgSign が有効なら署名する。署名は扱わない
        if (!falsy(c('commit.gpgsign'))) { throw new FastPathUnsupported('commit.gpgSign'); }
        const enc = c('i18n.commitencoding');
        if (enc !== undefined && !/^utf-?8$/i.test(enc)) { throw new FastPathUnsupported('i18n.commitEncoding'); }
        const infoAttributes = path.join(this.gitDir, 'info', 'attributes');
        this.attributesNeutral = false;
        if (fs.existsSync(infoAttributes)) {
            if (fs.readFileSync(infoAttributes, 'utf8') !== SHADOW_ATTRIBUTES) { throw new FastPathUnsupported('info/attributes'); }
            this.attributesNeutral = true;
        }
        // info/attributes で変換を止めていなければ、改行の変換や属性ファイルの設定がある環境は扱わない
        if (!this.attributesNeutral) {
            if (!falsy(c('core.autocrlf'))) { throw new FastPathUnsupported('core.autocrlf が有効（改行の変換が要る）'); }
            if (c('core.eol') !== undefined) { throw new FastPathUnsupported('core.eol'); }
            if (c('core.attributesfile') !== undefined) { throw new FastPathUnsupported('core.attributesFile'); }
        }
        if (fs.existsSync(path.join(this.gitDir, 'commondir'))) { throw new FastPathUnsupported('linked worktree'); }
    }

    /** 履歴の索引を git log 1 回で作る */
    private loadHistory(): void {
        this.stats.reloads++;
        this.commitTree.clear();
        this.treeToCommit.clear();
        this.fileIndex.clear();
        let out = '';
        try {
            out = this.git(['log', '--all', '--format=%H %T', '--raw', '--no-abbrev', '--no-renames', '-z']);
        } catch {
            out = ''; // まだコミットが無い
        }
        let commit = '';
        const tokens = out.split('\0');
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i].replace(/^\n/, '');
            const head = /^([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(t);
            if (head) {
                commit = head[1];
                this.commitTree.set(commit, head[2]);
                // git log は新しい順。最初に見たもの（いちばん新しい）を残す
                if (!this.treeToCommit.has(head[2])) { this.treeToCommit.set(head[2], commit); }
                continue;
            }
            if (t.startsWith(':')) {
                const fields = t.split(' ');
                const dst = fields[3];
                const p = tokens[++i];
                if (!commit || !dst || dst === ZERO) { continue; }
                let m = this.fileIndex.get(p);
                if (!m) { m = new Map(); this.fileIndex.set(p, m); }
                if (!m.has(dst)) { m.set(dst, commit); }
            }
        }
    }

    private buildTreeFromIndex(): void {
        this.root = newDir();
        for (const e of this.index.entries) {
            if (((e.flags >> 12) & 3) !== 0) { throw new FastPathUnsupported('index に競合（stage）がある'); }
            if (e.extendedFlags !== 0) { throw new FastPathUnsupported('index に skip-worktree などがある'); }
            const parts = e.path.split('/');
            let d = this.root;
            for (const name of parts.slice(0, -1)) {
                let sub = d.dirs.get(name);
                if (!sub) { sub = newDir(); d.dirs.set(name, sub); }
                d = sub;
            }
            d.files.set(parts[parts.length - 1], { mode: (e.mode & 0o170000) === 0o120000 ? '120000' : (e.mode & 0o111) ? '100755' : (e.mode & 0o170000) === 0o160000 ? '160000' : '100644', hash: e.hash });
        }
    }

    private reloadIndexIfChanged(): void {
        const now = stamp(indexPath(this.gitDir));
        if (this.loaded && sameStamp(now, this.indexStamp)) { return; }
        this.stats.indexReloads++;
        try {
            this.index = readIndex(indexPath(this.gitDir));
        } catch (e) {
            throw new FastPathUnsupported(e instanceof Error ? e.message : String(e));
        }
        this.indexStamp = now;
        this.buildTreeFromIndex();
        if (!this.attributesNeutral && this.index.entries.some((e) => path.posix.basename(e.path) === '.gitattributes')) {
            throw new FastPathUnsupported('.gitattributes が記録されている');
        }
    }

    private ensureLoaded(): void {
        if (this.loaded) { return; }
        // 停電などのあとなら、ジャーナルから Git のファイルを作り直す（ADR-0014。遅くてよい）
        if (this.useJournal) { this.lastRecovery = recoverJournals(this.gitDir); }
        this.loadConfig();
        this.reloadIndexIfChanged();
        this.loadHistory();
        this.loaded = true;
    }

    /** 状態を捨てる（CLI の実装で記録したあとなど） */
    invalidate(): void {
        // 状態を捨てる前に、貯めている分を書き出す（ジャーナルにはあるので、失敗しても次の起動で作り直せる）
        try { this.materialize(); } catch { /* 次の起動で作り直す */ }
        this.loaded = false;
        this.indexStamp = undefined;
        this.headFlat = undefined;
        this.refState = undefined;
        this.reflogs.clear();
    }

    private refKey(tags?: Iterable<string>): string {
        const f = (file: string) => {
            try {
                const st = fs.statSync(file);
                return `${st.mtimeMs}:${st.size}:${st.ino}`;
            } catch {
                return '-';
            }
        };
        const g = this.gitDir;
        const parts = [
            f(path.join(g, 'HEAD')),
            f(path.join(g, 'refs', 'heads', 'micro-history')),
            f(path.join(g, 'refs', 'tags')),
            f(path.join(g, 'packed-refs')),
        ];
        for (const t of tags ?? []) { parts.push(f(path.join(g, 'refs', 'tags', t))); }
        return parts.join('|');
    }

    /** ref の状態（変わっていなければメモリのもの） */
    private refs(): RefState {
        if (this.refState && this.refState.key === this.refKey(this.refState.tags.keys())) { return this.refState; }
        // ほかの処理が ref を書き換えた。貯めている分を書き出してから（書き換えられた ref は、そちらを残す）読み直す
        if (this.pending) { this.materialize(); }
        const tags = listTags(this.gitDir);
        this.refState = {
            key: this.refKey(tags.keys()),
            symbolic: readSymbolicHead(this.gitDir),
            head: readRef(this.gitDir, 'HEAD'),
            branch: readRef(this.gitDir, BRANCH),
            tags,
        };
        return this.refState;
    }

    /** 自分で ref を書いたあと、stat を取り直す */
    private restampRefs(): void {
        if (this.refState) { this.refState.key = this.refKey(this.refState.tags.keys()); }
    }

    /** index の中身を「パス → モード blob」にする */
    private flatIndex(): Map<string, string> {
        const m = new Map<string, string>();
        const walk = (d: Dir, prefix: string) => {
            for (const [name, f] of d.files) { m.set(prefix + name, `${f.mode} ${f.hash}`); }
            for (const [name, sub] of d.dirs) { walk(sub, `${prefix}${name}/`); }
        };
        walk(this.root, '');
        return m;
    }

    /** あるコミットの中身。覚えていなければ git ls-tree を 1 回（同じ中身に戻したあとの最初の記録だけ） */
    private flatOfCommit(commit: string): Map<string, string> {
        if (this.headFlat?.commit === commit) { return this.headFlat.files; }
        const remembered = this.recentFlats.get(commit);
        if (remembered) { return remembered; }
        const m = new Map<string, string>();
        const out = this.git(['ls-tree', '-r', '-z', '--full-tree', commit]);
        for (const rec of out.split('\0').filter(Boolean)) {
            const tab = rec.indexOf('\t');
            const [mode, , hash] = rec.slice(0, tab).split(' ');
            m.set(rec.slice(tab + 1), `${mode} ${hash}`);
        }
        return m;
    }

    /** ref が知らないコミットを指していたら（ほかの処理が記録した）、履歴を読み直す */
    private ensureKnown(hashes: Iterable<string | undefined>): void {
        for (const h of hashes) {
            if (h && !this.commitTree.has(h)) {
                this.loadHistory();
                return;
            }
        }
    }

    private treeHash(d: Dir, write: boolean): string {
        if (d.hash) { return d.hash; }
        const entries: TreeEntry[] = [];
        for (const [name, f] of d.files) { entries.push({ mode: f.mode, name, hash: f.hash }); }
        for (const [name, sub] of d.dirs) {
            if (sub.files.size === 0 && sub.dirs.size === 0) { continue; }
            entries.push({ mode: '40000', name, hash: this.treeHash(sub, write) });
        }
        const body = serializeTree(entries);
        d.hash = write ? this.stageObject('tree', body) : hashObject('tree', body);
        return d.hash;
    }

    private ident(env: NodeJS.ProcessEnv, who: 'AUTHOR' | 'COMMITTER', now: Date): Ident {
        const name = env[`GIT_${who}_NAME`];
        const email = env[`GIT_${who}_EMAIL`];
        if (!name || !email || /[<>\n]/.test(name + email) || name.trim() !== name || email.trim() !== email) {
            throw new FastPathUnsupported('作者・記録者の名前とメールは環境変数で、そのまま使える形で渡す');
        }
        const date = parseGitDate(env[`GIT_${who}_DATE`], now);
        if (date === 'unsupported' || date === undefined) { throw new FastPathUnsupported(`GIT_${who}_DATE の形`); }
        return { name, email, ...date };
    }

    private reflogIdent(now: Date): string | undefined {
        const all = this.config.get('core.logallrefupdates');
        const bare = /^(true|yes|on|1)$/i.test(this.config.get('core.bare') ?? 'false');
        const on = all === undefined ? !bare : /^(true|yes|on|1|always)$/i.test(all);
        if (!on) { return undefined; }
        const name = this.config.get('user.name') ?? 'MicroGit';
        const email = this.config.get('user.email') ?? 'microgit@local';
        const d = parseGitDate(undefined, now) as { seconds: number; tz: string };
        return `${name} <${email}> ${d.seconds} ${d.tz}`;
    }

    /** オブジェクトをこの記録に集める（もうあれば何もしない） */
    private stageObject(type: ObjectType, body: Buffer): string {
        const hash = hashObject(type, body);
        if (this.objCache.present.has(hash) || this.txn!.objects.has(hash) || this.pending?.objects.has(hash)) { return hash; }
        if (fs.existsSync(looseObjectPath(this.gitDir, hash))) {
            this.objCache.present.add(hash);
            return hash;
        }
        this.txn!.objects.set(hash, { type, body });
        return hash;
    }

    /** ref の変更をこの記録に集める */
    private setRef(name: string, hash: string, now: Date, old: string | undefined): void {
        this.txn!.refs.push({ name, old: old ?? null, new: hash, reflogIdent: this.reflogIdent(now), headPointsHere: this.refState?.symbolic === name });
    }

    /**
     * 集めたものを書く（ADR-0014）。ジャーナルを使うときは、先にジャーナルに追記して確定させ（fsync 1 回）、
     * そのあとでオブジェクト → index → HEAD → ref の順に、確定させずに書く（書いたファイルはチェックポイントで確定させる）。
     * ジャーナルを使わないとき（durability=process、またはジャーナルを止めたとき）は、今までどおり
     */
    private applyTxn(): void {
        const t = this.txn;
        this.txn = undefined;
        if (!t) { return; }
        const journalMode = this.fsync() && this.useJournal;
        if (journalMode && (t.objects.size > 0 || t.refs.length > 0 || t.head)) {
            if (!this.journal) { this.journal = new Journal(this.gitDir); }
            this.journal.append({
                objects: [...t.objects].map(([hash, o]) => ({ type: o.type, hash, body: o.body })),
                refs: t.refs.map((r) => ({ name: r.name, old: r.old, new: r.new })),
                head: t.head,
            });
            this.phase('journal');
            if (this.deferWrites) {
                this.stash(t);
                if (this.journal.shouldCheckpoint() && !this.journal.checkpointInProgress) {
                    // ジャーナルがたまった：書き出して、裏で確定させる（64 回に 1 回、この保存が書き出しの分だけ長くなる）
                    this.materialize();
                    this.phase('materialize');
                    this.journal.checkpoint().catch(() => undefined);
                }
                return;
            }
        }
        const fsyncEach = this.fsync() && !journalMode;
        for (const [hash, o] of t.objects) {
            writeLooseObject(this.gitDir, o.type, o.body, { fsync: fsyncEach, cache: this.objCache, mode: journalMode ? 0o644 : undefined });
            if (journalMode) { this.journal!.noteWritten(looseObjectPath(this.gitDir, hash)); }
        }
        this.phase('writeObjects');
        if (t.index) {
            try {
                writeIndex(indexPath(this.gitDir), this.index, { fsync: false });
            } catch (e) {
                this.invalidate();
                throw new FastPathUnsupported(`index を書けない: ${e instanceof Error ? e.message : String(e)}`);
            }
            this.indexStamp = stamp(indexPath(this.gitDir));
            this.phase('writeIndex');
        }
        if (t.head) {
            writeSymbolicRef(this.gitDir, 'HEAD', t.head, { fsync: fsyncEach });
            if (journalMode) { this.journal!.noteWritten(path.join(this.gitDir, 'HEAD')); }
        }
        for (const r of t.refs) {
            const log = path.join(this.gitDir, 'logs', ...r.name.split('/'));
            if (r.reflogIdent && !this.reflogs.has(log)) {
                if (!fs.existsSync(log) && r.name.startsWith('refs/heads/')) {
                    // git update-ref は、core.logAllRefUpdates が有効ならブランチの reflog を作る
                    fs.mkdirSync(path.dirname(log), { recursive: true });
                    fs.writeFileSync(log, '');
                }
                if (fs.existsSync(log)) { this.reflogs.add(log); }
            }
            const file = path.join(this.gitDir, ...r.name.split('/'));
            const dir = path.dirname(file);
            writeRef(this.gitDir, r.name, r.new, {
                fsync: fsyncEach,
                reflogIdent: r.reflogIdent,
                old: r.old,
                headPointsHere: r.headPointsHere,
                dirExists: this.objCache.dirs.has(dir),
            });
            this.objCache.dirs.add(dir);
            if (journalMode) { this.journal!.noteWritten(file); }
        }
        this.phase('writeRefs');
        if (t.refs.length > 0 || t.head) { this.restampRefs(); }
        this.phase('restamp');
        if (this.journal?.shouldCheckpoint()) {
            // 失敗しても記録は失われない（ジャーナルは消さずに残り、次の起動で作り直す）。待たないので、ここで受け止める
            this.journal.checkpoint().catch(() => undefined);
        }
    }

    /** 1 回の記録の分を、書き出し待ちに足す（ADR-0015） */
    private stash(t: Txn): void {
        const p: Pending = this.pending ??= { objects: new Map(), refs: new Map(), index: false, saves: 0 };
        for (const [hash, o] of t.objects) { p.objects.set(hash, o); }
        for (const r of t.refs) {
            let e = p.refs.get(r.name);
            if (!e) { e = { base: r.old, updates: [] }; p.refs.set(r.name, e); }
            e.updates.push({ old: r.old, new: r.new, reflogIdent: r.reflogIdent, headPointsHere: r.headPointsHere });
        }
        if (t.head) { p.head = t.head; }
        if (t.index) { p.index = true; }
        p.saves++;
    }

    /**
     * 貯めている Git のファイルを書き出す（ADR-0015）。確定（fsync）はしない。ジャーナルに確定済みで、チェックポイントで
     * まとめて確定させる。ref は最後の値だけを書き、reflog には途中の更新も順に 1 行ずつ足す（Git で 1 回ずつ
     * 更新したときと同じ行になる）。書き出すまでの間に、ほかの処理が ref・index を書き換えていたら、そちらを残す
     */
    materialize(): void {
        const p = this.pending;
        if (!p) { return; }
        this.pending = undefined;
        this.stats.materializations++;
        this.stats.materializedSaves += p.saves;
        for (const [hash, o] of p.objects) {
            writeLooseObject(this.gitDir, o.type, o.body, { fsync: false, cache: this.objCache, mode: 0o644 });
            this.journal?.noteWritten(looseObjectPath(this.gitDir, hash));
        }
        if (p.index) {
            if (sameStamp(stamp(indexPath(this.gitDir)), this.indexStamp)) {
                try {
                    writeIndex(indexPath(this.gitDir), this.index, { fsync: false });
                    this.indexStamp = stamp(indexPath(this.gitDir));
                } catch (e) {
                    this.loaded = false; // 次の記録で読み直す
                    this.indexStamp = undefined;
                    throw new FastPathUnsupported(`index を書けない: ${e instanceof Error ? e.message : String(e)}`);
                }
            } else {
                // ほかの処理が index を書き換えた：そちらを残し、次の記録で読み直す
                this.stats.externalWins++;
                this.indexStamp = undefined;
                this.loaded = false;
            }
        }
        if (p.head) {
            writeSymbolicRef(this.gitDir, 'HEAD', p.head, { fsync: false });
            this.journal?.noteWritten(path.join(this.gitDir, 'HEAD'));
        }
        for (const [name, e] of p.refs) {
            let current: string | null = null;
            try { current = readRef(this.gitDir, name) ?? null; } catch { current = null; }
            if (current !== e.base) {
                // ほかの処理（過去に戻る操作など）が書き換えた：そちらを残す。コミットはオブジェクトとして残る
                this.stats.externalWins++;
                this.refState = undefined;
                continue;
            }
            const last = e.updates[e.updates.length - 1];
            const log = path.join(this.gitDir, 'logs', ...name.split('/'));
            if (last.reflogIdent && !this.reflogs.has(log)) {
                if (!fs.existsSync(log) && name.startsWith('refs/heads/')) {
                    // git update-ref は、core.logAllRefUpdates が有効ならブランチの reflog を作る
                    fs.mkdirSync(path.dirname(log), { recursive: true });
                    fs.writeFileSync(log, '');
                }
                if (fs.existsSync(log)) { this.reflogs.add(log); }
            }
            for (const u of e.updates.slice(0, -1)) {
                if (u.reflogIdent) { logRefUpdate(this.gitDir, name, u.old ?? ZERO, u.new, u.reflogIdent, { headPointsHere: u.headPointsHere }); }
            }
            const file = path.join(this.gitDir, ...name.split('/'));
            const dir = path.dirname(file);
            writeRef(this.gitDir, name, last.new, {
                fsync: false,
                reflogIdent: last.reflogIdent,
                old: last.old,
                headPointsHere: last.headPointsHere,
                dirExists: this.objCache.dirs.has(dir),
            });
            this.objCache.dirs.add(dir);
            this.journal?.noteWritten(file);
        }
        this.restampRefs();
    }

    /**
     * HEAD に付いている mb-* のタグ（git tag --points-at HEAD -l 'mb-*' の最初）を、メモリの状態から答える。
     * 書き出し待ちがあるあいだは、ファイルを読むと古い答えになるので、こちらを使う（ADR-0015）。分からなければ undefined
     */
    headTagFromMemory(): string | undefined {
        const r = this.refState;
        if (!this.pending || !r?.head) { return undefined; }
        return [...r.tags].filter(([n, h]) => h === r.head && /^mb-/.test(n)).map(([n]) => n).sort()[0];
    }

    /** 貯めている分を書き出す（隠しリポジトリを読む処理の前に呼ぶ。ADR-0015） */
    flush(): void {
        this.materialize();
    }

    /** ジャーナルのチェックポイント（保存が落ち着いたときに呼ぶ。保存を待たせない）。先に貯めている分を書き出す */
    checkpoint(): Promise<void> {
        this.materialize();
        return this.journal?.checkpoint() ?? Promise.resolve();
    }

    /** ジャーナルのチェックポイントを同期で（拡張機能の終わり）。先に貯めている分を書き出す */
    checkpointSync(): void {
        this.materialize();
        this.journal?.checkpointSync();
    }

    /** HEAD を micro-history に向ける（もう向いていれば何もしない） */
    private pointHeadAtBranch(): void {
        if (this.refState?.symbolic === BRANCH) { return; }
        this.txn!.head = BRANCH;
        if (this.refState) { this.refState.symbolic = BRANCH; this.refState.head = this.refState.branch; }
    }

    /** 1 回の保存を記録する。前提から外れたら FastPathUnsupported（何も書く前に判断できるものは書く前に投げる） */
    record(input: MicroCommitInput): MicroCommitOutcome {
        // fsync の回数と時間（#45）。段階ごとの時間には fsync も含まれるので、別に数えて見分ける
        const fsyncBefore = { count: fsyncStats.count, ms: fsyncStats.ms };
        try {
            return this.recordInner(input);
        } finally {
            this.stats.lastPhases.fsyncCount = fsyncStats.count - fsyncBefore.count;
            this.stats.lastPhases.fsyncMs = fsyncStats.ms - fsyncBefore.ms;
        }
    }

    private recordInner(input: MicroCommitInput): MicroCommitOutcome {
        this.stats.lastPhases = {};
        this.phaseAt = performance.now();
        this.ensureLoaded();
        this.txn = { objects: new Map(), refs: [], index: false };
        this.phase('load');
        const now = new Date();
        const rel = input.relativeFilePath;
        let tag = input.currentTag;
        if (!this.attributesNeutral && path.posix.basename(rel) === '.gitattributes') { throw new FastPathUnsupported('.gitattributes の保存'); }

        // detached HEAD のままだと以降の記録が不安定なので、コミット前にブランチへ戻す（CLI の実装と同じ）
        let r = this.refs();
        if (r.branch && !r.symbolic) {
            const headHash = r.head;
            this.pointHeadAtBranch();
            if (headHash && isSafeGitRef(headHash)) {
                this.setRef(BRANCH, headHash, now, r.branch);
                r.branch = headHash;
                r.head = headHash;
            }
        }

        this.reloadIndexIfChanged();
        this.phase('refsAndIndex');

        // git add -- <rel>
        const abs = path.join(this.workTree, ...rel.split('/'));
        const st = fs.lstatSync(abs);
        if (!st.isFile()) { throw new FastPathUnsupported('通常のファイルではない'); }
        const parts = rel.split('/');
        let d = this.root;
        const chain: Dir[] = [d];
        for (const name of parts.slice(0, -1)) {
            if (d.files.has(name)) { throw new FastPathUnsupported('ファイルとディレクトリの置き換え'); }
            let sub = d.dirs.get(name);
            if (!sub) { sub = newDir(); d.dirs.set(name, sub); }
            d = sub;
            chain.push(d);
        }
        const base = parts[parts.length - 1];
        if (d.dirs.has(base) && (d.dirs.get(base)!.files.size > 0 || d.dirs.get(base)!.dirs.size > 0)) {
            throw new FastPathUnsupported('ファイルとディレクトリの置き換え');
        }
        const content = fs.readFileSync(abs);
        this.phase('readFile');
        const blob = this.stageObject('blob', content);
        this.phase('blob');
        const filemode = !/^(false|no|off|0)$/i.test(this.config.get('core.filemode') ?? 'true');
        const prev = d.files.get(base);
        const mode = filemode ? ((st.mode & 0o100) ? '100755' : '100644') : (prev?.mode === '100755' ? '100755' : '100644');
        d.files.set(base, { mode, hash: blob });
        for (const x of chain) { x.hash = undefined; }

        const entry: IndexEntry = entryFromStat(rel, abs, blob, mode === '100755' ? 0o100755 : 0o100644);
        const i = this.index.entries.findIndex((e) => e.path === rel);
        if (i >= 0) { this.index.entries[i] = entry; } else {
            this.index.entries.push(entry);
            this.index.entries.sort(compareIndexEntries);
        }
        this.txn.index = true;
        this.phase('index');

        // git write-tree
        const tree = this.treeHash(this.root, true);
        this.phase('tree');

        r = this.refs();
        const currentHead = r.head ?? '';
        const tags = r.tags;
        this.ensureKnown([currentHead, ...tags.values(), r.branch]);
        if (currentHead) {
            const headTree = this.commitTree.get(currentHead);
            if (headTree === tree) {
                this.applyTxn();
                return { kind: 'unchanged' };
            }
        }

        // 過去の同じ変更（同じ tree / 同じパスに同じ中身）
        let past: { commit: string; reason: 'tree' | 'file' } | undefined;
        if (currentHead) {
            const byTree = this.treeToCommit.get(tree);
            const byFile = this.fileIndex.get(rel)?.get(blob);
            if (byTree && isSafeGitRef(byTree)) { past = { commit: byTree, reason: 'tree' }; } else if (byFile && isSafeGitRef(byFile)) { past = { commit: byFile, reason: 'file' }; }
        }
        if (past && currentHead !== past.commit) {
            this.setRef(BRANCH, past.commit, now, r.branch);
            r.branch = past.commit;
            this.pointHeadAtBranch();
            r.head = past.commit;
            // git tag --points-at HEAD -l 'mb-*' の最初（名前の順）
            const attached = [...tags].filter(([, h]) => h === past!.commit).map(([n]) => n).sort()[0];
            if (attached) { tag = attached; }
            this.headFlat = undefined;
            this.applyTxn();
            return { kind: 'rewound', commit: past.commit, reason: past.reason, tag };
        }
        if (past && currentHead === past.commit) {
            this.applyTxn();
            return { kind: 'unchanged' };
        }

        const env = input.commitEnv;
        const body = serializeCommit({
            tree,
            parents: currentHead ? [currentHead] : [],
            author: this.ident(env, 'AUTHOR', now),
            committer: this.ident(env, 'COMMITTER', now),
            message: input.message(),
        });
        // 親から変わったパス（git log -- <パス> が「そのパスを変えた」と数えるもの）。同じ中身に戻したあとは
        // 作業ツリーと index が HEAD とずれているので、保存したファイル以外も変わっていることがある
        this.phase('past');
        const flat = this.flatIndex();
        const parentFlat = currentHead ? this.flatOfCommit(currentHead) : new Map<string, string>();
        const changed: Array<[string, string]> = [];
        for (const [p, v] of flat) {
            if (parentFlat.get(p) !== v) { changed.push([p, v.split(' ')[1]]); }
        }
        this.phase('flat');
        const commit = this.stageObject('commit', body);
        this.phase('commitObject');
        this.setRef(BRANCH, commit, now, r.branch);
        r.branch = commit;
        this.pointHeadAtBranch();
        r.head = commit;

        if (!isSafeGitRef(tag)) { tag = 'mb-1'; }
        const tip = tags.get(tag);
        if (currentHead && tip && currentHead !== tip) {
            let max = 0;
            for (const n of tags.keys()) {
                const m = /^mb-(\d+)$/.exec(n);
                if (m) { max = Math.max(max, Number(m[1])); }
            }
            tag = `mb-${max + 1}`;
        }
        this.txn.refs.push({ name: `refs/tags/${tag}`, old: tags.get(tag) ?? null, new: commit, headPointsHere: false });
        tags.set(tag, commit);
        this.phase('refs');
        this.applyTxn();

        // 索引を足す
        this.commitTree.set(commit, tree);
        this.treeToCommit.set(tree, commit);
        for (const [p, h] of changed) {
            let fm = this.fileIndex.get(p);
            if (!fm) { fm = new Map(); this.fileIndex.set(p, fm); }
            fm.set(h, commit);
        }
        this.headFlat = { commit, files: flat };
        this.recentFlats.set(commit, flat);
        if (this.recentFlats.size > 128) { this.recentFlats.delete(this.recentFlats.keys().next().value!); }

        // 親から変わったのが保存したファイル 1 つだけで、消えたファイルが無いなら、その中身を結果に載せる。
        // 層の作成で Git を起動して読み直さずに済む（#37）
        this.phase('historyIndex');
        let delta: MicroCommitDelta | undefined;
        if (currentHead && changed.length === 1 && changed[0][0] === rel && parentFlat.size <= flat.size) {
            let removed = false;
            for (const k of parentFlat.keys()) {
                if (!flat.has(k)) { removed = true; break; }
            }
            if (!removed) { delta = { parent: currentHead, files: [{ path: rel, mode: mode as '100644' | '100755', content }] }; }
        }
        return { kind: 'created', commit, parent: currentHead || undefined, tag, delta };
    }
}
