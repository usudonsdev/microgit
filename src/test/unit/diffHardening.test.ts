/**
 * 差分のレビュー（2026-11-24、docs/structured-diff-implementation.md §7）で見つかった問題の回帰テスト。VS Code は使わない。
 * 観点：細工した入力で時間を使い切らない（閉じていない行、長い数字の並びの式、対応しない閉じタグ）。番地の範囲の外を拒む。
 * 共有の式は他のシートの参照もずらす。シートの名前を変えても式を変更に数えない。実体の名前でプロトタイプを引かない。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { rewriteRefs, shiftFormula } from '../../diff/table';
import { parseXml, decodeEntities } from '../../diff/xml';
import { csvDriver } from '../../diff/csv';
import { xlsxDriver } from '../../diff/xlsx';
import { makeZip } from './helpers/zipWriter';
import { DEFAULT_LIMITS, DiffContext, DiffFormatError, DiffLimitError, TableDiff } from '../../diff/types';

const ctx: DiffContext = { limits: { ...DEFAULT_LIMITS }, tools: {}, tmpDir: '/tmp' };

function book(sheetXml: string, sheetName = 'S', extraSheets = ''): Buffer {
    return makeZip({
        '_rels/.rels': '<Relationships><Relationship Id="r" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': `<workbook xmlns:r="r"><sheets><sheet name="${sheetName}" sheetId="1" r:id="r1"/>${extraSheets}</sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheetXml,
        'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    });
}

const timed = async (fn: () => unknown) => { const t = Date.now(); await fn(); return Date.now() - t; };

describe('細工した入力で時間を使い切らない（レビュー #1）', () => {
    it('閉じていない <row> が大量にあっても速い', async () => {
        const xml = '<worksheet><sheetData>' + '<row>'.repeat(200_000) + '</sheetData></worksheet>';
        const ms = await timed(() => xlsxDriver.diff({ path: 'a.xlsx', oldBytes: book(xml), newBytes: book(xml) }, ctx));
        assert.ok(ms < 3000, `${ms} ms`);
    });
    it('長い数字の並び・閉じていない引用の式でも速い', () => {
        const f = '1'.repeat(200_000) + "+'abc" + 'A1+'.repeat(10_000);
        assert.ok(timedSync(() => rewriteRefs(f, (r, c) => ({ r: r + 1, c }))) < 1000);
    });
    it('対応しない閉じタグが大量にあっても速い', () => {
        const xml = '<a>' + '<b>'.repeat(40_000) + '</c>'.repeat(40_000) + '</a>';
        assert.ok(timedSync(() => parseXml(xml)) < 1000);
    });
});

function timedSync(fn: () => unknown): number { const t = Date.now(); fn(); return Date.now() - t; }

describe('番地の範囲（レビュー #2）', () => {
    it('16384 列を超える CSV は上限のエラー', async () => {
        const row = Array.from({ length: 20_001 }, (_, i) => String(i)).join(',');
        await assert.rejects(() => csvDriver.diff({ path: 'a.csv', oldBytes: Buffer.from(row), newBytes: Buffer.from(row + '\n1') }, ctx), DiffLimitError);
    });
    it('xlsx の範囲の外の番地は形式のエラー', async () => {
        const xml = '<worksheet><sheetData><row r="1"><c r="ZZZZ1"><v>1</v></c></row><row r="99999999"><c><v>1</v></c></row></sheetData></worksheet>';
        await assert.rejects(() => xlsxDriver.diff({ path: 'a.xlsx', oldBytes: book(xml), newBytes: book(xml) }, ctx), DiffFormatError);
    });
});

describe('式の参照（レビュー #6・#7）', () => {
    it('共有の式のずらしは、シート名の付いた参照もずらす', () => {
        assert.equal(shiftFormula("Sheet2!A1+A1+'My S'!$B1", 1, 0), "Sheet2!A2+A2+'My S'!$B2");
    });
    it('シートの名前を変えても、自分のシートの名前の付いた式は変更にしない', async () => {
        const sheet = (name: string) => `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>${name}!A1*2</f><v>2</v></c></row></sheetData></worksheet>`;
        const d = (await xlsxDriver.diff({ path: 'a.xlsx', oldBytes: book(sheet('Old'), 'Old'), newBytes: book(sheet('New'), 'New') }, ctx)) as TableDiff;
        assert.equal(d.sheets[0].status, 'renamed');
        assert.deepEqual(d.sheets[0].cells, []);
    });
});

describe('実体と属性（レビュー #8）', () => {
    it('実体の名前でプロトタイプを引かない。__proto__ の属性も普通に持つ', () => {
        assert.equal(decodeEntities('&constructor;&amp;'), '&constructor;&');
        const el = parseXml('<a __proto__="x" b="y"/>');
        assert.equal(el.attrs['__proto__'], 'x');
        assert.equal(el.attrs.b, 'y');
    });
});
