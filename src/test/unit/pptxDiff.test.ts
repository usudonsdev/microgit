/**
 * PowerPoint の差分ドライバ（src/diff/pptx.ts）の単体テスト（docs/structured-diff.md §3.3）。
 * 観点：図形の文字の変更、スライドの追加、並べ替え（moved）、図形の移動（a:off の変更）、ノートの変更、画像の差し替え、
 * 解釈しない部品（otherParts）。見本の ZIP は makeZip で組み立てる。実行は node scripts/run-unit-tests.mjs（先に npm run compile が要る）。
 */
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { pptxDriver } from '../../diff/pptx';
import { DEFAULT_LIMITS, DiffFormatError, SlidesDiff } from '../../diff/types';
import { makeZip } from './helpers/zipWriter';

const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface SlideSpec {
    title: string;
    body?: string;
    /** 本文の図形の位置 */
    x?: number;
    notes?: string;
    /** 画像の中身（あれば p:pic を置く） */
    image?: string;
}

function sp(id: number, name: string, text: string, ph?: string, x = 100): string {
    const phEl = ph ? `<p:ph type="${ph}"/>` : '';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${phEl}</p:nvPr></p:nvSpPr>`
        + `<p:spPr><a:xfrm><a:off x="${x}" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>`
        + `<p:txBody><a:bodyPr/>${text.split('\n').map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
}

function pptx(slides: SlideSpec[], extra: Record<string, string> = {}): Buffer {
    const files: Record<string, string> = {
        '_rels/.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
        'ppt/presentation.xml': `<p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('')}</p:sldIdLst></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 10}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
        'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout/>',
        ...extra,
    };
    slides.forEach((s, i) => {
        const n = i + 1;
        let shapes = sp(2, 'Title 1', s.title, 'title');
        if (s.body !== undefined) { shapes += sp(3, 'Content 2', s.body, 'body', s.x ?? 100); }
        const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
        if (s.image !== undefined) {
            shapes += '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group 8"/></p:nvGrpSpPr><p:grpSpPr/>'
                + `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/></p:blipFill>`
                + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:pic></p:grpSp>';
            rels.push(`<Relationship Id="rId5" Type="${REL}/image" Target="../media/image${n}.png"/>`);
            files[`ppt/media/image${n}.png`] = s.image;
        }
        if (s.notes !== undefined) {
            rels.push(`<Relationship Id="rId6" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
            files[`ppt/notesSlides/notesSlide${n}.xml`] = `<p:notes ${NS}><p:cSld><p:spTree>${sp(2, 'Slide Image 1', '', 'sldImg')}${sp(3, 'Notes 2', s.notes, 'body')}</p:spTree></p:cSld></p:notes>`;
        }
        files[`ppt/slides/slide${n}.xml`] = `<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
        files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<Relationships>${rels.join('')}</Relationships>`;
    });
    return makeZip(files);
}

async function run(oldBytes: Buffer | undefined, newBytes: Buffer | undefined): Promise<SlidesDiff> {
    const r = await pptxDriver.diff({ path: 'deck.pptx', oldBytes, newBytes }, { limits: DEFAULT_LIMITS, tools: {}, tmpDir: '' });
    assert.equal(r.kind, 'slides');
    return r as SlidesDiff;
}

const base: SlideSpec[] = [
    { title: '表紙', body: '2026 年度の計画' },
    { title: '売上', body: '前年より 10% 増えた\n新しい店を出す' },
    { title: '課題', body: '人が足りない' },
];

describe('pptx の差分', () => {
    it('拡張子と ZIP の印で選ぶ', () => {
        assert.equal(pptxDriver.matches('a/b.pptx', pptx(base).subarray(0, 4)), true);
        assert.equal(pptxDriver.matches('a/b.potx', Buffer.alloc(0)), true);
        assert.equal(pptxDriver.matches('a/b.pptx', Buffer.from('text')), false);
    });

    it('同じ中身なら unchanged', async () => {
        const r = await run(pptx(base), pptx(base));
        assert.equal(r.status, 'unchanged');
        assert.ok(r.slides.every((s) => s.status === 'unchanged' && s.shapes.length === 0));
    });

    it('図形の文字の変更', async () => {
        const next = base.map((s) => ({ ...s }));
        next[1].body = '前年より 20% 増えた\n新しい店を出す';
        const r = await run(pptx(base), pptx(next));
        const s = r.slides[1];
        assert.equal(s.status, 'modified');
        assert.equal(s.title, '売上');
        assert.equal(s.shapes.length, 1);
        assert.equal(s.shapes[0].name, 'Content 2');
        assert.ok(s.shapes[0].inline!.some((p) => p.op === 'del' && p.text === '10'));
        assert.ok(s.shapes[0].inline!.some((p) => p.op === 'ins' && p.text === '20'));
        assert.equal(r.summary, 'スライド 2 を変更');
    });

    it('スライドの追加', async () => {
        const next = [...base, { title: 'まとめ', body: 'ありがとう' }];
        const r = await run(pptx(base), pptx(next));
        const added = r.slides.filter((s) => s.status === 'added');
        assert.equal(added.length, 1);
        assert.equal(added[0].newIndex, 3);
        assert.equal(added[0].title, 'まとめ');
        assert.equal(r.summary, 'スライド 4 を追加');
    });

    it('並べ替えは moved 1 件', async () => {
        const r = await run(pptx(base), pptx([base[2], base[0], base[1]]));
        const moved = r.slides.filter((s) => s.status === 'moved');
        assert.equal(moved.length, 1);
        assert.equal(moved[0].oldIndex, 2);
        assert.equal(moved[0].newIndex, 0);
        assert.equal(r.slides.filter((s) => s.status === 'added' || s.status === 'deleted').length, 0);
        assert.equal(r.summary, 'スライドの並べ替え 1');
        assert.deepEqual(r.slides.map((s) => s.newIndex), [0, 1, 2]);
    });

    it('図形の移動は moved: true', async () => {
        const next = base.map((s) => ({ ...s }));
        next[0].x = 500;
        const r = await run(pptx(base), pptx(next));
        assert.equal(r.slides[0].status, 'modified');
        assert.deepEqual(r.slides[0].shapes, [{ status: 'modified', name: 'Content 2', moved: true }]);
    });

    it('ノートの変更', async () => {
        const a = base.map((s) => ({ ...s, notes: 'ゆっくり話す' }));
        const b = a.map((s) => ({ ...s }));
        b[2].notes = 'もっとゆっくり話す';
        const r = await run(pptx(a), pptx(b));
        const s = r.slides[2];
        assert.equal(s.status, 'modified');
        assert.equal(s.shapes.length, 0);
        assert.equal(s.notesChange?.oldText, 'ゆっくり話す');
        assert.equal(s.notesChange?.newText, 'もっとゆっくり話す');
        assert.deepEqual(s.notesChange?.inline?.[0], { op: 'ins', text: 'もっと' });
    });

    it('画像の差し替え（グループの中の画像）', async () => {
        const a = base.map((s, i) => (i === 1 ? { ...s, image: 'PNG-old' } : s));
        const b = base.map((s, i) => (i === 1 ? { ...s, image: 'PNG-new' } : s));
        const r = await run(pptx(a), pptx(b));
        const s = r.slides[1];
        assert.equal(s.status, 'modified');
        assert.deepEqual(s.shapes, [{ status: 'modified', name: 'Picture 3', newText: '画像を差し替え' }]);
        // 参照された画像は解釈した部品なので otherParts に出ない
        assert.equal(r.otherParts, undefined);
    });

    it('解釈しない部品の変更は otherParts', async () => {
        const r = await run(pptx(base), pptx(base, { 'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout x="1"/>' }));
        assert.equal(r.status, 'modified');
        assert.deepEqual(r.otherParts, [{ name: 'ppt/slideLayouts/slideLayout1.xml', status: 'modified' }]);
    });

    it('ファイルの追加', async () => {
        const r = await run(undefined, pptx(base));
        assert.equal(r.status, 'added');
        assert.equal(r.summary, '追加（3 枚のスライド）');
        assert.equal(r.slides.length, 3);
    });

    it('ZIP でなければ DiffFormatError', async () => {
        await assert.rejects(run(Buffer.from('nope'), pptx(base)), DiffFormatError);
    });
});
