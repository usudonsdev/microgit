/**
 * CSV・TSV の差分ドライバ（docs/structured-diff.md §3.3）。VS Code に依存しない。表として比べる（比べ方は table.ts）。
 * - 文字コード：BOM（UTF-8・UTF-16）があれば従う。無ければ UTF-8 として読み、壊れていれば Shift_JIS として読む
 *   （日本の Excel が書く CSV は Shift_JIS が多い）
 * - 区切り：拡張子 tsv・tab はタブ。csv は先頭の行で、カンマ・セミコロン・タブのうち最も多いもの
 * - RFC 4180 の引用（"..."、"" は " 1 文字）。改行を含むセルも読む
 * 値はすべて文字列として比べる（型は推測しない）。
 */
import { diffGrids, cellKey, Grid } from './table';
import { CellSnapshot, DiffContext, DiffDriver, DiffInput, DiffLimitError, TableDiff, baseOf, extOf } from './types';

export function decodeText(b: Buffer): string {
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { return b.subarray(3).toString('utf8'); }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { return new TextDecoder('utf-16le').decode(b.subarray(2)); }
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { return new TextDecoder('utf-16be').decode(b.subarray(2)); }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
        try { return new TextDecoder('shift_jis').decode(b); } catch { return b.toString('latin1'); }
    }
}

export function detectDelimiter(path: string, text: string): string {
    const ext = extOf(path);
    if (ext === 'tsv' || ext === 'tab') { return '\t'; }
    const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** CSV を行の配列に */
export function parseCsv(text: string, delim: string, maxCells: number): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let i = 0;
    let inQ = false;
    let cells = 0;
    const endField = () => {
        row.push(field);
        field = '';
        if (++cells > maxCells) { throw new DiffLimitError(`セルが多すぎる（上限 ${maxCells}）`); }
    };
    while (i < text.length) {
        const ch = text[i];
        if (inQ) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQ = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if (ch === '"' && field === '') { inQ = true; i++; continue; }
        if (ch === delim) {
            endField();
            // Excel と同じ列の上限。セルの鍵（行 × 20000 + 列）がぶつからないように（レビュー #2）
            if (row.length >= 16_384) { throw new DiffLimitError('列が多すぎる（上限 16384）'); }
            i++;
            continue;
        }
        if (ch === '\r' || ch === '\n') {
            endField();
            rows.push(row);
            row = [];
            if (ch === '\r' && text[i + 1] === '\n') { i++; }
            i++;
            continue;
        }
        field += ch; i++;
    }
    if (field !== '' || row.length > 0) { endField(); rows.push(row); }
    return rows;
}

function toGrid(rows: string[][]): Grid {
    const cells = new Map<number, CellSnapshot>();
    let cols = 0;
    rows.forEach((r, ri) => {
        r.forEach((v, ci) => {
            if (v !== '') { cells.set(cellKey(ri + 1, ci + 1), { v, t: 's' }); cols = Math.max(cols, ci + 1); }
        });
    });
    return { rows: rows.length, cols, cells };
}

export const csvDriver: DiffDriver = {
    id: 'csv',
    version: 1,
    label: 'CSV',
    matches: (path) => ['csv', 'tsv', 'tab'].includes(extOf(path)),
    async diff(input: DiffInput, ctx: DiffContext): Promise<TableDiff> {
        const base = baseOf(csvDriver, input);
        const read = (b?: Buffer) => {
            if (!b) { return { rows: 0, cols: 0, cells: new Map() } as Grid; }
            const text = decodeText(b);
            return toGrid(parseCsv(text, detectDelimiter(input.path, text), ctx.limits.maxCells));
        };
        const og = read(input.oldBytes);
        const ng = read(input.newBytes);
        const d = diffGrids(og, ng, ctx.limits.maxChanges);
        const { changed, ...rest } = d;
        const name = input.path.split('/').pop() ?? input.path;
        const isAddDel = base.status !== 'modified';
        const sheet = {
            name,
            status: (base.status === 'added' ? 'added' : base.status === 'deleted' ? 'deleted' : changed ? 'modified' : 'unchanged') as 'added' | 'deleted' | 'modified' | 'unchanged',
            oldIndex: input.oldBytes ? 0 : undefined,
            newIndex: input.newBytes ? 0 : undefined,
            ...rest,
            rowOps: isAddDel ? [] : rest.rowOps,
            colOps: isAddDel ? [] : rest.colOps,
        };
        const ins = rest.rowOps.filter((o) => o.type === 'insert').reduce((a, o) => a + o.count, 0);
        const del = rest.rowOps.filter((o) => o.type === 'delete').reduce((a, o) => a + o.count, 0);
        const edits = rest.cells.filter((c) => c.oldRef && c.newRef).length;
        const bits: string[] = [];
        if (ins) { bits.push(`${ins} 行追加`); }
        if (del) { bits.push(`${del} 行削除`); }
        const cins = rest.colOps.filter((o) => o.type === 'insert').reduce((a, o) => a + o.count, 0);
        const cdel = rest.colOps.filter((o) => o.type === 'delete').reduce((a, o) => a + o.count, 0);
        if (cins) { bits.push(`${cins} 列追加`); }
        if (cdel) { bits.push(`${cdel} 列削除`); }
        if (edits) { bits.push(`${edits} セル変更`); }
        const summary = base.status === 'added' ? `追加（${ng.rows} 行）` : base.status === 'deleted' ? `削除（${og.rows} 行）`
            : bits.length ? bits.join('、') : '変更なし（値は同じ）';
        const status = base.status === 'modified' && !changed ? 'unchanged' : base.status;
        return {
            ...base, kind: 'table', status, summary, sheets: [sheet],
            truncated: rest.truncated, warnings: rest.truncated ? [`変更が多いので、最初の ${ctx.limits.maxChanges} 件だけ表示している`] : [],
        };
    },
};
