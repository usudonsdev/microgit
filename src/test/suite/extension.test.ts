import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('MicroGit Head Travel Test Suite', function () {
    this.timeout(15000);

    let testFileUri: vscode.Uri;
    let rootPath: string;
    let shadowRepoPath: string;

    suiteSetup(async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        assert.ok(workspaceFolders, 'ワークスペースが開かれていません。');
        rootPath = workspaceFolders[0].uri.fsPath;
        // このテストは Git を直接操作して「過去に戻る」を再現するもので、MicroGit のコマンドは呼ばない。
        // 以前はワークスペースの .microgit_shadow に Git を直接作っていたが、それは MicroGit の本物の shadow の場所と
        // ぶつかる（overlayBackend.test.ts が MicroGit を有効にしたとき、古い形式として移し替えられてしまう）。
        // そこで一時フォルダに作る（#14）
        shadowRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-head-travel-'));

        // フォルダ内のクリア（.gitフォルダ自体は残してロック競合を回避）
        if (fs.existsSync(shadowRepoPath)) {
            try {
                const files = fs.readdirSync(shadowRepoPath);
                for (const file of files) {
                    if (file !== '.git') {
                        fs.rmSync(path.join(shadowRepoPath, file), { recursive: true, force: true });
                    }
                }
            } catch (e) {}
        } else {
            fs.mkdirSync(shadowRepoPath, { recursive: true });
        }

        // 🔥 【日本語パス対策】cwdオプションを完全に排除し、絶対パスをクォーテーションで囲んで直接Gitに渡します
        // git init は既存リポジトリに対して実行しても安全に上書き再初期化してくれます
        try {
            execSync(`git init "${shadowRepoPath}"`, { stdio: 'ignore' });
            execSync(`git -C "${shadowRepoPath}" config core.autocrlf false`, { stdio: 'ignore' });
        } catch (e) {}

        const testFilePath = path.join(rootPath, 'test_dummy.py');
        fs.writeFileSync(testFilePath, '# Initial Content\n', 'utf8');
        testFileUri = vscode.Uri.file(testFilePath);
    });

    suiteTeardown(() => {
        const testFilePath = path.join(rootPath, 'test_dummy.py');
        if (fs.existsSync(testFilePath)) { fs.unlinkSync(testFilePath); }
    });

    test('過去のコミットハッシュを指定してジャンプした際、Headが戻りファイル内容が復元されるかの検証', async function () {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const uniqueId = Date.now();

        // 📄 [状態①] 1回目の保存とコミット
        const state1Text = `# 【状態①】\n# Initial Content\n# RunID: ${uniqueId}-1\n`;
        fs.writeFileSync(testFileUri.fsPath, state1Text, 'utf8');
        
        const shadowTestFilePath = path.join(shadowRepoPath, 'test_dummy.py');
        fs.writeFileSync(shadowTestFilePath, state1Text, 'utf8');
        
        // 🔥 【日本語パス対策】-C オプションでターゲットのシャドウリポジトリを完全固定
        execSync(`git -C "${shadowRepoPath}" add .`, { stdio: 'ignore' });
        execSync(`git -C "${shadowRepoPath}" -c user.name="TestBot" -c user.email="test@example.com" commit -m "commit1"`, { stdio: 'ignore' });
        
        const state1Hash = execSync(`git -C "${shadowRepoPath}" rev-parse HEAD`).toString().trim();

        // 📄 [状態②] 2回目の保存とコミット
        const state2Text = `# 【状態②】\n# 【状態①】\n# Initial Content\n# RunID: ${uniqueId}-2\n`;
        fs.writeFileSync(testFileUri.fsPath, state2Text, 'utf8');
        fs.writeFileSync(shadowTestFilePath, state2Text, 'utf8');
        
        execSync(`git -C "${shadowRepoPath}" add .`, { stdio: 'ignore' });
        execSync(`git -C "${shadowRepoPath}" -c user.name="TestBot" -c user.email="test@example.com" commit -m "commit2"`, { stdio: 'ignore' });

        let currentText = fs.readFileSync(testFileUri.fsPath, 'utf8');
        assert.ok(currentText.includes('【状態②】'), '状態②の保存がファイルに反映されていません。');

        // 🚀 [タイムトラベル発動] 
        execSync(`git -C "${shadowRepoPath}" checkout ${state1Hash}`, { stdio: 'ignore' });
        
        const restoredContent = fs.readFileSync(shadowTestFilePath, 'utf8');
        fs.writeFileSync(testFileUri.fsPath, restoredContent, 'utf8');

        // VS Codeのテキストバッファを強制リロードしてディスクの最新(状態①)を反映
        const doc = await vscode.workspace.openTextDocument(testFileUri);
        await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);

        await new Promise(resolve => setTimeout(resolve, 1000));

        // 🔍 [検証] 実際のファイル内容を確認
        const travelText = fs.readFileSync(testFileUri.fsPath, 'utf8');

        assert.strictEqual(travelText.includes('【状態②】'), false, '🚨 状態②の変更が残ってしまっています。');
        assert.ok(travelText.includes('【状態①】'), '✅ 状態①のテキストが正しく復元されました！');

        const shadowHeadHash = execSync(`git -C "${shadowRepoPath}" rev-parse HEAD`).toString().trim();
        assert.strictEqual(shadowHeadHash, state1Hash, 'シャドウリポジトリ側のGit HEADが移動していません。');
    });
});