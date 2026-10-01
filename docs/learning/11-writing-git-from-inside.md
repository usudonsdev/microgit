# 11. Git を内側から書く：保存形式・プロセスの起動の費用・キャッシュの無効化・fsync

| 項目 | 内容 |
|---|---|
| 関係する Issue | #32（マイクロコミットを git commit より桁違いに速く、履歴が伸びても遅くならないものにする） |
| 実装 | [src/fastGit/](../../src/fastGit/)、[src/fastMicroCommit.ts](../../src/fastMicroCommit.ts)、[src/microCommit.ts](../../src/microCommit.ts) |
| 確かめ方 | [scripts/bench-micro-commit.mjs](../../scripts/bench-micro-commit.mjs)、[scripts/test/micro-commit-diff.mjs](../../scripts/test/micro-commit-diff.mjs) |
| 決めたこと | [ADR-0012](../adr/0012-record-exact-bytes.md)（保存した中身をそのまま記録する） |

---

## 1. 何のための仕組みか

MicroGit は、保存のたびに Git のコミットを作る。Git の形式で残すので、ふつうの Git で履歴を読める。ところが、ふつうの `git add` ＋ `git commit` は、人が数分に 1 回使う前提の道具で、保存のたびに使うと重い。MicroGit 5.0.0 までは、保存 1 回で Git のプロセスを 16 回前後起動し、さらに「過去に同じ変更があったか」を探すために、保存のたびに履歴全体を読んでいた。

| 履歴の長さ（Windows） | 5.0.0 までの記録 | ふつうの Git |
|---|---|---|
| 10 回 | 551 ms | 80 ms |
| 1,000 回 | 2,444 ms（Git を 62.5 回起動） | 78 ms |

**使うほど遅くなる**。#32 では、Git の保存形式はそのままに、書き方を作り直した。

---

## 2. 仕組み

### 2.1 Git の保存形式は小さい

Git のコミットは、次の 3 種類のファイル（オブジェクト）と、2 つの小さなファイルでできている。

| もの | 中身 | 置き場所 |
|---|---|---|
| blob | ファイルの中身そのもの | `objects/xx/yyyy…`（zlib で圧縮） |
| tree | 「名前・モード・blob か tree のハッシュ」の並び（1 フォルダ 1 つ） | 同上 |
| commit | tree、親、作者、日時、メッセージ | 同上 |
| index | 次のコミットに入るファイルの一覧（パス・モード・ハッシュ・stat） | `index` |
| ref | ブランチやタグが指すコミットのハッシュ（40 文字＋改行） | `refs/heads/…`、`refs/tags/…` |

オブジェクトの名前（ハッシュ）は「`<種類> <長さ>\0<中身>`」の SHA-1。**中身が同じなら名前も同じ** なので、Git と同じ手順で書けば、Git が書いたものと 1 ビットも違わない。

細かい決まりの例：

- tree の並びは名前のバイト列の順。ただしフォルダは名前の後ろに「/」があるものとして比べる（`a.txt` と `a/` の順が変わる）
- `git commit-tree -m <メッセージ>` は、メッセージの最後に改行が無ければ 1 つ足す
- index の各項目は、NUL で 8 バイトの倍数にそろえる

### 2.2 プロセスの起動は高い

Git のコマンドを 1 回起動するだけで、Windows では 30 ms 前後、Linux でも数 ms かかる（プログラムを読み込み、設定ファイルを読み、リポジトリを探す）。保存 1 回で 16 回起動すれば、それだけで 0.5 秒になる。速い記録は、Git の形式のファイルを拡張機能の中で直接書くので、ふだんは Git を起動しない。

### 2.3 探索を「毎回全部」から「索引を足す」に

「過去に同じ tree、または同じパスに同じ中身があったか」を、5.0.0 までは保存のたびに `git log --all` で履歴全体を読んで探していた。速い記録は、最初に 1 回だけ履歴を読んで索引（tree → コミット、パスごとの blob → コミット）を作り、記録のたびに足す。履歴が 10 回でも 1,000 回でも、探す費用は同じ。

### 2.4 キャッシュには「いつ捨てるか」が要る

メモリに持った状態（index・ref・索引）は、ほかの処理が Git のファイルを書き換えたら古くなる（過去に戻る操作、他デバイスからの取り込み）。速い記録は、使う前にファイルの **stat（更新時刻・大きさ・inode）** を見て、変わっていたら読み直す。Git はファイルを「一時ファイルに書いて名前を変える」ので、書き換えられると inode かフォルダの更新時刻が必ず変わる。ref が知らないコミットを指していたら、索引も読み直す。

### 2.5 振る舞いを 1 ビットそろえる：差分テスト

新しい実装が古い実装と同じことをするかは、**同じ入力の列を両方に流して、結果を全部比べる**（差分テスト）。今回は、書き換え・新しいファイル・日本語の名前・中身を戻す・直前の取り消し・途中で過去に戻る、を混ぜた 600 回の保存で、毎回の結果と HEAD・全部の ref・index を比べた。

実際に、66 回目で食い違いが見つかった。同じ中身に戻したあと、古い実装は HEAD だけを動かし index はそのまま残す。そのため次のコミットは、保存したファイル以外も親と違うことがある。新しい実装の索引は保存したファイルしか足していなかった。仕様書を読んでも気づきにくい振る舞いが、差分テストでは出てくる（学習用 07 と同じ考え方）。

### 2.6 fsync：「書いた」と「残った」は違う

`write` が返っても、データはまだ OS のメモリの中にある。電源が落ちると消える。`fsync` を呼ぶと、ディスクに書き終わるまで待つ。MicroGit の既定（ADR-0002）は「電源断でも記録を失わない」なので、オブジェクトと ref を fsync する。

| 1 回の記録（履歴 1,000 回、p50） | fsync なし | fsync あり |
|---|---|---|
| Linux（WSL2）速い記録 | 3.1 ms | 19.4 ms |
| Linux（WSL2）ふつうの Git | 16.3 ms | 30.7 ms |
| Windows 速い記録 | 44.5 ms ※ | 52.3 ms |
| Windows ふつうの Git | 83.7 ms ※ | 168.1 ms |

※ Windows の計測は、同じ条件でも回によって大きくばらついた（ふつうの Git が 84〜191 ms）。

fsync ありの時間の大半は fsync そのもの（保存 1 回で 7 ファイル）。これ以上速くするには、fsync する回数を減らす設計が要る（例：1 回の保存の記録を 1 つの追記ファイル（ジャーナル）に書いて fsync を 1 回にし、Git の形式のファイルは後で書く）。

**同じコードでも、fsync の費用は機械で大きく違う**（#45、2026-10-02）。fsync の時間だけを数えると：

| 環境 | fsync 1 回 | 記録のうち fsync の割合 |
|---|---|---|
| CI の Ubuntu | 約 0.35 ms | 約 40% |
| 手元の Windows 11 | 約 1.3 ms | 39% |
| CI の macOS | 約 1.6 ms | 56% |
| CI の Windows（クラウドの仮想マシン） | 約 7.2 ms | **69%** |

fsync は「ディスクが書き終わったと言うまで待つ」ので、その速さはディスクとその下（仮想マシンなら、その先の本物のディスク）で決まる。自分の PC だけで測ると、遅いディスクの利用者の体験を見落とす。

### 2.7 「保存した中身をそのまま」

Windows 版 Git は既定で改行を変換する（`core.autocrlf=true`）。スナップショットの道具がこれを受け継ぐと、CRLF で保存したファイルが LF で戻る。MicroGit では shadow の設定で変換を止めた（ADR-0012）。実際に、以前の VS Code のテストは「LF で戻る」ことを期待していて、この不具合のおかげで通っていた。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| blob・tree・commit を作って書く | `src/fastGit/objects.ts` |
| index を読み書きする | `src/fastGit/gitIndex.ts` |
| ref を読み書きする | `src/fastGit/refs.ts` |
| 1 回の保存の記録（速い記録） | `src/fastMicroCommit.ts` の `record` |
| 5.0.0 までの記録（Git のコマンド） | `src/microCommit.ts` の `recordMicroCommitViaGitCli` |
| どちらを使うか、使えなかったときに戻す | `src/extension.ts` の `recordMicroCommit` |
| 変換を止める設定 | `src/shadowStore.ts` の `SHADOW_ATTRIBUTES` |

---

## 4. 手を動かして確かめる

1. **オブジェクトを自分で作る**：`printf 'hello\n' | git hash-object --stdin` の値と、Node で `crypto.createHash('sha1').update('blob 6\0hello\n').digest('hex')` の値を比べる
2. **tree の並びを見る**：`a.txt` というファイルと `a` というフォルダを作ってコミットし、`git cat-file -p HEAD^{tree}` の順を見る
3. **プロセスの起動の費用を測る**：`time (for i in $(seq 100); do git rev-parse HEAD >/dev/null; done)`
4. **ベンチを流す**：`npm run compile && node scripts/bench-micro-commit.mjs --saves 300 --durability process`
5. **差分テストを流す**：`node scripts/test/micro-commit-diff.mjs --saves 200`、`--crlf` でも

---

## 5. もっと知りたいとき

- 『Pro Git』の「Git の内側」（Git Internals）の章：オブジェクト・ref・パックの形式
- Git のソースの `Documentation/gitformat-index.txt`（index の形式）、`Documentation/technical/`
- `git help config` の `core.fsync`・`core.fsyncMethod`（Git 自身の fsync の考え方）
- 「write-ahead logging」で検索する（データベースが fsync の回数を減らす方法）
