# 02. Git のオブジェクトと出力形式／whiteout の表し方／不具合の切り分け方

| 項目 | 内容 |
|---|---|
| 関係する Issue | #21（Node 版 Overlay の不具合 N-3〜N-6） |
| 実装 | [src/overlay.ts](../../src/overlay.ts) の `listCommitChanges`・`exportCommitLayer`・`applyLayerOntoMerge`・`removeTree`、[scripts/overlay-smoke.mjs](../../scripts/overlay-smoke.mjs) |
| 詳しい仕様 | [NodeOverlay.md](../NodeOverlay.md) のレイヤ形式 v2 |

---

## 1. 何のための仕組みか

MicroGit の Node 版 Overlay は、shadow の Git から「コミットごとの差分の層」を作り、それを重ねて過去の姿（ビュー）を組み立てる。ゴールデンテスト（[01](./01-golden-testing-and-namespaces.md)）で、この層の作り方に 4 つの不具合が見つかった。

| # | 症状 | 根っこにある知識 |
|---|---|---|
| N-3 | ファイルをディレクトリに置き換えると壊れる | Git のオブジェクト（blob と tree） |
| N-4 | ディレクトリをファイルに置き換えると壊れる | OverlayFS の「上の層が下の層を隠す」規則 |
| N-5 | `.wh.` で始まるファイルが消える | whiteout の表し方 |
| N-6 | 日本語のファイル名が壊れる | Git の出力のエスケープ |

どれも「Git やファイルシステムの仕組みを、表面の動きだけで判断した」ことから来ている。

---

## 2. 仕組み

### 2.1 Git のオブジェクト：blob・tree・commit（N-3）

Git は中身を 3 種類のオブジェクトで持つ。

```
commit ──→ tree（ルート）──┬→ blob  README.md の中身
                           └→ tree  src/ ──→ blob  app.js の中身
```

- **blob**：ファイルの中身だけ（名前は持たない）
- **tree**：ディレクトリ。「名前・モード・指すオブジェクト」の一覧
- **commit**：ある時点のルートの tree と、親のコミット

`git show <commit>:<path>` は、path が blob でも tree でも成功する。tree なら中身の一覧を表示する。

```
$ git show HEAD:p          # p がディレクトリなら
tree HEAD:p

q.txt
```

v1 は「`git show` が成功したらファイル」と判断していたので、ディレクトリになった `p` の一覧テキストを、ファイル `p` の中身として書いていた。種類は `git cat-file -t HEAD:p`（→ `tree`）で分かる。

### 2.2 人向けの出力と、プログラム向けの出力（N-3・N-6）

Git のコマンドには、人が読むための出力と、プログラムが読むための出力がある。

| 目的 | 例 | 特徴 |
|---|---|---|
| 人が読む | `git diff-tree --name-only` | 変わったパスだけ。特殊な文字はエスケープする |
| プログラムが読む | `git diff-tree -r -z --raw` | モード・オブジェクト・状態まで出る。`-z` で NUL 区切り、エスケープなし |

`--raw` の 1 レコード：

```
:100644 100644 78981922... 61780798... M   メモ.txt      （-z ではパスの前後が NUL）
 旧モード 新モード 旧sha       新sha       状態 パス
```

（2026-09-26 に手元で `git diff-tree -r -z --raw` を実行した出力。sha は途中を省略）

| 状態 | 意味 |
|---|---|
| A | 追加 |
| M | 中身の変更 |
| T | 種類の変化（ファイル ⇔ シンボリックリンクなど） |
| D | 削除 |

`-r` を付けると tree の中まで降りるので、出てくるのはファイル（blob）とサブモジュールだけになる。ファイル `p` がディレクトリになると、「`D p`」と「`A p/q.txt`」の 2 行で表される。

**エスケープ（N-6）**：Git の既定設定 `core.quotepath=true` では、人向けの出力で ASCII 以外の文字をエスケープする。

```
$ git -c core.quotepath=true diff-tree --name-only -r HEAD~1 HEAD
"\343\203\241\343\203\242.txt"          ← 「メモ.txt」の UTF-8 のバイト列を 8 進数で書いたもの
```

これをパスとして `git show` に渡すと「そんなパスは無い」と失敗する。v1 はその失敗を「削除された」と解釈していた。作者の PC はグローバル設定が `core.quotepath=false` だったので表に出なかった。**自分の環境の設定が、利用者の既定と同じとは限らない**。テストでは `-c core.quotepath=true` を付けて既定の挙動を強制している。

### 2.3 whiteout の表し方（N-5）

「下の層にあるファイルを、上の層で消した」ことをどう表すか。

| 方式 | 表し方 | 名前の衝突 |
|---|---|---|
| Linux の OverlayFS | 種類 0,0 のキャラクタデバイスファイルを、消したファイルと同じ名前で置く | 起きない（普通のファイルとは種類が違う） |
| AUFS、OCI イメージ（Docker のイメージの層） | `.wh.<名前>` という空ファイルを置く。ディレクトリの中身を全部隠す印は `.wh..wh..opq` | 起きる。OCI の仕様は「`.wh.` で始まる名前は作れない」と割り切っている |
| MicroGit Node 版 v1 | AUFS と同じ | 起きる（N-5） |
| **MicroGit Node 版 v2** | 層の外のメタデータ `layers/<hash>.json` に、消えたパスの一覧を持つ | 起きない |

Node.js からは種類 0,0 のデバイスファイルを作れない（作るには特別な権限が要る）ので、カーネルと同じ方式は採れない。そこで「層の中は利用者のファイルだけ、印は層の外」という形にした。

### 2.4 上の層が下の層を隠す規則（N-4）

OverlayFS では、上の層にある **ディレクトリでないもの**（ファイルや whiteout）は、下の層の同じ名前のディレクトリを **丸ごと** 隠す。だから「ディレクトリ `p/` をファイル `p` に置き換えた」層には、`p/q.txt` の whiteout は要らない。v1 はそれを書こうとして、ファイル `p` の下にディレクトリを作る羽目になり失敗していた。

### 2.5 readdir の順番は決まっていない

ディレクトリの中身を列挙する `readdir` の順番は、ファイルシステムしだいである。NTFS（Windows）ではほぼ名前順、ext4（Linux）ではハッシュ順になる。v1 は「whiteout `p`」と「新しい `p/`」の処理順を readdir に任せていたので、Windows で通るテストが Linux で落ちる可能性があった。v2 は whiteout を先に全部当ててから、ファイルを置く。

### 2.6 小さな落とし穴 2 つ

- **`execFileSync` の出力の上限**：既定の `maxBuffer` は 1 MiB。それを超える出力は `ENOBUFS` で失敗する。v1 は大きいファイルの `git show` が失敗し、それも「削除」扱いになっていた
- **キャッシュの形式を変えるとき**：形式の版を `format.json` に書いておき、古ければ捨てる。捨ててよいのは、正本（shadow の Git）から作り直せるキャッシュだから。正本のデータの形式を変えるときは、こうはいかない（#11 で扱う）

### 2.7 不具合の切り分け方（Node 25 の例）

作業中、スモークテストが何も出さずに終了コード 127 で止まった。やったことを順に書く。

1. **どこで止まるかを絞る**：テストに `console.log` を足して、「コミット 1 は通る、コミット 2 の前で止まる」まで絞った
2. **最小の再現を作る**：その間のファイル操作を 1 行ずつ別のスクリプトにして、`fs.rmSync('資料', { recursive: true })` で落ちることを突き止めた
3. **条件を変えて比べる**：ASCII 名のディレクトリなら落ちない、日本語名のファイルなら落ちない、`force: true` でも落ちる、と条件を 1 つずつ変えた
4. **バージョンを変えて比べる**：Node 22.23.3 と 24.21.0 では落ちず、25.1.0 だけで落ちることを確かめた
5. **影響範囲を判断する**：拡張機能は VS Code の Node（22 系）で動くので今は影響しない。ただし将来に備えて、再帰削除を自前の `removeTree` にした

**自分のコードの不具合か、道具の不具合かは、最小の再現とバージョンの比較で切り分けられる**。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| Git の生の出力を読む | `overlay.ts` の `listCommitChanges()`（`diff-tree -r -z --raw --no-renames`、最初のコミットは `ls-tree -r -z`） |
| 層を書き出す（whiteout は層の外、最後に書く） | `exportCommitLayer()`、`writeLayerMeta()` |
| 層を重ねる（whiteout が先、ぶつかりを片付ける） | `applyLayerOntoMerge()`、`ensureDirectoryPath()` |
| 古い形式を捨てる | `migrateLayerFormat()` |
| Node のバージョンに依存しない再帰削除 | `removeTree()` |
| 拡張機能の Git 呼び出しでエスケープを止める | `extension.ts` の `runGit()`（`-c core.quotepath=false`） |
| 回帰テスト | `scripts/overlay-smoke.mjs` の 4〜7 |

---

## 4. 手を動かして確かめる

1. **blob と tree を見分ける**（どこかの Git リポジトリで）
   ```bash
   git cat-file -t HEAD:src          # tree
   git cat-file -t HEAD:README.md    # blob
   git show HEAD:src                 # tree でも成功してしまう
   ```
2. **エスケープを見る**：日本語名のファイルをコミットして、次の 2 つを比べる
   ```bash
   git -c core.quotepath=true  log -1 --name-only
   git -c core.quotepath=false log -1 --name-only
   git log -1 -z --name-only | od -c | head   # NUL 区切りでエスケープなし
   ```
3. **`--raw` の状態を読む**：ファイルを消す・変える・足すを 1 コミットでやって、`git diff-tree -r --raw HEAD~1 HEAD` の A/M/D を確かめる
4. **回帰テストを流す**：`npm run test:overlay`。4〜7 が今回直した点
5. **層の形を見る**：MicroGit を使っているワークスペースの `.microgit_overlay/layers/` を開き、`<hash>/` と `<hash>.json` を見比べる

---

## 5. もっと知りたいとき

- Pro Git（git-scm.com/book/ja/v2）の 10 章「Git の内側」、特に 10.2「Git オブジェクト」
- `git help diff-tree` の「RAW OUTPUT FORMAT」、`git help config` の `core.quotePath`
- OCI Image Spec の `layer.md`（github.com/opencontainers/image-spec）の「Whiteouts」
- Linux カーネルのドキュメント「Overlay Filesystem」の「whiteouts and opaque directories」
- `man 3 readdir`（順番が決まっていないことの記述）
