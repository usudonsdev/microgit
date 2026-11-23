/**
 * OOXML を読むための最小の XML パーサ。依存を増やさないため自前で持つ。
 *
 * 信頼できない入力を読む前提：
 * - DTD（<!DOCTYPE ...>）は中身を解釈しない（読み飛ばす）。実体参照は既定の 5 つ（&lt; など）と数値（&#...;）だけ展開する。
 *   独自の実体を展開しないので、実体の入れ子で膨らませる攻撃（billion laughs）は効かない
 * - 再帰を使わない（スタックで組み立てる）。深い入れ子でもスタックあふれにならない
 * - 名前空間は解釈しない。名前は接頭辞つきのまま（w:p）。localName() で接頭辞を外せる
 * 形が少し崩れていても（閉じタグの名前の不一致など）、例外にせずできるだけ読む。
 */
import { DiffFormatError } from './types';

export interface XmlElement {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
}
export type XmlNode = XmlElement | string;

export function isElement(n: XmlNode | undefined): n is XmlElement {
    return typeof n === 'object' && n !== null;
}

/** 接頭辞を外した名前（w:p → p） */
export function localName(name: string): string {
    const i = name.indexOf(':');
    return i < 0 ? name : name.slice(i + 1);
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
    if (s.indexOf('&') < 0) { return s; }
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) { return m; }
            try { return String.fromCodePoint(code); } catch { return m; }
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
    });
}

/** XML の文字列を読んで、根の要素を返す */
export function parseXml(text: string): XmlElement {
    const root: XmlElement = { name: '#document', attrs: {}, children: [] };
    const stack: XmlElement[] = [root];
    // 開いている要素の名前ごとの数。対応する開きタグの無い閉じタグで、スタックを毎回たどらないため（レビュー #1）
    const openCount = new Map<string, number>();
    let i = 0;
    const n = text.length;
    while (i < n) {
        const lt = text.indexOf('<', i);
        if (lt < 0) {
            pushText(stack[stack.length - 1], text.slice(i));
            break;
        }
        if (lt > i) { pushText(stack[stack.length - 1], text.slice(i, lt)); }
        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            i = end < 0 ? n : end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            const body = text.slice(lt + 9, end < 0 ? n : end);
            stack[stack.length - 1].children.push(body);
            i = end < 0 ? n : end + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) {
            const end = text.indexOf('?>', lt + 2);
            i = end < 0 ? n : end + 2;
            continue;
        }
        if (text.startsWith('<!', lt)) {
            // DOCTYPE など。内部サブセット [...] を含むことがあるので、角かっこの対応を見て読み飛ばす（中身は解釈しない）
            let j = lt + 2;
            let depth = 0;
            for (; j < n; j++) {
                const c = text[j];
                if (c === '[') { depth++; } else if (c === ']') { depth--; } else if (c === '>' && depth <= 0) { break; }
            }
            i = j + 1;
            continue;
        }
        if (text[lt + 1] === '/') {
            const end = text.indexOf('>', lt + 2);
            if (end < 0) { break; }
            const name = text.slice(lt + 2, end).trim();
            // 対応する開きタグまで戻る。開いていなければ無視する
            if ((openCount.get(name) ?? 0) > 0) {
                for (let k = stack.length - 1; k > 0; k--) {
                    const nm = stack[k].name;
                    openCount.set(nm, (openCount.get(nm) ?? 1) - 1);
                    if (nm === name) { stack.length = k; break; }
                }
            }
            i = end + 1;
            continue;
        }
        // 開きタグ。属性値の中の > に注意して終わりを探す
        let j = lt + 1;
        let quote = '';
        for (; j < n; j++) {
            const c = text[j];
            if (quote) { if (c === quote) { quote = ''; } continue; }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === '>') { break; }
        }
        if (j >= n) { throw new DiffFormatError('XML の開きタグが閉じていない'); }
        let body = text.slice(lt + 1, j);
        const selfClose = body.endsWith('/');
        if (selfClose) { body = body.slice(0, -1); }
        const m = /^([^\s/>]+)/.exec(body);
        if (!m) { i = j + 1; continue; }
        const el: XmlElement = { name: m[1], attrs: parseAttrs(body.slice(m[1].length)), children: [] };
        stack[stack.length - 1].children.push(el);
        if (!selfClose) { stack.push(el); openCount.set(el.name, (openCount.get(el.name) ?? 0) + 1); }
        i = j + 1;
    }
    const top = root.children.find(isElement);
    if (!top) { throw new DiffFormatError('XML に要素が無い'); }
    return top;
}

function pushText(parent: XmlElement, raw: string): void {
    if (raw.length === 0) { return; }
    parent.children.push(decodeEntities(raw));
}

function parseAttrs(s: string): Record<string, string> {
    // 属性の名前に __proto__ などが来ても、普通のキーとして持つ（プロトタイプの無いオブジェクト。レビュー #8）
    const out: Record<string, string> = Object.create(null);
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
        out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
    }
    return out;
}

/** 子の要素（接頭辞を無視した名前で絞る） */
export function childrenNamed(el: XmlElement, local: string): XmlElement[] {
    return el.children.filter((c): c is XmlElement => isElement(c) && localName(c.name) === local);
}

export function firstChild(el: XmlElement, local: string): XmlElement | undefined {
    return el.children.find((c): c is XmlElement => isElement(c) && localName(c.name) === local);
}

/** 子孫の要素を、文書の順に全部たどる（再帰を使わない） */
export function* descendants(el: XmlElement): Generator<XmlElement> {
    const stack: XmlNode[] = [...el.children].reverse();
    while (stack.length) {
        const c = stack.pop()!;
        if (!isElement(c)) { continue; }
        yield c;
        for (let k = c.children.length - 1; k >= 0; k--) { stack.push(c.children[k]); }
    }
}

/** 子孫のうち、接頭辞を無視した名前が local の要素 */
export function findAll(el: XmlElement, local: string): XmlElement[] {
    const out: XmlElement[] = [];
    for (const d of descendants(el)) { if (localName(d.name) === local) { out.push(d); } }
    return out;
}

/** 要素の中の文字（子孫の文字をつないだもの） */
export function textContent(el: XmlElement): string {
    let s = '';
    const stack: XmlNode[] = [el];
    while (stack.length) {
        const c = stack.pop()!;
        if (typeof c === 'string') { s += c; continue; }
        for (let k = c.children.length - 1; k >= 0; k--) { stack.push(c.children[k]); }
    }
    return s;
}

/** 要素を XML の文字列に戻す（比較の指紋用。元の文字列と一致する保証はない） */
export function serialize(el: XmlNode): string {
    const parts: string[] = [];
    const stack: (XmlNode | { close: string })[] = [el];
    while (stack.length) {
        const c = stack.pop()!;
        if (typeof c === 'string') { parts.push(c.replace(/&/g, '&amp;').replace(/</g, '&lt;')); continue; }
        if ('close' in c) { parts.push(`</${c.close}>`); continue; }
        const attrs = Object.keys(c.attrs).sort().map((k) => ` ${k}="${c.attrs[k].replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
        if (c.children.length === 0) { parts.push(`<${c.name}${attrs}/>`); continue; }
        parts.push(`<${c.name}${attrs}>`);
        stack.push({ close: c.name });
        for (let k = c.children.length - 1; k >= 0; k--) { stack.push(c.children[k]); }
    }
    return parts.join('');
}

/**
 * OOXML の関係（_rels/*.rels）を読む。Id → 対象のパス（ZIP の中の絶対パス、先頭の / なし）。
 * baseDir は .rels が属する部品のフォルダ（例：xl/_rels/workbook.xml.rels なら xl）
 */
export function parseRels(xml: string | undefined, baseDir: string): Map<string, { target: string; type: string; external: boolean }> {
    const out = new Map<string, { target: string; type: string; external: boolean }>();
    if (!xml) { return out; }
    const root = parseXml(xml);
    for (const r of childrenNamed(root, 'Relationship')) {
        const id = r.attrs.Id;
        const target = r.attrs.Target ?? '';
        if (!id) { continue; }
        const external = r.attrs.TargetMode === 'External';
        out.set(id, { target: external ? target : resolvePartPath(baseDir, target), type: r.attrs.Type ?? '', external });
    }
    return out;
}

/** 部品のパスを解決する（../ を畳む。先頭の / はパッケージの根） */
export function resolvePartPath(baseDir: string, target: string): string {
    const parts = (target.startsWith('/') ? target.slice(1) : (baseDir ? `${baseDir}/${target}` : target)).split('/');
    const out: string[] = [];
    for (const p of parts) {
        if (p === '' || p === '.') { continue; }
        if (p === '..') { out.pop(); continue; }
        out.push(p);
    }
    return out.join('/');
}
