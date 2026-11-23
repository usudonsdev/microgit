/**
 * Word 文書の差分ドライバ（src/diff/docx.ts）の単体テスト（docs/structured-diff.md §3.3）。
 * 観点：段落の文字の変更（語の単位の差分）、途中への段落の追加、書式だけの変更、保存のたびに変わる印（rsid）だけの変更、
 * 表のセルの変更、ファイルの追加、ZIP 爆弾（上限で DiffLimitError を投げる）、ZIP でない（DiffFormatError）。
 * 見本の ZIP は makeZip で組み立てる。実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { docxDriver } from '../../diff/docx';
import { DEFAULT_LIMITS, DiffContext, DiffFormatError, DiffLimitError, DocumentDiff } from '../../diff/types';
import { makeZip } from './helpers/zipWriter';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function para(text: string, opts: { rsid?: string; bold?: boolean; style?: string } = {}): string {
    const ppr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : '';
    const rpr = opts.bold ? '<w:rPr><w:b/></w:rPr>' : '';
    return `<w:p w:rsidR="${opts.rsid ?? '00A1'}" w14:paraId="${opts.rsid ?? '1111'}">${ppr}<w:r w:rsidRPr="${opts.rsid ?? '00A1'}">${rpr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function docx(body: string): Buffer {
    return makeZip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    });
}

const ctx = (limits = DEFAULT_LIMITS): DiffContext => ({ limits, tools: {}, tmpDir: '' });

async function run(oldBytes: Buffer | undefined, newBytes: Buffer | undefined, c = ctx()): Promise<DocumentDiff> {
    const r = await docxDriver.diff({ path: 'a/report.docx', oldBytes, newBytes }, c);
    assert.equal(r.kind, 'document');
    return r as DocumentDiff;
}

const changes = (r: DocumentDiff) => r.blocks.filter((b) => b.type !== 'equal');

describe('docx の差分', () => {
    it('拡張子と ZIP の印で選ぶ', () => {
        const zipHead = docx(para('a')).subarray(0, 4);
        assert.equal(docxDriver.matches('x/a.docx', zipHead), true);
        assert.equal(docxDriver.matches('x/A.DOCM', Buffer.alloc(0)), true);
        assert.equal(docxDriver.matches('x/a.docx', Buffer.from('hello')), false);
        assert.equal(docxDriver.matches('x/a.xlsx', zipHead), false);
    });

    it('段落の文字の変更は modify で、語の単位の差分が付く', async () => {
        const r = await run(docx(para('最初') + para('今日は晴れです')), docx(para('最初') + para('今日は雨です')));
        assert.equal(r.status, 'modified');
        const ch = changes(r);
        assert.equal(ch.length, 1);
        assert.equal(ch[0].type, 'modify');
        assert.equal(ch[0].oldIndex, 1);
        assert.deepEqual(ch[0].inline, [
            { op: 'eq', text: '今日は' }, { op: 'del', text: '晴れ' }, { op: 'ins', text: '雨' }, { op: 'eq', text: 'です' },
        ]);
        assert.match(r.summary, /1 段落を変更/);
    });

    it('途中に足した段落は insert 1 つで、ほかは equal', async () => {
        const r = await run(docx(para('一') + para('二') + para('三')), docx(para('一') + para('新しい段落') + para('二') + para('三')));
        const ch = changes(r);
        assert.equal(ch.length, 1);
        assert.equal(ch[0].type, 'insert');
        assert.equal(ch[0].newIndex, 1);
        assert.equal(ch[0].newText, '新しい段落');
        const eqCount = r.blocks.filter((b) => b.type === 'equal').reduce((n, b) => n + b.count!, 0);
        assert.equal(eqCount, 3);
        assert.equal(r.summary, '1 段落を追加');
    });

    it('太字にしただけなら format', async () => {
        const r = await run(docx(para('本文')), docx(para('本文', { bold: true })));
        const ch = changes(r);
        assert.equal(ch.length, 1);
        assert.equal(ch[0].type, 'format');
        assert.equal(r.summary, '書式の変更 1 段落');
    });

    it('rsid などの保存のたびに変わる印だけの違いは unchanged', async () => {
        const r = await run(docx(para('本文', { rsid: '00A1' })), docx(para('本文', { rsid: '00B2' })));
        assert.equal(r.status, 'unchanged');
        assert.equal(r.summary, '変更なし（文字と書式は同じ）');
        assert.deepEqual(r.blocks, [{ type: 'equal', count: 1, oldIndex: 0, newIndex: 0 }]);
    });

    it('同じ書式の文字の並びの分け方が違うだけなら unchanged', async () => {
        const split = '<w:p><w:r><w:t>本</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>文</w:t></w:r></w:p>';
        const r = await run(docx(para('本文')), docx(split));
        assert.equal(r.status, 'unchanged');
    });

    it('見出し・表のセル・変更履歴の削除文字', async () => {
        const tbl = (a: string, b: string) => `<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>${a}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${b}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
        const del = '<w:p><w:r><w:t>残す</w:t></w:r><w:del><w:r><w:delText>消した</w:delText></w:r></w:del><w:ins><w:r><w:t>足した</w:t></w:r></w:ins></w:p>';
        const r = await run(docx(para('章', { style: 'Heading1' }) + tbl('売上', '100 円') + del), docx(para('章', { style: 'Heading1' }) + tbl('売上', '120 円') + del));
        const ch = changes(r);
        assert.equal(ch.length, 1);
        assert.equal(ch[0].type, 'modify');
        assert.equal(ch[0].blockKind, 'table-cell');
        assert.equal(ch[0].oldText, '100 円');
        assert.equal(ch[0].newText, '120 円');
        const added = await run(undefined, docx(para('章', { style: 'Heading1' }) + del));
        assert.equal(added.blocks[0].blockKind, 'heading');
        assert.equal(added.blocks[1].newText, '残す足した');
    });

    it('ファイルの追加はすべての段落が insert', async () => {
        const r = await run(undefined, docx(para('一') + para('二')));
        assert.equal(r.status, 'added');
        assert.equal(r.summary, '追加（2 段落）');
        assert.deepEqual(r.blocks.map((b) => [b.type, b.newText]), [['insert', '一'], ['insert', '二']]);
    });

    it('変更が maxChanges を超えたら打ち切る', async () => {
        const r = await run(undefined, docx(para('一') + para('二') + para('三')), ctx({ ...DEFAULT_LIMITS, maxChanges: 2 }));
        assert.equal(r.blocks.length, 2);
        assert.equal(r.truncated, true);
        assert.equal(r.warnings.length, 1);
    });

    it('ヘッダーなどの関係で結ばれた部品も比べ、解釈しない部品は otherParts', async () => {
        const mk = (header: string, media: string) => makeZip({
            '_rels/.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${para('本文')}</w:body></w:document>`,
            'word/_rels/document.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
            'word/header1.xml': `<w:hdr xmlns:w="${W}">${para(header)}</w:hdr>`,
            'word/media/image1.png': media,
        });
        const r = await run(mk('社外秘', 'a'), mk('社外秘（改）', 'b'));
        const ch = changes(r);
        assert.equal(ch.length, 1);
        assert.equal(ch[0].blockKind, 'header');
        assert.equal(ch[0].type, 'modify');
        assert.deepEqual(r.otherParts, [{ name: 'word/media/image1.png', status: 'modified' }]);
    });

    it('ZIP 爆弾は DiffLimitError を投げる', async () => {
        const bomb = makeZip({
            '_rels/.rels': '<Relationships/>',
            'word/document.xml': Buffer.alloc(50 * 1024 * 1024),
        });
        assert.ok(bomb.length < 1024 * 1024);
        const limits = { ...DEFAULT_LIMITS, maxUncompressedBytes: 1024 * 1024 };
        await assert.rejects(run(docx(para('a')), bomb, ctx(limits)), DiffLimitError);
    });

    it('ZIP でなければ DiffFormatError を投げる', async () => {
        await assert.rejects(run(Buffer.from('not a zip at all'), docx(para('a'))), DiffFormatError);
    });
});
