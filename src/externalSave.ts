/**
 * VS Code の外で保存されたファイル（Excel、画像・動画の編集ソフト、外部の AI エージェントなど）を記録するための、VS Code に依存しない部品。
 * 構想は docs/structured-diff.md §2、決めたことは docs/external-saves.md。
 *
 * - isTransientFileName：アプリが保存の途中で作る一時ファイル・ロックファイルか（記録しない）
 * - SettleWatcher：変更の通知を受けたファイルを、大きさと更新時刻が settleMs のあいだ変わらなくなるまで待ってから知らせる
 *   （書き出しの途中のファイルを記録しないため。動画の書き出しのように長く書き続けるファイルは、終わるまで待ち続ける）
 * - RecordedContents：パスごとに、最後に記録した（または verEve 自身が書いた）中身のハッシュを持つ。
 *   エディタの保存と監視の二重の記録、過去に戻る操作が書いたファイルの記録を防ぐ
 *
 * 前提：ここでは Git もファイルの中身も扱わない（stat とタイマーは差し替えられる。単体テストで偽物を入れる）。
 */
import * as path from 'path';

/**
 * 記録しない一時ファイル・ロックファイルのファイル名（パスでなく、最後の要素）。
 * 根拠：Office のロックファイル `~$名前`、LibreOffice のロックファイル `.~lock.名前#`、
 * Office の保存途中の一時ファイル `~WRL1234.tmp` など、エディタのスワップ、ブラウザの途中のダウンロード、OS が作るファイル。
 * 実機の Excel・Word で一時ファイルの名前を確かめたわけではない（docs/external-saves.md の未確認の項目）
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
    /^~\$/,                 // Office のロックファイル（~$book.xlsx）
    /^\.~lock\..*#$/,       // LibreOffice のロックファイル（.~lock.book.xlsx#）
    /\.tmp$/i,              // 一時ファイル全般（Office の ~WRL0001.tmp、ABCD1234.tmp など）
    /\.(swp|swo|swx)$/i,    // vim
    /~$/,                   // バックアップ（emacs など）
    /^#.*#$/,               // emacs の自動保存
    /\.(crdownload|part|partial|download)$/i, // 途中のダウンロード
    /^\.DS_Store$/,
    /^Thumbs\.db$/i,
    /^desktop\.ini$/i,
    /^\._/,                 // macOS が他のファイルシステムに作るリソースフォーク
];

/** アプリが保存の途中で作る一時ファイル・ロックファイル・OS の管理ファイルなら true */
export function isTransientFileName(fileName: string): boolean {
    const base = path.basename(fileName);
    return TRANSIENT_PATTERNS.some((re) => re.test(base));
}

/** ワークスペースからの相対パス（/ 区切り）のどこかに .git の要素があれば true（Git 自身の書き込みは記録しない） */
export function isInsideGitDir(relativePosixPath: string): boolean {
    return relativePosixPath.split('/').some((seg) => seg === '.git');
}

/** ファイルの大きさと更新時刻。消えていれば undefined */
export interface FileSignature { size: number; mtimeMs: number }

/** SettleWatcher の差し替えられる部分 */
export interface SettleWatcherDeps {
    /** ファイルの大きさと更新時刻を返す。無い・読めないなら undefined */
    stat(absPath: string): FileSignature | undefined;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
}

/**
 * 変更の通知を受けたファイルを、大きさと更新時刻が settleMs のあいだ変わらなくなってから onSettled で知らせる。
 * - 待っている間に同じパスの通知が来たら、待ち直す（連続の通知は 1 回にまとまる）
 * - 待ち終わりに大きさか更新時刻が変わっていたら、もう一度待つ（書き出しの途中）。上限は設けない
 * - 待ち終わりにファイルが無ければ、何も知らせずに忘れる（一時ファイルを改名して消えた場合など）
 */
export class SettleWatcher {
    private readonly pending = new Map<string, { sig: FileSignature | undefined; timer: unknown }>();
    private disposed = false;

    constructor(
        private readonly settleMs: number,
        private readonly onSettled: (absPath: string) => void,
        private readonly deps: SettleWatcherDeps,
    ) {}

    /** 変更（作成を含む）の通知を受ける */
    notify(absPath: string): void {
        if (this.disposed) { return; }
        const prev = this.pending.get(absPath);
        if (prev) { this.deps.clearTimer(prev.timer); }
        const sig = this.deps.stat(absPath);
        this.pending.set(absPath, { sig, timer: this.schedule(absPath) });
    }

    /** 削除の通知を受ける。待っているなら忘れる */
    forget(absPath: string): void {
        const prev = this.pending.get(absPath);
        if (prev) { this.deps.clearTimer(prev.timer); this.pending.delete(absPath); }
    }

    /** 待っているパスの数（テストと状態の表示用） */
    get pendingCount(): number { return this.pending.size; }

    dispose(): void {
        this.disposed = true;
        for (const { timer } of this.pending.values()) { this.deps.clearTimer(timer); }
        this.pending.clear();
    }

    private schedule(absPath: string): unknown {
        return this.deps.setTimer(() => this.check(absPath), this.settleMs);
    }

    private check(absPath: string): void {
        const entry = this.pending.get(absPath);
        if (!entry || this.disposed) { return; }
        const now = this.deps.stat(absPath);
        if (!now) { this.pending.delete(absPath); return; }
        if (entry.sig && entry.sig.size === now.size && entry.sig.mtimeMs === now.mtimeMs) {
            this.pending.delete(absPath);
            this.onSettled(absPath);
            return;
        }
        // まだ書いている（または最初の stat が取れなかった）。今の状態を基準に、もう一度待つ
        entry.sig = now;
        entry.timer = this.schedule(absPath);
    }
}

/**
 * パスごとに、最後に記録した中身（または verEve 自身がワークスペースに書いた中身）のハッシュを覚える。
 * 監視が知らせたファイルの中身が、覚えているハッシュと同じなら記録しない。
 * - エディタで保存したファイル：onDidSaveTextDocument で記録したあと、監視からも同じ中身の通知が来る
 * - 過去に戻る操作で書いたファイル：利用者の保存ではない
 * 覚える数には上限を設け、古いものから忘れる（忘れても、記録の側が「HEAD と同じ中身なら何もしない」ので誤りにはならない。余分な仕事が増えるだけ）
 */
export class RecordedContents {
    private readonly map = new Map<string, string>();

    constructor(private readonly limit = 4096) {}

    remember(absPath: string, contentHash: string): void {
        this.map.delete(absPath);
        this.map.set(absPath, contentHash);
        if (this.map.size > this.limit) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) { this.map.delete(oldest); }
        }
    }

    /** 覚えている中身と同じなら true */
    isKnown(absPath: string, contentHash: string): boolean {
        return this.map.get(absPath) === contentHash;
    }

    forget(absPath: string): void { this.map.delete(absPath); }

    clear(): void { this.map.clear(); }
}

/** 監視からの記録を受け付けるかの判定の結果。skip のときは理由（ログ用） */
export type ExternalSaveDecision = { record: true } | { record: false; reason: string };

/**
 * 監視が知らせたファイルを記録するか（中身を読む前に決められる部分）。
 * relativePosixPath はワークスペースからの相対パス。ワークスペースの外・成果物のフォルダの判定は呼ぶ側が先にする
 */
export function decideExternalSave(
    relativePosixPath: string,
    size: number,
    maxFileSizeBytes: number,
): ExternalSaveDecision {
    if (isInsideGitDir(relativePosixPath)) { return { record: false, reason: '.git の中' }; }
    if (isTransientFileName(relativePosixPath)) { return { record: false, reason: '一時ファイル・ロックファイル' }; }
    if (maxFileSizeBytes > 0 && size > maxFileSizeBytes) {
        return { record: false, reason: `大きすぎる（${size} バイト > 上限 ${maxFileSizeBytes} バイト）` };
    }
    return { record: true };
}
