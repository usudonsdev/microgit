/**
 * 拡張機能ホストのイベントループを止める「同期の仕事」の計測（#67、計測用ブランチだけ）。
 *
 * 関数の同期でかかった時間（performance.now()）と、Git のプロセスを同期で起動した回数・時間を、内部の配列に貯める。
 * 取り出しは内部コマンド microgit.internal.syncWorkLog（取ったら空にする）。動き（何をいつ実行するか）は変えない。
 *
 * async の関数は await で同期の部分が分かれる。timeSync(name, () => asyncFn()) は呼んでから最初の await で
 * Promise が返るまでを測るので、「その呼び出しの同期の部分」になる。await の後の続きは、続きの中にある
 * timeSync / markResume で測る。記録の t（開始時刻）と ms から、同期で連続して走った部分（run）が復元できる。
 */

export interface WorkRecord {
    /** fn: 関数の同期の部分 / git: Git の同期の起動 / note: 数の記録 / resume: await の後で続きが走り出した印 */
    kind: 'fn' | 'git' | 'note' | 'resume';
    name: string;
    /** 開始時刻（performance.now()） */
    t: number;
    /** かかった時間（ms）。note・resume では 0 */
    ms: number;
    /** この中で測っている呼び出しの深さ（0 が一番外） */
    depth: number;
    /** 直近の外側の記録の名前 */
    parent?: string;
    /** git の失敗、note の値、書いた大きさなど */
    detail?: string;
}

const records: WorkRecord[] = [];
const stack: string[] = [];

/** 同期の関数の時間を測って記録する。戻り値・例外はそのまま */
export function timeSync<T>(name: string, fn: () => T, detail?: () => string | undefined): T {
    const depth = stack.length;
    const parent = stack[depth - 1];
    stack.push(name);
    const t = performance.now();
    try {
        return fn();
    } finally {
        const ms = performance.now() - t;
        stack.pop();
        records.push({ kind: 'fn', name, t, ms, depth, parent, detail: detail?.() });
    }
}

/** Git の同期の起動を測る。label は引数の最初の 1〜2 語 */
export function timeGit<T>(args: readonly string[], fn: () => T): T {
    const depth = stack.length;
    const parent = stack[depth - 1];
    const t = performance.now();
    let failed = false;
    try {
        return fn();
    } catch (e) {
        failed = true;
        throw e;
    } finally {
        const ms = performance.now() - t;
        records.push({ kind: 'git', name: gitLabel(args), t, ms, depth, parent, detail: failed ? 'failed' : undefined });
    }
}

/** 最初の 1〜2 語（'log --all'、'push --force'、'rev-parse HEAD' など。長い値は切る） */
export function gitLabel(args: readonly string[]): string {
    return args.slice(0, 2).map((a) => (a.length > 24 ? a.slice(0, 24) : a)).join(' ');
}

/** await の後で続きが走り出した印（同期の run の切れ目を見るため） */
export function markResume(name: string): void {
    records.push({ kind: 'resume', name, t: performance.now(), ms: 0, depth: stack.length, parent: stack[stack.length - 1] });
}

/** 数を記録する（mb-* のタグの本数など） */
export function noteWork(name: string, value: number | string): void {
    records.push({ kind: 'note', name, t: performance.now(), ms: 0, depth: stack.length, parent: stack[stack.length - 1], detail: String(value) });
}

/** 貯めた記録を返す。clear のときは空にする */
export function takeSyncWorkLog(clear = true): WorkRecord[] {
    const all = records.slice();
    if (clear) { records.length = 0; }
    return all;
}
