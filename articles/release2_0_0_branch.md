---
title: "Ctrl+Z で消えるコードを残す VS Code 拡張を作った"
emoji: "⏱️"
type: "tech" # tech: 技術記事 / idea: アイデア
topics: ["vscode", "git", "typescript", "svg", "webview"]
published: true
---

Ctrl+Z で少し前のコードまで戻して、そこから別の書き方を試し始める。その瞬間、戻る前に書いていたコードは Undo の履歴から消えて、もう取り戻せません。

コミットするほどではないけれど、消えると惜しい数分間の試行錯誤。これを残すために、**ファイルを保存するたびに裏で自動コミットを作り、過去の保存点をグラフでたどれる VS Code 拡張「MicroGit」** を作りました。

:::message
**この記事で書くこと**
- 保存のたびに、普段の `.git` とは別の隠しリポジトリへ自動でコミットする仕組み
- `git commit` ではなく `git commit-tree` で親コミットを指定し、過去の保存点から枝分かれさせる方法
- VS Code の Webview に SVG でコミットグラフを描く方法

VS Code 拡張から git を操作したい人、Git の内部コマンドに興味がある人向けです。
:::

---

## 解決したかった課題

一般的な開発フローでは、以下のような「あるある」が発生します。

1. アイデアAを試すためにコードを10行書く（上書き保存）
2. 「うーん、やっぱりイマイチだな」と思い、**Ctrl + Zを連打して元に戻す**
3. 別のアイデアBを試すために1行書き換えて**保存**する
4. **結果：アイデア A の 10 行は復元できない**

Gitで細かくブランチを切れば防げますが、数分単位のちょっとした実験のために手動でブランチを作るのはあまりにも面倒です。
そこで、**「ファイル保存をトリガーに、裏側で自動的に歴史を枝分かれ（フォーク）させる」**仕組みを実装しました。

---

## アプローチ：隠しリポジトリと枝分かれするコミット

この拡張機能は、メインプロジェクトの `.git` とは完全に独立した、独自の隠しリポジトリ（`.microgit_shadow`、以下シャドウリポジトリ）を裏側で管理しています。

最大の特徴は、通常の `git commit` コマンドを一切使わず、**Gitの低レベル配管コマンドである `git commit-tree` を直接叩いている点**です。これにより、現在のHEADポインタ（過去に戻っているならその時点）を明示的に親（`-p`）として指定し、完全に非線形な「歴史の枝分かれ」をコード保存と同時に自動生成しています。

### 核心となるシャドウコミット処理（TypeScript）

```typescript
// ファイル保存時に裏側で自動的に歴史を構築する
async function runShadowCommit(mainRepoPath: string, savedFilePath: string): Promise<void> {
    // ...（シャドウ領域へのファイル同期などの前処理）

    // 💡 通常の git commit は使わない！
    // 過去の特定地点（headHash）を明示的に親に指定してコミットオブジェクトを手動構築
    const treeHash = execSync('git write-tree', { cwd: shadowRepoPath }).toString().trim();
    let commitHash = '';
    
    if (!headHash) {
        commitHash = execSync(`git commit-tree ${treeHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
    } else {
        // ここで過去の任意のコミットを親（-p）に結びつけることで、Ctrl+Zで戻った後の分岐を可能にする
        commitHash = execSync(`git commit-tree ${treeHash} -p ${headHash} -m "${commitMessage}"`, { cwd: shadowRepoPath }).toString().trim();
    }

    // HEADポインタをこの新しいコミットに移動
    execSync(`git update-ref HEAD ${commitHash}`, { cwd: shadowRepoPath });

    // 直列前進なら既存タグを移動、過去からの分岐なら新しい連番タグ（mb-2など）を生成
    if (isForwarding) {
        execSync(`git tag -f ${currentMicroBranchTag} ${commitHash}`, { cwd: shadowRepoPath });
    } else {
        const nextTag = getNextTagCode(shadowRepoPath);
        execSync(`git tag ${nextTag} ${commitHash}`, { cwd: shadowRepoPath });
        currentMicroBranchTag = nextTag;
    }
}
```

### 可視化：SVG で Git グラフを描く

歴史が自動で分岐するようになっても、CLIの文字列だけでは自分が今どの世界線にいるのか分からなくなります。そこで、VS CodeのWebviewを使い、親子関係を自動で解析して結線するSVGグラフビューアを実装しました。

Webview 側では、拡張機能の本体から送られてきた `parents`（親コミットのハッシュの配列）を元に、子ノードから親ノードへ向かって SVG の `<line>` 要素を引いています。

```javascript
// 各コミットの親子関係をループで回してSVGの線を引く
commits.forEach((c) => {
    const childPos = nodeMap.get(c.hash);
    c.parents.forEach(pHash => {
        const parentPos = nodeMap.get(pHash);
        if (parentPos) {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", childPos.x);
            line.setAttribute("y1", childPos.y);
            line.setAttribute("x2", parentPos.x);
            line.setAttribute("y2", parentPos.y);
            line.setAttribute("class", "line"); // CSSで太さや色を調整
            svg.appendChild(line);
        }
    });
});
```

## 動かしてみる

完成した拡張機能の動作がこちらです。

ファイルを何回か保存すると、Webview上にノードが縦に並び、線で繋がります。

グラフ上の「丸（ノード）」をポチッとクリックすると、フロントからバックエンドへメッセージが飛び、一瞬でその瞬間のコードがエディタに復元されます。

過去に戻った状態でコードを書き換えて保存すると、古いノードから新しい線がパッと枝分かれして伸びていきます。

「別の書き方も試したいが、今のコードが消えるのは困る」という状況で、戻る前の状態が保存点として残ります。

## まとめ

上書きでしかなかった「保存」を分岐点として扱うことで、試行錯誤を消さずに残せるようになりました。

今後は、分岐した歴史同士の差分（diff）をVS Code標準の差分ビューで一発確認できる機能や、この細かいマイクロ履歴をチームメンバー間で自動同期して「隣の席の人が2分前にやっていた試行錯誤」すら覗き見れるように拡張していきたいと考えています。

拡張機能から `git commit-tree` を直接叩く構成に興味がある方の参考になれば幸いです。

- リポジトリ: [usudonsdev/microgit](https://github.com/usudonsdev/microgit)
- VS Code 拡張: [MicroGit](https://marketplace.visualstudio.com/items?itemName=usudonsdev.microgit)

> この記事は v2.0.0 時点の記録です。現行は v4.0.0 で、シャドウ領域は `.microgit_overlay` を使う構成に変わりました。最新の設計は「[Git 高速化の論文を読んで、保存ごとに履歴を残す拡張を作った](https://zenn.dev/usudonsdev/articles/article-zenn-microgit-overlaygit)」に書いています。