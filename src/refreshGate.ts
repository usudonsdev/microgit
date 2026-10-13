/**
 * 画面の更新を「1 つずつ・最新だけ」にする部品（#73）。VS Code に依存しないので単体テストできる。
 *
 * 背景（#67 の計測）：保存のあとの画面の更新は、Git を同期で 4 回起動して約 200 ms 拡張機能ホストを止めていた。
 * 非同期にすると、更新が重なったとき、古い更新が後から終わって新しい表示を上書きしうる。そこで
 *  - 同時に走らせるのは 1 つだけ（走っている間に来た依頼は 1 回にまとめ、終わってから最新の状態で 1 回やり直す）
 *  - 依頼のたびに世代番号を進め、始めたときより世代が進んでいたら結果を捨てる（やり直しが必ず続くので、表示は最新になる）
 */
export class RefreshCoalescer {
    private generation = 0;
    private running = false;
    private again = false;
    private waiters: Array<() => void> = [];

    /**
     * @param work 1 回の更新。始めたときの世代と、まだ最新かを返す関数を受け取る。
     *             結果を画面へ渡す直前に isCurrent() を見て、false なら捨てる
     */
    constructor(private readonly work: (isCurrent: () => boolean) => Promise<void>) {}

    /** 更新を頼む。この依頼を含む更新と、それに続くやり直しが全部終わったら解決する（失敗しても解決する） */
    request(): Promise<void> {
        this.generation++;
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
            if (this.running) {
                this.again = true;
                return;
            }
            void this.loop();
        });
    }

    /** 走っている更新の結果を捨てさせる（見えなくなったときなど）。やり直しは起こさない */
    invalidate(): void {
        this.generation++;
    }

    private async loop(): Promise<void> {
        this.running = true;
        // 結果を捨てた更新の依頼も、やり直しの結果が出るまで解決しない（先に解決すると、グラフを開く前に
        // 「更新が終わった」と思って、まだ古い内容のまま開いてしまう）。最後のやり直しまで終わってから、まとめて解決する
        const pending: Array<() => void> = [];
        try {
            do {
                this.again = false;
                pending.push(...this.waiters.splice(0));
                const started = this.generation;
                try {
                    await this.work(() => this.generation === started);
                } catch {
                    /* 更新の失敗は、次の依頼で取り戻す */
                }
            } while (this.again);
        } finally {
            this.running = false;
            for (const resolve of pending) { resolve(); }
        }
    }
}

/**
 * VS Code の Git 拡張の onDidChange は、作業ツリーの状態（変更ファイルの一覧など）が変わるたびに鳴る。
 * 画面（ブランチ名・HEAD・メインのコミットの区間）に関係するのは HEAD の名前とコミットだけなので、
 * その印が前と同じなら「変わっていない」と答える（#73）。
 * 注意：マージ中・リベース中・変更ファイルの増減だけの通知も捨てる。いまの画面はこれらを使っていないので影響しないが、
 * 将来、画面がそれらを出すようにするときは、この判定に印を足すこと
 */
export class ChangeDedupe {
    private last = new Map<string, string>();

    /** key（リポジトリ）ごとに、印が前回と違えば true。初めて見た key は true */
    changed(key: string, signature: string): boolean {
        if (this.last.get(key) === signature) { return false; }
        this.last.set(key, signature);
        return true;
    }
}

/** Git 拡張のリポジトリの HEAD から、画面に関係する印を作る */
export function headSignature(head: { name?: string; commit?: string; type?: number } | undefined): string {
    return `${head?.name ?? ''}\u0001${head?.commit ?? ''}\u0001${head?.type ?? ''}`;
}
