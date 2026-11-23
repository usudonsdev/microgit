/**
 * Word 文書（docx・docm・dotx）の差分ドライバ（docs/structured-diff.md §3.3）。
 *
 * - 段落（w:p）を文書の順に並べ、文字で対応づける（diffSequences）。消した段落と足した段落のうち似ているもの（similarity が 0.5 以上）は
 *   「変更」にして、語の単位の差分（diffInline）を付ける。文字が同じで書式だけ違う段落は「書式」
 * - 表の中の段落も 1 段落として数える（blockKind 'table-cell'）。見出しは段落のスタイルか outlineLvl で見分ける
 * - ヘッダー・フッター・脚注・文末脚注・コメントの段落も、本文のあとに続けて比べる（blockKind 'header' など）
 * - 書式の比較では、保存のたびに変わる印（w:rsid*、w14:paraId など）と、校正の印（w:proofErr）を無視する。
 *   同じ書式の文字の並び（w:r）の分け方が違うだけなら、同じとみなす
 * - 変更履歴で削除された文字（w:delText）は文字に入れない。挿入された文字（w:ins）は入れる
 * 信頼できないファイルを読むので、ZIP は上限つきで開く（ZipReader）。上限を超えたら DiffLimitError を投げる（worker.ts が結果に直す）。
 */
import { BlockChange, DiffDriver, DiffInput, DiffLimits, DiffFormatError, DocumentDiff, baseOf, extOf } from './types';
import { ZipReader, looksLikeZip, otherPartChanges } from './zip';
import { XmlElement, XmlNode, childrenNamed, firstChild, isElement, localName, parseRels, parseXml, serialize, textContent } from './xml';
import { diffInline, diffSequences, pairRuns, similarity } from './seq';

const EXTS = new Set(['docx', 'docm', 'dotx']);
const MAIN_DEFAULT = 'word/document.xml';

/** 比べる 1 段落 */
interface Para {
    /** 本文・表・ヘッダーなどの区分。対応づけは同じ区分どうしだけ */
    area: string;
    kind: string;
    text: string;
    /** 書式の指紋（保存のたびに変わる印を除いたもの） */
    fmt: string;
}

interface DocModel {
    paras: Para[];
    /** 解釈した部品（otherParts から除く） */
    known: Set<string>;
}

export const docxDriver: DiffDriver = {
    id: 'docx',
    version: 1,
    label: 'Word 文書',
    matches: (path, head) => EXTS.has(extOf(path)) && (head.length === 0 || looksLikeZip(head)),
    async diff(input: DiffInput, ctx): Promise<DocumentDiff> {
        const base = baseOf(docxDriver, input);
        const oldZip = input.oldBytes ? new ZipReader(input.oldBytes, ctx.limits) : undefined;
        const newZip = input.newBytes ? new ZipReader(input.newBytes, ctx.limits) : undefined;
        const oldDoc = oldZip ? readDocument(oldZip) : undefined;
        const newDoc = newZip ? readDocument(newZip) : undefined;
        const limits = ctx.limits;

        if (!oldDoc || !newDoc) {
            // 追加・削除：全部の段落を追加・削除として返す
            const doc = (newDoc ?? oldDoc)!;
            const added = !!newDoc;
            const { blocks, truncated } = capBlocks(doc.paras.map((p, i): BlockChange => added
                ? { type: 'insert', newIndex: i, newText: p.text, blockKind: p.kind }
                : { type: 'delete', oldIndex: i, oldText: p.text, blockKind: p.kind }), limits);
            const summary = `${added ? '追加' : '削除'}（${doc.paras.length} 段落）`;
            return { ...base, kind: 'document', summary, blocks, ...truncInfo(truncated, base.warnings, limits) };
        }

        const blocks = compareParas(oldDoc.paras, newDoc.paras);
        const capped = capBlocks(blocks, limits);
        const known = (n: string) => oldDoc.known.has(n) || newDoc.known.has(n);
        const otherParts = otherPartChanges(oldZip, newZip, known);
        const changed = capped.blocks.some((b) => b.type !== 'equal');
        const status = !changed && otherParts.length === 0 ? 'unchanged' : 'modified';
        return {
            ...base,
            kind: 'document',
            status,
            summary: summarize(blocks, otherParts.length),
            blocks: capped.blocks,
            ...(otherParts.length ? { otherParts } : {}),
            ...truncInfo(capped.truncated, base.warnings, limits),
        };
    },
};

function truncInfo(truncated: boolean, warnings: string[], limits: DiffLimits): { truncated?: boolean } {
    if (!truncated) { return {}; }
    warnings.push(`変更が多いので、最初の ${limits.maxChanges} 件だけ表示する`);
    return { truncated: true };
}

/** 変更（equal 以外）が maxChanges を超えたら、そこで打ち切る */
function capBlocks(blocks: BlockChange[], limits: DiffLimits): { blocks: BlockChange[]; truncated: boolean } {
    let n = 0;
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'equal') { continue; }
        if (++n > limits.maxChanges) { return { blocks: blocks.slice(0, i), truncated: true }; }
    }
    return { blocks, truncated: false };
}

function summarize(blocks: BlockChange[], otherCount: number): string {
    const c = { modify: 0, insert: 0, delete: 0, format: 0 };
    for (const b of blocks) { if (b.type !== 'equal') { c[b.type]++; } }
    const parts: string[] = [];
    if (c.modify) { parts.push(`${c.modify} 段落を変更`); }
    if (c.insert) { parts.push(`${c.insert} 段落を追加`); }
    if (c.delete) { parts.push(`${c.delete} 段落を削除`); }
    if (c.format) { parts.push(`書式の変更 ${c.format} 段落`); }
    if (parts.length === 0) {
        return otherCount ? `段落は同じ。ほかの部品の変更 ${otherCount} 件` : '変更なし（文字と書式は同じ）';
    }
    if (otherCount) { parts.push(`ほかの部品の変更 ${otherCount} 件`); }
    return parts.join('、');
}

/** 段落の列どうしを比べる */
function compareParas(a: Para[], b: Para[]): BlockChange[] {
    const key = (p: Para) => `${p.area}\u0000${p.kind}\u0000${p.text}`;
    const ops = pairRuns(
        diffSequences(a.map(key), b.map(key)),
        (i, j) => a[i].area === b[j].area && similarity(a[i].text, b[j].text) >= 0.5,
    );
    const out: BlockChange[] = [];
    let eq: BlockChange | undefined;
    const flushEq = () => { if (eq) { out.push(eq); eq = undefined; } };
    for (const o of ops) {
        if (o.op === 'eq' && a[o.a].fmt === b[o.b].fmt) {
            if (eq) { eq.count!++; } else { eq = { type: 'equal', count: 1, oldIndex: o.a, newIndex: o.b }; }
            continue;
        }
        flushEq();
        if (o.op === 'eq' || (o.op === 'mod' && a[o.a].text === b[o.b].text)) {
            // 文字は同じで、書式か段落の種類（本文 → 見出し）が変わった
            out.push({ type: 'format', oldIndex: o.a, newIndex: o.b, oldText: a[o.a].text, newText: b[o.b].text, blockKind: b[o.b].kind });
        } else if (o.op === 'mod') {
            out.push({
                type: 'modify', oldIndex: o.a, newIndex: o.b, oldText: a[o.a].text, newText: b[o.b].text,
                inline: diffInline(a[o.a].text, b[o.b].text), blockKind: b[o.b].kind,
            });
        } else if (o.op === 'del') {
            out.push({ type: 'delete', oldIndex: o.a, oldText: a[o.a].text, blockKind: a[o.a].kind });
        } else {
            out.push({ type: 'insert', newIndex: o.b, newText: b[o.b].text, blockKind: b[o.b].kind });
        }
    }
    flushEq();
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

/** 本文の部品を探す（_rels/.rels の officeDocument → [Content_Types].xml → 既定の word/document.xml） */
function findMainPart(zip: ZipReader): string {
    for (const r of parseRels(zip.readText('_rels/.rels'), '').values()) {
        if (!r.external && /\/officeDocument$/.test(r.type) && zip.has(r.target)) { return r.target; }
    }
    const ct = zip.readText('[Content_Types].xml');
    if (ct) {
        for (const o of childrenNamed(parseXml(ct), 'Override')) {
            const name = (o.attrs.PartName ?? '').replace(/^\//, '');
            if (/wordprocessingml\.(document|template)\.main\+xml$/.test(o.attrs.ContentType ?? '') && zip.has(name)) { return name; }
        }
    }
    if (zip.has(MAIN_DEFAULT)) { return MAIN_DEFAULT; }
    throw new DiffFormatError('Word 文書の本文（word/document.xml）が見つからない');
}

/** 本文から関係で結ばれた部品のうち、段落として読むもの。種類 → blockKind */
const SUB_PARTS: [RegExp, string][] = [
    [/\/header$/, 'header'],
    [/\/footer$/, 'footer'],
    [/\/footnotes$/, 'footnote'],
    [/\/endnotes$/, 'endnote'],
    [/\/comments$/, 'comment'],
];

function readDocument(zip: ZipReader): DocModel {
    const main = findMainPart(zip);
    const known = new Set<string>([main]);
    const styles = new Map<string, boolean>();
    const paras: Para[] = [];
    const mainRels = relsPathOf(main);
    known.add(mainRels);
    const rels = parseRels(zip.readText(mainRels), dirOf(main));

    // 見出しのスタイル（日本語版の Word ではスタイルの ID が「1」などで、名前が「heading 1」）
    for (const r of rels.values()) {
        if (!r.external && /\/styles$/.test(r.type)) { readHeadingStyles(zip.readText(r.target), styles); }
    }

    const body = firstChild(parseXml(zip.readText(main)!), 'body');
    if (body) { collectParas(body, 'body', undefined, styles, paras); }

    const subs: { part: string; kind: string }[] = [];
    for (const r of rels.values()) {
        if (r.external) { continue; }
        const hit = SUB_PARTS.find(([re]) => re.test(r.type));
        if (hit && zip.has(r.target)) { subs.push({ part: r.target, kind: hit[1] }); }
    }
    subs.sort((x, y) => SUB_PARTS.findIndex((s) => s[1] === x.kind) - SUB_PARTS.findIndex((s) => s[1] === y.kind) || x.part.localeCompare(y.part));
    for (const s of subs) {
        known.add(s.part);
        const root = parseXml(zip.readText(s.part)!);
        // 区分は部品の名前（header1.xml と header2.xml の段落を取り違えない）
        const area = s.part.split('/').pop()!;
        if (s.kind === 'footnote' || s.kind === 'endnote') {
            for (const note of root.children) {
                // 区切り線などの決まった注は飛ばす
                if (!isElement(note) || (note.attrs['w:type'] && note.attrs['w:type'] !== 'normal')) { continue; }
                collectParas(note, area, s.kind, styles, paras);
            }
        } else {
            collectParas(root, area, s.kind, styles, paras);
        }
    }
    return { paras, known };
}

function readHeadingStyles(xml: string | undefined, out: Map<string, boolean>): void {
    if (!xml) { return; }
    for (const s of childrenNamed(parseXml(xml), 'style')) {
        const id = s.attrs['w:styleId'];
        if (!id) { continue; }
        const name = firstChild(s, 'name')?.attrs['w:val'] ?? '';
        const ppr = firstChild(s, 'pPr');
        if (/heading|見出し|title|表題/i.test(name) || (ppr && firstChild(ppr, 'outlineLvl'))) { out.set(id, true); }
    }
}

/**
 * 要素の中の段落を文書の順に集める（再帰を使わない）。表（w:tbl）の中はセルの段落として、
 * 内容の入れ物（w:sdt・w:customXml など）の中はそのまま辿る。段落の中の段落（テキストボックス）は外の段落の文字に含める
 */
function collectParas(root: XmlElement, area: string, fixedKind: string | undefined, styles: Map<string, boolean>, out: Para[]): void {
    const stack: { el: XmlNode; inTable: boolean }[] = [];
    for (let k = root.children.length - 1; k >= 0; k--) { stack.push({ el: root.children[k], inTable: false }); }
    while (stack.length) {
        const { el, inTable } = stack.pop()!;
        if (!isElement(el)) { continue; }
        const ln = localName(el.name);
        if (ln === 'p') {
            const { text, fmt, heading } = readPara(el, styles);
            const kind = fixedKind ?? (inTable ? 'table-cell' : heading ? 'heading' : 'paragraph');
            out.push({ area, kind, text, fmt });
            continue;
        }
        if (ln === 'sectPr' || ln === 'tblPr' || ln === 'tblGrid' || ln === 'trPr' || ln === 'tcPr' || ln === 'sdtPr' || ln === 'Fallback') { continue; }
        const nowTable = inTable || ln === 'tbl';
        for (let k = el.children.length - 1; k >= 0; k--) { stack.push({ el: el.children[k], inTable: nowTable }); }
    }
}

/** 保存のたびに変わる属性（書式の比較では無視する） */
const VOLATILE_ATTR = / (?:w:rsid[A-Za-z]*|w14:paraId|w14:textId)="[^"]*"/g;

function fmtKey(el: XmlElement | undefined): string {
    return el ? serialize(el).replace(VOLATILE_ATTR, '') : '';
}

/** 段落の文字と書式の指紋 */
function readPara(p: XmlElement, styles: Map<string, boolean>): { text: string; fmt: string; heading: boolean } {
    const ppr = firstChild(p, 'pPr');
    const style = ppr ? firstChild(ppr, 'pStyle')?.attrs['w:val'] ?? '' : '';
    const heading = !!ppr && (/heading|見出し|title/i.test(style) || styles.get(style) === true || !!firstChild(ppr, 'outlineLvl'));
    // 書式の指紋は「段落の書式」＋「同じ文字の書式の並びをつないだ (書式, 文字) の列」＋「図などの文字でない中身」
    const segs: { k: string; t: string }[] = [];
    let text = '';
    const add = (k: string, t: string) => {
        const last = segs[segs.length - 1];
        if (last && last.k === k) { last.t += t; } else { segs.push({ k, t }); }
    };
    const stack: { el: XmlNode; rk: string; wrap: string }[] = [];
    for (let k = p.children.length - 1; k >= 0; k--) { stack.push({ el: p.children[k], rk: '', wrap: '' }); }
    while (stack.length) {
        const { el, rk, wrap } = stack.pop()!;
        if (!isElement(el)) { continue; }
        const ln = localName(el.name);
        let childRk = rk;
        let childWrap = wrap;
        switch (ln) {
            case 'pPr': case 'rPr': case 'proofErr': case 'lastRenderedPageBreak': case 'bookmarkStart': case 'bookmarkEnd':
            case 'instrText': case 'Fallback':
                continue;
            case 't': { const s = textContent(el); text += s; add(wrap + rk, s); continue; }
            case 'tab': text += '\t'; add(wrap + rk, '\t'); continue;
            case 'br': case 'cr': text += '\n'; add(wrap + rk, '\n'); continue;
            case 'noBreakHyphen': text += '-'; add(wrap + rk, '-'); continue;
            case 'delText': add(`del${rk}`, textContent(el)); continue;
            case 'drawing': case 'pict': case 'object':
                // 図・埋め込み：中のテキストボックスの文字は辿って読み、図そのものは指紋に入れる
                add(`obj:${fmtKey(el).slice(0, 4096)}`, '');
                break;
            case 'r': childRk = fmtKey(firstChild(el, 'rPr')); break;
            case 'ins': childWrap = 'ins'; break;
        }
        for (let k = el.children.length - 1; k >= 0; k--) { stack.push({ el: el.children[k], rk: childRk, wrap: childWrap }); }
    }
    const fmt = `${fmtKey(ppr)}\u0001${segs.map((s) => `${s.k}\u0002${s.t}`).join('\u0003')}`;
    return { text, fmt, heading };
}
