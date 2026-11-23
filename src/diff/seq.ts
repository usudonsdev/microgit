/**
 * 列どうしの対応づけ（LCS）。表の行・列、文書の段落、スライド、文字の差分が共通で使う。VS Code に依存しない。
 *
 * - diffSequences：Myers の O((N+M)D) の差分。共通の先頭・末尾は先に外す。D が maxD を超えたら諦めて、
 *   残りを「全部消して全部足した」にする（巨大な差で時間とメモリを使い切らないため。結果は正しいが粗い）
 * - pairRuns：隣り合う「削除の並び」と「追加の並び」を、前から順に 1 対 1 で組にして「変更」にする
 *   （表の行で、1 セル変えた行は行の指紋が変わるので、削除 + 追加に見える。それを同じ行の変更として扱うため）
 * - diffInline：文字列を語（英数字の並び・1 文字の日本語・空白・記号）に分けて差分を取る
 */

export type SeqOp =
    | { op: 'eq'; a: number; b: number }
    | { op: 'del'; a: number }
    | { op: 'ins'; b: number };

/** a と b の差分。要素は === で比べる（文字列か数値の指紋を渡す） */
export function diffSequences<T>(a: readonly T[], b: readonly T[], maxD = 4000): SeqOp[] {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) { pre++; }
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) { suf++; }
    const out: SeqOp[] = [];
    for (let i = 0; i < pre; i++) { out.push({ op: 'eq', a: i, b: i }); }
    const mid = myers(a, b, pre, a.length - suf, pre, b.length - suf, maxD);
    out.push(...mid);
    for (let k = suf; k > 0; k--) { out.push({ op: 'eq', a: a.length - k, b: b.length - k }); }
    return out;
}

function myers<T>(a: readonly T[], b: readonly T[], a0: number, a1: number, b0: number, b1: number, maxD: number): SeqOp[] {
    const n = a1 - a0;
    const m = b1 - b0;
    if (n === 0 && m === 0) { return []; }
    if (n === 0) { return range(b0, b1).map((b) => ({ op: 'ins', b }) as SeqOp); }
    if (m === 0) { return range(a0, a1).map((a) => ({ op: 'del', a }) as SeqOp); }
    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    v.fill(-1);
    v[off + 1] = 0;
    const trace: Int32Array[] = [];
    const limit = Math.min(max, maxD);
    let found = -1;
    for (let d = 0; d <= limit; d++) {
        trace.push(v.slice(off - d - 1, off + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) {
                x = v[off + k + 1];
            } else {
                x = v[off + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) { found = d; break; }
        }
        if (found >= 0) { break; }
    }
    if (found < 0) {
        // 差が大きすぎる：粗く「全部消して全部足した」
        return [
            ...range(a0, a1).map((a) => ({ op: 'del', a }) as SeqOp),
            ...range(b0, b1).map((b) => ({ op: 'ins', b }) as SeqOp),
        ];
    }
    // 経路を逆にたどる。trace[d] は d 手目を始める前の v（k は -d-1..d+1 を 0.. に詰めて保存）
    const ops: SeqOp[] = [];
    let x = n;
    let y = m;
    for (let d = found; d >= 0; d--) {
        const tv = trace[d];
        const get = (k: number) => tv[k + d + 1];
        const k = x - y;
        let prevK: number;
        if (d === 0) {
            prevK = 0;
        } else if (k === -d || (k !== d && get(k - 1) < get(k + 1))) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = d === 0 ? 0 : get(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            x--; y--;
            ops.push({ op: 'eq', a: a0 + x, b: b0 + y });
        }
        if (d > 0) {
            if (x === prevX) { y--; ops.push({ op: 'ins', b: b0 + y }); } else { x--; ops.push({ op: 'del', a: a0 + x }); }
        }
    }
    return ops.reverse();
}

function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i < to; i++) { out.push(i); }
    return out;
}

export type PairedOp =
    | { op: 'eq'; a: number; b: number }
    | { op: 'mod'; a: number; b: number }
    | { op: 'del'; a: number }
    | { op: 'ins'; b: number };

/**
 * 隣り合う削除の並びと追加の並びを組にする。similar が与えられれば、似ているものだけを組にする
 * （似ていなければ削除・追加のまま）。与えられなければ前から順に組にする
 */
export function pairRuns(ops: readonly SeqOp[], similar?: (a: number, b: number) => boolean): PairedOp[] {
    const out: PairedOp[] = [];
    let i = 0;
    while (i < ops.length) {
        const o = ops[i];
        if (o.op === 'eq') { out.push(o); i++; continue; }
        const dels: number[] = [];
        const inss: number[] = [];
        while (i < ops.length && ops[i].op !== 'eq') {
            const p = ops[i];
            if (p.op === 'del') { dels.push(p.a); } else if (p.op === 'ins') { inss.push(p.b); }
            i++;
        }
        if (!similar) {
            const k = Math.min(dels.length, inss.length);
            for (let j = 0; j < k; j++) { out.push({ op: 'mod', a: dels[j], b: inss[j] }); }
            for (let j = k; j < dels.length; j++) { out.push({ op: 'del', a: dels[j] }); }
            for (let j = k; j < inss.length; j++) { out.push({ op: 'ins', b: inss[j] }); }
            continue;
        }
        // 順序を保ったまま、似ているものを貪欲に組にする
        let bi = 0;
        for (const a of dels) {
            let matched = -1;
            for (let j = bi; j < inss.length && j < bi + 8; j++) {
                if (similar(a, inss[j])) { matched = j; break; }
            }
            if (matched < 0) { out.push({ op: 'del', a }); continue; }
            for (let j = bi; j < matched; j++) { out.push({ op: 'ins', b: inss[j] }); }
            out.push({ op: 'mod', a, b: inss[matched] });
            bi = matched + 1;
        }
        for (let j = bi; j < inss.length; j++) { out.push({ op: 'ins', b: inss[j] }); }
    }
    return out;
}

export interface InlinePiece { op: 'eq' | 'ins' | 'del'; text: string }

/** 2 つの文字列の語単位の差分。同じ op の隣り合う部分はつなぐ */
export function diffInline(oldText: string, newText: string): InlinePiece[] {
    const a = splitWords(oldText);
    const b = splitWords(newText);
    const ops = diffSequences(a, b, 2000);
    const out: InlinePiece[] = [];
    const push = (op: InlinePiece['op'], text: string) => {
        const last = out[out.length - 1];
        if (last && last.op === op) { last.text += text; } else { out.push({ op, text }); }
    };
    // 削除を先、追加を後にまとめると読みやすい（同じ変更の並びの中で）
    let pendDel = '';
    let pendIns = '';
    const flush = () => {
        if (pendDel) { push('del', pendDel); pendDel = ''; }
        if (pendIns) { push('ins', pendIns); pendIns = ''; }
    };
    for (const o of ops) {
        if (o.op === 'eq') { flush(); push('eq', a[o.a]); } else if (o.op === 'del') { pendDel += a[o.a]; } else { pendIns += b[o.b]; }
    }
    flush();
    return out;
}

/** 日本語の文字は 1 文字ずつ、英数字は語ごと */
function splitWords(s: string): string[] {
    const out: string[] = [];
    const re = /[A-Za-z0-9_À-ɏ]+|\s+|[\s\S]/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) { out.push(m[0]); }
    return out;
}

/** 2 つの文字列がどれだけ似ているか（0〜1。共通の語の割合）。組にするかの判定に使う */
export function similarity(oldText: string, newText: string): number {
    if (oldText === newText) { return 1; }
    if (!oldText || !newText) { return 0; }
    const a = splitWords(oldText);
    const b = splitWords(newText);
    if (a.length * b.length > 4_000_000) {
        // 大きすぎるときは語の集合で近似する
        const sa = new Set(a);
        let common = 0;
        for (const w of b) { if (sa.has(w)) { common++; } }
        return (2 * common) / (a.length + b.length);
    }
    const ops = diffSequences(a, b, 1000);
    const eq = ops.filter((o) => o.op === 'eq').length;
    return (2 * eq) / (a.length + b.length);
}
