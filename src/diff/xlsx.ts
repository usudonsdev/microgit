/**
 * Excel ブック（xlsx・xlsm）の差分ドライバ（docs/structured-diff.md §3.1）。VS Code に依存しない。
 *
 * 読むもの：ブック（xl/workbook.xml：シートの名前・順序・sheetId）、関係（xl/_rels/workbook.xml.rels）、
 * 共有文字列（xl/sharedStrings.xml）、書式（xl/styles.xml の cellXfs と、そこから参照する numFmt・font・fill・border）、
 * シート（xl/worksheets/*.xml のセル・式・結合セル）。比べ方は table.ts。
 * - シートは sheetId で対応づける（名前を変えても同じシート）。無ければ名前で
 * - 共有文字列は番号ではなく中身で比べる（番号は保存のたびに振り直されうる）
 * - 共有の式（t="shared"）は、セルごとの式に展開してから比べる
 * - 書式は番号ではなく、参照先の中身（数値の書式・フォント・塗りつぶし・罫線・配置）で比べる
 * シートの XML は大きくなりうるので、DOM にせず正規表現で走査する（セル・行・結合セルだけ）。
 * 解釈しない部品（グラフ・ピボット・条件付き書式・マクロなど）は otherParts に「変わった」とだけ出す。
 */
import { otherPartChanges, looksLikeZip, ZipReader } from './zip';
import { childrenNamed, decodeEntities, firstChild, parseRels, parseXml, serialize, textContent, XmlElement, localName, isElement } from './xml';
import { cellKey, diffGrids, Grid, shiftFormula, parseA1 } from './table';
import { CellSnapshot, DiffContext, DiffDriver, DiffInput, DiffLimitError, DiffFormatError, SheetDiff, TableDiff, baseOf, extOf } from './types';

interface SheetInfo { name: string; sheetId: string; part: string; index: number; state?: string }

interface Book {
    zip: ZipReader;
    sheets: SheetInfo[];
    known: Set<string>;
    styleSigs: string[];
    styleAspects: Map<string, Record<string, string>>;
    numFmts: string[];
    shared: string[];
}

const BUILTIN_NUMFMT: Record<number, string> = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'yyyy/m/d', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy/m/d h:mm',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

function readBook(buf: Buffer, ctx: DiffContext): Book {
    const zip = new ZipReader(buf, ctx.limits);
    const known = new Set<string>(['[Content_Types].xml', '_rels/.rels']);
    // ブックの部品の場所（ふつうは xl/workbook.xml）
    let wbPart = 'xl/workbook.xml';
    const rootRels = parseRels(zip.readText('_rels/.rels'), '');
    for (const r of rootRels.values()) {
        if (/officeDocument$/.test(r.type) && !r.external) { wbPart = r.target; }
    }
    const wbXml = zip.readText(wbPart);
    if (!wbXml) { throw new DiffFormatError('ブック（workbook.xml）が無い。xlsx ではないか、壊れている'); }
    known.add(wbPart);
    const wbDir = wbPart.includes('/') ? wbPart.slice(0, wbPart.lastIndexOf('/')) : '';
    const relsPart = `${wbDir ? wbDir + '/' : ''}_rels/${wbPart.split('/').pop()}.rels`;
    known.add(relsPart);
    const rels = parseRels(zip.readText(relsPart), wbDir);
    const wb = parseXml(wbXml);
    const sheetsEl = firstChild(wb, 'sheets');
    const sheets: SheetInfo[] = [];
    for (const s of sheetsEl ? childrenNamed(sheetsEl, 'sheet') : []) {
        const rid = Object.entries(s.attrs).find(([k]) => localName(k) === 'id' && k.includes(':'))?.[1];
        const rel = rid ? rels.get(rid) : undefined;
        if (!rel || rel.external || !/worksheet$/.test(rel.type)) { continue; } // グラフシートなどは otherParts へ
        sheets.push({ name: s.attrs.name ?? '', sheetId: s.attrs.sheetId ?? '', part: rel.target, index: sheets.length, state: s.attrs.state });
        known.add(rel.target);
    }

    // 共有文字列（ふりがな rPh は外す）
    const shared: string[] = [];
    for (const r of rels.values()) {
        if (/sharedStrings$/.test(r.type)) {
            known.add(r.target);
            const xml = zip.readText(r.target);
            if (xml) {
                const sst = parseXml(xml);
                for (const si of childrenNamed(sst, 'si')) { shared.push(siText(si)); }
            }
        }
    }

    // 書式
    const styleSigs: string[] = [];
    const styleAspects = new Map<string, Record<string, string>>();
    const numFmts: string[] = [];
    for (const r of rels.values()) {
        if (!/styles$/.test(r.type)) { continue; }
        known.add(r.target);
        const xml = zip.readText(r.target);
        if (!xml) { continue; }
        const st = parseXml(xml);
        const custom = new Map<number, string>();
        const nf = firstChild(st, 'numFmts');
        for (const f of nf ? childrenNamed(nf, 'numFmt') : []) { custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? ''); }
        const list = (parent: string, child: string) => {
            const p = firstChild(st, parent);
            return p ? childrenNamed(p, child).map((e) => serialize(e)) : [];
        };
        const fonts = list('fonts', 'font');
        const fills = list('fills', 'fill');
        const borders = list('borders', 'border');
        const xfs = firstChild(st, 'cellXfs');
        for (const xf of xfs ? childrenNamed(xfs, 'xf') : []) {
            const id = Number(xf.attrs.numFmtId ?? 0);
            const fmt = custom.get(id) ?? BUILTIN_NUMFMT[id] ?? `#${id}`;
            const align = firstChild(xf, 'alignment');
            const prot = firstChild(xf, 'protection');
            const aspects: Record<string, string> = {
                '数値の書式': fmt,
                'フォント': fonts[Number(xf.attrs.fontId ?? 0)] ?? '',
                '塗りつぶし': fills[Number(xf.attrs.fillId ?? 0)] ?? '',
                '罫線': borders[Number(xf.attrs.borderId ?? 0)] ?? '',
                '配置': align ? serialize(align) : '',
                '保護': prot ? serialize(prot) : '',
            };
            const sig = JSON.stringify(aspects);
            styleSigs.push(sig);
            numFmts.push(fmt);
            styleAspects.set(sig, aspects);
        }
    }
    return { zip, sheets, known, styleSigs, styleAspects, numFmts, shared };
}

function siText(si: XmlElement): string {
    let s = '';
    const stack = [...si.children].reverse();
    while (stack.length) {
        const c = stack.pop()!;
        if (typeof c === 'string') { continue; }
        const ln = localName(c.name);
        if (ln === 'rPh' || ln === 'phoneticPr') { continue; }
        if (ln === 't') { s += textContent(c); continue; }
        for (let k = c.children.length - 1; k >= 0; k--) { if (isElement(c.children[k])) { stack.push(c.children[k]); } }
    }
    return s;
}

const RE_ROW = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const RE_CELL = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const RE_F = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/;
const RE_V = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/;
const RE_IS = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/;
const RE_T = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
const RE_MERGE = /<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*"([^"]+)"/g;

function attr(s: string, name: string): string | undefined {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(s);
    return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

/** シートの XML を表にする */
function readSheet(book: Book, part: string, ctx: DiffContext, budget: { cells: number }): Grid {
    const xml = book.zip.readText(part) ?? '';
    const cells = new Map<number, CellSnapshot>();
    const styleSig = new Map<number, string>();
    const sharedF = new Map<string, { f: string; r: number; c: number }>();
    let rows = 0;
    let cols = 0;
    let rowNo = 0;
    const sd = /<(?:\w+:)?sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?sheetData>)/.exec(xml);
    const data = sd?.[1] ?? '';
    RE_ROW.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RE_ROW.exec(data))) {
        const rAttr = attr(rm[1], 'r');
        rowNo = rAttr ? parseInt(rAttr, 10) : rowNo + 1;
        const body = rm[2] ?? '';
        let colNo = 0;
        RE_CELL.lastIndex = 0;
        let cm: RegExpExecArray | null;
        while ((cm = RE_CELL.exec(body))) {
            const ref = attr(cm[1], 'r');
            const pos = ref ? parseA1(ref) : undefined;
            const r = pos?.r ?? rowNo;
            const c = pos?.c ?? colNo + 1;
            colNo = c;
            if (--budget.cells < 0) { throw new DiffLimitError(`セルが多すぎる（上限 ${ctx.limits.maxCells}）`); }
            const t = attr(cm[1], 't') ?? 'n';
            const s = attr(cm[1], 's');
            const inner = cm[2] ?? '';
            const snap: CellSnapshot = { t };
            const fm = RE_F.exec(inner);
            if (fm) {
                const fAttrs = fm[1];
                let f = decodeEntities(fm[2] ?? '');
                const ft = attr(fAttrs, 't');
                const si = attr(fAttrs, 'si');
                if (ft === 'shared' && si !== undefined) {
                    if (f) { sharedF.set(si, { f, r, c }); } else {
                        const base = sharedF.get(si);
                        if (base) { f = shiftFormula(base.f, r - base.r, c - base.c); }
                    }
                }
                if (f) { snap.f = f; }
            }
            const vm = RE_V.exec(inner);
            if (t === 'inlineStr') {
                const im = RE_IS.exec(inner);
                if (im) {
                    let txt = '';
                    RE_T.lastIndex = 0;
                    let tm: RegExpExecArray | null;
                    while ((tm = RE_T.exec(im[1].replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')))) { txt += decodeEntities(tm[1]); }
                    snap.v = txt;
                }
                snap.t = 's';
            } else if (vm) {
                const raw = decodeEntities(vm[1]);
                if (t === 's') {
                    const idx = parseInt(raw, 10);
                    snap.v = book.shared[idx] ?? '';
                } else if (t === 'b') {
                    snap.v = raw === '1' ? 'TRUE' : 'FALSE';
                } else {
                    snap.v = raw;
                }
            }
            {
                // s が無いセルは既定の書式（cellXfs の 0 番）
                const si = s === undefined ? 0 : Number(s);
                const sig = book.styleSigs[si];
                const fmt = book.numFmts[si];
                if (sig) { styleSig.set(cellKey(r, c), sig); }
                if (fmt && fmt !== 'General') { snap.style = fmt; }
            }
            const empty = (snap.v === undefined || snap.v === '') && !snap.f;
            if (!empty || s !== undefined) {
                cells.set(cellKey(r, c), snap);
                if (!empty) { rows = Math.max(rows, r); cols = Math.max(cols, c); }
            }
        }
    }
    // 書式だけのセルは、値のあるセルの範囲の中だけ数える（範囲の外の書式だけのセルで表を広げない）
    for (const [k, v] of cells) {
        if ((v.v === undefined || v.v === '') && !v.f) {
            const r = Math.floor(k / 20000);
            const c = k % 20000;
            if (r > rows || c > cols) { cells.delete(k); styleSig.delete(k); }
        }
    }
    const merges: string[] = [];
    RE_MERGE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = RE_MERGE.exec(xml))) { merges.push(mm[1]); }
    return {
        rows,
        cols,
        cells,
        styleSig,
        styleAspects: (sig) => book.styleAspects.get(sig) ?? {},
        merges,
    };
}

function emptyGrid(): Grid { return { rows: 0, cols: 0, cells: new Map(), merges: [] }; }

export const xlsxDriver: DiffDriver = {
    id: 'xlsx',
    version: 1,
    label: 'Excel ブック',
    matches: (path, head) => ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(extOf(path)) && (head.length === 0 || looksLikeZip(head)),
    async diff(input: DiffInput, ctx: DiffContext): Promise<TableDiff> {
        const base = baseOf(xlsxDriver, input);
        const oldBook = input.oldBytes ? readBook(input.oldBytes, ctx) : undefined;
        const newBook = input.newBytes ? readBook(input.newBytes, ctx) : undefined;
        const budget = { cells: ctx.limits.maxCells };
        let remaining = ctx.limits.maxChanges;

        // シートの対応づけ：sheetId、無ければ名前
        const oldSheets = oldBook?.sheets ?? [];
        const newSheets = newBook?.sheets ?? [];
        const usedNew = new Set<SheetInfo>();
        const pairs: { o?: SheetInfo; n?: SheetInfo }[] = [];
        for (const o of oldSheets) {
            const n = newSheets.find((x) => !usedNew.has(x) && x.sheetId && x.sheetId === o.sheetId)
                ?? newSheets.find((x) => !usedNew.has(x) && x.name === o.name);
            if (n) { usedNew.add(n); }
            pairs.push({ o, n });
        }
        for (const n of newSheets) { if (!usedNew.has(n)) { pairs.push({ n }); } }
        pairs.sort((x, y) => (x.n?.index ?? (x.o!.index - 0.5)) - (y.n?.index ?? (y.o!.index - 0.5)));

        const sheets: SheetDiff[] = [];
        let truncated = false;
        for (const { o, n } of pairs) {
            const og = o && oldBook ? readSheet(oldBook, o.part, ctx, budget) : emptyGrid();
            const ng = n && newBook ? readSheet(newBook, n.part, ctx, budget) : emptyGrid();
            const d = diffGrids(og, ng, Math.max(0, remaining), n?.name ?? o?.name);
            remaining -= d.cells.length;
            if (d.truncated) { truncated = true; }
            const status: SheetDiff['status'] = !o ? 'added' : !n ? 'deleted'
                : o.name !== n.name ? 'renamed'
                : d.changed || o.index !== n.index ? 'modified' : 'unchanged';
            const { changed: _changed, ...rest } = d;
            sheets.push({
                name: n?.name ?? o!.name,
                oldName: o && n && o.name !== n.name ? o.name : undefined,
                status,
                oldIndex: o?.index,
                newIndex: n?.index,
                ...rest,
                // 追加・削除されたシートは、行の挿入・削除として出さない（シートごとの追加・削除で足りる）
                rowOps: !o || !n ? [] : rest.rowOps,
                colOps: !o || !n ? [] : rest.colOps,
            });
        }

        const otherParts = otherPartChanges(oldBook?.zip, newBook?.zip, (name) =>
            (oldBook?.known.has(name) ?? false) || (newBook?.known.has(name) ?? false) || /^docProps\//.test(name));
        const changedSheets = sheets.filter((s) => s.status !== 'unchanged');
        const summary = summarize(base.status, sheets, otherParts.length);
        const status = base.status === 'modified' && changedSheets.length === 0 && otherParts.length === 0 ? 'unchanged' : base.status;
        const warnings: string[] = [];
        if (truncated) { warnings.push(`変更が多いので、最初の ${ctx.limits.maxChanges} 件だけ表示している`); }
        const hidden = [...oldSheets, ...newSheets].filter((s) => s.state && s.state !== 'visible');
        if (hidden.length) { warnings.push(`非表示のシートがある：${[...new Set(hidden.map((s) => s.name))].join('、')}`); }
        return { ...base, kind: 'table', status, summary, sheets, otherParts: otherParts.length ? otherParts : undefined, warnings, truncated: truncated || undefined };
    },
};

function summarize(status: TableDiff['status'], sheets: SheetDiff[], others: number): string {
    if (status === 'added') { return `追加（シート ${sheets.length} 枚）`; }
    if (status === 'deleted') { return `削除（シート ${sheets.length} 枚）`; }
    const parts: string[] = [];
    for (const s of sheets) {
        if (s.status === 'added') { parts.push(`${s.name} を追加`); continue; }
        if (s.status === 'deleted') { parts.push(`${s.name} を削除`); continue; }
        const bits: string[] = [];
        if (s.status === 'renamed') { bits.push(`名前を変更（${s.oldName} → ${s.name}）`); }
        if (s.oldIndex !== s.newIndex) { bits.push('並びを変更'); }
        const ins = s.rowOps.filter((o) => o.type === 'insert').reduce((a, o) => a + o.count, 0);
        const del = s.rowOps.filter((o) => o.type === 'delete').reduce((a, o) => a + o.count, 0);
        const cins = s.colOps.filter((o) => o.type === 'insert').reduce((a, o) => a + o.count, 0);
        const cdel = s.colOps.filter((o) => o.type === 'delete').reduce((a, o) => a + o.count, 0);
        if (ins) { bits.push(`${ins} 行挿入`); }
        if (del) { bits.push(`${del} 行削除`); }
        if (cins) { bits.push(`${cins} 列挿入`); }
        if (cdel) { bits.push(`${cdel} 列削除`); }
        const inAxis = (c: { change: string }) => c.change === 'added' || c.change === 'removed';
        const edits = s.cells.filter((c) => !inAxis(c) || (c.oldRef && c.newRef)).length;
        if (edits) { bits.push(`${edits}${s.truncated ? ' 以上の' : ' '}セル`); }
        if (s.mergesAdded?.length || s.mergesRemoved?.length) { bits.push('結合セルを変更'); }
        if (bits.length) { parts.push(`${s.name}：${bits.join('、')}`); }
    }
    if (others) { parts.push(`その他の部品 ${others} 個`); }
    return parts.length ? parts.join(' / ') : '変更なし（値・式・書式は同じ）';
}

/** テスト用：シート 1 枚を表にして返す */
export function readSheetForTest(buf: Buffer, ctx: DiffContext, index = 0): Grid {
    const book = readBook(buf, ctx);
    return readSheet(book, book.sheets[index].part, ctx, { cells: ctx.limits.maxCells });
}
