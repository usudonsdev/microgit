/**
 * Git の ref（ブランチ・タグ）を、Git のプロセスを起動せずに読み書きする（#32）。
 * 扱うのは「ファイル」形式の ref（loose と packed-refs）だけ。reftable は扱わない（呼ぶ側が Git の CLI に任せる）。
 */
import * as fs from 'fs';
import { timedFsync } from './fsyncStats';
import { renameReplaceSync } from './renameRetry';
import * as path from 'path';

/** 作業ツリーから Git のディレクトリを探す（.git がディレクトリならそれ、gitfile なら書かれた場所） */
export function resolveGitDir(workTree: string): string {
    const marker = path.join(workTree, '.git');
    const st = fs.statSync(marker);
    if (st.isDirectory()) { return marker; }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
    if (!m) { throw new Error(`gitfile が読めない: ${marker}`); }
    return path.resolve(workTree, m[1]);
}

function readPackedRefs(gitDir: string): Map<string, string> {
    const map = new Map<string, string>();
    const file = path.join(gitDir, 'packed-refs');
    if (!fs.existsSync(file)) { return map; }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
        if (m) { map.set(m[2], m[1]); }
    }
    return map;
}

/** ref が指すコミット（symbolic ref はたどる）。無ければ undefined */
export function readRef(gitDir: string, name: string, depth = 0): string | undefined {
    if (depth > 5) { return undefined; }
    const file = path.join(gitDir, ...name.split('/'));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const v = fs.readFileSync(file, 'utf8').trim();
        const sym = /^ref:\s*(\S+)$/.exec(v);
        if (sym) { return readRef(gitDir, sym[1], depth + 1); }
        return /^[0-9a-f]{40}$/.test(v) ? v : undefined;
    }
    return readPackedRefs(gitDir).get(name);
}

/** HEAD が symbolic なら指している ref の名前、detached なら undefined */
export function readSymbolicHead(gitDir: string): string | undefined {
    const v = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(\S+)$/.exec(v);
    return m ? m[1] : undefined;
}

/** refs/tags/mb-* の一覧（loose と packed-refs。loose が優先） */
export function listTags(gitDir: string, prefix = 'mb-'): Map<string, string> {
    const map = new Map<string, string>();
    for (const [name, hash] of readPackedRefs(gitDir)) {
        if (name.startsWith(`refs/tags/${prefix}`)) { map.set(name.slice('refs/tags/'.length), hash); }
    }
    const dir = path.join(gitDir, 'refs', 'tags');
    if (fs.existsSync(dir)) {
        for (const n of fs.readdirSync(dir)) {
            if (!n.startsWith(prefix)) { continue; }
            const v = fs.readFileSync(path.join(dir, n), 'utf8').trim();
            if (/^[0-9a-f]{40}$/.test(v)) { map.set(n, v); }
        }
    }
    return map;
}

/**
 * git tag --points-at HEAD -l '<prefix>*' の最初（名前の順）と同じ答え。HEAD がどのタグにも指されていなければ undefined（#37）
 */
export function firstTagAtHead(gitDir: string, prefix = 'mb-'): string | undefined {
    const head = readRef(gitDir, 'HEAD');
    if (!head) { return undefined; }
    return [...listTags(gitDir, prefix)].filter(([, h]) => h === head).map(([n]) => n).sort()[0];
}

/**
 * ref を書く（<名前>.lock を排他で作り、書いて、名前を変える）。git update-ref と同じ手順。
 * reflog（logs/<名前>）は、そのファイルがもうあるときだけ 1 行足す（Git は core.logAllRefUpdates で決める）
 */
export function writeRef(
    gitDir: string,
    name: string,
    hash: string,
    options: {
        fsync: boolean;
        reflogIdent?: string;
        message?: string;
        /** 前の値が分かっていれば渡す（読み直さない）。null は「無かった」 */
        old?: string | null;
        /** HEAD がこの ref を指しているかが分かっていれば渡す（読み直さない） */
        headPointsHere?: boolean;
        /** 親のフォルダがあると分かっていれば true（作らない） */
        dirExists?: boolean;
    },
): void {
    const file = path.join(gitDir, ...name.split('/'));
    if (!options.dirExists) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    const old = (options.old === undefined ? readRef(gitDir, name) : options.old) ?? '0'.repeat(40);
    const lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o644);
    try {
        try {
            fs.writeSync(fd, `${hash}\n`);
            if (options.fsync) { timedFsync(fd); }
        } finally {
            fs.closeSync(fd);
        }
        renameReplaceSync(lock, file);
    } catch (e) {
        fs.rmSync(lock, { force: true });
        throw e;
    }
    if (options.reflogIdent) {
        logRefUpdate(gitDir, name, old, hash, options.reflogIdent, { message: options.message, headPointsHere: options.headPointsHere });
    }
}

/**
 * ref の 1 回の更新を reflog に足す（ref のファイルは書かない）。HEAD がこの ref を指していれば、HEAD の reflog にも
 * 足す（git update-ref と同じ）。書き出しを遅らせた記録（ADR-0015）で、途中の更新の行を順に足すのに使う
 */
export function logRefUpdate(
    gitDir: string, name: string, oldHash: string, newHash: string, ident: string,
    options?: { message?: string; headPointsHere?: boolean },
): void {
    appendReflog(gitDir, name, oldHash, newHash, ident, options?.message);
    try {
        const headHere = options?.headPointsHere ?? readSymbolicHead(gitDir) === name;
        if (headHere) { appendReflog(gitDir, 'HEAD', oldHash, newHash, ident, options?.message); }
    } catch { /* HEAD が読めなければ足さない */ }
}

function appendReflog(gitDir: string, name: string, oldHash: string, newHash: string, ident: string, message?: string): void {
    const log = path.join(gitDir, 'logs', ...name.split('/'));
    if (!fs.existsSync(log)) { return; }
    fs.appendFileSync(log, `${oldHash} ${newHash} ${ident}${message ? `\t${message}` : ''}\n`);
}

/** symbolic ref（HEAD → refs/heads/...）を書く */
export function writeSymbolicRef(gitDir: string, name: string, target: string, options: { fsync: boolean }): void {
    const file = path.join(gitDir, ...name.split('/'));
    const want = `ref: ${target}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === want) { return; }
    const lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o644);
    try {
        try {
            fs.writeSync(fd, want);
            if (options.fsync) { timedFsync(fd); }
        } finally {
            fs.closeSync(fd);
        }
        renameReplaceSync(lock, file);
    } catch (e) {
        fs.rmSync(lock, { force: true });
        throw e;
    }
}

