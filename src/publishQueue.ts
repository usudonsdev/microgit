/**
 * 親のリポジトリへの共有（publish）を、重ならないように 1 本の列で順に流す（#72）。
 *
 * 保存の 1.5 秒後の自動の共有は、#67 の計測で拡張機能ホストを毎回約 520 ms 止めていた（execFileSync）。
 * Git の起動を非同期にすると、共有が走っている間にも次の保存が来て、次の共有の時刻になりうる。
 * 同じ親の refs へ 2 つの git push を同時に走らせると、ref のロックで片方が失敗しうるので、
 * - 自動の共有（schedule）：走っている間に何度頼まれても、終わってからもう 1 回だけ走らせる。そのときは最後に頼まれた内容
 * - 利用者のコマンド（runExclusive）：列の後ろに並んで、前の共有が終わってから走る。結果を返す
 * とする。VS Code に依存しない（単体テストで確かめる）。
 */
export class PublishQueue<J> {
    /** 列の最後（これが終われば、それまでに並んだものは全部終わっている） */
    private tail: Promise<void> = Promise.resolve();
    /**
     * 列で待っている、いちばん新しい自動の共有（まだ始まっていない）。その内容と、それを積んだ直後の列の最後。
     * 待っている間の頼みは、そのあとに何も並んでいないとき（列の最後がまだこれのとき）だけ、内容を差し替える。
     * 間に利用者のコマンドが並んだあとの頼みは、コマンドの後ろに新しく並ぶ
     */
    private autoCell: { job: J | undefined; started: boolean } | undefined;
    private autoTail: Promise<void> | undefined;
    private closed = false;

    constructor(
        private readonly run: (job: J) => Promise<void>,
        private readonly onError: (err: unknown) => void,
    ) {}

    /** 自動の共有を頼む。今走っている共有があれば、それが終わってから 1 回だけ（最後に頼まれた内容で）走る */
    schedule(job: J): void {
        if (this.closed) { return; }
        const waiting = this.autoCell;
        if (waiting && !waiting.started && this.tail === this.autoTail) { waiting.job = job; return; }
        const mine: { job: J | undefined; started: boolean } = { job, started: false };
        const task = this.tail.then(async () => {
            // ここで初めて内容を取る（待っている間に差し替えられた最後の内容）
            mine.started = true;
            const j = mine.job;
            mine.job = undefined;
            if (j === undefined || this.closed) { return; }
            try {
                await this.run(j);
            } catch (err: unknown) {
                this.onError(err);
            }
        });
        this.autoCell = mine;
        this.autoTail = task;
        this.tail = task;
    }

    /** 列の後ろに並んで fn を走らせ、その結果を返す（利用者のコマンドの共有。前の共有と重ならない） */
    runExclusive<R>(fn: () => Promise<R>): Promise<R> {
        const result = this.tail.then(fn);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }

    /** 列に並んでいるものが全部終わるまで待つ（待っている間に足されたものも待つ） */
    async whenIdle(): Promise<void> {
        let seen: Promise<void> | undefined;
        while (seen !== this.tail) {
            seen = this.tail;
            await seen;
        }
    }

    /**
     * 拡張機能の終了（deactivate）のとき。まだ始まっていない自動の共有は捨て（次の起動の保存でまた共有される。
     * 前も、待っている setTimeout は終了で消えていた）、今走っている git push だけは終わるのを待つ。
     * push の途中で拡張機能ホストごと止まると、親の refs に .lock が残って、次からの共有が失敗しうるため
     */
    async close(): Promise<void> {
        this.closed = true;
        if (this.autoCell) { this.autoCell.job = undefined; }
        await this.whenIdle();
    }
}
