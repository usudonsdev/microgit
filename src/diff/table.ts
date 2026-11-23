/**
 * 表（シート）どうしの差分。xlsx と csv が共通で使う。VS Code に依存しない。
 *
 * 手順（docs/structured-diff.md §3.1.1）：
 * 1. 行の対応づけ：行ごとの指紋（その行のセルの中身）の列を LCS で比べる。削除と追加が隣り合えば「同じ行の変更」として組にする
 * 2. 列の対応づけ：対応した行だけを使って、列ごとの指紋を LCS で比べる
 * 3. 列の挿入・削除があったら、対応した列だけで行の指紋を作り直して 1 と 2 をやり直す（列を挿入すると全行の指紋が変わるため）
 * 4. 対応した行と列の交わりでセルを比べる。式は、旧版の式の参照を新版の番地へ移してから比べる
 *    （行を挿入すると Excel は =A4 を =A5 に書き換える。それは利用者の変更ではないので、変更に数えない）
 * 引き受けること：同じ保存で行と列の両方を大量に挿入すると、対応づけが崩れて「全部変わった」に近くなることがある。
 * 保存ごとの記録なので、1 回の変更は小さいのがふつう、という前提に立つ。
 */
import { diffSequences, pairRuns, PairedOp } from './seq';
import { AxisOp, CellChange, CellSnapshot, SheetDiff } from './types';

/** シートの中身。cells のキーは cellKey(行, 列)（どちらも 1 始まり） */
export interface Grid {
    rows: number;
    cols: number;
    cells: Map<number, CellSnapshot>;
    /** 書式の比較用の指紋（cellKey → 指紋）。無ければ書式は比べない */
    styleSig?: Map<number, string>;
    /** 書式の指紋を、比べる観点ごとに分けたもの（指紋 → 観点ごとの値） */
    styleAspects?: (sig: string) => Record<string, string>;
    merges?: string[];
}

const COL_FACTOR = 20000; // 列の最大は 16384

export function cellKey(r: number, c: number): number { return r * COL_FACTOR + c; }
export function keyRow(k: number): number { return Math.floor(k / COL_FACTOR); }
export function keyCol(k: number): number { return k % COL_FACTOR; }

/** 列の番号（1 始まり）→ 英字（A、B、…、AA） */
export function colName(c: number): string {
    let s = '';
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
}

export function colIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) { n = n * 26 + (ch.charCodeAt(0) - 64); }
    return n;
}

export function a1(r: number, c: number): string { return `${colName(c)}${r}`; }

/** 番地（A1、$B$3）を行と列に。読めなければ undefined */
export function parseA1(ref: string): { r: number; c: number } | undefined {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
    if (!m) { return undefined; }
    return { r: parseInt(m[2], 10), c: colIndex(m[1]) };
}

/**
 * 式の中のセル参照（シート名の付かないもの、または sheetName の付いたもの）を、mapRef で書き換える。
 * 文字列の中（"..."）は触らない。関数名（LOG10( など）・名前の定義は参照として扱わない。
 * mapRef が undefined を返したら #REF! にする
 */
export function rewriteRefs(
    formula: string,
    mapRef: (r: number, c: number, absR: boolean, absC: boolean) => { r: number; c: number } | undefined,
    sheetName?: string,
): string {
    let out = '';
    let i = 0;
    while (i < formula.length) {
        const ch = formula[i];
        if (ch === '"') {
            const end = findStringEnd(formula, i);
            out += formula.slice(i, end);
            i = end;
            continue;
        }
        const rest = formula.slice(i);
        const prev = i > 0 ? formula[i - 1] : '';
        const m = /^((?:'(?:[^']|'')+'|[A-Za-z0-9_.\u0080-￿]+)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(.!])/.exec(rest);
        if (m && !/[A-Za-z0-9_.$\u0080-￿]/.test(prev)) {
            const qual = m[1];
            const qualName = qual ? qual.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : undefined;
            const own = !qual || (sheetName !== undefined && qualName === sheetName);
            if (own) {
                const r = parseInt(m[5], 10);
                const c = colIndex(m[3]);
                const mapped = mapRef(r, c, m[4] === '$', m[2] === '$');
                out += (qual ?? '') + (mapped ? `${m[2]}${colName(mapped.c)}${m[4]}${mapped.r}` : '#REF!');
            } else {
                out += m[0];
            }
            i += m[0].length;
            continue;
        }
        // 識別子（関数名・名前）はまとめて読み飛ばす（途中から参照として読まないため）
        const id = /^[A-Za-z_\u0080-￿][A-Za-z0-9_.\u0080-￿]*/.exec(rest);
        if (id && !/[A-Za-z0-9_.$]/.test(prev)) {
            out += id[0];
            i += id[0].length;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function findStringEnd(s: string, start: number): number {
    let j = start + 1;
    while (j < s.length) {
        if (s[j] === '"') {
            if (s[j + 1] === '"') { j += 2; continue; }
            return j + 1;
        }
        j++;
    }
    return s.length;
}

/** 共有の式（t="shared"）を、基準のセルから (dr, dc) ずらしたセルの式にする。$ の付いた部分は動かさない */
export function shiftFormula(formula: string, dr: number, dc: number): string {
    return rewriteRefs(formula, (r, c, absR, absC) => {
        const nr = absR ? r : r + dr;
        const nc = absC ? c : c + dc;
        if (nr < 1 || nc < 1) { return undefined; }
        return { r: nr, c: nc };
    });
}

/** 対応づけた結果：旧の番号 → 新の番号（削除は undefined） */
interface AxisMap {
    ops: PairedOp[];
    oldToNew: Map<number, number>;
    newToOld: Map<number, number>;
}

function buildAxisMap(ops: PairedOp[]): AxisMap {
    const oldToNew = new Map<number, number>();
    const newToOld = new Map<number, number>();
    for (const o of ops) {
        if (o.op === 'eq' || o.op === 'mod') { oldToNew.set(o.a + 1, o.b + 1); newToOld.set(o.b + 1, o.a + 1); }
    }
    return { ops, oldToNew, newToOld };
}

/** 対応づけの範囲の外（使われている範囲より後ろ）の番号は、最後の差でずらす */
function mapIndex(m: AxisMap, oldLen: number, newLen: number, i: number): number | undefined {
    if (i > oldLen) { return i + (newLen - oldLen); }
    return m.oldToNew.get(i);
}

function cellText(c: CellSnapshot | undefined): string {
    if (!c) { return ''; }
    return `${c.t ?? ''}\u0001${c.v ?? ''}\u0001${c.f ?? ''}`;
}

/** 行の指紋。cols が与えられれば、その列だけを、その順で使う（列の対応づけのあと） */
function rowKeys(g: Grid, cols?: number[]): string[] {
    const byRow: Map<number, [number, string][]> = new Map();
    for (const [k, v] of g.cells) {
        const r = keyRow(k);
        let list = byRow.get(r);
        if (!list) { list = []; byRow.set(r, list); }
        list.push([keyCol(k), relCellText(v, r, keyCol(k))]);
    }
    const out: string[] = [];
    const colPos = cols ? new Map(cols.map((c, i) => [c, i])) : undefined;
    for (let r = 1; r <= g.rows; r++) {
        const list = byRow.get(r);
        if (!list) { out.push(''); continue; }
        const parts: string[] = [];
        for (const [c, t] of list.sort((x, y) => x[0] - y[0])) {
            if (colPos) {
                const p = colPos.get(c);
                if (p === undefined) { continue; }
                parts.push(`${p}\u0002${t}`);
            } else {
                parts.push(`${c}\u0002${t}`);
            }
        }
        out.push(parts.join('\u0003'));
    }
    return out;
}

/** 列の指紋。rows は使う行（旧版なら旧の番号、新版なら新の番号）を、対応の順に並べたもの */
function colKeys(g: Grid, rows: number[]): string[] {
    const pos = new Map(rows.map((r, i) => [r, i]));
    const byCol: Map<number, [number, string][]> = new Map();
    for (const [k, v] of g.cells) {
        const p = pos.get(keyRow(k));
        if (p === undefined) { continue; }
        const c = keyCol(k);
        let list = byCol.get(c);
        if (!list) { list = []; byCol.set(c, list); }
        list.push([p, relCellText(v, keyRow(k), c)]);
    }
    const out: string[] = [];
    for (let c = 1; c <= g.cols; c++) {
        const list = byCol.get(c);
        out.push(list ? list.sort((x, y) => x[0] - y[0]).map(([p, t]) => `${p}\u0002${t}`).join('\u0003') : '');
    }
    return out;
}

/**
 * 指紋に使うセルの文字列。式は相対の形（R[-1]C[0] のような、そのセルからの差）にして、行・列がずれても同じ指紋にする
 */
function relCellText(c: CellSnapshot, r: number, col: number): string {
    if (!c.f) { return cellText(c); }
    const rel = rewriteRefs(c.f, (rr, cc, absR, absC) => ({ r: absR ? rr : rr - r + 1_000_000, c: absC ? cc : cc - col + 10_000 }));
    return `${c.t ?? ''}\u0001\u0001${rel}`;
}

function axisOpsOf(ops: PairedOp[]): AxisOp[] {
    const out: AxisOp[] = [];
    for (const o of ops) {
        if (o.op === 'ins') {
            const at = o.b + 1;
            const last = out[out.length - 1];
            if (last && last.type === 'insert' && last.at + last.count === at) { last.count++; } else { out.push({ type: 'insert', at, count: 1 }); }
        } else if (o.op === 'del') {
            const at = o.a + 1;
            const last = out[out.length - 1];
            if (last && last.type === 'delete' && last.at + last.count === at) { last.count++; } else { out.push({ type: 'delete', at, count: 1 }); }
        }
    }
    return out;
}

/** 似ている行・列だけを組にする（全部違う行どうしを「変更」にしない）。指紋を区切りで分け、共通の部分の割合で見る */
function similarKeys(a: string[], b: string[]): (i: number, j: number) => boolean {
    return (i, j) => {
        const x = a[i];
        const y = b[j];
        if (x === y) { return true; }
        if (!x || !y) { return true; } // 空の行と中身のある行：位置が同じなら同じ行の変更とみなす
        const sx = new Set(x.split('\u0003'));
        const ys = y.split('\u0003');
        let common = 0;
        for (const p of ys) { if (sx.has(p)) { common++; } }
        return common * 2 >= Math.min(sx.size, ys.length); // 半分以上同じ
    };
}

function alignAxis(a: string[], b: string[]): PairedOp[] {
    const ops = diffSequences(a, b, 3000);
    return pairRuns(ops, similarKeys(a, b));
}

/** 2 つの表の差分。limit を超えたセルの変更は打ち切る */
export function diffGrids(oldG: Grid, newG: Grid, maxChanges: number, sheetName?: string): Omit<SheetDiff, 'name' | 'status'> & { changed: boolean } {
    // 行を先に対応づける順と、列を先にする順の両方を試し、同じと分かったセルが多いほうを使う
    // （列を挿入すると全行の指紋が変わり、行を挿入すると全列の指紋が変わるため、どちらが先がよいかは変更しだい）
    const a = alignRowsFirst(oldG, newG);
    const b = alignColsFirst(oldG, newG);
    const best = matchScore(oldG, newG, b.rowOps, b.colOps) > matchScore(oldG, newG, a.rowOps, a.colOps) ? b : a;
    const { rowOps, colOps } = best;
    const rowMap = buildAxisMap(rowOps);
    const colMap = buildAxisMap(colOps);

    const mapOldRef = (r: number, c: number) => {
        const nr = mapIndex(rowMap, oldG.rows, newG.rows, r);
        const nc = mapIndex(colMap, oldG.cols, newG.cols, c);
        return nr === undefined || nc === undefined ? undefined : { r: nr, c: nc };
    };

    const changes: CellChange[] = [];
    let total = 0;
    const push = (c: CellChange) => { total++; if (changes.length < maxChanges) { changes.push(c); } };
    const seenNew = new Set<number>();
    for (const [k, oc] of oldG.cells) {
        const r = keyRow(k);
        const c = keyCol(k);
        const nr = rowMap.oldToNew.get(r);
        const nc = colMap.oldToNew.get(c);
        if (nr === undefined || nc === undefined) {
            // 行か列ごと削除された。行・列の削除として表示するが、何が消えたかも残す
            if (!isEmptyCell(oc)) { push({ oldRef: a1(r, c), change: 'removed', old: oc }); }
            continue;
        }
        const nk = cellKey(nr, nc);
        seenNew.add(nk);
        const ncell = newG.cells.get(nk);
        const ch = compareCells(oc, ncell, oldG, newG, k, nk, mapOldRef, sheetName);
        if (ch) { push({ oldRef: a1(r, c), newRef: a1(nr, nc), ...ch }); }
    }
    for (const [k, nc] of newG.cells) {
        if (seenNew.has(k) || isEmptyCell(nc)) { continue; }
        const r = keyRow(k);
        const c = keyCol(k);
        const or = rowMap.newToOld.get(r);
        const oc = colMap.newToOld.get(c);
        push({ oldRef: or !== undefined && oc !== undefined ? a1(or, oc) : undefined, newRef: a1(r, c), change: 'added', new: nc });
    }
    changes.sort((x, y) => refOrder(x) - refOrder(y));

    // 結合セル：旧の範囲を新の番地へ移してから比べる
    const mapRange = (ref: string) => rewriteRefs(ref, (r, c) => mapOldRef(r, c));
    const oldMerges = new Set((oldG.merges ?? []).map(mapRange));
    const newMerges = new Set(newG.merges ?? []);
    const mergesAdded = [...newMerges].filter((m) => !oldMerges.has(m));
    const mergesRemoved = (oldG.merges ?? []).filter((m) => !newMerges.has(mapRange(m)));

    const rOps = axisOpsOf(rowOps);
    const cOps = axisOpsOf(colOps);
    const changed = total > 0 || rOps.length > 0 || cOps.length > 0 || mergesAdded.length > 0 || mergesRemoved.length > 0;
    return {
        rowOps: rOps,
        colOps: cOps,
        cells: changes,
        mergesAdded: mergesAdded.length ? mergesAdded : undefined,
        mergesRemoved: mergesRemoved.length ? mergesRemoved : undefined,
        newRows: newG.rows,
        newCols: newG.cols,
        truncated: total > changes.length ? true : undefined,
        changed,
    };
}

function pairedOf(ops: PairedOp[]): { a: number[]; b: number[] } {
    const eq = ops.filter((o) => o.op === 'eq') as { a: number; b: number }[];
    const use = eq.length >= 1 ? eq : (ops.filter((o) => o.op === 'mod') as { a: number; b: number }[]);
    return { a: use.map((o) => o.a + 1), b: use.map((o) => o.b + 1) };
}

function matchedOf(ops: PairedOp[]): { a: number[]; b: number[] } {
    const m = ops.filter((o) => o.op === 'eq' || o.op === 'mod') as { a: number; b: number }[];
    return { a: m.map((o) => o.a + 1), b: m.map((o) => o.b + 1) };
}

function identity(n: number): number[] { return Array.from({ length: n }, (_, i) => i + 1); }

/** 行 → 列 →（列の挿入・削除があれば）行 → 列 */
function alignRowsFirst(oldG: Grid, newG: Grid): { rowOps: PairedOp[]; colOps: PairedOp[] } {
    let rowOps = alignAxis(rowKeys(oldG), rowKeys(newG));
    let pr = pairedOf(rowOps);
    let colOps = alignAxis(colKeys(oldG, pr.a), colKeys(newG, pr.b));
    if (colOps.some((o) => o.op === 'ins' || o.op === 'del')) {
        const pc = matchedOf(colOps);
        rowOps = alignAxis(rowKeys(oldG, pc.a), rowKeys(newG, pc.b));
        pr = pairedOf(rowOps);
        colOps = alignAxis(colKeys(oldG, pr.a), colKeys(newG, pr.b));
    }
    return { rowOps, colOps };
}

/** 列（行はそのままの番号で）→ 行 → 列 */
function alignColsFirst(oldG: Grid, newG: Grid): { rowOps: PairedOp[]; colOps: PairedOp[] } {
    let colOps = alignAxis(colKeys(oldG, identity(oldG.rows)), colKeys(newG, identity(newG.rows)));
    const pc = pairedOf(colOps);
    const rowOps = alignAxis(rowKeys(oldG, pc.a), rowKeys(newG, pc.b));
    const pr = pairedOf(rowOps);
    colOps = alignAxis(colKeys(oldG, pr.a), colKeys(newG, pr.b));
    return { rowOps, colOps };
}

/** 対応づけの良さ：対応した行と列の交わりで、中身が同じセルの数 */
function matchScore(oldG: Grid, newG: Grid, rowOps: PairedOp[], colOps: PairedOp[]): number {
    const rm = buildAxisMap(rowOps);
    const cm = buildAxisMap(colOps);
    let n = 0;
    for (const [k, oc] of oldG.cells) {
        const nr = rm.oldToNew.get(keyRow(k));
        const nc = cm.oldToNew.get(keyCol(k));
        if (nr === undefined || nc === undefined) { continue; }
        const ncell = newG.cells.get(cellKey(nr, nc));
        if (ncell && ncell.v === oc.v && relCellText(ncell, nr, nc) === relCellText(oc, keyRow(k), keyCol(k))) { n++; }
    }
    return n;
}

function refOrder(c: CellChange): number {
    const p = parseA1(c.newRef ?? c.oldRef ?? 'A1');
    return p ? cellKey(p.r, p.c) : 0;
}

function isEmptyCell(c: CellSnapshot | undefined): boolean {
    return !c || ((c.v === undefined || c.v === '') && !c.f);
}

function compareCells(
    oc: CellSnapshot,
    nc: CellSnapshot | undefined,
    oldG: Grid,
    newG: Grid,
    ok: number,
    nk: number,
    mapOldRef: (r: number, c: number) => { r: number; c: number } | undefined,
    sheetName: string | undefined,
): Pick<CellChange, 'change' | 'old' | 'new' | 'styleAspects'> | undefined {
    const oEmpty = isEmptyCell(oc);
    const nEmpty = isEmptyCell(nc);
    if (oEmpty && nEmpty) { return styleChange(oc, nc, oldG, newG, ok, nk); }
    if (oEmpty) { return { change: 'added', old: oc, new: nc }; }
    if (nEmpty) { return { change: 'removed', old: oc, new: nc }; }
    const n = nc!;
    if (oc.f || n.f) {
        if (!oc.f || !n.f) { return { change: 'formula', old: oc, new: n }; }
        const moved = rewriteRefs(oc.f, mapOldRef, sheetName);
        if (normFormula(moved) !== normFormula(n.f)) { return { change: 'formula', old: oc, new: n }; }
        if ((oc.v ?? '') !== (n.v ?? '') || (oc.t ?? '') !== (n.t ?? '')) { return { change: 'computed', old: oc, new: n }; }
        return styleChange(oc, n, oldG, newG, ok, nk);
    }
    if ((oc.v ?? '') !== (n.v ?? '') || (oc.t ?? 'n') !== (n.t ?? 'n')) { return { change: 'value', old: oc, new: n }; }
    return styleChange(oc, n, oldG, newG, ok, nk);
}

function normFormula(f: string): string {
    return f.replace(/\s+/g, '').toUpperCase();
}

function styleChange(
    oc: CellSnapshot | undefined,
    nc: CellSnapshot | undefined,
    oldG: Grid,
    newG: Grid,
    ok: number,
    nk: number,
): Pick<CellChange, 'change' | 'old' | 'new' | 'styleAspects'> | undefined {
    if (!oldG.styleSig || !newG.styleSig) { return undefined; }
    const a = oldG.styleSig.get(ok) ?? '';
    const b = newG.styleSig.get(nk) ?? '';
    if (a === b) { return undefined; }
    const aa = a && oldG.styleAspects ? oldG.styleAspects(a) : {};
    const bb = b && newG.styleAspects ? newG.styleAspects(b) : {};
    const names = new Set([...Object.keys(aa), ...Object.keys(bb)]);
    const aspects = [...names].filter((n) => (aa[n] ?? '') !== (bb[n] ?? ''));
    if (aspects.length === 0) { return undefined; }
    return { change: 'style', old: oc, new: nc, styleAspects: aspects };
}
