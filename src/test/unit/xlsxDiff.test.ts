/**
 * Excel ブックと CSV の差分（xlsx.ts・csv.ts・table.ts）の単体テスト（docs/structured-diff.md §3.1）。
 * 見本の xlsx はテストの中で組み立てる（helpers/zipWriter.ts）。VS Code は使わない。
 * 観点：値・式・式の結果だけ・書式だけの変更を分ける。行・列の挿入で下のセルを「変わった」にしない。
 * 挿入で Excel が書き換えた式（=A4 → =A5）を変更に数えない。共有文字列の番号の振り直し・共有の式を正しく読む。
 * シートの追加・削除・改名・並べ替え。結合セル。解釈しない部品は otherParts。ZIP 爆弾とセルの上限。CSV の文字コードと引用。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { makeZip } from './helpers/zipWriter';
import { xlsxDriver } from '../../diff/xlsx';
import { csvDriver, parseCsv, decodeText } from '../../diff/csv';
import { rewriteRefs, shiftFormula } from '../../diff/table';
import { DEFAULT_LIMITS, DiffContext, DiffLimitError, TableDiff } from '../../diff/types';

const ctx: DiffContext = { limits: { ...DEFAULT_LIMITS }, tools: {}, tmpDir: '/tmp' };

type Cell = string | number | { f: string; v?: string | number; s?: number; shared?: { si: number; ref?: string } } | { v: string | number; s: number };
interface SheetSpec { name: string; id?: number; cells: Record<string, Cell>; merges?: string[]; state?: string }

/** 見本の xlsx を作る。文字列は共有文字列にする（order で並びを変えられる） */
function makeXlsx(sheets: SheetSpec[], opts: { reverseShared?: boolean; extra?: Record<string, string>; boldStyle?: boolean } = {}): Buffer {
    const strings: string[] = [];
    const idx = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
    // 先に全部の文字列を集める
    for (const sh of sheets) { for (const v of Object.values(sh.cells)) { if (typeof v === 'string') { idx(v); } } }
    if (opts.reverseShared) { strings.reverse(); }
    const files: Record<string, string> = {
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    };
    const rels: string[] = [];
    const sheetEls: string[] = [];
    sheets.forEach((sh, i) => {
        const id = sh.id ?? i + 1;
        rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`);
        sheetEls.push(`<sheet name="${sh.name}" sheetId="${id}" r:id="rId${i + 1}"${sh.state ? ` state="${sh.state}"` : ''}/>`);
        const byRow = new Map<number, string[]>();
        for (const [ref, v] of Object.entries(sh.cells)) {
            const r = parseInt(/\d+/.exec(ref)![0], 10);
            let xml: string;
            if (typeof v === 'string') { xml = `<c r="${ref}" t="s"><v>${strings.indexOf(v)}</v></c>`; }
            else if (typeof v === 'number') { xml = `<c r="${ref}"><v>${v}</v></c>`; }
            else if ('f' in v) {
                const fAttr = v.shared ? ` t="shared" si="${v.shared.si}"${v.shared.ref ? ` ref="${v.shared.ref}"` : ''}` : '';
                const fBody = v.f ? `<f${fAttr}>${v.f.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</f>` : `<f${fAttr}/>`;
                xml = `<c r="${ref}"${v.s !== undefined ? ` s="${v.s}"` : ''}>${fBody}${v.v !== undefined ? `<v>${v.v}</v>` : ''}</c>`;
            } else { xml = `<c r="${ref}" s="${v.s}"><v>${v.v}</v></c>`; }
            const list = byRow.get(r) ?? [];
            list.push(xml);
            byRow.set(r, list);
        }
        const rowsXml = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.join('')}</row>`).join('');
        const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
        files[`xl/worksheets/sheet${id}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="10"/></cols><sheetData>${rowsXml}</sheetData>${merges}</worksheet>`;
    });
    const n = sheets.length;
    rels.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
    rels.push(`<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
    files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEls.join('')}</sheets></workbook>`;
    files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
    files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
    // 書式：0 = 標準、1 = 太字、2 = 数値の書式 0.00、3 = 太字（opts.boldStyle なら 1 と同じ中身を別の番号で）
    files['xl/styles.xml'] = '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<fonts><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><fills><fill/></fills><borders><border/></borders>'
        + '<cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellXfs></styleSheet>';
    Object.assign(files, opts.extra ?? {});
    return makeZip(files);
}

async function diffXlsx(a: Buffer | undefined, b: Buffer | undefined): Promise<TableDiff> {
    return (await xlsxDriver.diff({ path: 'book.xlsx', oldBytes: a, newBytes: b }, ctx)) as TableDiff;
}

const base: SheetSpec = {
    name: 'Sheet1',
    cells: {
        A1: '品名', B1: '数量', C1: '単価', D1: '金額',
        A2: 'りんご', B2: 3, C2: 100, D2: { f: 'B2*C2', v: 300 },
        A3: 'みかん', B3: 5, C3: 80, D3: { f: 'B3*C3', v: 400 },
        A4: 'ぶどう', B4: 2, C4: 300, D4: { f: 'B4*C4', v: 600 },
        A5: '合計', D5: { f: 'SUM(D2:D4)', v: 1300 },
    },
};
const clone = (s: SheetSpec, patch: Record<string, Cell | undefined> = {}): SheetSpec => {
    const cells: Record<string, Cell> = { ...s.cells };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) { delete cells[k]; } else { cells[k] = v; } }
    return { ...s, cells };
};

describe('xlsx：セルの変更の種類', () => {
    it('同じ中身なら unchanged（共有文字列の番号が振り直されていても）', async () => {
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([base], { reverseShared: true }));
        assert.equal(d.status, 'unchanged');
        assert.equal(d.sheets[0].cells.length, 0);
    });
    it('値の変更・式の変更・式の結果だけの変更を分ける', async () => {
        const after = clone(base, {
            B2: 4, D2: { f: 'B2*C2', v: 400 }, // B2 の値を変え、D2 は結果だけ
            D3: { f: 'B3*C3*1.1', v: 440 }, // 式を変えた
            D5: { f: 'SUM(D2:D4)', v: 1440 },
        });
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        assert.equal(d.status, 'modified');
        const by = Object.fromEntries(d.sheets[0].cells.map((c) => [c.newRef, c]));
        assert.equal(by.B2.change, 'value');
        assert.equal(by.B2.old?.v, '3');
        assert.equal(by.B2.new?.v, '4');
        assert.equal(by.D2.change, 'computed');
        assert.equal(by.D3.change, 'formula');
        assert.equal(by.D3.new?.f, 'B3*C3*1.1');
        assert.equal(by.D5.change, 'computed');
        assert.equal(d.sheets[0].cells.length, 4);
        assert.match(d.summary, /Sheet1：4 セル/);
    });
    it('空のセルに入れた・消したは added / removed', async () => {
        const after = clone(base, { E2: '備考', A4: undefined });
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const by = Object.fromEntries(d.sheets[0].cells.map((c) => [c.newRef ?? c.oldRef, c.change]));
        assert.equal(by.E2, 'added');
        assert.equal(by.A4, 'removed');
    });
    it('書式だけの変更は style で、何が変わったかを出す。中身が同じ書式の番号の違いは変更にしない', async () => {
        const after = clone(base, { B2: { v: 3, s: 1 }, C2: { v: 100, s: 2 } });
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const by = Object.fromEntries(d.sheets[0].cells.map((c) => [c.newRef, c]));
        assert.equal(by.B2.change, 'style');
        assert.deepEqual(by.B2.styleAspects, ['フォント']);
        assert.equal(by.C2.change, 'style');
        assert.deepEqual(by.C2.styleAspects, ['数値の書式']);
        // 1 と 3 は同じ中身（太字）。番号だけ変えても変更にしない
        const a2 = clone(base, { B2: { v: 3, s: 1 } });
        const b2 = clone(base, { B2: { v: 3, s: 3 } });
        const d2 = await diffXlsx(makeXlsx([a2]), makeXlsx([b2]));
        assert.equal(d2.status, 'unchanged');
    });
});

describe('xlsx：行・列の挿入と削除', () => {
    it('行を挿入しても、下のセルと、Excel が書き換えた式を変更に数えない', async () => {
        // 3 行目の前に「もも」の行を挿入。下の行は 1 つずつ下がり、式の参照も Excel が書き換える
        const after: SheetSpec = {
            name: 'Sheet1',
            cells: {
                A1: '品名', B1: '数量', C1: '単価', D1: '金額',
                A2: 'りんご', B2: 3, C2: 100, D2: { f: 'B2*C2', v: 300 },
                A3: 'もも', B3: 1, C3: 250, D3: { f: 'B3*C3', v: 250 },
                A4: 'みかん', B4: 5, C4: 80, D4: { f: 'B4*C4', v: 400 },
                A5: 'ぶどう', B5: 2, C5: 300, D5: { f: 'B5*C5', v: 600 },
                A6: '合計', D6: { f: 'SUM(D2:D5)', v: 1550 },
            },
        };
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const s = d.sheets[0];
        assert.deepEqual(s.rowOps, [{ type: 'insert', at: 3, count: 1 }]);
        assert.deepEqual(s.colOps, []);
        // 挿入した行の 4 セル（added）と、合計の結果だけ。範囲の中に挿入すると Excel が SUM(D2:D4) を D2:D5 に広げる。
        // 旧の式の参照を新の番地へ移すと同じ D2:D5 になるので、式の変更ではなく結果だけの変更
        const edits = s.cells.map((c) => `${c.newRef}:${c.change}`).sort();
        assert.deepEqual(edits, ['A3:added', 'B3:added', 'C3:added', 'D3:added', 'D6:computed']);
        assert.match(d.summary, /1 行挿入/);
    });
    it('行の削除', async () => {
        const after: SheetSpec = {
            name: 'Sheet1',
            cells: {
                A1: '品名', B1: '数量', C1: '単価', D1: '金額',
                A2: 'りんご', B2: 3, C2: 100, D2: { f: 'B2*C2', v: 300 },
                A3: 'ぶどう', B3: 2, C3: 300, D3: { f: 'B3*C3', v: 600 },
                A4: '合計', D4: { f: 'SUM(D2:D3)', v: 900 },
            },
        };
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const s = d.sheets[0];
        assert.deepEqual(s.rowOps, [{ type: 'delete', at: 3, count: 1 }]);
        const edits = s.cells.filter((c) => c.change !== 'removed').map((c) => `${c.newRef}:${c.change}`);
        // SUM(D2:D4) は D4 が消えて Excel が D2:D3 に縮める。参照の移し替えでは D4（ぶどうの行）→ D3 なので同じ式になり、結果だけ変わる
        assert.deepEqual(edits, ['D4:computed']);
        assert.equal(s.cells.filter((c) => c.change === 'removed').length, 4);
    });
    it('列の挿入', async () => {
        const after: SheetSpec = {
            name: 'Sheet1',
            cells: {
                A1: '品名', B1: '産地', C1: '数量', D1: '単価', E1: '金額',
                A2: 'りんご', B2: '青森', C2: 3, D2: 100, E2: { f: 'C2*D2', v: 300 },
                A3: 'みかん', B3: '愛媛', C3: 5, D3: 80, E3: { f: 'C3*D3', v: 400 },
                A4: 'ぶどう', B4: '山梨', C4: 2, D4: 300, E4: { f: 'C4*D4', v: 600 },
                A5: '合計', E5: { f: 'SUM(E2:E4)', v: 1300 },
            },
        };
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const s = d.sheets[0];
        assert.deepEqual(s.colOps, [{ type: 'insert', at: 2, count: 1 }]);
        assert.deepEqual(s.rowOps, []);
        assert.deepEqual(s.cells.map((c) => `${c.newRef}:${c.change}`).sort(), ['B1:added', 'B2:added', 'B3:added', 'B4:added']);
    });
    it('挿入と同時に別のセルの値も変えたら、その変更は出る', async () => {
        const after: SheetSpec = {
            name: 'Sheet1',
            cells: {
                A1: '品名', B1: '数量', C1: '単価', D1: '金額',
                A2: 'りんご', B2: 3, C2: 100, D2: { f: 'B2*C2', v: 300 },
                A3: 'もも', B3: 1, C3: 250, D3: { f: 'B3*C3', v: 250 },
                A4: 'みかん', B4: 5, C4: 90, D4: { f: 'B4*C4', v: 450 },
                A5: 'ぶどう', B5: 2, C5: 300, D5: { f: 'B5*C5', v: 600 },
                A6: '合計', D6: { f: 'SUM(D2:D5)', v: 1600 },
            },
        };
        const d = await diffXlsx(makeXlsx([base]), makeXlsx([after]));
        const s = d.sheets[0];
        assert.deepEqual(s.rowOps, [{ type: 'insert', at: 3, count: 1 }]);
        const by = Object.fromEntries(s.cells.map((c) => [c.newRef, c]));
        assert.equal(by.C4.change, 'value');
        assert.equal(by.C4.oldRef, 'C3');
        assert.equal(by.D4.change, 'computed');
    });
});

describe('xlsx：シートとその他', () => {
    it('シートの追加・削除・改名・並べ替え', async () => {
        const s2: SheetSpec = { name: '集計', id: 2, cells: { A1: 'x' } };
        const s3: SheetSpec = { name: 'メモ', id: 3, cells: { A1: 'memo' } };
        const before = makeXlsx([base, s2, s3]);
        const after = makeXlsx([{ ...s2, name: '集計2' }, base, { name: '新規', id: 4, cells: { A1: 1 } }]);
        const d = await diffXlsx(before, after);
        const by = Object.fromEntries(d.sheets.map((s) => [s.name, s]));
        assert.equal(by['集計2'].status, 'renamed');
        assert.equal(by['集計2'].oldName, '集計');
        assert.equal(by.Sheet1.status, 'modified'); // 並びが変わった
        assert.equal(by.Sheet1.oldIndex, 0);
        assert.equal(by.Sheet1.newIndex, 1);
        assert.equal(by['新規'].status, 'added');
        assert.equal(by['メモ'].status, 'deleted');
        assert.match(d.summary, /新規 を追加/);
        assert.match(d.summary, /メモ を削除/);
    });
    it('共有の式（t="shared"）を展開して比べる', async () => {
        const a: SheetSpec = { name: 'S', cells: { A1: 1, A2: 2, A3: 3, B1: { f: 'A1*2', v: 2, shared: { si: 0, ref: 'B1:B3' } }, B2: { f: '', v: 4, shared: { si: 0 } }, B3: { f: '', v: 6, shared: { si: 0 } } } };
        const b: SheetSpec = { name: 'S', cells: { A1: 1, A2: 2, A3: 3, B1: { f: 'A1*2', v: 2 }, B2: { f: 'A2*2', v: 4 }, B3: { f: 'A3*3', v: 9 } } };
        const d = await diffXlsx(makeXlsx([a]), makeXlsx([b]));
        assert.deepEqual(d.sheets[0].cells.map((c) => `${c.newRef}:${c.change}`), ['B3:formula']);
        assert.equal(d.sheets[0].cells[0].old?.f, 'A3*2');
    });
    it('結合セルの追加・削除', async () => {
        const d = await diffXlsx(makeXlsx([{ ...base, merges: ['A5:C5'] }]), makeXlsx([{ ...base, merges: ['A1:B1'] }]));
        assert.deepEqual(d.sheets[0].mergesAdded, ['A1:B1']);
        assert.deepEqual(d.sheets[0].mergesRemoved, ['A5:C5']);
    });
    it('解釈しない部品（グラフ）が変わったら otherParts に出す', async () => {
        const a = makeXlsx([base], { extra: { 'xl/charts/chart1.xml': '<c>1</c>' } });
        const b = makeXlsx([base], { extra: { 'xl/charts/chart1.xml': '<c>2</c>' } });
        const d = await diffXlsx(a, b);
        assert.equal(d.status, 'modified');
        assert.deepEqual(d.otherParts, [{ name: 'xl/charts/chart1.xml', status: 'modified' }]);
    });
    it('ファイルの追加', async () => {
        const d = await diffXlsx(undefined, makeXlsx([base]));
        assert.equal(d.status, 'added');
        assert.equal(d.sheets[0].status, 'added');
        assert.equal(d.sheets[0].cells.length, Object.keys(base.cells).length);
    });
    it('ZIP 爆弾とセルの上限で DiffLimitError', async () => {
        const bomb = makeXlsx([base], { extra: { 'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' + ' '.repeat(5_000_000) + '</sheetData></worksheet>' } });
        const small: DiffContext = { ...ctx, limits: { ...ctx.limits, maxUncompressedBytes: 1_000_000 } };
        await assert.rejects(() => xlsxDriver.diff({ path: 'b.xlsx', oldBytes: bomb, newBytes: bomb }, small), DiffLimitError);
        const fewCells: DiffContext = { ...ctx, limits: { ...ctx.limits, maxCells: 10 } };
        await assert.rejects(() => xlsxDriver.diff({ path: 'b.xlsx', oldBytes: makeXlsx([base]), newBytes: makeXlsx([base]) }, fewCells), DiffLimitError);
    });
    it('変更の数の上限で打ち切って truncated', async () => {
        const many: Record<string, Cell> = {};
        for (let r = 1; r <= 50; r++) { many[`A${r}`] = r; }
        const changed: Record<string, Cell> = {};
        for (let r = 1; r <= 50; r++) { changed[`A${r}`] = r * 10; }
        const lim: DiffContext = { ...ctx, limits: { ...ctx.limits, maxChanges: 10 } };
        const d = (await xlsxDriver.diff({ path: 'b.xlsx', oldBytes: makeXlsx([{ name: 'S', cells: many }]), newBytes: makeXlsx([{ name: 'S', cells: changed }]) }, lim)) as TableDiff;
        assert.equal(d.sheets[0].cells.length, 10);
        assert.equal(d.truncated, true);
        assert.ok(d.warnings.length > 0);
    });
});

describe('式の参照の書き換え', () => {
    it('文字列・関数名・他のシートの参照は触らない', () => {
        const f = 'IF(A1>0,"A1です",LOG10(B2))+Sheet2!C3+\'My Sheet\'!D4+$E$5';
        const out = rewriteRefs(f, (r, c) => ({ r: r + 1, c }));
        assert.equal(out, 'IF(A2>0,"A1です",LOG10(B3))+Sheet2!C3+\'My Sheet\'!D4+$E$6');
    });
    it('共有の式のずらしは $ の部分を動かさない', () => {
        assert.equal(shiftFormula('A1*$B$1+A$1+$A1', 2, 1), 'B3*$B$1+B$1+$A3');
    });
    it('消えた参照は #REF!', () => {
        assert.equal(rewriteRefs('A1+A2', (r, c) => (r === 2 ? undefined : { r, c })), 'A1+#REF!');
    });
});

describe('CSV', () => {
    const csv = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc);
    it('引用・改行を含むセル', () => {
        assert.deepEqual(parseCsv('a,"b,c","d""e"\n"x\ny",z\n', ',', 100), [['a', 'b,c', 'd"e'], ['x\ny', 'z']]);
    });
    it('Shift_JIS と UTF-8 の BOM を読む', () => {
        const sjis = Buffer.from([0x82, 0xa0, 0x2c, 0x31]); // 「あ,1」
        assert.equal(decodeText(sjis), 'あ,1');
        assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'a');
    });
    it('行の追加とセルの変更', async () => {
        const d = (await csvDriver.diff({ path: 'a.csv', oldBytes: csv('id,name\n1,佐藤\n2,鈴木\n'), newBytes: csv('id,name\n1,佐藤\n3,田中\n2,鈴木一郎\n') }, ctx)) as TableDiff;
        const s = d.sheets[0];
        assert.deepEqual(s.rowOps, [{ type: 'insert', at: 3, count: 1 }]);
        assert.deepEqual(s.cells.filter((c) => c.change === 'value').map((c) => `${c.oldRef}->${c.newRef}`), ['B3->B4']);
        assert.match(d.summary, /1 行追加、1 セル変更/);
    });
    it('同じ中身なら unchanged（改行コードの違いだけ）', async () => {
        const d = await csvDriver.diff({ path: 'a.csv', oldBytes: csv('a,b\r\n1,2\r\n'), newBytes: csv('a,b\n1,2\n') }, ctx);
        assert.equal(d.status, 'unchanged');
    });
});
