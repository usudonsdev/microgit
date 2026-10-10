import * as vscode from 'vscode';
import { timeSync } from './syncWorkLog';
import { filterCommitsByMainInterval, type MainIntervalOption } from './mainHead';

export interface GraphCommit {
    hash: string;
    parents: string[];
    tags: string[];
    subject: string;
    timestamp: string;
    /** 作成時のメインリポジトリ HEAD（Main-Head trailer） */
    mainHead?: string;
}

export interface MicroGitUiSnapshot {
    enabled: boolean;
    targetBranch?: string;
    currentBranch?: string;
    onTarget: boolean;
    active: boolean;
    currentTag: string;
    currentHead?: string;
    commits: GraphCommit[];
    /** メインコミット区間フィルタ用オプション */
    mainIntervals?: MainIntervalOption[];
    hasShadow: boolean;
    workspaceOpen: boolean;
}

/**
 * Activity Bar の専用ビューとグラフパネルを管理し、状態変更をリアルタイム反映する
 */
export class MicroGitUi implements vscode.WebviewViewProvider {
    public static readonly viewType = 'microgit.sidebar';

    private view?: vscode.WebviewView;
    private graphPanel?: vscode.WebviewPanel;
    private latest: MicroGitUiSnapshot = emptySnapshot();
    /** サイドバー／グラフ共通のメインコミット区間フィルタ */
    private selectedIntervalId = 'all';

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = getSidebarHtml();
        webviewView.webview.onDidReceiveMessage((message) => {
            void this.handleSidebarMessage(message);
        });
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });
        this.postToSidebar();
    }

    update(snapshot: MicroGitUiSnapshot): void {
        this.latest = snapshot;
        this.postToSidebar();
        this.postToGraph();
    }

    showGraphPanel(): void {
        if (!this.latest.workspaceOpen) {
            vscode.window.showWarningMessage('ワークスペースを開いてからグラフを表示してください。');
            return;
        }
        if (!this.latest.active) {
            vscode.window.showWarningMessage('MicroGit が無効、または記録可能なブランチ上にいないためグラフを表示できません。');
            return;
        }
        if (!this.latest.hasShadow) {
            vscode.window.showWarningMessage('シャドウリポジトリがまだ存在しません。ファイルを保存して履歴を作ってください。');
            return;
        }

        if (this.graphPanel) {
            this.graphPanel.reveal(vscode.ViewColumn.One);
            this.postToGraph();
            return;
        }

        this.graphPanel = vscode.window.createWebviewPanel(
            'microgitGraph',
            'MicroGit Graph',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.graphPanel.webview.html = getGraphHtml();
        this.graphPanel.webview.onDidReceiveMessage((message) => {
            void this.handleGraphMessage(message);
        });
        this.graphPanel.onDidDispose(() => {
            this.graphPanel = undefined;
        });
        this.postToGraph();
    }

    private resolveInterval(): MainIntervalOption {
        const intervals = this.latest.mainIntervals?.length
            ? this.latest.mainIntervals
            : emptySnapshot().mainIntervals!;
        const found = intervals.find((i) => i.id === this.selectedIntervalId);
        if (found) {
            return found;
        }
        this.selectedIntervalId = 'all';
        return intervals.find((i) => i.id === 'all') ?? { id: 'all', label: 'すべて（ブランチ全体）', mainHead: null };
    }

    private viewPayload(): MicroGitUiSnapshot & { selectedIntervalId: string; filteredCount: number; totalCount: number } {
        const interval = this.resolveInterval();
        const filtered = filterCommitsByMainInterval(this.latest.commits, interval.mainHead);
        return {
            ...this.latest,
            commits: filtered,
            selectedIntervalId: interval.id,
            filteredCount: filtered.length,
            totalCount: this.latest.commits.length,
        };
    }

    private postToSidebar(): void {
        timeSync('ui.postToSidebar', () => this.view?.webview.postMessage({ type: 'update', payload: timeSync('ui.viewPayload', () => this.viewPayload()) }), () => `view=${this.view ? 'yes' : 'no'}`);
    }

    private postToGraph(): void {
        timeSync('ui.postToGraph', () => this.postToGraphBody(), () => `panel=${this.graphPanel ? 'yes' : 'no'}`);
    }

    private postToGraphBody(): void {
        const payload = timeSync('ui.viewPayload', () => this.viewPayload());
        this.graphPanel?.webview.postMessage({
            type: 'update',
            payload: {
                commits: payload.commits,
                currentHead: payload.currentHead,
                currentTag: payload.currentTag,
                active: payload.active,
                hasShadow: payload.hasShadow,
                mainIntervals: payload.mainIntervals,
                selectedIntervalId: payload.selectedIntervalId,
                filteredCount: payload.filteredCount,
                totalCount: payload.totalCount,
            },
        });
    }

    private setIntervalFilter(intervalId: string): void {
        this.selectedIntervalId = intervalId || 'all';
        this.postToSidebar();
        this.postToGraph();
    }

    private async handleSidebarMessage(message: {
        command?: string;
        hash?: string;
        intervalId?: string;
    }): Promise<void> {
        switch (message.command) {
            case 'toggle':
                await vscode.commands.executeCommand('microgit.toggle');
                return;
            case 'showGraph':
                this.showGraphPanel();
                return;
            case 'jumpToCommit':
                if (typeof message.hash === 'string') {
                    await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
                }
                return;
            case 'jumpPrompt':
                await vscode.commands.executeCommand('microgit.jumpToCommit');
                return;
            case 'exportLogs':
                await vscode.commands.executeCommand('microgit.exportLogs');
                return;
            case 'setInterval':
                if (typeof message.intervalId === 'string') {
                    this.setIntervalFilter(message.intervalId);
                }
                return;
            case 'ready':
                this.postToSidebar();
                return;
        }
    }

    private async handleGraphMessage(message: {
        command?: string;
        hash?: string;
        intervalId?: string;
    }): Promise<void> {
        if (message.command === 'jumpToCommit' && typeof message.hash === 'string') {
            await vscode.commands.executeCommand('microgit.jumpToCommit', message.hash);
            return;
        }
        if (message.command === 'setInterval' && typeof message.intervalId === 'string') {
            this.setIntervalFilter(message.intervalId);
            return;
        }
        if (message.command === 'ready') {
            this.postToGraph();
        }
    }
}

function emptySnapshot(): MicroGitUiSnapshot {
    return {
        enabled: false,
        onTarget: false,
        active: false,
        currentTag: 'mb-1',
        commits: [],
        mainIntervals: [{ id: 'all', label: 'すべて（ブランチ全体）', mainHead: null }],
        hasShadow: false,
        workspaceOpen: false,
    };
}

function getSidebarHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, #444);
    --btn: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn2: var(--vscode-button-secondaryBackground);
    --btn2-fg: var(--vscode-button-secondaryForeground);
    --active: var(--vscode-charts-green, #3fb950);
    --warn: var(--vscode-charts-orange, #d29922);
    --card: var(--vscode-editor-background);
  }
  body {
    margin: 0;
    padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
  }
  h1 { font-size: 13px; margin: 0 0 10px; font-weight: 600; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
  }
  .row { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0; }
  .label { color: var(--muted); }
  .value { font-weight: 600; text-align: right; word-break: break-all; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
  }
  .badge.on { background: rgba(63, 185, 80, 0.2); color: var(--active); }
  .badge.off { background: rgba(128, 128, 128, 0.2); color: var(--muted); }
  .badge.warn { background: rgba(210, 153, 34, 0.2); color: var(--warn); }
  .actions { display: grid; gap: 6px; margin-bottom: 10px; }
  button {
    border: none;
    border-radius: 4px;
    padding: 7px 10px;
    cursor: pointer;
    font: inherit;
  }
  button.primary { background: var(--btn); color: var(--btn-fg); }
  button.secondary { background: var(--btn2); color: var(--btn2-fg); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .list { display: grid; gap: 4px; max-height: 50vh; overflow: auto; }
  .item {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
    background: transparent;
    text-align: left;
    color: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .item:hover { outline: 1px solid var(--btn); }
  .item.active { border-color: var(--active); background: rgba(63, 185, 80, 0.08); }
  .item-compact { display: flex; justify-content: space-between; gap: 8px; }
  .item-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .item-time { color: var(--muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; }
  .empty { color: var(--muted); font-size: 12px; }
  .filter-row { margin-bottom: 8px; }
  .filter-row label {
    display: block;
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 4px;
  }
  select#interval-filter {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--fg);
    font: inherit;
  }
  .filter-meta { color: var(--muted); font-size: 11px; margin: 0 0 8px; }
  .hover-tip {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--fg);
    font-size: 11px;
    line-height: 1.45;
    pointer-events: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .hover-tip[hidden] { display: none; }
</style>
</head>
<body>
  <h1>MicroGit Control</h1>
  <div class="card" id="status-card">
    <div class="row"><span class="label">状態</span><span id="status-badge" class="badge off">OFF</span></div>
    <div class="row"><span class="label">マイクロ空間</span><span class="value" id="target-branch">-</span></div>
    <div class="row"><span class="label">現在ブランチ</span><span class="value" id="current-branch">-</span></div>
    <div class="row"><span class="label">マイクロタグ</span><span class="value" id="current-tag">-</span></div>
    <div class="row"><span class="label">HEAD</span><span class="value" id="current-head">-</span></div>
  </div>

  <div class="actions">
    <button class="primary" id="btn-toggle">有効化 / 無効化</button>
    <button class="secondary" id="btn-graph">グラフを開く</button>
    <button class="secondary" id="btn-jump">タグ / ハッシュへジャンプ</button>
    <button class="secondary" id="btn-export">ログをエクスポート</button>
  </div>

  <h1>最近のマイクロ履歴</h1>
  <div class="filter-row">
    <label for="interval-filter">メインコミット区間</label>
    <select id="interval-filter"></select>
  </div>
  <p class="filter-meta" id="filter-meta"></p>
  <div class="list" id="commit-list"><div class="empty">履歴はまだありません</div></div>
  <div id="sidebar-tip" class="hover-tip" hidden></div>

  <script>
    const vscode = acquireVsCodeApi();
    const statusBadge = document.getElementById('status-badge');
    const targetBranch = document.getElementById('target-branch');
    const currentBranch = document.getElementById('current-branch');
    const currentTag = document.getElementById('current-tag');
    const currentHead = document.getElementById('current-head');
    const commitList = document.getElementById('commit-list');
    const btnGraph = document.getElementById('btn-graph');
    const btnJump = document.getElementById('btn-jump');
    const btnExport = document.getElementById('btn-export');
    const sidebarTip = document.getElementById('sidebar-tip');
    const intervalFilter = document.getElementById('interval-filter');
    const filterMeta = document.getElementById('filter-meta');

    document.getElementById('btn-toggle').onclick = () => vscode.postMessage({ command: 'toggle' });
    btnGraph.onclick = () => vscode.postMessage({ command: 'showGraph' });
    btnJump.onclick = () => vscode.postMessage({ command: 'jumpPrompt' });
    btnExport.onclick = () => vscode.postMessage({ command: 'exportLogs' });
    intervalFilter.onchange = () => {
      vscode.postMessage({ command: 'setInterval', intervalId: intervalFilter.value });
    };

    function short(hash) {
      return hash ? hash.substring(0, 7) : '-';
    }

    function fillIntervalOptions(intervals, selectedId) {
      const list = Array.isArray(intervals) ? intervals : [];
      intervalFilter.innerHTML = '';
      list.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = opt.label;
        intervalFilter.appendChild(o);
      });
      intervalFilter.value = selectedId || 'all';
      if (intervalFilter.value !== (selectedId || 'all') && list.length) {
        intervalFilter.value = list[0].id;
      }
    }

    function commitLabel(c) {
      if (c.tags && c.tags.length) {
        return c.tags[c.tags.length - 1];
      }
      return short(c.hash);
    }

    function isAiCommit(c) {
      return /\\[AI\\]/i.test(c.subject || '');
    }

    /** subject から更新内容（相対パス等）を取り出す */
    function updateSummary(c) {
      const subject = c.subject || '';
      const m = subject.match(/saved\\s+(.+?)\\s+at\\s+/i);
      if (m && m[1]) {
        return m[1].replace(/^\\[AI\\]\\s*/i, '').trim();
      }
      const cleaned = subject.replace(/^micro:\\s*/i, '').replace(/^\\[AI\\]\\s*/i, '').trim();
      return cleaned || short(c.hash);
    }

    /** 非ホバー時: ブランチ先端は mb-N、それ以外は短縮ハッシュ。AI は [AI] 付き */
    function compactDisplay(c) {
      const summary = updateSummary(c);
      const tipTag = (c.tags || []).filter((t) => /^mb-\\d+$/.test(t)).pop();
      const head = tipTag || short(c.hash);
      if (isAiCommit(c)) {
        return head + ' [AI] (' + summary + ')';
      }
      return head + ' (' + summary + ')';
    }

    function shortTime(timestamp) {
      if (!timestamp) { return '-'; }
      const parts = String(timestamp).split(' ');
      const timePart = parts.length > 1 ? parts[parts.length - 1] : timestamp;
      return timePart.length >= 5 ? timePart.slice(0, 5) : timePart;
    }

    function commitDetailText(c) {
      const lines = [
        'hash: ' + (c.hash || '-'),
        'message: ' + (c.subject || '(no message)'),
        'time: ' + (c.timestamp || '-'),
        'main-head: ' + (c.mainHead ? short(c.mainHead) : '(none)'),
      ];
      if (isAiCommit(c)) {
        lines.push('source: AI agent');
      }
      if (c.tags && c.tags.length) {
        lines.push('tags: ' + c.tags.join(', '));
      }
      if (c.parents && c.parents.length) {
        lines.push('parents: ' + c.parents.map(short).join(', '));
      }
      return lines.join('\\n');
    }

    function showTip(tipEl, text, target) {
      tipEl.textContent = text;
      tipEl.hidden = false;
      const rect = target.getBoundingClientRect();
      tipEl.style.left = Math.min(rect.left, window.innerWidth - 330) + 'px';
      tipEl.style.top = (rect.bottom + 6) + 'px';
    }

    function hideTip(tipEl) {
      tipEl.hidden = true;
    }

    function render(payload) {
      const active = !!payload.active;
      const enabled = !!payload.enabled;
      statusBadge.className = 'badge ' + (active ? 'on' : (enabled ? 'warn' : 'off'));
      statusBadge.textContent = active ? 'ACTIVE' : (enabled ? '待機中' : 'OFF');
      targetBranch.textContent = payload.targetBranch || '-';
      currentBranch.textContent = payload.currentBranch || '-';
      currentTag.textContent = payload.currentTag || '-';
      currentHead.textContent = short(payload.currentHead);

      btnGraph.disabled = !active || !payload.hasShadow;
      btnJump.disabled = !active || !payload.hasShadow;
      btnExport.disabled = !payload.onTarget;

      fillIntervalOptions(payload.mainIntervals, payload.selectedIntervalId);
      const total = typeof payload.totalCount === 'number' ? payload.totalCount : 0;
      const filtered = typeof payload.filteredCount === 'number' ? payload.filteredCount : 0;
      filterMeta.textContent = total
        ? ('表示 ' + filtered + ' / 全体 ' + total)
        : '';

      const commits = Array.isArray(payload.commits) ? payload.commits.slice(0, 30) : [];
      if (!commits.length) {
        commitList.innerHTML = '<div class="empty">' +
          (payload.workspaceOpen
            ? (total > 0
              ? 'この区間にマイクロ履歴はありません。区間フィルタを変えてください。'
              : '履歴はまだありません。ファイルを保存してください。')
            : 'ワークスペースを開いてください。') +
          '</div>';
        return;
      }

      hideTip(sidebarTip);
      commitList.innerHTML = '';
      commits.forEach((c) => {
        const btn = document.createElement('button');
        btn.className = 'item' + (c.hash === payload.currentHead ? ' active' : '');
        btn.disabled = !active;
        btn.innerHTML =
          '<div class="item-compact">' +
            '<span class="item-label"></span>' +
            '<span class="item-time"></span>' +
          '</div>';
        btn.querySelector('.item-label').textContent = compactDisplay(c);
        btn.querySelector('.item-time').textContent = shortTime(c.timestamp);
        btn.onmouseenter = () => showTip(sidebarTip, commitDetailText(c), btn);
        btn.onmouseleave = () => hideTip(sidebarTip);
        btn.onclick = () => vscode.postMessage({ command: 'jumpToCommit', hash: c.hash });
        commitList.appendChild(btn);
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        render(msg.payload || {});
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function getGraphHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<style>
  body {
    margin: 0;
    padding: 16px;
    font-family: var(--vscode-font-family, sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #fff);
    overflow-x: auto;
  }
  #graph-area { display: block; }
  .header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  h3 { margin: 0; color: var(--vscode-descriptionForeground, #888); font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }
  .toolbar label { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
  select#interval-filter {
    min-width: 260px;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #fff);
    font: inherit;
  }
  #empty { padding: 20px; color: var(--vscode-descriptionForeground, #888); }
  .node { cursor: pointer; fill: #007acc; transition: 0.15s; }
  .node:hover { fill: #fff; }
  .node.current { fill: #3fb950; stroke: #fff; stroke-width: 2px; }
  .line { stroke: #555; stroke-width: 3px; fill: none; }
  .node-label {
    fill: var(--vscode-editor-foreground, #ccc);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    pointer-events: none;
  }
  .node-label.tag {
    fill: #58a6ff;
    font-weight: 600;
  }
  .hover-tip {
    position: fixed;
    z-index: 1000;
    max-width: 360px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #fff);
    font-size: 11px;
    line-height: 1.45;
    pointer-events: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .hover-tip[hidden] { display: none; }
</style>
</head>
<body>
  <div class="header">
    <h3>MicroGit タイムライン</h3>
    <div class="meta" id="meta"></div>
  </div>
  <div class="toolbar">
    <label for="interval-filter">メインコミット区間</label>
    <select id="interval-filter"></select>
  </div>
  <div id="empty" hidden>履歴がまだありません。</div>
  <svg id="graph-area" width="100%" height="80px"></svg>
  <div id="graph-tip" class="hover-tip" hidden></div>
  <script>
    const vscode = acquireVsCodeApi();
    const svg = document.getElementById('graph-area');
    const empty = document.getElementById('empty');
    const meta = document.getElementById('meta');
    const graphTip = document.getElementById('graph-tip');
    const intervalFilter = document.getElementById('interval-filter');

    intervalFilter.onchange = () => {
      vscode.postMessage({ command: 'setInterval', intervalId: intervalFilter.value });
    };

    function short(hash) {
      return hash ? hash.substring(0, 7) : '-';
    }

    function fillIntervalOptions(intervals, selectedId) {
      const list = Array.isArray(intervals) ? intervals : [];
      intervalFilter.innerHTML = '';
      list.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = opt.label;
        intervalFilter.appendChild(o);
      });
      intervalFilter.value = selectedId || 'all';
      if (intervalFilter.value !== (selectedId || 'all') && list.length) {
        intervalFilter.value = list[0].id;
      }
    }

    function commitLabel(commit) {
      if (commit.tags && commit.tags.length) {
        return commit.tags[commit.tags.length - 1];
      }
      return short(commit.hash);
    }

    function isAiCommit(commit) {
      return /\\[AI\\]/i.test(commit.subject || '');
    }

    function updateSummary(commit) {
      const subject = commit.subject || '';
      const m = subject.match(/saved\\s+(.+?)\\s+at\\s+/i);
      if (m && m[1]) {
        return m[1].replace(/^\\[AI\\]\\s*/i, '').trim();
      }
      const cleaned = subject.replace(/^micro:\\s*/i, '').replace(/^\\[AI\\]\\s*/i, '').trim();
      return cleaned || short(commit.hash);
    }

    function compactDisplay(commit) {
      const summary = updateSummary(commit);
      const tipTag = (commit.tags || []).filter((t) => /^mb-\\d+$/.test(t)).pop();
      const head = tipTag || short(commit.hash);
      if (isAiCommit(commit)) {
        return head + ' [AI] (' + summary + ')';
      }
      return head + ' (' + summary + ')';
    }

    function shortTime(timestamp) {
      if (!timestamp) { return '-'; }
      const parts = String(timestamp).split(' ');
      const timePart = parts.length > 1 ? parts[parts.length - 1] : timestamp;
      return timePart.length >= 5 ? timePart.slice(0, 5) : timePart;
    }

    function commitDetailText(commit) {
      const lines = [
        'hash: ' + (commit.hash || '-'),
        'message: ' + (commit.subject || '(no message)'),
        'time: ' + (commit.timestamp || '-'),
        'main-head: ' + (commit.mainHead ? short(commit.mainHead) : '(none)'),
      ];
      if (isAiCommit(commit)) {
        lines.push('source: AI agent');
      }
      if (commit.tags && commit.tags.length) {
        lines.push('tags: ' + commit.tags.join(', '));
      }
      if (commit.parents && commit.parents.length) {
        lines.push('parents: ' + commit.parents.map(short).join(', '));
      }
      return lines.join('\\n');
    }

    function showTip(text, target) {
      graphTip.textContent = text;
      graphTip.hidden = false;
      const rect = target.getBoundingClientRect();
      graphTip.style.left = Math.min(rect.left, window.innerWidth - 370) + 'px';
      graphTip.style.top = (rect.bottom + 8) + 'px';
    }

    function hideTip() {
      graphTip.hidden = true;
    }

    function render(payload) {
      fillIntervalOptions(payload.mainIntervals, payload.selectedIntervalId);
      const commitsAsc = Array.isArray(payload.commits) ? payload.commits.slice().reverse() : [];
      const total = typeof payload.totalCount === 'number' ? payload.totalCount : commitsAsc.length;
      const filtered = typeof payload.filteredCount === 'number' ? payload.filteredCount : commitsAsc.length;
      meta.textContent = (payload.currentTag || '-') + ' · ' +
        (payload.currentHead ? payload.currentHead.substring(0, 7) : '-') +
        ' · 表示 ' + filtered + '/' + total;

      hideTip();
      while (svg.firstChild) { svg.removeChild(svg.firstChild); }

      if (!commitsAsc.length) {
        empty.hidden = false;
        empty.textContent = total > 0
          ? 'この区間にマイクロ履歴はありません。区間フィルタを変えてください。'
          : '履歴がまだありません。';
        svg.setAttribute('height', '40px');
        return;
      }
      empty.hidden = true;

      const nodeMap = new Map();
      const yInterval = 52;
      const laneSpacing = 56;
      const leftPad = 28;
      const branchLanes = new Map();
      let currentMaxLane = 0;

      commitsAsc.forEach((c, i) => {
        let lane = 0;
        if (i > 0) {
          const prevCommit = commitsAsc[i - 1];
          if (!c.parents.includes(prevCommit.hash)) {
            currentMaxLane++;
            lane = currentMaxLane;
          } else {
            lane = branchLanes.get(prevCommit.hash) || 0;
          }
        }
        branchLanes.set(c.hash, lane);
        nodeMap.set(c.hash, {
          x: leftPad + (lane * laneSpacing),
          y: i * yInterval + 28,
          lane,
        });
      });

      // ラベルは全レーンの右外側の共通列に置き、枝同士の文字被りを防ぐ
      const labelColumnX = leftPad + ((currentMaxLane + 1) * laneSpacing) + 16;
      const approxLabelWidth = 220;
      const svgWidth = Math.max(labelColumnX + approxLabelWidth + 24, 280);
      svg.setAttribute('height', (commitsAsc.length * yInterval + 40) + 'px');
      svg.setAttribute('width', svgWidth + 'px');
      svg.style.minWidth = svgWidth + 'px';
      svg.style.overflow = 'visible';

      commitsAsc.forEach((c) => {
        const childPos = nodeMap.get(c.hash);
        c.parents.forEach((pHash) => {
          const parentPos = nodeMap.get(pHash);
          if (!parentPos) { return; }
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', childPos.x);
          line.setAttribute('y1', childPos.y);
          line.setAttribute('x2', parentPos.x);
          line.setAttribute('y2', parentPos.y);
          line.setAttribute('class', 'line');
          svg.appendChild(line);
        });
      });

      commitsAsc.forEach((commit) => {
        const pos = nodeMap.get(commit.hash);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', pos.x);
        circle.setAttribute('cy', pos.y);
        circle.setAttribute('r', commit.hash === payload.currentHead ? '9' : '8');
        circle.setAttribute('class', 'node' + (commit.hash === payload.currentHead ? ' current' : ''));
        circle.onclick = () => vscode.postMessage({ command: 'jumpToCommit', hash: commit.hash });
        circle.onmouseenter = () => showTip(commitDetailText(commit), circle);
        circle.onmouseleave = hideTip;
        svg.appendChild(circle);

        // ノードからラベル列への短いガイド線
        const guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        guide.setAttribute('x1', pos.x + 10);
        guide.setAttribute('y1', pos.y);
        guide.setAttribute('x2', labelColumnX - 6);
        guide.setAttribute('y2', pos.y);
        guide.setAttribute('stroke', '#444');
        guide.setAttribute('stroke-width', '1');
        guide.setAttribute('stroke-dasharray', '2 3');
        svg.appendChild(guide);

        const hasTag = commit.tags && commit.tags.length;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', labelColumnX);
        label.setAttribute('y', pos.y + 4);
        label.setAttribute('class', 'node-label' + (hasTag || isAiCommit(commit) ? ' tag' : ''));
        label.textContent = compactDisplay(commit) + '  ' + shortTime(commit.timestamp);
        svg.appendChild(label);
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        render(msg.payload || {});
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}
