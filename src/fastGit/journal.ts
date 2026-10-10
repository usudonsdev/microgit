/**
 * 記録のジャーナル（ADR-0014、#38）。保存 1 回の記録を 1 つの追記と 1 回の fsync で確定させ、
 * Git の形式のファイルは確定を待たずに書く。停電などのあとは、起動時にジャーナルから作り直す。
 *
 * ファイル：<Git のディレクトリ>/microgit-journal/<pid>-<乱数>.log（プロセスごとに別。鍵を取り合わない）
 * 1 つの記録：'MGJ1' ＋ 長さ（u32、ビッグエンディアン）＋ 中身（JSON）＋ 中身の SHA-256（32 バイト）
 * 読むときは先頭から順に、形と SHA-256 が合う記録だけを使い、合わなくなったところで止める（書きかけの最後の記録を捨てる）。
 */
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { timedFdatasync, timedFsync } from './fsyncStats';
import { timeSync, markResume } from '../syncWorkLog';
import { hashObject, looseObjectPath, ObjectType, writeLooseObject } from './objects';
import { readIndex } from './gitIndex';
import { readRef, readSymbolicHead, writeRef, writeSymbolicRef } from './refs';

const MAGIC = Buffer.from('MGJ1', 'ascii');

export type JournalObject = { type: ObjectType; hash: string; body: Buffer };
export type JournalRefChange = { name: string; old: string | null; new: string };
export type JournalEntry = {
    seq: number;
    at: string;
    objects: JournalObject[];
    refs: JournalRefChange[];
    /** HEAD を向ける先（symbolic ref）。変えないときは undefined */
    head?: string;
};

export function journalDir(gitDir: string): string {
    return path.join(gitDir, 'microgit-journal');
}

export function serializeEntry(e: JournalEntry): Buffer {
    const payload = Buffer.from(JSON.stringify({
        v: 1,
        seq: e.seq,
        at: e.at,
        objects: e.objects.map((o) => ({ t: o.type, h: o.hash, d: o.body.toString('base64') })),
        refs: e.refs.map((r) => ({ n: r.name, o: r.old, w: r.new })),
        head: e.head,
    }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    return Buffer.concat([MAGIC, len, payload, crypto.createHash('sha256').update(payload).digest()]);
}

/** ジャーナルの中身を読む。形か SHA-256 が合わなくなったところで止める */
export function parseJournal(buf: Buffer): { entries: JournalEntry[]; validBytes: number; tail: 'complete' | 'truncated' | 'corrupt' } {
    const entries: JournalEntry[] = [];
    let p = 0;
    while (p < buf.length) {
        if (buf.length - p < 8) { return { entries, validBytes: p, tail: 'truncated' }; }
        if (!buf.subarray(p, p + 4).equals(MAGIC)) { return { entries, validBytes: p, tail: 'corrupt' }; }
        const len = buf.readUInt32BE(p + 4);
        const end = p + 8 + len + 32;
        if (end > buf.length) { return { entries, validBytes: p, tail: 'truncated' }; }
        const payload = buf.subarray(p + 8, p + 8 + len);
        const sum = buf.subarray(p + 8 + len, end);
        if (!crypto.createHash('sha256').update(payload).digest().equals(sum)) { return { entries, validBytes: p, tail: 'corrupt' }; }
        let j: { seq: number; at: string; objects: Array<{ t: ObjectType; h: string; d: string }>; refs: Array<{ n: string; o: string | null; w: string }>; head?: string };
        try {
            j = JSON.parse(payload.toString('utf8'));
        } catch {
            return { entries, validBytes: p, tail: 'corrupt' };
        }
        entries.push({
            seq: j.seq,
            at: j.at,
            objects: j.objects.map((o) => ({ type: o.t, hash: o.h, body: Buffer.from(o.d, 'base64') })),
            refs: j.refs.map((r) => ({ name: r.n, old: r.o, new: r.w })),
            head: j.head,
        });
        p = end;
    }
    return { entries, validBytes: p, tail: 'complete' };
}

/** プロセスが動いているか（同じ利用者のプロセス。pid の再利用で「動いている」と誤ることはあるが、そのときは消さないだけ） */
function processAlive(pid: number): boolean {
    if (pid === process.pid) { return true; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * 1 プロセスのジャーナル。append で記録を確定させ（fsync 1 回）、呼ぶ側はそのあとで Git のファイルを確定させずに書き、
 * noteWritten で書いたファイルを知らせる。checkpoint で、それらをまとめて確定させてから古いジャーナルを消す。
 */
export class Journal {
    private fd = -1;
    private file = '';
    private seq = 0;
    private entries = 0;
    private bytes = 0;
    private written = new Set<string>();
    private checkpointing: Promise<void> | undefined;

    constructor(private readonly gitDir: string) { }

    get pendingEntries(): number { return this.entries; }
    get pendingBytes(): number { return this.bytes; }

    /**
     * 新しいジャーナルのファイルを作り、その名前も確定させる（ディレクトリの fsync）。Linux などでは、ファイルの中身を
     * fdatasync しても、ファイルの名前（ディレクトリの中身）は確定しない。名前が消えるとジャーナルごと失う。
     * チェックポイントでは次のファイルを裏で作るので（createNext）、保存のときにここを通るのは、起動して最初の記録のときだけ
     */
    private open(): void {
        const dir = journalDir(this.gitDir);
        const created = !fs.existsSync(dir);
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}.log`);
        this.fd = fs.openSync(this.file, 'a', 0o644);
        fsyncDirSync(dir);
        if (created) { fsyncDirSync(this.gitDir); }
    }

    /** 次のジャーナルのファイルを、保存の外で作る（名前の確定＝ディレクトリの fsync も、保存を待たせない） */
    private async createNext(): Promise<{ fd: number; file: string }> {
        const dir = journalDir(this.gitDir);
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}.log`);
        const fd = await new Promise<number>((resolve, reject) => fs.open(file, 'a', 0o644, (e, f) => (e ? reject(e) : resolve(f))));
        await fsyncDir(dir);
        return { fd, file };
    }

    /** 記録を追記して確定させる（fdatasync 1 回） */
    append(e: Omit<JournalEntry, 'seq' | 'at'>): void {
        if (this.fd < 0) { this.open(); }
        const buf = serializeEntry({ ...e, seq: ++this.seq, at: new Date().toISOString() });
        let off = 0;
        while (off < buf.length) { off += fs.writeSync(this.fd, buf, off, buf.length - off); }
        timedFdatasync(this.fd);
        this.entries++;
        this.bytes += buf.length;
    }

    /** ジャーナルの後で、確定させずに書いた Git のファイル（チェックポイントで確定させる） */
    noteWritten(file: string): void {
        this.written.add(file);
    }

    /** チェックポイントが進んでいるところか（ADR-0015：その間は、たまっていても書き出し直さない） */
    get checkpointInProgress(): boolean { return this.checkpointing !== undefined; }

    /** 記録が一定数たまったか（64 件か 8 MiB） */
    shouldCheckpoint(): boolean {
        return this.entries >= 64 || this.bytes >= 8 * 1024 * 1024;
    }

    /**
     * チェックポイント：新しいジャーナルに切り替え、古いジャーナルの記録で書いたファイルをまとめて確定させ、古いジャーナルを消す。
     * 非同期（保存を待たせない）。途中で停電しても、古いジャーナルは消す前なので起動時に作り直せる
     */
    checkpoint(): Promise<void> {
        if (this.checkpointing) { return this.checkpointing; }
        if (this.entries === 0 || this.fd < 0) { return Promise.resolve(); }
        this.checkpointing = (async () => {
            try {
                // 1. 次のファイルを裏で作る。その間の保存は、今のファイルに追記し続ける
                const next = await this.createNext();
                markResume('journal.checkpoint after createNext');
                if (this.fd < 0) {
                    // その間に checkpointSync が今のファイルを片付けた。次のファイルをそのまま使う
                    this.fd = next.fd;
                    this.file = next.file;
                    return;
                }
                // 2. 切り替える（保存と保存の間に、同期で一度に）
                const oldFd = this.fd;
                const oldFile = this.file;
                const files = [...this.written];
                this.fd = next.fd;
                this.file = next.file;
                this.entries = 0;
                this.bytes = 0;
                this.written = new Set();
                // 3. 古いファイルの記録で書いた Git のファイルと、その名前（ディレクトリ）を確定させてから、古いファイルを消す
                timeSync('journal.closeSync(old)', () => fs.closeSync(oldFd));
                // オブジェクトは上書きされないので裏で確定させる。ref・HEAD・index など上書きされうるファイルは、
                // 開いて確定させて閉じるまでを同期で一度に行う。裏で開いたままにすると、その間の保存の上書きの rename が
                // Windows で EPERM になる（5.0.0 の公開前の確認、windows-latest で 105 回に 1 回）
                for (const f of files) {
                    if (isObjectFile(f)) { await timeSync('journal.flushFile(objects: async, sync part)', () => flushFile(f)); } else { timeSync('journal.flushFileSync(ref/HEAD/index)', () => flushFileSync(f), () => path.basename(f)); }
                }
                for (const d of parentDirs(files)) { await fsyncDir(d); }
                await fs.promises.unlink(oldFile).catch(() => undefined);
            } finally {
                this.checkpointing = undefined;
            }
        })();
        return this.checkpointing;
    }

    /** チェックポイントを同期でする（拡張機能の終わりなど） */
    checkpointSync(): void {
        if (this.fd < 0) { return; }
        fs.closeSync(this.fd);
        for (const f of this.written) { flushFileSync(f); }
        for (const d of parentDirs([...this.written])) { fsyncDirSync(d); }
        try { fs.unlinkSync(this.file); } catch { /* 消せなくても、起動時に作り直すだけ */ }
        this.fd = -1;
        this.file = '';
        this.entries = 0;
        this.bytes = 0;
        this.written = new Set();
    }
}

const parentDirs = (files: string[]) => new Set(files.map((f) => path.dirname(f)));

/**
 * ディレクトリを fsync する（その中のファイルの名前の追加・削除を確定させる）。Windows ではディレクトリを開いて
 * fsync できない（NTFS はメタデータを自分のジャーナルで守る）ので、何もしない
 */
function fsyncDirSync(dir: string): void {
    if (process.platform === 'win32') { return; }
    let fd = -1;
    try {
        fd = fs.openSync(dir, 'r');
        timedFsync(fd); // 保存の途中で通るとき（新しいジャーナルの最初の記録）も、fsync の回数に数える
    } catch { /* ディレクトリの fsync ができないファイルシステム */ } finally {
        if (fd >= 0) { fs.closeSync(fd); }
    }
}

async function fsyncDir(dir: string): Promise<void> {
    if (process.platform === 'win32') { return; }
    let h: fs.promises.FileHandle | undefined;
    try {
        h = await fs.promises.open(dir, 'r');
        await h.sync();
    } catch { /* ディレクトリの fsync ができないファイルシステム */ } finally {
        await h?.close();
    }
}

const isObjectFile = (f: string) => /[\\/]objects[\\/][0-9a-f]{2}[\\/][0-9a-f]{38}$/.test(f);

/**
 * ファイルを確定させる。loose object は確定させてから読み取り専用（Git と同じ 0444）にする。
 * もう読み取り専用のファイル（前のチェックポイントで確定させたオブジェクトや、Git のコマンドが作ったもの）は
 * 書き込みで開けないので、読み取りで開いて確定させる（Linux・macOS はこれで fsync できる。Windows は
 * 書き込みの権限が要るので、できなければ飛ばす：0444 にしたのは確定させたあとなので、もう確定している）
 */
async function flushFile(f: string): Promise<void> {
    for (const flags of ['r+', 'r']) {
        let h: fs.promises.FileHandle | undefined;
        try {
            h = await fs.promises.open(f, flags);
            await h.datasync();
            break;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') { return; }
            if (code !== 'EACCES' && code !== 'EPERM') { throw e; }
            if (flags === 'r') { return; }
        } finally {
            await h?.close();
        }
    }
    if (isObjectFile(f)) { await fs.promises.chmod(f, 0o444).catch(() => undefined); }
}

function flushFileSync(f: string): void {
    for (const flags of ['r+', 'r']) {
        let fd = -1;
        try {
            fd = fs.openSync(f, flags);
            fs.fdatasyncSync(fd);
            break;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') { return; }
            if (code !== 'EACCES' && code !== 'EPERM') { throw e; }
            if (flags === 'r') { return; }
        } finally {
            if (fd >= 0) { fs.closeSync(fd); }
        }
    }
    if (isObjectFile(f)) { try { fs.chmodSync(f, 0o444); } catch { /* 読み取り専用にできなくても中身は確定している */ } }
}

export type RecoveryReport = {
    files: number;
    entries: number;
    objectsRepaired: number;
    refsAdvanced: number;
    refsKept: number;
    headRepaired: boolean;
    truncatedTails: number;
    deletedFiles: number;
    /** index を HEAD の tree から作り直したか */
    indexReset: boolean;
    /** 直した reflog の数 */
    reflogsRepaired: number;
};

/** loose object が、正しい中身でディスクにあるか（展開してハッシュを確かめる） */
function looseObjectValid(gitDir: string, o: JournalObject): boolean {
    const file = looseObjectPath(gitDir, o.hash);
    try {
        const raw = zlib.inflateSync(fs.readFileSync(file));
        const nul = raw.indexOf(0);
        const [type, size] = raw.subarray(0, nul).toString('ascii').split(' ');
        const body = raw.subarray(nul + 1);
        return type === o.type && Number(size) === body.length && hashObject(o.type, body) === o.hash;
    } catch {
        return false;
    }
}

/** コミットが Git にあるか（loose か pack。pack は Git に聞く。作り直しは遅くてよい） */
function objectExists(gitDir: string, hash: string): boolean {
    if (fs.existsSync(looseObjectPath(gitDir, hash))) { return true; }
    try {
        execFileSync('git', ['--git-dir', gitDir, 'cat-file', '-e', hash], { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * 起動時の作り直し（ADR-0014）。すべてのジャーナルを読み、記録ごとに
 * - オブジェクト：無いか壊れていれば、ジャーナルの中身から書き直して確定させる
 * - ref：今の値が記録の「前の値」と同じか、読めない・指すオブジェクトが無いときだけ「新しい値」に進めて確定させる
 *   （それ以外はほかの処理が後から書き換えたので触らない）
 * - HEAD：読めなければ記録の向きに直す
 * 持ち主のプロセスがもう動いていないジャーナルは、作り直したあとで消す。
 */
export function recoverJournals(gitDir: string): RecoveryReport {
    const report: RecoveryReport = { files: 0, entries: 0, objectsRepaired: 0, refsAdvanced: 0, refsKept: 0, headRepaired: false, truncatedTails: 0, deletedFiles: 0, indexReset: false, reflogsRepaired: 0 };
    const staleFiles: string[] = [];
    const touchedRefs = new Set<string>();
    const chains = new Map<string, RefChain>();
    /** 作り直したファイルのディレクトリ（ジャーナルを消す前に、名前も確定させる） */
    const repairedDirs = new Set<string>();
    const dir = journalDir(gitDir);
    if (!fs.existsSync(dir)) { return report; }
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort();
    for (const name of files) {
        const file = path.join(dir, name);
        report.files++;
        const { entries, tail } = parseJournal(fs.readFileSync(file));
        if (tail !== 'complete') { report.truncatedTails++; }
        for (const e of entries) {
            report.entries++;
            for (const o of e.objects) {
                if (hashObject(o.type, o.body) !== o.hash) { continue; } // ジャーナルの中身そのものが合わない（起きないはず）
                if (!looseObjectValid(gitDir, o)) {
                    try { fs.chmodSync(looseObjectPath(gitDir, o.hash), 0o644); } catch { /* 無い */ }
                    fs.rmSync(looseObjectPath(gitDir, o.hash), { force: true });
                    writeLooseObject(gitDir, o.type, o.body, { fsync: true });
                    repairedDirs.add(path.dirname(looseObjectPath(gitDir, o.hash)));
                    report.objectsRepaired++;
                }
            }
            if (e.head) {
                let ok = false;
                try { ok = readSymbolicHead(gitDir) !== undefined || readRef(gitDir, 'HEAD') !== undefined; } catch { ok = false; }
                if (!ok) {
                    writeSymbolicRef(gitDir, 'HEAD', e.head, { fsync: true });
                    report.headRepaired = true;
                }
            }
            const at = Date.parse(e.at);
            for (const r of e.refs) {
                touchedRefs.add(r.name);
                let c = chains.get(r.name);
                if (!c) { c = { values: new Set(), final: r.new, lastAt: at }; chains.set(r.name, c); }
                if (r.old) { c.values.add(r.old); }
                c.values.add(r.new);
                if (at >= c.lastAt) { // ジャーナルが複数あるときは、いちばん新しい記録の値
                    c.final = r.new;
                    c.lastAt = at;
                }
            }
        }
        const pid = Number(name.split('-')[0]);
        if (!Number.isFinite(pid) || !processAlive(pid)) { staleFiles.push(file); }
    }
    for (const [name, c] of chains) {
        switch (decideRef(gitDir, name, c)) {
            case 'advance':
                writeRef(gitDir, name, c.final, { fsync: true });
                repairedDirs.add(path.dirname(path.join(gitDir, ...name.split('/'))));
                report.refsAdvanced++;
                break;
            case 'kept':
                report.refsKept++;
                break;
        }
    }
    // index はジャーナルに入れていない（Git でもキャッシュ扱い）。ref を進めたとき（停電で index も古いままのはず）か、
    // index が読めない・無いオブジェクトを指すときは、HEAD の tree から作り直す。古い index のまま次の保存をすると、
    // 最後の数回分の変更が消えた tree ができてしまう
    if (report.refsAdvanced > 0 || !indexUsable(gitDir)) {
        try {
            execFileSync('git', ['--git-dir', gitDir, 'read-tree', 'HEAD'], { stdio: 'ignore', windowsHide: true });
            report.indexReset = true;
        } catch { /* HEAD がまだ無い（最初のコミットの前） */ }
    }
    // reflog も fsync せずに追記しているので、停電で行が途中で切れたり、無いオブジェクトを指したりしうる。
    // 記録に出てきた ref と HEAD の reflog から、形の合わない行と、無いオブジェクトを指す行を取り除く
    if (report.entries > 0) {
        for (const name of ['HEAD', ...touchedRefs]) {
            if (sanitizeReflog(gitDir, name)) { report.reflogsRepaired++; }
        }
    }
    for (const d of repairedDirs) { fsyncDirSync(d); }
    // 持ち主のプロセスがもう動いていないジャーナルは消す（中身はもう反映した）
    for (const file of staleFiles) {
        try {
            fs.unlinkSync(file);
            report.deletedFiles++;
        } catch { /* 消せなくても、次の起動でもう一度読むだけ（何も起きない） */ }
    }
    return report;
}

type RefChain = { values: Set<string>; final: string; lastAt: number };

/**
 * 1 つの ref を、ジャーナルの最後の値に進めるか決める。
 * - 今の値が最後の値：何もしない
 * - 読めない・無いオブジェクトを指す：書き込みが失われた → 進める
 * - 今の値がジャーナルの途中の値：書き込みが失われて途中の値が残ったのか、ほかの処理（過去に戻る操作など）が
 *   ちょうどその値に戻したのか、値だけでは分からない。ref のファイルの更新時刻で見分ける。
 *   こちらが途中の値を書いたのは最後の記録より前、ほかの処理が書いたのは最後の記録より後
 * - 今の値がジャーナルに無い値：ほかの処理が書いた → 触らない
 */
function decideRef(gitDir: string, name: string, c: RefChain): 'none' | 'advance' | 'kept' {
    let current: string | undefined;
    try { current = readRef(gitDir, name); } catch { current = undefined; }
    if (current === c.final) { return 'none'; }
    if (current === undefined || !objectExists(gitDir, current)) { return 'advance'; }
    if (!c.values.has(current)) { return 'kept'; }
    const mtime = refMtime(gitDir, name);
    return mtime !== undefined && mtime > c.lastAt ? 'kept' : 'advance';
}

/** ref のファイル（無ければ packed-refs）の更新時刻（ミリ秒） */
function refMtime(gitDir: string, name: string): number | undefined {
    for (const f of [path.join(gitDir, ...name.split('/')), path.join(gitDir, 'packed-refs')]) {
        try { return fs.statSync(f).mtimeMs; } catch { /* 次 */ }
    }
    return undefined;
}

/** reflog から、形の合わない行と、無いオブジェクトを指す行を取り除く。直したら true */
function sanitizeReflog(gitDir: string, name: string): boolean {
    const file = path.join(gitDir, 'logs', ...name.split('/'));
    if (!fs.existsSync(file)) { return false; }
    const text = fs.readFileSync(file, 'utf8');
    // 最後の行が改行で終わっていなければ、途中で切れている（捨てる）。改行で終わっていれば最後の要素は空
    const complete = text.split('\n').slice(0, -1);
    const exists = new Map<string, boolean>();
    const ok = (h: string) => {
        if (/^0{40}$/.test(h)) { return true; }
        if (!exists.has(h)) { exists.set(h, objectExists(gitDir, h)); }
        return exists.get(h)!;
    };
    const kept = complete.filter((l) => {
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) .+$/.exec(l);
        return m !== null && ok(m[1]) && ok(m[2]);
    });
    const next = kept.length ? kept.join('\n') + '\n' : '';
    if (next === text) { return false; }
    const fd = fs.openSync(file, 'w');
    try {
        fs.writeSync(fd, next);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return true;
}

/** index が読めて、指すオブジェクトがすべてあるか（loose に無いものは Git にまとめて聞く） */
function indexUsable(gitDir: string): boolean {
    const file = path.join(gitDir, 'index');
    if (!fs.existsSync(file)) { return false; }
    let hashes: string[];
    try {
        hashes = readIndex(file).entries.map((e) => e.hash);
    } catch {
        return false;
    }
    const notLoose = hashes.filter((h) => !fs.existsSync(looseObjectPath(gitDir, h)));
    if (notLoose.length === 0) { return true; }
    try {
        const out = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-check'], { input: notLoose.join('\n') + '\n', encoding: 'utf8', windowsHide: true });
        return !/ missing$/m.test(out);
    } catch {
        return false;
    }
}
