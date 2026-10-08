import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

    /** 保存ジョブ（キュー）が shadow にコミットを作るまで待つ */
    async function waitForNewHead(before: string | undefined, timeoutMs = 60_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const head = shadowHead();
            if (head && head !== before) { return head; }
            await new Promise((r) => setTimeout(r, 100));
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
        const before = shadowHead();
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
