/**
 * Git のオブジェクト（blob・tree・commit）を、Git のプロセスを起動せずに作って書く（#32）。
 *
 * 形式は Git と同じ（SHA-1、loose object＝zlib で圧縮した「<種類> <長さ>\0<中身>」）。
 * 書いたものは、ふつうの Git でそのまま読める（git fsck --strict が通ることをテストで確かめる）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { timedFsync } from './fsyncStats';
import * as path from 'path';
import * as zlib from 'zlib';

export type ObjectType = 'blob' | 'tree' | 'commit';

export function objectHeader(type: ObjectType, length: number): Buffer {
    return Buffer.from(`${type} ${length}\0`, 'ascii');
}

/** git hash-object と同じ値（SHA-1 の 16 進 40 文字） */
export function hashObject(type: ObjectType, body: Buffer): string {
    return crypto.createHash('sha1').update(objectHeader(type, body.length)).update(body).digest('hex');
}

export function looseObjectPath(gitDir: string, hash: string): string {
    return path.join(gitDir, 'objects', hash.slice(0, 2), hash.slice(2));
}

/**
 * loose object を書く。もうあれば書かない（中身で決まる名前なので、同じものがあれば同じ中身）。
 * 書き方は Git と同じく「一時ファイルに書く → （fsync）→ 名前を変える」。途中で落ちても壊れたオブジェクトは残らない。
 */
export function writeLooseObject(
    gitDir: string,
    type: ObjectType,
    body: Buffer,
    options: { fsync: boolean; cache?: ObjectWriteCache; /** ファイルのモード（既定 0o444。ジャーナルを使うときは後で確定させるため 0o644、ADR-0014） */ mode?: number },
): string {
    const hash = hashObject(type, body);
    const cache = options.cache;
    if (cache?.present.has(hash)) { return hash; }
    const dest = looseObjectPath(gitDir, hash);
    if (fs.existsSync(dest)) {
        cache?.present.add(hash);
        return hash;
    }
    const dir = path.dirname(dest);
    if (!cache?.dirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        cache?.dirs.add(dir);
    }
    const data = zlib.deflateSync(Buffer.concat([objectHeader(type, body.length), body]));
    const tmp = path.join(dir, `tmp_obj_${process.pid}_${crypto.randomBytes(6).toString('hex')}`);
    const fd = fs.openSync(tmp, 'wx', options.mode ?? 0o444);
    try {
        fs.writeSync(fd, data);
        if (options.fsync) { timedFsync(fd); }
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, dest);
    } catch (e) {
        // 同時に同じオブジェクトが書かれた（Windows では上書きの rename が失敗する）
        fs.rmSync(tmp, { force: true });
        if (!fs.existsSync(dest)) { throw e; }
    }
    cache?.present.add(hash);
    return hash;
}

/**
 * 書いた（あると分かった）オブジェクトと、作ったフォルダを覚えておく（#32。存在の確認とフォルダの作成を繰り返さない）。
 * git gc で loose object が pack に移っても、オブジェクトそのものは残るので、覚えたままでよい
 */
export type ObjectWriteCache = { present: Set<string>; dirs: Set<string> };

export type TreeEntry = {
    /** 100644・100755・120000・160000・40000（ディレクトリ） */
    mode: string;
    name: string;
    hash: string;
};

/** Git の tree の並び順：名前のバイト列で比べ、ディレクトリは名前の後ろに「/」があるものとして比べる */
function treeSortKey(e: TreeEntry): Buffer {
    return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

export function serializeTree(entries: TreeEntry[]): Buffer {
    const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
    const parts: Buffer[] = [];
    for (const e of sorted) {
        parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.hash, 'hex'));
    }
    return Buffer.concat(parts);
}

export type Ident = { name: string; email: string; seconds: number; tz: string };

/** 「名前 <メール> 秒 +0900」 */
export function formatIdent(i: Ident): string {
    return `${i.name} <${i.email}> ${i.seconds} ${i.tz}`;
}

/** process の地方時の時差を Git の形（+0900）にする */
export function localTz(date: Date): string {
    const off = -date.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

/**
 * GIT_AUTHOR_DATE・GIT_COMMITTER_DATE の値を読む。「<秒> <+hhmm>」と「@<秒> <+hhmm>」だけを扱う。
 * それ以外の形なら undefined（呼ぶ側は Git の CLI に任せる）
 */
export function parseGitDate(value: string | undefined, now: Date): { seconds: number; tz: string } | undefined | 'unsupported' {
    if (value === undefined || value === '') {
        return { seconds: Math.floor(now.getTime() / 1000), tz: localTz(now) };
    }
    const m = /^@?(\d+) ([+-]\d{4})$/.exec(value.trim());
    if (!m) { return 'unsupported'; }
    return { seconds: Number(m[1]), tz: m[2] };
}

/** git commit-tree -m <message> と同じ中身（メッセージが改行で終わっていなければ改行を 1 つ足す） */
export function serializeCommit(c: { tree: string; parents: string[]; author: Ident; committer: Ident; message: string }): Buffer {
    const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${formatIdent(c.author)}`, `committer ${formatIdent(c.committer)}`];
    const message = c.message.endsWith('\n') ? c.message : `${c.message}\n`;
    return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}
