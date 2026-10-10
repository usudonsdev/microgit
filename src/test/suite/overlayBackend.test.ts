import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as vscode from 'vscode';

/**
 * MicroGit を有効にして、VS Code の編集機能で保存し、過去に戻るコマンドでワークスペースが戻るかを確かめる（#14）。
 *
 * どのバックエンド（カーネル版か Node.js 版か）を使うかは環境しだい:
 *   - Windows で guest/.cache/qemu-win と guest/out/x86_64/Image があればカーネル版（QEMU）
 *   - Linux で guest/out/<arch>/init があり、非特権のユーザー名前空間が使えればカーネル版（VM なし）
 *   - どれも無い（CI の test ジョブなど）なら Node.js 版
 * 環境変数 MICROGIT_TEST_EXPECT_BACKEND（kernel / nodejs）を付けると、使ったバックエンドも確かめる。
 * 環境変数 MICROGIT_TEST_BACKEND_SETTING（auto / kernel / nodejs）を付けると、設定 microgit.overlayBackend をその値にしてから試す。
 */
suite('MicroGit Overlay backend (save → jump)', function () {
    this.timeout(300_000);

    let root: string;
    let shadow: string;

    const shadowHead = (): string | undefined => {
        try {
            // 最初のコミットの前は HEAD が無い。その失敗の stderr は出さない
            return execFileSync('git', ['-C', shadow, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
            return undefined;
        }
    };

    type LastSave = { processed: number; head?: string };
    const lastSave = async () => (await vscode.commands.executeCommand<LastSave>('microgit.internal.lastSave'))!;

    /**
     * 保存ジョブ（キュー）が shadow にコミットを作るまで待つ。
     * 保存の処理の最中は Git を起動しない（#61）。テストは拡張機能と同じプロセスで動くので、ここで Git を起動すると
     * その間（execFileSync なら Windows で 30〜40 ms、非同期の execFile でも Linux の fork の数 ms）ループが止まり、
     * MicroGit は agent の応答を読めず、層づくりの「通信」が長く測られていた。保存の数と最後のコミットは拡張機能から受け取る
     */
    async function waitForNewHead(before: LastSave, timeoutMs = 60_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const now = await lastSave();
            if (now.processed > before.processed && now.head && now.head !== before.head) { return now.head; }
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('shadow commit did not appear');
    }

    /**
     * 保存した直後にディスクにあった中身（コミット:パス → バイト列）。VS Code は Windows では文書の改行を CRLF に
     * そろえて保存するので、入力した文字列ではなく、ディスクの中身と比べる（ADR-0012：保存したバイト列がそのまま戻る）
     */
    const savedBytes = new Map<string, Buffer>();
    const assertRestored = (head: string, rel: string) => {
        const want = savedBytes.get(`${head}:${rel}`);
        assert.ok(want, `${head}:${rel} の保存した中身を覚えていない`);
        const got = fs.readFileSync(path.join(root, ...rel.split('/')));
        assert.ok(got.equals(want), `${rel} が保存したときと違う（${got.length} バイト、期待 ${want.length} バイト。先頭 ${JSON.stringify(got.subarray(0, 16).toString())}）`);
    };

    /** VS Code の編集機能でファイルを書き換えて保存する（onDidSaveTextDocument が発火する） */
    async function editAndSave(rel: string, text: string): Promise<string> {
        const abs = path.join(root, ...rel.split('/'));
        if (!fs.existsSync(abs)) {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, '');
        }
        const before = await lastSave();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(await doc.save());
        const head = await waitForNewHead(before);
        savedBytes.set(`${head}:${rel}`, fs.readFileSync(abs));
        return head;
    }

    suiteSetup(async () => {
        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders, 'ワークスペースが開かれていません。');
        root = folders[0].uri.fsPath;
        shadow = path.join(root, '.microgit', 'shadow');
        assert.ok(!fs.existsSync(shadow), 'MicroGit を有効にする前から .microgit/shadow がある（ほかのテストが作った？）');
        const setting = process.env.MICROGIT_TEST_BACKEND_SETTING;
        if (setting) {
            await vscode.workspace.getConfiguration().update('microgit.overlayBackend', setting, vscode.ConfigurationTarget.Workspace);
        }
        await vscode.commands.executeCommand('microgit.enable');
    });

    test('保存した 2 つの時点を行き来でき、あとから作ったファイルは消え、日本語の名前も戻る', async () => {
        const h1 = await editAndSave('kb/メモ.txt', 'v1\n');
        const h2 = await editAndSave('kb/メモ.txt', 'v2\n');
        const h3 = await editAndSave('kb/later.txt', 'created later\n');
        assert.notStrictEqual(h1, h2);
        assert.notStrictEqual(h2, h3);

        await vscode.commands.executeCommand('microgit.jumpToCommit', h1);
        assertRestored(h1, 'kb/メモ.txt');
        if (process.platform === 'win32') {
            // VS Code は Windows では CRLF で保存する。以前は shadow が LF に変えて記録し、戻すと LF になっていた（ADR-0012）
            assert.ok(savedBytes.get(`${h1}:kb/メモ.txt`)!.includes('\r\n'), 'Windows で保存した中身が CRLF でない');
        }
        assert.ok(!fs.existsSync(path.join(root, 'kb', 'later.txt')), 'h1 の時点には無いファイルが残っている');
        assert.strictEqual(shadowHead(), h1);

        await vscode.commands.executeCommand('microgit.jumpToCommit', h3);
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'メモ.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v2\n');
        assertRestored(h2, 'kb/メモ.txt');
        assertRestored(h3, 'kb/later.txt');
        assert.strictEqual(shadowHead(), h3);
    });

    test('3 MiB のファイルも保存して過去へ戻せる', async () => {
        // macOS の Virtualization.framework は、virtio-console の JSON 1 行が約 64 KiB を超えると
        // 停止した。stage / readChunk が実際の VSIX の中でも分割することを回帰確認する。
        const large = 'a'.repeat(3 * 1024 * 1024 + 7);
        const largeHead = await editAndSave('kb/large.txt', large);
        const smallHead = await editAndSave('kb/large.txt', 'small\n');

        await vscode.commands.executeCommand('microgit.jumpToCommit', largeHead);
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'large.txt'), 'utf8'), large);
        assertRestored(largeHead, 'kb/large.txt');

        await vscode.commands.executeCommand('microgit.jumpToCommit', smallHead);
        assertRestored(smallHead, 'kb/large.txt');
    });

    // 保存 1 回の処理の段階ごとの時間（#37）。MICROGIT_TEST_SAVE_BENCH=<回数> のときだけ走る計測
    // （MICROGIT_TEST_SAVE_BENCH_OUT=<パス> で、1 回ごとの記録を JSON に書く）
    const benchSaves = Number(process.env.MICROGIT_TEST_SAVE_BENCH ?? '0');
    (benchSaves > 0 ? test : test.skip)(`保存 ${benchSaves} 回の段階ごとの時間を計る`, async function () {
        this.timeout(0);
        await vscode.commands.executeCommand('microgit.internal.waitForSaves');
        await vscode.commands.executeCommand('microgit.internal.saveTimings', true);
        const files = Array.from({ length: 20 }, (_, i) => `bench/dir${i % 4}/file${i}.ts`);
        const heads: Array<{ head: string; rel: string }> = [];
        for (let n = 0; n < benchSaves; n++) {
            const rel = files[n % files.length];
            const head = await editAndSave(rel, `// ${rel}\n${'x'.repeat(200)}\n// save ${n}\n`);
            heads.push({ head, rel });
            await vscode.commands.executeCommand('microgit.internal.waitForSaves');
        }
        // 過去に戻る操作の時間（#41）：途中の時点と最後の時点を 5 回ずつ行き来し、戻った中身が保存したときと同じか確かめる
        const travels: number[] = [];
        const middle = heads[Math.floor(heads.length / 2)];
        const last = heads[heads.length - 1];
        for (let i = 0; i < 10; i++) {
            const to = i % 2 === 0 ? middle : last;
            const t0 = performance.now();
            await vscode.commands.executeCommand('microgit.jumpToCommit', to.head);
            travels.push(performance.now() - t0);
            assertRestored(to.head, to.rel);
        }
        // 最後の時点に戻して、ほかのテストに影響しないようにする
        if (shadowHead() !== last.head) { await vscode.commands.executeCommand('microgit.jumpToCommit', last.head); }
        type T = { stages: Record<string, number>; commitPhases?: Record<string, number>; layerPhases?: Record<string, number>; recordedMs?: number; restorableMs?: number; totalMs: number; result: string; recorder?: string; layer?: string };
        const all = await vscode.commands.executeCommand<T[]>('microgit.internal.saveTimings');
        const out = process.env.MICROGIT_TEST_SAVE_BENCH_OUT;
        if (out) { fs.writeFileSync(out, JSON.stringify({ platform: `${process.platform}-${process.arch}`, saves: all, travels }, null, 2)); }
        const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0; };
        const names = ['queue', 'policy', 'write', 'ensure', 'commit', 'layer', 'fileLog', 'overlay', 'logFile', 'ui'];
        const windowSize = Math.min(20, all.length);
        const table = (label: string, items: T[]) => {
            const row = (n: string, xs: number[]) => `  ${n.padEnd(11)} p50 ${pct(xs, 0.5).toFixed(1).padStart(7)}  p95 ${pct(xs, 0.95).toFixed(1).padStart(7)}`;
            console.log(`[save-bench] ${label}（${items.length} 回、recorder=${[...new Set(items.map((i) => i.recorder))].join('/')} layer=${[...new Set(items.map((i) => i.layer))].join('/')}）`);
            for (const n of names) { console.log(row(n, items.map((i) => i.stages[n] ?? 0))); }
            console.log(row('recorded', items.map((i) => i.recordedMs ?? 0)));
            console.log(row('restorable', items.map((i) => i.restorableMs ?? 0)));
            console.log(row('total', items.map((i) => i.totalMs)));
            // 記録（commit）の中の内訳（#45）
            const phaseNames = [...new Set(items.flatMap((i) => Object.keys(i.commitPhases ?? {})))];
            for (const n of phaseNames) { console.log(row(`  c.${n}`, items.map((i) => i.commitPhases?.[n] ?? 0))); }
            // 層づくり（layer）の中の内訳（#61）。カーネル版で層を作った保存だけ
            const layered = items.filter((i) => i.layerPhases);
            const layerNames = [...new Set(layered.flatMap((i) => Object.keys(i.layerPhases!)))];
            for (const n of layerNames) { console.log(row(`  l.${n}`, layered.map((i) => i.layerPhases![n] ?? 0))); }
        };
        table('最初の区間', all.slice(0, windowSize));
        table('最後の区間', all.slice(-windowSize));
        console.log(`[save-bench] 過去に戻る操作 10 回：p50 ${pct(travels, 0.5).toFixed(1)}  p95 ${pct(travels, 0.95).toFixed(1)}  最初 ${travels[0].toFixed(1)} ms`);
        assert.strictEqual(all.length, benchSaves);
        // 既定の永続性では、速い記録の保存 1 回の fsync はジャーナルへの 1 回だけ（ADR-0014）。起動して最初の記録だけは
        // ジャーナルのファイルを作るので、ディレクトリの fsync が 1 回増える（Linux・macOS）。中央値で見る
        // （保存のたびの処理がジャーナルを閉じていたとき、CI の Linux・macOS で 2 回になった）
        const fsyncs = all.filter((i) => i.result === 'created' && i.recorder === 'fast' && i.commitPhases?.fsyncCount !== undefined)
            .map((i) => i.commitPhases!.fsyncCount);
        if (fsyncs.length > 0) { assert.strictEqual(pct(fsyncs, 0.5), 1, `保存 1 回の fsync の回数の中央値が 1 でない: ${JSON.stringify(fsyncs.slice(0, 10))}`); }
        // カーネル版の環境では、層づくりの内訳がゲストの段階まで取れているはず（#61。同梱の agent が古いと guest.* が無い）
        if (process.env.MICROGIT_TEST_EXPECT_BACKEND === 'kernel') {
            const withGuest = all.filter((i) => i.layerPhases?.['guest.mount'] !== undefined && i.layerPhases?.wire !== undefined).length;
            assert.ok(withGuest > benchSaves / 2, `層づくりの内訳（guest.mount と wire）が付いた保存が ${withGuest} / ${benchSaves} 回しかない`);
        }
    });

    // 保存の前後で拡張機能ホストのイベントループが止まった最長の時間（#67）。MICROGIT_TEST_STALL_BENCH=<回数> のときだけ走る計測
    // （MICROGIT_TEST_STALL_BENCH_OUT=<パス> で、1 回ごとの記録を JSON に書く）。合格の基準
    // 「保存のときに、利用者がマイクロコミットされていることに気づかない」を、ホストが止まった時間で判定するための数字。
    //
    // 測り方に perf_hooks.monitorEventLoopDelay（resolution 1 ms）を選んだ理由:
    //   - setImmediate を回す方法は、ループを 1 周するたびに休まず回るので CPU を 1 コア近く使い続け、同じ機械で動く QEMU や
    //     Git の時間を乱す。計測自体が結果を変えてしまう
    //   - monitorEventLoopDelay は 1 ms ごとのタイマーだけで、負荷が小さい。区間ごとに reset して max を読めば、その区間で
    //     ループが止まった最長が分かる。タイマーが遅れて発火した分だけ記録されるので、止まった時間は max から resolution
    //     （1 ms）を引いたもの。Windows のタイマーの粗さ（既定は約 15.6 ms）は、Electron が 1 ms に上げるので
    //     最初に何もしない 1 秒の「休止」区間を測り、その max を床（ノイズ）として添える
    //   - 止まっているあいだは記録されず、止まりが終わった時点で記録される。だから止まりは、終わった区間に入る
    // 区間: W1 保存の呼び出しから、その保存の処理が終わる（lastSave().processed が増える）まで／W2 そこから 1.0 秒
    // （0.3 秒後の後片付けを含む）／W3 そのあと 1.5 秒（1.5 秒後の共有を含む）。後片付けが後ろへずれ続けないよう、
    // 1 回保存して 2.5 秒待つ。予算（16 ms 目標・50 ms 上限）を超えても落とさない。
    const stallSaves = Number(process.env.MICROGIT_TEST_STALL_BENCH ?? '0');
    (stallSaves > 0 ? test : test.skip)(`保存 ${stallSaves} 回の前後でホストのループが止まった最長を計る`, async function () {
        this.timeout(0);
        const RES_MS = 1;
        const h = monitorEventLoopDelay({ resolution: RES_MS });
        const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        const maxMs = () => Math.max(0, h.max / 1e6 - RES_MS);
        const round = (x: number) => Math.round(x * 100) / 100;
        const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0; };
        // 同期の仕事の計測（microgit.internal.syncWorkLog。取ったら空になる）
        type WorkRec = { kind: 'fn' | 'git' | 'note' | 'resume'; name: string; t: number; ms: number; depth: number; parent?: string; detail?: string };
        const takeWork = async () => ((await vscode.commands.executeCommand('microgit.internal.syncWorkLog', true)) as WorkRec[] | undefined) ?? [];
        // 休止の床を汚さないよう、前のテストの後片付けと publish が終わってから測る。waitForSaves は保存の列を待つだけで
        // 0.3 秒後・1.5 秒後のタイマーは待たない。flushAfterSave で後片付けを済ませ、publish のタイマー（1.5 秒）が切れて処理が終わる
        // （publishToParentRefs の記録が出る）まで待つ
        await vscode.commands.executeCommand('microgit.internal.waitForSaves');
        await vscode.commands.executeCommand('microgit.internal.flushAfterSave');
        await sleep(1800);
        const preWork: WorkRec[] = [];
        for (const settleDeadline = Date.now() + 4000; ;) {
            preWork.push(...await takeWork());
            if (preWork.some((r) => r.name === 'publishToParentRefs') || Date.now() > settleDeadline) { break; }
            await sleep(100);
        }
        await sleep(500);
        await takeWork();
        h.enable();
        await sleep(1000);
        h.reset();
        await sleep(1000);
        const idleMs = round(maxMs());
        type Rec = { n: number; warmup: boolean; rel: string; w1: number; w2: number; w3: number; w1Wall: number; work?: SaveWork };
        type Run = { start: number; ms: number; top: string[] };
        type SaveWork = { edges: { w1: number; w2: number; w3: number }; records: Array<WorkRec & { rel: number; win: 'w1' | 'w2' | 'w3' }>; runs: Array<Run & { win: 'w1' | 'w2' | 'w3' }> };
        // 同期で連続して走った部分（記録の区間の和集合。隙間 1 ms 未満はつなぐ。await の後でもマイクロタスクで続けば 1 つの止まりになる）
        const runsOf = (ws: Array<{ rel: number; ms: number; name: string; depth: number; kind: string }>): Run[] => {
            const xs = ws.filter((r) => r.kind === 'fn' || r.kind === 'git').sort((a, b) => a.rel - b.rel || a.depth - b.depth);
            const runs: Array<Run & { end: number; minDepth: number }> = [];
            for (const r of xs) {
                const last = runs[runs.length - 1];
                if (last && r.rel <= last.end + 1) {
                    last.end = Math.max(last.end, r.rel + r.ms);
                    if (r.depth < last.minDepth) { last.minDepth = r.depth; last.top = []; }
                    if (r.depth === last.minDepth && !last.top.includes(r.name)) { last.top.push(r.name); }
                } else {
                    runs.push({ start: r.rel, end: r.rel + r.ms, ms: 0, top: [r.name], minDepth: r.depth });
                }
            }
            return runs.map((r) => ({ start: round(r.start), ms: round(r.end - r.start), top: r.top }));
        };
        const recs: Rec[] = [];
        const controls: Array<{ n: number; w2: number; w3: number }> = [];
        const files = Array.from({ length: 5 }, (_, i) => `stall/file${i}.ts`);
        try {
            // 最初の 1 回は層やジャーナルを作るので、集計には入れず（warmup）、JSON には残す
            for (let n = 0; n <= stallSaves; n++) {
                const rel = files[n % files.length];
                const abs = path.join(root, ...rel.split('/'));
                if (!fs.existsSync(abs)) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, ''); }
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), `// ${rel}
${'x'.repeat(200)}
// stall ${n}
`);
                assert.ok(await vscode.workspace.applyEdit(edit));
                await takeWork();
                const before = await lastSave();
                // W1: 保存の呼び出しから、その保存の処理が終わるまで
                h.reset();
                const t0 = performance.now();
                assert.ok(await doc.save());
                const deadline = Date.now() + 60_000;
                while ((await lastSave()).processed <= before.processed) {
                    if (Date.now() > deadline) { throw new Error('save was not processed'); }
                    await sleep(2);
                }
                const w1Wall = performance.now() - t0;
                const w1 = maxMs();
                h.reset();
                await sleep(1000);
                const w2 = maxMs();
                const tW2End = performance.now();
                h.reset();
                await sleep(1500);
                const w3 = maxMs();
                const edges = { w1: round(w1Wall), w2: round(tW2End - t0), w3: round(performance.now() - t0) };
                const winOf = (rel: number): 'w1' | 'w2' | 'w3' => (rel < edges.w1 ? 'w1' : rel < edges.w2 ? 'w2' : 'w3');
                const records = (await takeWork()).map((r) => ({ ...r, t: round(r.t), ms: round(r.ms), rel: round(r.t - t0), win: winOf(r.t - t0) }));
                const runs = runsOf(records).map((r) => ({ ...r, win: winOf(r.start) }));
                recs.push({ n, warmup: n === 0, rel, w1: round(w1), w2: round(w2), w3: round(w3), w1Wall: round(w1Wall), work: { edges, records, runs } });
            }
            // 対照：保存せずに同じ区間（1.0 秒＋1.5 秒）を測る。保存と関係なく起きる止まり（ほかの定期処理、VS Code の都合）を見分ける
            for (let n = 0; n < Math.min(stallSaves, 10); n++) {
                h.reset();
                await sleep(1000);
                const w2 = maxMs();
                h.reset();
                await sleep(1500);
                controls.push({ n, w2: round(w2), w3: round(maxMs()) });
            }
        } finally {
            h.disable();
        }
        const counted = recs.filter((r) => !r.warmup);
        const budget = { targetMs: 16, limitMs: 50 };
        const windows = ['w1', 'w2', 'w3'] as const;
        const summary = Object.fromEntries(windows.map((w) => {
            const xs = counted.map((r) => r[w]);
            return [w, { median: round(pct(xs, 0.5)), p95: round(pct(xs, 0.95)), max: round(Math.max(...xs)), overTarget: xs.filter((x) => x > budget.targetMs).length, overLimit: xs.filter((x) => x > budget.limitMs).length }];
        }));
        // 関数ごとの時間：保存 1 回あたり、その区間で同期でかかった時間の合計（無い保存は 0）の中央値・p95
        const winNames = ['w1', 'w2', 'w3'] as const;
        const fnTable: Record<string, Record<string, { median: number; p95: number; calls: number }>> = {};
        const gitTable: Record<string, Record<string, { countMedian: number; countP95: number; sumMsMedian: number; sumMsP95: number; callMsMedian: number; callMsMax: number }>> = {};
        const runTable: Record<string, { longestMedian: number; longestP95: number; longestTop: string[] }> = {};
        for (const w of winNames) {
            fnTable[w] = {}; gitTable[w] = {};
            const inWin = counted.map((r) => (r.work?.records ?? []).filter((x) => x.win === w));
            for (const name of new Set(inWin.flat().filter((x) => x.kind === 'fn').map((x) => x.name))) {
                const sums = inWin.map((rs) => rs.filter((x) => x.kind === 'fn' && x.name === name).reduce((a, x) => a + x.ms, 0));
                fnTable[w][name] = { median: round(pct(sums, 0.5)), p95: round(pct(sums, 0.95)), calls: inWin.flat().filter((x) => x.kind === 'fn' && x.name === name).length };
            }
            for (const name of new Set(inWin.flat().filter((x) => x.kind === 'git').map((x) => x.name))) {
                const gs = inWin.map((rs) => rs.filter((x) => x.kind === 'git' && x.name === name));
                const counts = gs.map((g) => g.length);
                const sums = gs.map((g) => g.reduce((a, x) => a + x.ms, 0));
                const calls = gs.flat().map((x) => x.ms);
                gitTable[w][name] = { countMedian: pct(counts, 0.5), countP95: pct(counts, 0.95), sumMsMedian: round(pct(sums, 0.5)), sumMsP95: round(pct(sums, 0.95)), callMsMedian: round(pct(calls, 0.5)), callMsMax: round(Math.max(...calls)) };
            }
            const longest = counted.map((r) => (r.work?.runs ?? []).filter((x) => x.win === w).sort((a, b) => b.ms - a.ms)[0]);
            const lens = longest.map((x) => x?.ms ?? 0);
            runTable[w] = { longestMedian: round(pct(lens, 0.5)), longestP95: round(pct(lens, 0.95)), longestTop: [...new Set(longest.flatMap((x) => x?.top ?? []))] };
        }
        const mbTags = counted.flatMap((r) => (r.work?.records ?? []).filter((x) => x.name === 'publish.mbTags').map((x) => Number(x.detail)));
        const workSummary = { functions: fnTable, git: gitTable, longestSyncRun: runTable, mbTags: { min: Math.min(...mbTags), max: Math.max(...mbTags), last: mbTags[mbTags.length - 1] } };
        const out = process.env.MICROGIT_TEST_STALL_BENCH_OUT;
        if (out) { fs.writeFileSync(out, JSON.stringify({ platform: `${process.platform}-${process.arch}`, backend: process.env.MICROGIT_TEST_EXPECT_BACKEND ?? 'auto', resolutionMs: RES_MS, idleMaxMs: idleMs, idleSettle: { publishSeenBeforeIdle: preWork.some((r) => r.name === 'publishToParentRefs'), preWorkRecords: preWork.length }, budget, saves: counted.length, summary, workSummary, records: recs, controls }, null, 2)); }
        console.log(`[stall-bench] ループが止まった最長（ms、${counted.length} 回、休止中の床 ${idleMs} ms、予算 ${budget.targetMs} / ${budget.limitMs} ms）`);
        for (const w of windows) {
            const x = summary[w];
            console.log(`  ${w.toUpperCase()}  中央値 ${x.median.toFixed(1).padStart(6)}  p95 ${x.p95.toFixed(1).padStart(6)}  最大 ${x.max.toFixed(1).padStart(6)}  ${budget.targetMs} ms 超え ${x.overTarget} 回  ${budget.limitMs} ms 超え ${x.overLimit} 回`);
        }
        if (controls.length > 0) {
            const c2 = controls.map((c) => c.w2); const c3 = controls.map((c) => c.w3);
            console.log(`  対照（保存なし ${controls.length} 回）  W2 相当 中央値 ${pct(c2, 0.5).toFixed(1)} 最大 ${Math.max(...c2).toFixed(1)}  W3 相当 中央値 ${pct(c3, 0.5).toFixed(1)} 最大 ${Math.max(...c3).toFixed(1)}`);
        }
        console.log('  同期でかかった時間：関数ごと（保存 1 回あたりの合計 ms の中央値 / p95。呼び出し回数は全保存の合計）');
        for (const w of winNames) {
            const rows = Object.entries(fnTable[w]).sort((a, b) => b[1].p95 - a[1].p95);
            if (rows.length === 0) { continue; }
            console.log(`   [${w.toUpperCase()}]  最長の同期の連続 中央値 ${runTable[w].longestMedian.toFixed(1)} p95 ${runTable[w].longestP95.toFixed(1)}（${runTable[w].longestTop.join(', ')}）`);
            for (const [name, x] of rows) { console.log(`     ${name.padEnd(48)} 中央値 ${x.median.toFixed(1).padStart(7)}  p95 ${x.p95.toFixed(1).padStart(7)}  回数 ${x.calls}`); }
        }
        console.log('  Git のプロセスの同期の起動：種類ごと（保存 1 回あたりの回数・合計 ms の中央値 / p95、1 回の ms の中央値・最大）');
        for (const w of winNames) {
            for (const [name, x] of Object.entries(gitTable[w]).sort((a, b) => b[1].sumMsP95 - a[1].sumMsP95)) {
                console.log(`   [${w.toUpperCase()}] ${name.padEnd(24)} 回数 ${x.countMedian}/${x.countP95}  合計 ${x.sumMsMedian.toFixed(1).padStart(7)}/${x.sumMsP95.toFixed(1).padStart(7)} ms  1 回 中央値 ${x.callMsMedian.toFixed(1)} 最大 ${x.callMsMax.toFixed(1)}`);
            }
        }
        console.log(`  mb-* のタグの本数（publish のとき）: 最小 ${workSummary.mbTags.min} 最大 ${workSummary.mbTags.max} 最後 ${workSummary.mbTags.last}`);
        assert.strictEqual(counted.length, stallSaves);
    });

    test('Overlay Status で、使ったバックエンドが分かる', async () => {
        await vscode.commands.executeCommand('microgit.overlayStatus');
        const status = vscode.workspace.textDocuments.map((d) => d.getText()).find((t) => t.startsWith('active='));
        assert.ok(status, 'Overlay Status の文書が開かれていない');
        const active = /^active=(\w+)/.exec(status)![1];
        console.log(`[overlayBackend.test] active backend = ${active}`);
        console.log(status.split('\n').slice(0, 12).map((l) => `  ${l}`).join('\n'));
        // 保存の記録は、Git のコマンドを起動しない速い記録で行われたはず（#32）。shadow は改行の変換を止めているので
        // （ADR-0012）、Windows の core.autocrlf=true でも速い記録の前提を満たす
        assert.match(status, /^microCommit=fast:[1-9]\d* git:0$/m, '保存の記録に Git のコマンドが使われた（速い記録の前提から外れた）');
        const expected = process.env.MICROGIT_TEST_EXPECT_BACKEND;
        if (expected) {
            assert.strictEqual(active, expected);
            if (expected === 'kernel') {
                // 起動だけ成功して checkout が失敗すると、Node.js 版で操作を続けたあと Status のために
                // カーネル版が再起動し、active=kernel だけは表示される。実際に反映まで使えた証拠も要る。
                assert.ok(status.includes('lastCheckout:'), 'カーネル版で成功した checkout の記録が無い');
            }
        }
    });
});
