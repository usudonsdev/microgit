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
        return waitForNewHead(before);
    }

    suiteSetup(async () => {
        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders, 'ワークスペースが開かれていません。');
        root = folders[0].uri.fsPath;
        shadow = path.join(root, '.microgit_shadow');
        assert.ok(!fs.existsSync(shadow), 'MicroGit を有効にする前から .microgit_shadow がある（ほかのテストが作った？）');
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
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'メモ.txt'), 'utf8'), 'v1\n');
        assert.ok(!fs.existsSync(path.join(root, 'kb', 'later.txt')), 'h1 の時点には無いファイルが残っている');
        assert.strictEqual(shadowHead(), h1);

        await vscode.commands.executeCommand('microgit.jumpToCommit', h3);
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'メモ.txt'), 'utf8'), 'v2\n');
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'later.txt'), 'utf8'), 'created later\n');
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

        await vscode.commands.executeCommand('microgit.jumpToCommit', smallHead);
        assert.strictEqual(fs.readFileSync(path.join(root, 'kb', 'large.txt'), 'utf8'), 'small\n');
    });

    test('Overlay Status で、使ったバックエンドが分かる', async () => {
        await vscode.commands.executeCommand('microgit.overlayStatus');
        const status = vscode.workspace.textDocuments.map((d) => d.getText()).find((t) => t.startsWith('active='));
        assert.ok(status, 'Overlay Status の文書が開かれていない');
        const active = /^active=(\w+)/.exec(status)![1];
        console.log(`[overlayBackend.test] active backend = ${active}`);
        console.log(status.split('\n').slice(0, 12).map((l) => `  ${l}`).join('\n'));
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
