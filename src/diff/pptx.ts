/**
 * PowerPoint（pptx・pptm・potx）の差分ドライバ（docs/structured-diff.md §3.3）。
 *
 * - スライドの並びは ppt/presentation.xml の p:sldIdLst の順（r:id を presentation.xml.rels で部品に直す）
 * - スライドの対応づけは、中身の指紋（図形の文字と画像）で diffSequences。消えた指紋と同じものが別の位置に足されていたら
 *   「並べ替え」（moved）。残りの消えた・足されたスライドのうち、文字が似ているもの（similarity が 0.4 以上）は「変更」
 * - スライドの中の図形は cNvPr の id で、無ければ名前で対応づける。文字の変更・位置や大きさの変更・画像の差し替えを見る。
 *   グループ（p:grpSp）の中の図形は平らに並べる（再帰を使わない）
 * - ノートは本文のプレースホルダ（ph type="body"）の文字を比べる
 * - 図形の書式（色・線・文字の書式）の変更は見ない。スライドの文字・位置・画像が同じなら「変わらない」とする
 * 信頼できないファイルを読むので、ZIP は上限つきで開く（ZipReader）。上限を超えたら DiffLimitError を投げる（worker.ts が結果に直す）。
 */
import { DiffDriver, DiffFormatError, DiffInput, DiffLimits, ShapeChange, SlideChange, SlidesDiff, baseOf, extOf } from './types';
import { ZipReader, looksLikeZip, otherPartChanges } from './zip';
import { XmlElement, childrenNamed, descendants, findAll, firstChild, isElement, localName, parseRels, parseXml, textContent } from './xml';
import { SeqOp, diffInline, diffSequences, pairRuns, similarity } from './seq';

const EXTS = new Set(['pptx', 'pptm', 'potx']);
const MAIN_DEFAULT = 'ppt/presentation.xml';

interface Shape {
    id: string;
    name: string;
    text: string;
    /** 位置と大きさ（a:xfrm）の指紋 */
    pos: string;
    /** 画像（p:pic）なら、参照先の部品の中身の指紋 */
    media?: string;
    isPic: boolean;
    ph?: string;
}

interface Slide {
    part: string;
    title?: string;
    shapes: Shape[];
    notes?: string;
    /** 対応づけに使う中身の指紋 */
    key: string;
    text: string;
}

interface Deck {
    slides: Slide[];
    known: Set<string>;
}

export const pptxDriver: DiffDriver = {
    id: 'pptx',
    version: 1,
    label: 'PowerPoint',
    matches: (path, head) => EXTS.has(extOf(path)) && (head.length === 0 || looksLikeZip(head)),
    async diff(input: DiffInput, ctx): Promise<SlidesDiff> {
        const base = baseOf(pptxDriver, input);
        const limits = ctx.limits;
        const oldZip = input.oldBytes ? new ZipReader(input.oldBytes, limits) : undefined;
        const newZip = input.newBytes ? new ZipReader(input.newBytes, limits) : undefined;
        const oldDeck = oldZip ? readDeck(oldZip) : undefined;
        const newDeck = newZip ? readDeck(newZip) : undefined;

        if (!oldDeck || !newDeck) {
            const deck = (newDeck ?? oldDeck)!;
            const added = !!newDeck;
            const all = deck.slides.map((s, i): SlideChange => ({
                status: added ? 'added' : 'deleted',
                ...(added ? { newIndex: i } : { oldIndex: i }),
                ...(s.title ? { title: s.title } : {}),
                shapes: [],
            }));
            const truncated = all.length > limits.maxChanges;
            const slides = truncated ? all.slice(0, limits.maxChanges) : all;
            const summary = `${added ? '追加' : '削除'}（${deck.slides.length} 枚のスライド）`;
            return { ...base, kind: 'slides', summary, slides, ...truncInfo(truncated, base.warnings, limits) };
        }

        const all = compareDecks(oldDeck.slides, newDeck.slides);
        const { slides, truncated } = capSlides(all, limits);
        const known = (n: string) => oldDeck.known.has(n) || newDeck.known.has(n);
        const otherParts = otherPartChanges(oldZip, newZip, known);
        const changed = slides.some((s) => s.status !== 'unchanged');
        return {
            ...base,
            kind: 'slides',
            status: !changed && otherParts.length === 0 ? 'unchanged' : 'modified',
            summary: summarize(all, otherParts.length),
            slides,
            ...(otherParts.length ? { otherParts } : {}),
            ...truncInfo(truncated, base.warnings, limits),
        };
    },
};

function truncInfo(truncated: boolean, warnings: string[], limits: DiffLimits): { truncated?: boolean } {
    if (!truncated) { return {}; }
    warnings.push(`変更が多いので、最初の ${limits.maxChanges} 件だけ表示する`);
    return { truncated: true };
}

/** 変更（変わったスライドと図形）の数が maxChanges を超えたら、そこで打ち切る */
function capSlides(all: SlideChange[], limits: DiffLimits): { slides: SlideChange[]; truncated: boolean } {
    let n = 0;
    for (let i = 0; i < all.length; i++) {
        if (all[i].status === 'unchanged') { continue; }
        n += 1 + all[i].shapes.length;
        if (n > limits.maxChanges) { return { slides: all.slice(0, i), truncated: true }; }
    }
    return { slides: all, truncated: false };
}

function slideList(nums: number[], verb: string): string {
    return nums.length <= 3 ? `スライド ${nums.join('・')} を${verb}` : `${nums.length} 枚のスライドを${verb}`;
}

function summarize(all: SlideChange[], otherCount: number): string {
    const mod: number[] = [];
    const add: number[] = [];
    const del: number[] = [];
    let moved = 0;
    for (const s of all) {
        if (s.status === 'modified') { mod.push(s.newIndex! + 1); }
        if (s.status === 'added') { add.push(s.newIndex! + 1); }
        if (s.status === 'deleted') { del.push(s.oldIndex! + 1); }
        if (s.status === 'moved') { moved++; if (s.shapes.length || s.notesChange) { mod.push(s.newIndex! + 1); } }
    }
    const parts: string[] = [];
    if (mod.length) { parts.push(slideList(mod, '変更')); }
    if (add.length) { parts.push(slideList(add, '追加')); }
    if (del.length) { parts.push(slideList(del, '削除')); }
    if (moved) { parts.push(`スライドの並べ替え ${moved}`); }
    if (parts.length === 0) {
        return otherCount ? `スライドは同じ。ほかの部品の変更 ${otherCount} 件` : '変更なし（スライドの文字・位置・画像は同じ）';
    }
    if (otherCount) { parts.push(`ほかの部品の変更 ${otherCount} 件`); }
    return parts.join('、');
}

// ---------- 比較 ----------

function compareDecks(a: Slide[], b: Slide[]): SlideChange[] {
    const ops = diffSequences(a.map((s) => s.key), b.map((s) => s.key));
    // 並べ替え：消えたスライドと同じ指紋のスライドが別の位置に足されていたら、1 件の moved にする
    const insByKey = new Map<string, number[]>();
    for (const o of ops) {
        if (o.op !== 'ins') { continue; }
        const list = insByKey.get(b[o.b].key);
        if (list) { list.push(o.b); } else { insByKey.set(b[o.b].key, [o.b]); }
    }
    const movedTo = new Map<number, number>(); // 新の位置 → 旧の位置
    const movedFrom = new Set<number>();
    for (const o of ops) {
        if (o.op !== 'del') { continue; }
        const list = insByKey.get(a[o.a].key);
        if (list && list.length) { const nb = list.shift()!; movedTo.set(nb, o.a); movedFrom.add(o.a); }
    }
    const rest: SeqOp[] = ops.filter((o) => !(o.op === 'del' && movedFrom.has(o.a)) && !(o.op === 'ins' && movedTo.has(o.b)));
    const paired = pairRuns(rest, (i, j) => similarity(a[i].text, b[j].text) >= 0.4);
    // 並べ替えたスライドは、新の位置の順に差し込む
    const out: SlideChange[] = [];
    const movedNew = [...movedTo.keys()].sort((x, y) => x - y);
    let mi = 0;
    const emitMovedBefore = (limit: number) => {
        while (mi < movedNew.length && movedNew[mi] < limit) {
            const nb = movedNew[mi++];
            out.push(compareSlide(a[movedTo.get(nb)!], b[nb], movedTo.get(nb)!, nb, 'moved'));
        }
    };
    for (const o of paired) {
        if (o.op !== 'del') { emitMovedBefore(o.b); }
        if (o.op === 'eq' || o.op === 'mod') {
            out.push(compareSlide(a[o.a], b[o.b], o.a, o.b, 'modified'));
        } else if (o.op === 'del') {
            out.push({ status: 'deleted', oldIndex: o.a, ...(a[o.a].title ? { title: a[o.a].title } : {}), shapes: [] });
        } else {
            out.push({ status: 'added', newIndex: o.b, ...(b[o.b].title ? { title: b[o.b].title } : {}), shapes: [] });
        }
    }
    emitMovedBefore(Infinity);
    return out;
}

/** 対応づけた 2 枚のスライドを比べる。何も変わっていなければ unchanged（図形の一覧は空） */
function compareSlide(a: Slide, b: Slide, oldIndex: number, newIndex: number, ifChanged: 'modified' | 'moved'): SlideChange {
    const shapes = compareShapes(a.shapes, b.shapes);
    const title = b.title ?? a.title;
    const res: SlideChange = { status: ifChanged, oldIndex, newIndex, ...(title ? { title } : {}), shapes };
    if ((a.notes ?? '') !== (b.notes ?? '')) {
        res.notesChange = { oldText: a.notes, newText: b.notes, inline: diffInline(a.notes ?? '', b.notes ?? '') };
    }
    if (ifChanged === 'modified' && shapes.length === 0 && !res.notesChange) { res.status = 'unchanged'; }
    return res;
}

function compareShapes(a: Shape[], b: Shape[]): ShapeChange[] {
    const matchOf = new Map<number, number>(); // 新 → 旧
    const used = new Set<number>();
    const tryMatch = (same: (x: Shape, y: Shape) => boolean) => {
        for (let j = 0; j < b.length; j++) {
            if (matchOf.has(j)) { continue; }
            const i = a.findIndex((x, k) => !used.has(k) && same(x, b[j]));
            if (i >= 0) { matchOf.set(j, i); used.add(i); }
        }
    };
    tryMatch((x, y) => !!x.id && x.id === y.id && x.isPic === y.isPic);
    tryMatch((x, y) => !!x.name && x.name === y.name);
    const out: ShapeChange[] = [];
    for (let j = 0; j < b.length; j++) {
        const y = b[j];
        const i = matchOf.get(j);
        if (i === undefined) {
            out.push({ status: 'added', name: y.name, ...(y.text ? { newText: y.text } : {}) });
            continue;
        }
        const x = a[i];
        const c: ShapeChange = { status: 'modified', name: y.name || x.name };
        let changed = false;
        if (x.text !== y.text) {
            Object.assign(c, { oldText: x.text, newText: y.text, inline: diffInline(x.text, y.text) });
            changed = true;
        } else if (x.isPic && y.isPic && x.media !== y.media) {
            c.newText = '画像を差し替え';
            changed = true;
        }
        if (x.pos !== y.pos) { c.moved = true; changed = true; }
        if (changed) { out.push(c); }
    }
    for (let i = 0; i < a.length; i++) {
        if (!used.has(i)) { out.push({ status: 'deleted', name: a[i].name, ...(a[i].text ? { oldText: a[i].text } : {}) }); }
    }
    return out;
}

// ---------- 読み込み ----------

function relsPathOf(part: string): string {
    const i = part.lastIndexOf('/');
    return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

function dirOf(part: string): string {
    const i = part.lastIndexOf('/');
    return i < 0 ? '' : part.slice(0, i);
}

/** 接頭辞つきの属性（r:id・r:embed など）を、接頭辞を無視して探す */
function prefixedAttr(el: XmlElement, local: string): string | undefined {
    for (const k of Object.keys(el.attrs)) {
        if (k.includes(':') && localName(k) === local) { return el.attrs[k]; }
    }
    return undefined;
}

function findMainPart(zip: ZipReader): string {
    for (const r of parseRels(zip.readText('_rels/.rels'), '').values()) {
        if (!r.external && /\/officeDocument$/.test(r.type) && zip.has(r.target)) { return r.target; }
    }
    if (zip.has(MAIN_DEFAULT)) { return MAIN_DEFAULT; }
    throw new DiffFormatError('PowerPoint のプレゼンテーション（ppt/presentation.xml）が見つからない');
}

function readDeck(zip: ZipReader): Deck {
    const main = findMainPart(zip);
    const mainRelsPath = relsPathOf(main);
    const known = new Set<string>([main, mainRelsPath]);
    const rels = parseRels(zip.readText(mainRelsPath), dirOf(main));
    const pres = parseXml(zip.readText(main)!);
    const list = firstChild(pres, 'sldIdLst');
    const slides: Slide[] = [];
    for (const sid of list ? childrenNamed(list, 'sldId') : []) {
        const rid = prefixedAttr(sid, 'id');
        const target = rid ? rels.get(rid) : undefined;
        if (!target || target.external || !zip.has(target.target)) { continue; }
        slides.push(readSlide(zip, target.target, known));
    }
    return { slides, known };
}

function readSlide(zip: ZipReader, part: string, known: Set<string>): Slide {
    known.add(part);
    const relsPath = relsPathOf(part);
    known.add(relsPath);
    const rels = parseRels(zip.readText(relsPath), dirOf(part));
    const root = parseXml(zip.readText(part)!);
    const shapes = readShapes(root, (rid) => {
        const r = rels.get(rid);
        if (!r || r.external) { return r ? `外部:${r.target}` : undefined; }
        known.add(r.target);
        return zip.fingerprint(r.target);
    });
    let notes: string | undefined;
    for (const r of rels.values()) {
        if (r.external || !/\/notesSlide$/.test(r.type) || !zip.has(r.target)) { continue; }
        known.add(r.target);
        known.add(relsPathOf(r.target));
        const ns = readShapes(parseXml(zip.readText(r.target)!), () => undefined);
        notes = ns.filter((s) => s.ph === 'body').map((s) => s.text).join('\n');
        break;
    }
    const title = shapes.find((s) => s.ph === 'title' || s.ph === 'ctrTitle')?.text || undefined;
    const text = shapes.map((s) => s.text).filter((t) => t).join('\n');
    const key = shapes.map((s) => `${s.text}\u0001${s.isPic ? `${s.name}\u0001${s.media ?? ''}` : ''}`).join('\u0002');
    return { part, title, shapes, notes, key, text };
}

/** p:spTree の中の図形を、文書の順に平らに集める（グループは中身を展開。再帰を使わない） */
function readShapes(root: XmlElement, mediaOf: (rid: string) => string | undefined): Shape[] {
    const tree = findAll(root, 'spTree')[0];
    if (!tree) { return []; }
    const out: Shape[] = [];
    const stack: XmlElement[] = tree.children.filter(isElement).reverse();
    while (stack.length) {
        const el = stack.pop()!;
        const ln = localName(el.name);
        if (ln === 'grpSp' || ln === 'AlternateContent' || ln === 'Choice') {
            // グループと互換用の入れ物：中身を順に辿る（AlternateContent は最初の Choice だけ）
            const kids = ln === 'AlternateContent' ? el.children.filter(isElement).filter((c) => localName(c.name) === 'Choice').slice(0, 1) : el.children.filter(isElement);
            for (let k = kids.length - 1; k >= 0; k--) { stack.push(kids[k]); }
            continue;
        }
        if (ln !== 'sp' && ln !== 'pic' && ln !== 'graphicFrame' && ln !== 'cxnSp') { continue; }
        out.push(readShape(el, ln === 'pic', mediaOf));
    }
    return out;
}

function readShape(el: XmlElement, isPic: boolean, mediaOf: (rid: string) => string | undefined): Shape {
    const nv = el.children.find((c): c is XmlElement => isElement(c) && localName(c.name).startsWith('nv'));
    const cnv = nv ? firstChild(nv, 'cNvPr') : undefined;
    const nvPr = nv ? firstChild(nv, 'nvPr') : undefined;
    const phEl = nvPr ? firstChild(nvPr, 'ph') : undefined;
    const ph = phEl ? phEl.attrs.type ?? 'obj' : undefined;
    const spPr = firstChild(el, 'spPr');
    const xfrm = spPr ? firstChild(spPr, 'xfrm') : firstChild(el, 'xfrm');
    let pos = '';
    if (xfrm) {
        const off = firstChild(xfrm, 'off');
        const ext = firstChild(xfrm, 'ext');
        pos = [off?.attrs.x, off?.attrs.y, ext?.attrs.cx, ext?.attrs.cy, xfrm.attrs.rot, xfrm.attrs.flipH, xfrm.attrs.flipV].map((v) => v ?? '').join(',');
    }
    let media: string | undefined;
    if (isPic) {
        const blip = findAll(el, 'blip')[0];
        const rid = blip ? prefixedAttr(blip, 'embed') ?? prefixedAttr(blip, 'link') : undefined;
        media = rid ? mediaOf(rid) : undefined;
    }
    return { id: cnv?.attrs.id ?? '', name: cnv?.attrs.name ?? '', text: shapeText(el), pos, media, isPic, ph };
}

/** 図形の文字。段落（a:p）を改行でつなぐ。表（a:tbl）のセルの段落も同じ */
function shapeText(el: XmlElement): string {
    const paras: string[] = [];
    for (const p of findAll(el, 'p')) {
        let s = '';
        for (const d of descendants(p)) {
            const ln = localName(d.name);
            if (ln === 't') { s += textContent(d); } else if (ln === 'br') { s += '\n'; }
        }
        paras.push(s);
    }
    return paras.join('\n');
}
