/**
 * 保存 1 回の処理を、段階ごとに時間を計る（#37）。
 *
 * 保存のイベントから処理の終わりまでを、次の段階に分けて記録する（どれも ms）。
 *   queue    保存のイベントから、列（前の保存の処理）を待って処理が始まるまで
 *   policy   記録してよいブランチかの確認
 *   write    shadow の作業ツリーへの書き込み
 *   ensure   shadow の準備
 *   commit   記録（Git の形式のコミット。#32 の速い記録）
 *   layer    カーネル版・Node.js 版の層の作成
 *   fileLog  .microgit_logs/timeline.log の生成
 *   overlay  Overlay の状態の更新
 *   logFile  .microgit_logs/log_latest.json の書き出し
 *   ui       ステータスバーとパネルの更新
 * あわせて、保存のイベントから「記録が終わるまで」（recorded）と「その時点に戻れるようになるまで」
 * （restorable＝層ができるまで）の時間も記録する。
 *
 * VS Code に依存しない（単体テストで確かめるため）。
 */

export const SAVE_STAGES = ['queue', 'policy', 'write', 'ensure', 'commit', 'layer', 'fileLog', 'overlay', 'logFile', 'ui'] as const;
export type SaveStage = typeof SAVE_STAGES[number];

export type SaveTiming = {
    stages: Partial<Record<SaveStage, number>>;
    /** 保存のイベントから記録（コミット）が終わるまで */
    recordedMs?: number;
    /** 保存のイベントから、その時点に戻れる（層ができる）まで */
    restorableMs?: number;
    totalMs: number;
    result: string;
    /** 速い記録の中の段階ごとの時間（ms）と、fsync の回数・時間（fsyncCount・fsyncMs）。#45 */
    commitPhases?: Record<string, number>;
    /** 記録に使ったもの（fast / git）と、層を作ったもの（kernel / nodejs / none） */
    recorder?: string;
    layer?: string;
};

type Clock = () => number;

export class SaveTimer {
    private last: number;
    readonly timing: SaveTiming = { stages: {}, totalMs: 0, result: 'unknown' };

    /** eventAt：保存のイベントが起きた時刻（列を待つ前） */
    constructor(private readonly eventAt: number, private readonly now: Clock = () => performance.now()) {
        this.last = eventAt;
    }

    /** 直前の印からここまでを、その段階の時間として足す */
    mark(stage: SaveStage): void {
        const t = this.now();
        this.timing.stages[stage] = (this.timing.stages[stage] ?? 0) + (t - this.last);
        this.last = t;
    }

    /** 計らない区間を飛ばす（次の mark がここから数える） */
    skip(): void {
        this.last = this.now();
    }

    recorded(): void {
        this.timing.recordedMs = this.now() - this.eventAt;
    }

    restorable(): void {
        this.timing.restorableMs = this.now() - this.eventAt;
    }

    finish(result: string): SaveTiming {
        this.timing.totalMs = this.now() - this.eventAt;
        this.timing.result = result;
        return this.timing;
    }
}

/** 直近 N 回の保存の記録 */
export class SaveTimingLog {
    private readonly items: SaveTiming[] = [];

    constructor(private readonly capacity = 200) { }

    add(t: SaveTiming): void {
        this.items.push(t);
        if (this.items.length > this.capacity) { this.items.shift(); }
    }

    get all(): readonly SaveTiming[] {
        return this.items;
    }

    clear(): void {
        this.items.length = 0;
    }

    /** 段階ごとの中央値と p95（その段階を通った保存だけで計算） */
    summary(): { count: number; rows: Array<{ name: string; n: number; p50: number; p95: number }> } {
        const pct = (xs: number[], p: number) => {
            const s = [...xs].sort((a, b) => a - b);
            return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
        };
        const rows: Array<{ name: string; n: number; p50: number; p95: number }> = [];
        const add = (name: string, xs: number[]) => {
            if (xs.length) { rows.push({ name, n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95) }); }
        };
        for (const s of SAVE_STAGES) {
            add(s, this.items.map((i) => i.stages[s]).filter((v): v is number => v !== undefined));
        }
        add('recorded', this.items.map((i) => i.recordedMs).filter((v): v is number => v !== undefined));
        add('restorable', this.items.map((i) => i.restorableMs).filter((v): v is number => v !== undefined));
        add('total', this.items.map((i) => i.totalMs));
        return { count: this.items.length, rows };
    }

    /** Overlay Status に出す文字列 */
    describe(): string {
        const { count, rows } = this.summary();
        if (count === 0) { return 'save: まだ記録なし'; }
        const f = (v: number) => v.toFixed(1);
        const results = new Map<string, number>();
        for (const i of this.items) { results.set(i.result, (results.get(i.result) ?? 0) + 1); }
        return [
            `save: 直近 ${count} 回（${[...results].map(([k, v]) => `${k} ${v}`).join('、')}） p50 / p95 ms`,
            ...rows.map((r) => `  ${r.name.padEnd(10)} ${f(r.p50).padStart(8)} ${f(r.p95).padStart(8)}  (n=${r.n})`),
        ].join('\n');
    }
}
