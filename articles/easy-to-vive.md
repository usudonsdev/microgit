---
title: "Copilot が従量課金になったので、無料の Gemini でペアプロする"
emoji: "🌊"
type: "tech" # tech: 技術記事 / idea: アイデア
topics: ["vscode", "gemini", "ai", "ペアプログラミング", "個人開発"]
published: false
---

こんにちは、臼丼（@usudonsdev）です。大学で個人開発をしています。

2026 年 6 月、GitHub Copilot の料金が、使ったトークンの量に応じた従量課金に切り替わりました。学生の個人開発だと、月の枠を気にしながら AI に質問することになります。正直、けっこう気疲れします。

そこで、**プロジェクトのコードを丸ごと 1 つの Markdown ファイルにまとめて、無料で使える Gemini に渡し、相談しながら開発する**やり方を試しました。その「まとめる」部分を VS Code 拡張機能「**EasyToVibe**」にして、Marketplace で公開しています。

:::message
**この記事で書くこと**
- 最初に素朴な実装でまとめたら 125 万行になった話と、`.gitignore` を使って数千行まで減らした方法
- EasyToVibe のコード全文（100 行ちょっと）
- Gemini を「相談相手」にするための指示文（システムプロンプト）

AI の課金額を抑えつつ、プロジェクト全体を AI に見せて相談したい人向けです。
:::

ここで言う「バイブコーディング」は、細かい実装を AI に任せ、人は「こうしたい」を言葉で伝えながら進める開発スタイルのことです。

---

## すぐ使いたい人へ

VS Code の拡張機能タブで「EasyToVibe」と検索するか、以下からインストールできます。

[EasyToVibe - VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=usudonsdev.easy-to-vibe)

インストール後、フォルダを開いた状態で `Ctrl + Shift + P`（Mac は `Cmd + Shift + P`）を押し、「**AI用: プロジェクトの全コードをMarkdown化**」を実行します。`markdowns/` フォルダに、ディレクトリ構造と全ソースコードをまとめた Markdown ができます。

---

## 1. 最初は 125 万行になった

最初に作ったのは、「プロジェクト内の全ファイルを読んで、1 つの Markdown に結合する」だけのスクリプトでした。

開発中の VS Code 拡張のプロジェクトで試したところ、出力は **125 万行**。`node_modules` やビルド結果（`dist`、`build`）の中身まで全部読み込んでいたのが原因です。これでは AI に渡せません。

AI に見せたいのは、**自分が書いたソースコードと、ディレクトリ全体の構造**だけです。そこで次の 2 つを入れました。

1. `.gitignore` のルールを読み込み、Git で無視しているファイルは中身を読まない
2. `node_modules` などは、ツリーには「ここにある」とだけ残し、中身は読まない

これで、125 万行が数百〜数千行に収まりました。

---

## 2. EasyToVibe のコード

拡張機能の本体（`extension.js`）は次のとおりです。`.gitignore` の書式を正しく解釈するために、`ignore` というライブラリを使っています。

```javascript
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

// ツリー構造には出すが、中身のソースコード出力からは除外するディレクトリ
const CONTENT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'markdowns']);

// テキストとして読み込む対象の拡張子
const VALID_EXTENSIONS = new Set(['.py', '.c', '.h', '.java', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.yml', '.yaml']);

function getGitignoreFilter(workspaceRoot) {
    const ig = ignore();
    ig.add(['.git', 'markdowns']); 
    
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
            ig.add(gitignoreContent);
        } catch (e) {
            console.error('.gitignore の読み込みに失敗しました:', e);
        }
    }
    return ig;
}

function generateTree(dirPath, workspaceRoot, ig, prefix = "") {
    let treeStr = "";
    if (!fs.existsSync(dirPath)) return treeStr;

    const files = fs.readdirSync(dirPath).sort();
    const filtered = files.filter(file => {
        const fullPath = path.join(dirPath, file);
        const relativePath = path.relative(workspaceRoot, fullPath);
        const isDir = fs.statSync(fullPath).isDirectory();
        const checkPath = isDir ? `${relativePath}/` : relativePath;
        return !ig.ignores(checkPath);
    });

    filtered.forEach((file, i) => {
        const isLast = i === filtered.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const fullPath = path.join(dirPath, file);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            treeStr += `${prefix}${connector}${file}/\n`;
            if (CONTENT_SKIP_DIRS.has(file)) {
                treeStr += `${prefix}${isLast ? "    " : "│   "}└── (...contents skipped...)\n`;
            } else {
                const newPrefix = prefix + (isLast ? "    " : "│   ");
                treeStr += generateTree(fullPath, workspaceRoot, ig, newPrefix);
            }
        } else {
            if (VALID_EXTENSIONS.has(path.extname(file))) {
                treeStr += `${prefix}${connector}${file}\n`;
            }
        }
    });
    return treeStr;
}

function bundleCode(workspaceRoot) {
    const rootName = path.basename(workspaceRoot);
    const ig = getGitignoreFilter(workspaceRoot);

    let markdown = `# Project Context: ${rootName}\n\n## Directory Structure\n\`\`\`text\n${rootName}/\n`;
    markdown += generateTree(workspaceRoot, workspaceRoot, ig);
    markdown += `\`\`\`\n\n## Source Code Files\n\n`;

    function walk(currentDir) {
        if (!fs.existsSync(currentDir)) return;
        const files = fs.readdirSync(currentDir);

        files.forEach(file => {
            const fullPath = path.join(currentDir, file);
            const relativePath = path.relative(workspaceRoot, fullPath);
            const stats = fs.statSync(fullPath);
            const isDir = stats.isDirectory();
            const checkPath = isDir ? `${relativePath}/` : relativePath;

            if (ig.ignores(checkPath)) return;

            if (isDir) {
                if (CONTENT_SKIP_DIRS.has(file)) return;
                walk(fullPath);
            } else {
                if (VALID_EXTENSIONS.has(path.extname(file))) {
                    const lang = path.extname(file).slice(1);
                    markdown += `### File: \`${relativePath}\`\n\`\`\`${lang}\n`;
                    try {
                        markdown += fs.readFileSync(fullPath, 'utf-8');
                    } catch (e) {
                        markdown += `// Error reading file: ${e.message}\n`;
                    }
                    markdown += `\n\`\`\`\n\n`;
                }
            }
        });
    }

    walk(workspaceRoot);
    return markdown;
}

function activate(context) {
    let disposable = vscode.commands.registerCommand('easy-to-vibe.copyContext', async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('ワークスペースが開かれていません。');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        vscode.window.showInformationMessage('プロジェクトをスキャン中...');
        
        const markdownResult = bundleCode(rootPath);
        const outputDir = path.join(rootPath, 'markdowns');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const now = new Date();
        const timestamp = now.getFullYear() + 
            String(now.getMonth() + 1).padStart(2, '0') + 
            String(now.getDate()).padStart(2, '0') + '_' + 
            String(now.getHours()).padStart(2, '0') + 
            String(now.getMinutes()).padStart(2, '0') + 
            String(now.getSeconds()).padStart(2, '0');
        
        const outputFileName = `project_context_${timestamp}.md`;
        const outputFilePath = path.join(outputDir, outputFileName);
        
        try {
            fs.writeFileSync(outputFilePath, markdownResult, 'utf-8');
            vscode.window.showInformationMessage(`保存成功: markdowns/${outputFileName}`);
            const document = await vscode.workspace.openTextDocument(outputFilePath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            vscode.window.showErrorMessage(`保存失敗: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

module.exports = { activate, deactivate: function(){} };
```


## 3. Gemini に「相談相手」の役を与える

できた Markdown を Gemini にドラッグ＆ドロップで渡します。

どこで渡すかには注意が要ります。無料の Gemini アプリは一度に読める量が小さめなので、大きなプロジェクトだと全部は読んでくれません。その場合は、無料で使える **Google AI Studio** で、長い入力を扱えるモデルを選ぶのがおすすめです。小さめのプロジェクトなら、Gemini アプリの **Gems**（指示文を保存しておける機能。無料プランでも使えます）が手軽です。

どちらでも、最初に次の指示文を設定しておくと、「一度に大量の修正を出してくる」ことが減り、一歩ずつ一緒に進める相手になってくれます。

### 指示文（システムプロンプト）

```plaintext
ユーザーから、プロジェクトのディレクトリ構造とソースコードが統合されたマークダウンファイル（Project Context）が提供されます。
あなたは、優秀で親しみやすく、かつ的確な指摘を行うシニア開発者（ペアプログラミングの相棒）として振る舞い、以下のガイドラインに従って「疑似ライブコーディング」のワークフローを形成してください。

### 1. 基本方針と出力フォーマット
- 返答はすべて「Markdown」形式で、構造的に美しく、パッと見で理解しやすく出力してください。
- ユーザーからコードが渡された直後の最初の返答では、まず「プロジェクト全体の概要（何をしようとしているコードか）」を1〜2行で簡潔に要約し、把握したことを示してください。

### 2. 疑似ライブコーディングの進行
- 一度に大量の修正案を提示してユーザーを圧倒しないでください。
- ライブコーディングのように、「まずはここから直していきましょう」「次は〜を実装しましょう」と、ステップバイステップで対話をリードしてください。
- 修正コードを提示する場合は、変更前後の差分が分かりやすいように、該当ファイル名（例: `### 修正: src/main.c`）を明記し、コードブロックを使ってください。

### 3. 対話の締めくくり（次のステップ）
- 返答の最後には必ず、ユーザーが次に取るべきアクションや、次に議論したいポイントを「1つの明確な質問、または次のステップの提案」として投げかけ、コーディングのグルーヴ（流れ）を止めないようにしてください。
```


## 4. 実際の流れ

普段の開発は、こんな流れになりました。

1. いつも通りコードを書く
2. `Ctrl + Shift + P`（Mac は `Cmd + Shift + P`）で「AI用: プロジェクトの全コードをMarkdown化」を実行
3. `markdowns/` にタイムスタンプ付きの Markdown ができ、VS Code で自動的に開く
4. そのファイルを Gemini に渡す

Gemini はファイル同士の関係や CI の設定（`.github/workflows/ci.yml`）、`.vscode/settings.json` まで読んだうえで、たとえばこんなふうに返してきます。

> 「〇〇機能の実装ですね。全体を見ましたが、`src/extension.ts` のこの関数はファイル保存時に同期処理が走っていて、少し重くなりそうです。まずここを非同期にするところから始めませんか？」

あとは「じゃあそこを直して」「次はこの関数を足したいけど、どこに書くのがいい？」と会話しながら進めます。

一方で、弱点もあります。コードを変えるたびに Markdown を作り直して渡し直す必要があり、Copilot のようにエディタの中で直接書き換えてはくれません。出てきたコードを貼り付けるのは自分です。

---

## まとめ

有料の AI ツールは便利で、体験としてはやはり上です。ただ、

- `.gitignore` を使って、渡すコードを自分で絞る
- 長い入力を無料で扱える Gemini に、プロジェクトごと渡す

の 2 つを組み合わせると、お金をかけずに「プロジェクト全体を分かっている相談相手」を用意できます。課金の枠を気にせず AI と相談したい人は、試してみてください。

※ Gemini の無料枠や読み込める量は変わることがあります。執筆時点（2026 年 9 月）の情報です。
