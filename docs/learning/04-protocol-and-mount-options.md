# 04. 2 つのプログラムのあいだの約束（プロトコル）／mount オプション／層の中を覗く

| 項目 | 内容 |
|---|---|
| 関係する Issue | #12（境界インターフェースと mount 構成） |
| 仕様・決定 | [agent-protocol.md](../agent-protocol.md)（v1）、[ADR-0004](../adr/0004-commit-per-save.md)、[ADR-0005](../adr/0005-mount-options.md) |
| 実装 | [guest/agent/main.go](../../guest/agent/main.go)、[guest/agent/overlay.go](../../guest/agent/overlay.go)、[guest/agent/agent_test.go](../../guest/agent/agent_test.go) |

---

## 1. 何のための仕組みか

MicroGit の拡張機能（TypeScript、あなたの PC）と agent（Go、仮想マシンの中）は、別の言語で書かれ、別の場所で動き、別々に作り直される。2 つがかみ合い続けるには、「何を送れば何が返ってくるか」を文書にして固定する必要がある。これが **プロトコル** である。

さらに、agent が使う OverlayFS の挙動は mount オプションで変わる。オプションを固定しないと、同じ命令でもカーネルによって結果が変わりうる。

---

## 2. 仕組み

### 2.1 枠組み（フレーミング）：どこまでが 1 つのメッセージか

線（virtio-console や stdin）には、バイト列が切れ目なく流れてくる。どこまでが 1 つの命令かを決めるのがフレーミングである。

| 方式 | 例 | 長所 | 短所 |
|---|---|---|---|
| **1 行 1 JSON**（採用） | `{"id":1,"op":"hello"}\n` | 人が読める、ログにそのまま残せる、どの言語でも書ける | 中身に改行を入れられない（JSON の中では `\n` とエスケープされるので問題ない） |
| 長さを先に送る | `0017{"id":1,...}` | 大きなバイナリを効率よく送れる | 人が読みにくい |
| HTTP や gRPC | — | 道具がそろっている | ゲストにネットワークの仕組みが要る（NFR-4 に反する） |

バイナリのファイルは base64 にして JSON の文字列に入れる（`writeb64`、`read`）。約 33% 大きくなるが、仕組みが単純になる。

### 2.2 要求と応答を対応づける（`id`）

ホストは要求に番号（`id`）を付け、agent は同じ番号を付けて答える。今の agent は 1 つずつ順番に答えるので番号が無くても対応はつくが、番号があれば「答えが来ないまま時間切れになった要求」を見分けられ、将来並べて送るようにもできる。

### 2.3 同じ命令を 2 回送っても壊れない（冪等性）

`commit` は、同じ名前・同じ親の層がもうあれば、作り直さずに `existed: true` を返す。こうしておくと、ホストは「送ったが答えが来なかった」ときに、気にせず送り直せる。同じ操作を何回しても結果が同じになる性質を **冪等性**（べきとうせい）という。

一方、同じ名前で **親が違う** 層を作ろうとしたら `EEXIST` で断る。黙って受け入れると、同じ名前が違う中身を指すことになり、あとで必ず混乱する。

### 2.4 エラーは人向けの文と、機械向けの記号の両方で返す

```json
{"ok":false,"error":"unknown parent abc","code":"UNKNOWN_LAYER"}
```

`error` の文は人が読むためのもので、あとで言い回しを変えてもよい。ホストのプログラムが分岐に使うのは `code` の記号だけにする。そうしないと、エラーの文を直しただけでホストが壊れる。システムコールの失敗は、Linux の errno の名前（`ENOENT`、`ENOSPC` など）をそのまま記号にしている。

### 2.5 版を上げるときの約束

- 応答に項目を **足す** だけなら版は上げない。受け取る側は知らない項目を無視する
- 意味を **変える**・項目を **消す** なら版（`protocol`）を上げる

agent は起動時の `ready` で版を名乗り、ホストは知らない版なら使わずに Node 版に切り替える。拡張機能だけ更新されて、古いゲストが残っているような場合にも安全に動く。

### 2.6 名前は誰が付けるか

層の名前は、ホストが決める文字列にした。MicroGit ではそれが Git のコミットのハッシュになる。agent が番号を振る方式（v0）だと、ホストは「番号とハッシュの対応表」を持つ必要があり、agent が再起動して番号がずれると対応表が壊れる。

ただし、agent はディスク上では短い番号（`l0`、`l1`）を使う。mount のオプション文字列は 4096 バイトまでなので、40 文字のハッシュを 32 層並べると 1.9 KB になり、余裕が小さい。**外に見せる名前と、中で使う名前を分けてよい**。

### 2.7 mount オプションを固定する

OverlayFS の mount オプションの既定値は、カーネルの版と設定で変わる。固定した値とその意味：

| オプション | 意味 |
|---|---|
| `userxattr` | 管理情報を `user.*` の拡張属性に書く。非特権で mount するのに必須 |
| `redirect_dir=nofollow` | 下の層のフォルダの rename を「転送の記録」で済ませず、`EXDEV` にする |
| `index=off` | ハードリンクと NFS のための索引を作らない |
| `metacopy=off` | 属性だけの変更でも中身ごとコピーする |
| `xino=off` | 層をまたいだ inode 番号の付け方を特別にしない |

試して分かったこと：**`userxattr` と `redirect_dir=on`、`userxattr` と `metacopy=on` は、カーネルが同時に受け付けない**。

```
overlayfs: conflicting options: userxattr,redirect_dir=on
```

非特権の mount では、転送の記録や属性だけのコピーは「危なくて任せられない」とカーネルが判断している、ということである。だから非特権で使う以上、フォルダの名前変更は必ずコピーになる。

### 2.8 層の中を覗く（`inspect`）と、予想が外れた話

ゴールデンテストは「重ねた結果（ビュー）」しか比べない。層そのものに OverlayFS がどう書いているかは、`inspect` 命令で見る。

| 操作 | 層に入るもの |
|---|---|
| 下の層のファイルを消す | `w a.txt`（whiteout：種類 0,0 のデバイスファイル） |
| フォルダを中身ごと消して作り直す | `O d`（opaque：下の層の中身を見せない印） |
| フォルダの名前を変える | `w d`（元の whiteout）＋ `d e`（新しい名前のコピー） |

テストを書いたとき、「ファイル `p` を消して、同じ名前でフォルダ `p/` を作る」の層は、普通のフォルダ `d p` になると予想していた。実際には **opaque の `O p`** だった。whiteout（消したファイル `p`）の上にフォルダを作ると、カーネルは「下の層の `p` を見せない」印を付ける。

正解はカーネルが知っている。予想が外れたら、テストの期待値のほうを直す（そして、なぜそうなるのかを書き残す）。ゴールデンテスト（[01](./01-golden-testing-and-namespaces.md)）と同じ考え方である。

### 2.9 特権が要るコードをテストする

agent のテストは本物の OverlayFS を mount するので、root かユーザー名前空間の中で動かす必要がある。

```bash
go test -c -o agent.test        # テストを実行ファイルにする（その場では動かさない）
unshare -Urm ./agent.test -test.v   # WSL2 など：ユーザー名前空間の中で
sudo ./agent.test -test.v           # GitHub Actions：非特権の名前空間が止められているので root で
```

mount できない環境では `t.Skip` で飛ばす（失敗にはしない）。

**道具の落とし穴**：Windows PowerShell 5.1 は、`-test.v` のようにドットを含む `-` 始まりの引数を、ネイティブのコマンドに渡すときに 2 つに分けてしまう。テストの実行ファイルが引数を読めずに使い方を表示して終わったのはこのためで、bash から渡して解決した。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| 1 行 1 JSON の読み書き、`ready`、版 | `main.go` の `serveStream()`、`hello()` |
| エラーの記号 | `main.go` の `protoError`、`errorCode()` |
| 冪等な commit、深さ、オプション文字列の長さの確認 | `overlay.go` の `store.commit()`、`checkOptions()` |
| 固定した mount オプション | `overlay.go` の `overlayOpts`、`record-kernel.mjs` の `MOUNT_OPTS` |
| 層の中を覗く | `overlay.go` の `store.inspect()` |
| テスト | `agent_test.go`、`check-guest.mjs` の `UPPER_EXPECT` |

---

## 4. 手を動かして確かめる

1. **agent と直接話す**（WSL2 で）
   ```bash
   unshare -Urm guest/out/amd64/init
   {"id":1,"op":"hello"}
   {"id":2,"op":"commit","layer":"a","ops":[["write","x.txt","1"]]}
   {"id":3,"op":"commit","layer":"b","parent":"a","ops":[["rm","x.txt"]]}
   {"id":4,"op":"inspect","layer":"b"}
   {"id":5,"op":"commit","layer":"b","parent":"a","ops":[]}
   {"id":6,"op":"commit","layer":"b","parent":"","ops":[]}
   {"id":7,"op":"poweroff"}
   ```
   4 で whiteout、5 で `existed: true`、6 で `EEXIST` が返る
2. **オプションのぶつかりを見る**：WSL2 で `unshare -Urm` の中から、`userxattr,redirect_dir=on` で mount してみる（`dmesg` に理由が出る）
3. **予想してから確かめる**：「フォルダの中のファイルを 1 つだけ書き換えた層」の `inspect` がどうなるかを予想してから、agent に聞いてみる

---

## 5. もっと知りたいとき

- Linux カーネルのドキュメント「Overlay Filesystem」の「Redirect dir」「Metadata only copy up」「Permission model」「whiteouts and opaque directories」
- JSON Lines（jsonlines.org）
- 「idempotency」「protocol versioning」「errno」で検索する
- `go help test` の `-c`
