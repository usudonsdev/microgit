/**
 * 構造を理解した差分（docs/structured-diff.md）を表示する Webview のパネル。
 * 拡張機能（diffCommand.ts）が計算した結果（StructuredDiff の JSON）を postMessage で渡し、Webview の中のスクリプトが描く。
 * - 結果の文字列（セルの値・段落の文字・ファイル名）は、すべて textContent で入れる。innerHTML には固定の文字列しか入れない
 *   （ファイルの中身は利用者以外が書いたものでありうる。CSP でスクリプトは nonce 付きのものしか動かないが、二重に防ぐ）
 * - 画像は結果に入れた data:image/png だけを表示する（CSP の img-src data:）。src に入れる前に data:image/png;base64, で始まるか確かめる
 * - パネルは 1 つを使い回す（新しい差分を開くと中身を差し替える）
 */
import * as vscode from 'vscode';
import { applyCsp } from './webviewCsp';
import type { StructuredDiff } from './diff/types';

export interface DiffViewInput {
    /** 表示の見出し（例：mb-3 3f2a1c0 の book.xlsx） */
    title: string;
    /** 何と何を比べたか（例：「1 つ前の保存 → この保存」） */
    subtitle: string;
    diff: StructuredDiff;
    driverLabel: string;
}

export class DiffView {
    private panel?: vscode.WebviewPanel;
    private pending?: DiffViewInput;
    private ready = false;

    show(input: DiffViewInput): void {
        this.pending = input;
        if (!this.panel) {
            this.ready = false;
            this.panel = vscode.window.createWebviewPanel('vereve.structuredDiff', `差分: ${input.title}`, vscode.ViewColumn.Active, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            });
            this.panel.webview.html = applyCsp(DIFF_HTML, undefined, { dataImages: true });
            this.panel.webview.onDidReceiveMessage((m: { command?: string }) => {
                if (m && m.command === 'ready') { this.ready = true; this.flush(); }
            });
            this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; });
        } else {
            this.panel.title = `差分: ${input.title}`;
            this.panel.reveal(vscode.ViewColumn.Active);
        }
        this.flush();
    }

    /** テスト用：いま表示している内容 */
    get current(): DiffViewInput | undefined { return this.pending; }

    private flush(): void {
        if (!this.panel || !this.ready || !this.pending) { return; }
        void this.panel.webview.postMessage({ type: 'diff', payload: this.pending });
    }

    dispose(): void { this.panel?.dispose(); }
}

/** パネルの HTML（描画の確認のために export する）。スクリプトは文字列で、Webview の中で動く。バッククォートを使わない（このテンプレートの中なので） */
export const DIFF_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --border: var(--vscode-panel-border, #444);
    --add: rgba(63, 185, 80, 0.22); --del: rgba(248, 81, 73, 0.22); --mod: rgba(210, 153, 34, 0.22);
    --add-fg: #3fb950; --del-fg: #f85149; --mod-fg: #d29922;
  }
  body { color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; padding: 12px 16px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 6px; }
  .sub, .muted { color: var(--muted); }
  .summary { margin: 8px 0; font-weight: 600; }
  .warn { color: var(--mod-fg); margin: 4px 0; }
  .chip { display: inline-block; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); margin-right: 4px; font-size: 11px; }
  .st-added, .ins { background: var(--add); }
  .st-deleted, .del { background: var(--del); }
  .st-modified, .st-renamed, .st-moved, .mod { background: var(--mod); }
  .del { text-decoration: line-through; }
  table { border-collapse: collapse; margin: 4px 0; }
  th, td { border: 1px solid var(--border); padding: 3px 6px; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: normal; }
  td.mono, .mono { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all; }
  .block { border-left: 3px solid var(--border); padding: 2px 8px; margin: 4px 0; white-space: pre-wrap; }
  .block.b-insert { border-color: var(--add-fg); }
  .block.b-delete { border-color: var(--del-fg); }
  .block.b-modify, .block.b-format { border-color: var(--mod-fg); }
  .block.b-equal { color: var(--muted); font-style: italic; }
  .card { border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; margin: 6px 0; }
  .imgs { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
  .imgs figure { margin: 0; }
  .imgs img { max-width: 360px; border: 1px solid var(--border); image-rendering: pixelated; }
  figcaption { color: var(--muted); font-size: 11px; }
  .timeline { position: relative; height: 18px; background: var(--vscode-editorWidget-background, #222); border: 1px solid var(--border); margin: 2px 0 8px; }
  .timeline div { position: absolute; top: 0; bottom: 0; }
  .seg-equal { background: transparent; }
  .seg-modified { background: var(--mod-fg); }
  .seg-inserted { background: var(--add-fg); }
  .seg-deleted { background: var(--del-fg); }
  .thumbs img { width: 160px; margin-right: 6px; border: 1px solid var(--border); }
  .collapsed { color: var(--muted); }
</style>
</head>
<body>
<div id="root"><p class="muted">読み込み中…</p></div>
<script>
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function img(src, caption) {
    const f = el('figure');
    if (typeof src === 'string' && src.indexOf('data:image/png;base64,') === 0) {
      const i = document.createElement('img');
      i.src = src;
      i.alt = caption || '';
      f.appendChild(i);
    }
    if (caption) { f.appendChild(el('figcaption', '', caption)); }
    return f;
  }
  const STATUS = { added: '追加', deleted: '削除', modified: '変更', unchanged: '変更なし', renamed: '名前を変更', moved: '並べ替え' };
  function chip(status) { return el('span', 'chip st-' + status, STATUS[status] || status); }
  function inline(parent, parts) {
    (parts || []).forEach(function (p) { add(parent, el('span', p.op === 'eq' ? '' : p.op, p.text)); });
  }
  function fmtTime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) { return '-'; }
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60;
    const ss = (r < 10 ? '0' : '') + r.toFixed(1);
    return (h > 0 ? h + ':' + (m < 10 ? '0' : '') + m : String(m)) + ':' + ss;
  }

  const CELL_CHANGE = { value: '値', formula: '式', computed: '式の結果だけ', style: '書式', added: '入力', removed: '削除' };
  function cellText(c) {
    if (!c) { return ''; }
    let s = c.v !== undefined ? c.v : '';
    if (c.f) { s = '=' + c.f + (s !== '' ? '  → ' + s : ''); }
    if (c.style) { s += '  [' + c.style + ']'; }
    return s;
  }

  function renderTable(d, out) {
    (d.sheets || []).forEach(function (s) {
      const h = add(out, el('h2'));
      h.appendChild(document.createTextNode('シート：' + s.name + ' '));
      h.appendChild(chip(s.status));
      if (s.oldName) { add(out, el('div', 'muted', '旧の名前：' + s.oldName)); }
      if (s.oldIndex !== undefined && s.newIndex !== undefined && s.oldIndex !== s.newIndex) {
        add(out, el('div', 'muted', '並び：' + (s.oldIndex + 1) + ' 番目 → ' + (s.newIndex + 1) + ' 番目'));
      }
      const ops = [];
      (s.rowOps || []).forEach(function (o) { ops.push((o.type === 'insert' ? '行の挿入 ' : '行の削除 ') + o.at + (o.count > 1 ? '〜' + (o.at + o.count - 1) : '') + ' 行目'); });
      (s.colOps || []).forEach(function (o) { ops.push((o.type === 'insert' ? '列の挿入 ' : '列の削除 ') + o.at + (o.count > 1 ? '〜' + (o.at + o.count - 1) : '') + ' 列目'); });
      if (s.mergesAdded) { ops.push('結合を追加：' + s.mergesAdded.join(', ')); }
      if (s.mergesRemoved) { ops.push('結合を解除：' + s.mergesRemoved.join(', ')); }
      ops.forEach(function (t) { add(out, el('div', '', t)); });
      if (s.status === 'unchanged') { add(out, el('div', 'collapsed', '変わったセルはない')); return; }
      if (!s.cells || !s.cells.length) { return; }
      const t = add(out, el('table'));
      const hr = add(t, el('tr'));
      ['番地', '種類', '前', '後'].forEach(function (x) { add(hr, el('th', '', x)); });
      s.cells.forEach(function (c) {
        const tr = add(t, el('tr'));
        const ref = c.oldRef && c.newRef && c.oldRef !== c.newRef ? c.oldRef + ' → ' + c.newRef : (c.newRef || c.oldRef || '');
        add(tr, el('td', 'mono', ref));
        const kind = CELL_CHANGE[c.change] || c.change;
        add(tr, el('td', c.change === 'added' ? 'ins' : c.change === 'removed' ? 'del' : 'mod', kind + (c.styleAspects ? '（' + c.styleAspects.join('・') + '）' : '')));
        add(tr, el('td', 'mono', cellText(c.old)));
        add(tr, el('td', 'mono', cellText(c.new)));
      });
      if (s.truncated) { add(out, el('div', 'warn', '多いので途中までを表示している')); }
    });
  }

  const BLOCK_KIND = { heading: '見出し', paragraph: '', 'table-cell': '表', header: 'ヘッダー', footer: 'フッター', footnote: '脚注', endnote: '文末脚注', comment: 'コメント' };
  function renderDocument(d, out) {
    (d.blocks || []).forEach(function (b) {
      const div = add(out, el('div', 'block b-' + b.type));
      const kind = BLOCK_KIND[b.blockKind] || '';
      if (b.type === 'equal') { div.textContent = '… 変わらない段落 ' + (b.count || 0) + ' 個 …'; return; }
      const label = { insert: '追加', delete: '削除', modify: '変更', format: '書式だけ変更' }[b.type] || b.type;
      add(div, el('span', 'chip', label + (kind ? '・' + kind : '')));
      if (b.type === 'modify' && b.inline) { inline(div, b.inline); }
      else if (b.type === 'insert') { add(div, el('span', 'ins', b.newText || '')); }
      else if (b.type === 'delete') { add(div, el('span', 'del', b.oldText || '')); }
      else { div.appendChild(document.createTextNode(b.newText || b.oldText || '')); }
    });
  }

  function renderSlides(d, out) {
    const unchanged = (d.slides || []).filter(function (s) { return s.status === 'unchanged'; }).length;
    (d.slides || []).forEach(function (s) {
      if (s.status === 'unchanged') { return; }
      const card = add(out, el('div', 'card'));
      const h = add(card, el('div'));
      const no = s.newIndex !== undefined ? 'スライド ' + (s.newIndex + 1) : 'スライド（旧 ' + ((s.oldIndex || 0) + 1) + '）';
      h.appendChild(document.createTextNode(no + ' '));
      h.appendChild(chip(s.status));
      if (s.status === 'moved' && s.oldIndex !== undefined) { h.appendChild(document.createTextNode(' 旧 ' + (s.oldIndex + 1) + ' 番目から')); }
      if (s.title) { add(card, el('div', 'muted', 'タイトル：' + s.title)); }
      (s.shapes || []).forEach(function (sh) {
        if (sh.status === 'unchanged' && !sh.moved) { return; }
        const row = add(card, el('div', 'block b-' + (sh.status === 'added' ? 'insert' : sh.status === 'deleted' ? 'delete' : 'modify')));
        add(row, el('span', 'chip', (STATUS[sh.status] || sh.status) + (sh.moved ? '・位置' : '') + '：' + sh.name));
        if (sh.inline) { inline(row, sh.inline); }
        else if (sh.status === 'added') { add(row, el('span', 'ins', sh.newText || '')); }
        else if (sh.status === 'deleted') { add(row, el('span', 'del', sh.oldText || '')); }
        else if (sh.newText) { row.appendChild(document.createTextNode(sh.newText)); }
      });
      if (s.notesChange) {
        const row = add(card, el('div', 'block b-modify'));
        add(row, el('span', 'chip', 'ノート'));
        if (s.notesChange.inline) { inline(row, s.notesChange.inline); } else { row.appendChild(document.createTextNode(s.notesChange.newText || '')); }
      }
    });
    if (unchanged) { add(out, el('div', 'collapsed', '変わらないスライド ' + unchanged + ' 枚')); }
  }

  function renderImage(d, out) {
    const sz = function (s) { return s ? s.w + '×' + s.h : '-'; };
    add(out, el('div', '', '大きさ：' + sz(d.oldSize) + ' → ' + sz(d.newSize)));
    if (typeof d.changedRatio === 'number' && !d.sizeChanged) { add(out, el('div', '', '変わった画素：' + (d.changedRatio * 100).toFixed(2) + '%')); }
    const p = d.previews || {};
    const box = add(out, el('div', 'imgs'));
    if (p.old) { box.appendChild(img(p.old, '前')); }
    if (p.new) { box.appendChild(img(p.new, '後')); }
    if (p.heat) { box.appendChild(img(p.heat, '変わったところ（赤）')); }
    if (d.regions && d.regions.length) {
      add(out, el('h2', '', '変わった範囲'));
      const t = add(out, el('table'));
      const hr = add(t, el('tr'));
      ['x', 'y', '幅', '高さ'].forEach(function (x) { add(hr, el('th', '', x)); });
      d.regions.forEach(function (r) {
        const tr = add(t, el('tr'));
        [r.x, r.y, r.w, r.h].forEach(function (v) { add(tr, el('td', 'mono', v)); });
      });
    }
  }

  const SEG = { equal: '同じ', modified: '差し替え', inserted: '追加', deleted: '削除' };
  function timeline(parent, segs, side, total) {
    const bar = add(parent, el('div', 'timeline'));
    if (!total || total <= 0) { return; }
    segs.forEach(function (s) {
      const a = side === 'old' ? s.oldStart : s.newStart;
      const b = side === 'old' ? s.oldEnd : s.newEnd;
      if (typeof a !== 'number' || typeof b !== 'number' || s.type === 'equal') { return; }
      const d = add(bar, el('div', 'seg-' + s.type));
      d.style.left = (100 * a / total) + '%';
      d.style.width = Math.max(0.3, 100 * (b - a) / total) + '%';
      d.title = SEG[s.type] + ' ' + fmtTime(a) + '〜' + fmtTime(b);
    });
  }
  function renderVideo(d, out) {
    const info = function (i) {
      if (!i) { return '-'; }
      return fmtTime(i.durationSec) + (i.width ? '、' + i.width + '×' + i.height : '') + (i.fps ? '、' + i.fps.toFixed(2) + ' fps' : '') + (i.videoCodec ? '、' + i.videoCodec : '') + (i.hasAudio ? '、音声あり' : '');
    };
    add(out, el('div', '', '前：' + info(d.oldInfo)));
    add(out, el('div', '', '後：' + info(d.newInfo)));
    if (d.sampleIntervalSec) { add(out, el('div', 'muted', '比べたコマの間隔：' + d.sampleIntervalSec.toFixed(3) + ' 秒')); }
    const segs = d.segments || [];
    add(out, el('div', 'muted', '前の動画'));
    timeline(out, segs, 'old', d.oldInfo && d.oldInfo.durationSec);
    add(out, el('div', 'muted', '後の動画'));
    timeline(out, segs, 'new', d.newInfo && d.newInfo.durationSec);
    segs.forEach(function (s) {
      if (s.type === 'equal') { return; }
      const card = add(out, el('div', 'card'));
      const range = function (a, b) { return typeof a === 'number' ? fmtTime(a) + '〜' + fmtTime(b) : '-'; };
      add(card, el('div', '', SEG[s.type] + '：前 ' + range(s.oldStart, s.oldEnd) + ' / 後 ' + range(s.newStart, s.newEnd)));
      const th = add(card, el('div', 'imgs thumbs'));
      if (s.thumbOld) { th.appendChild(img(s.thumbOld, '前')); }
      if (s.thumbNew) { th.appendChild(img(s.thumbNew, '後')); }
      if (s.heat) { th.appendChild(img(s.heat, '変わったところ')); }
    });
    if (d.audio) {
      add(out, el('h2', '', '音声'));
      if (d.audio.note) { add(out, el('div', 'muted', d.audio.note)); }
      const changed = (d.audio.segments || []).filter(function (s) { return s.type !== 'equal'; });
      if (!changed.length) { add(out, el('div', 'collapsed', '音声の変わった区間はない')); }
      changed.forEach(function (s) {
        add(out, el('div', '', SEG[s.type] + '：前 ' + (typeof s.oldStart === 'number' ? fmtTime(s.oldStart) + '〜' + fmtTime(s.oldEnd) : '-') + ' / 後 ' + (typeof s.newStart === 'number' ? fmtTime(s.newStart) + '〜' + fmtTime(s.newEnd) : '-')));
      });
    }
  }

  function render(input) {
    root.textContent = '';
    const d = input.diff || {};
    const h = add(root, el('h1'));
    h.appendChild(document.createTextNode(input.title + ' '));
    if (d.status) { h.appendChild(chip(d.status)); }
    add(root, el('div', 'sub', input.subtitle + '（' + input.driverLabel + '）'));
    add(root, el('div', 'summary', d.summary || ''));
    (d.warnings || []).forEach(function (w) { add(root, el('div', 'warn', w)); });
    const out = add(root, el('div'));
    if (d.kind === 'table') { renderTable(d, out); }
    else if (d.kind === 'document') { renderDocument(d, out); }
    else if (d.kind === 'slides') { renderSlides(d, out); }
    else if (d.kind === 'image') { renderImage(d, out); }
    else if (d.kind === 'video') { renderVideo(d, out); }
    else if (d.kind === 'error') { add(out, el('div', 'warn', d.message || '')); }
    else if (d.kind === 'binary') { add(out, el('div', 'muted', '大きさ：' + (d.oldSize === undefined ? '-' : d.oldSize) + ' → ' + (d.newSize === undefined ? '-' : d.newSize) + ' バイト')); }
    if (d.otherParts && d.otherParts.length) {
      add(root, el('h2', '', 'その他の部品（中身は解釈していない）'));
      d.otherParts.forEach(function (p) {
        const row = add(root, el('div', 'mono'));
        row.appendChild(chip(p.status));
        row.appendChild(document.createTextNode(p.name));
      });
    }
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.type === 'diff' && msg.payload) { render(msg.payload); }
  });
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
