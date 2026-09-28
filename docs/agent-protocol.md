# agent の命令の形（プロトコル v1）

| 項目 | 内容 |
|---|---|
| 版 | v1（2026-09-26、#12 で確定。2026-09-28 に大容量転送の加法的命令を追加）。agent 1.1.0 |
| 実装 | [guest/agent/main.go](../guest/agent/main.go)（受け答え）、[guest/agent/overlay.go](../guest/agent/overlay.go)（層） |
| テスト | [guest/agent/agent_test.go](../guest/agent/agent_test.go)、[scripts/golden/check-guest.mjs](../scripts/golden/check-guest.mjs) |
| 関連 | [ADR-0001](./adr/0001-source-of-truth.md)（層はキャッシュ）、[ADR-0003](./adr/0003-layer-compaction.md)（深さの上限）、[ADR-0004](./adr/0004-commit-per-save.md)（保存ごとに層）、[ADR-0005](./adr/0005-mount-options.md)（mount オプション） |

## 1. 通り道と枠組み

| 動かし方 | 通り道 |
|---|---|
| 最小ゲスト（QEMU、Virtualization.framework） | virtio-console の名前付きポート `microgit`（ゲストの `/dev/vportNpM`） |
| VM なし（Linux の `unshare -Urm <agent>`） | agent の stdin / stdout |

- **1 行 1 つの JSON**（UTF-8、改行で区切る）。要求 1 つに応答 1 つで、agent は受け取った順に答える
- 要求の 1 行は 128 MiB まで
- agent は準備ができると、要求を待たずに `{"event":"ready", ...}` を 1 行送る（中身は `hello` の応答と同じ）
- ホストは `ready` の `protocol` を確かめ、自分の知っている版と違えば使わない（Node 版にフォールバックする）

## 2. 要求と応答の共通の形

```json
{"id": 7, "op": "commit", "layer": "…", "parent": "…", "ops": [...]}
{"id": 7, "ok": true, "layer": "…", "depth": 3, "elapsedUs": 118}
{"id": 8, "ok": false, "error": "unknown parent abc", "code": "UNKNOWN_LAYER", "elapsedUs": 12}
```

| 項目 | 意味 |
|---|---|
| `id` | ホストが付ける番号。応答に同じ値が付く |
| `ok` | 成功したか |
| `error` / `code` | 失敗の説明と、種類の記号（§5） |
| `elapsedUs` | agent の中でかかった時間（マイクロ秒）。ホストとの往復は含まない |

## 3. 層の名前

- 層の名前（`layer`、`parent`）は **ホストが決める文字列**。MicroGit では shadow の Git のコミットのハッシュ（写しの層も同じハッシュ）を使う
- `parent` が空文字列（または省略）なら、親の無い層（空の base の上）
- agent はディスク上では短い番号（`l0`、`l1`、…）で持つ。mount のオプション文字列の長さの制限（1 ページ）に余裕を持たせるため（ADR-0003）
- 層は正本ではなくキャッシュ（ADR-0001）。agent が再起動すれば全部消える。ホストは `reset` や VM の再起動のあと、必要な層を作り直す

## 4. 命令

| op | 引数 | 応答 | すること |
|---|---|---|---|
| `hello` | — | `protocol`、`agent`、`kernel`、`mountOptions` | 版と、固定している mount オプションを返す |
| `reset` | — | — | 層をすべて捨てる |
| `stage` | `upload`、`data`、`append` | — | base64 の断片（最大32 KiB）を一時領域へ置く。macOS の小さいフレーム用 |
| `stageOp` | `upload`、`stagedOp`、`append` | — | commitの操作を1件ずつ一時領域へ置く。ファイル数が多い場合の小さいフレーム用 |
| `commit` | `layer`、`parent`、`ops` | `layer`、`depth`、`existed`、`mountOptions`、`exdevRenames` | 親までの層を lowerdir に積み、空の upper に `ops` を当てて凍結する（§4.1） |
| `view` | `layer` | `entries`（空のツリーでは省かれる） | その時点のツリーの一覧（§4.2） |
| `read` | `layer`、`path` | `data`（base64） | 1 ファイルの中身 |
| `readMany` | `layer`、`paths` | `files`（`[{path, data}]`） | 複数のファイルの中身。合計 32 MiB を超えると `TOO_LARGE`（ホストは分けて頼み直す） |
| `readChunk` | `layer`、`path`、`offset`、`limit` | `data`、`done` | 1ファイルを最大32 KiBずつ読む。macOS の小さいフレーム用 |
| `inspect` | `layer` | `entries` | 層そのもの（凍結した upper）の中身と OverlayFS の表現（§4.3） |
| `stats` | — | `layers`、`usedBytes`、`totalBytes` | 層の数と、置き場所の使用量 |
| `poweroff` | — | — | 答えてから止まる（ゲストは電源断、VM なしなら片付けて終わる） |

### 4.1 commit

- 同じ `layer` がもうあり、`parent` も同じなら、作り直さずに `existed: true` で返す（ホストの再送や、別の枝から同じコミットに届いた場合）。`parent` が違えば `EEXIST`
- `depth` は、自分を含めた層の数（base を除く）。400 を超えると `TOO_DEEP`。どこで写しの層に切り替えるかはホストが決める（ADR-0003 では 32）
- `ops` のどれかが失敗したら、その層は残さない
- `exdevRenames` は、`mv` が `EXDEV` になりコピーで代わりにやった回数（下の層のディレクトリの rename。ADR-0005）

`ops` の要素（どれも文字列の配列）：

| op | 形 | すること |
|---|---|---|
| `write` | `["write", path, text]` | テキストを書く（ゴールデンテストのシナリオ用） |
| `writeb64` | `["writeb64", path, base64, mode?]` | 中身を base64 で渡して書く。`mode` は `"644"`（省略時）か `"755"` |
| `writeupload` | `["writeupload", path, upload, mode?]` | `stage` で受け取った中身を書く。commit の成功・失敗後に一時データを消す |
| `rm` | `["rm", path]` | ファイルを消す |
| `rmdir` | `["rmdir", path]` | ディレクトリを中身ごと消す |
| `mkdir` | `["mkdir", path]` | ディレクトリを作る |
| `mv` | `["mv", from, to]` | 名前を変える |

- `path` は `/` 区切りの相対パス。空・絶対パス・`.`・`..` の段は `BAD_PATH`
- `write` / `writeb64` は、置き先にディレクトリがあれば中身ごと消し、途中にファイルがあれば消してディレクトリにする。Git のツリーでは同じパスがファイルとディレクトリを同時に取らないので、ホストが「消す op」を先に並べれば起きないが、順番に依存しないようにしている

### 4.1.1 macOS のフレーム分割

Apple silicon Mac（macOS 26.5.1）の実機では、Virtualization.framework の
virtio-console に約64 KiBを超えるJSON 1行を渡すと、ゲストが行末を受け取れず停止した。
stdioをUnix domain socketへ替えても停止点は変わらなかったため、ホストのstdioではなく
virtio-console経路の制限として扱う。

`planMac` は `maxFrameBytes=48 KiB` を指定する。ホストはファイルの書き込みを24 KiBずつ
`stage`し、`commit`には小さい`writeupload`だけを渡す。パスの数だけでcommitが48 KiBを
超える場合は`stageOp`で操作も1件ずつ渡し、commitの`opsUpload`から参照する。読み取りも
`readChunk`で24 KiBずつ受け取る。他OSは従来の`writeb64` / `readMany`を使い、往復回数を増やさない。

### 4.2 view の一覧の形

ゴールデンテストの期待値と同じ。1 行 1 エントリで、パスのバイト順。

| 種別 | 形 |
|---|---|
| ディレクトリ | `d<TAB>path` |
| ファイル | `f<TAB>path<TAB>sha256` |
| シンボリックリンク | `l<TAB>path<TAB>リンク先` |
| その他 | `o<TAB>path` |

### 4.3 inspect の一覧の形

| 種別 | 意味 |
|---|---|
| `w<TAB>path` | whiteout（種類 0,0 のキャラクタデバイス）。下の層の同じ名前を消す |
| `O<TAB>path` | opaque ディレクトリ（`user.overlay.opaque=y`）。下の層の同じディレクトリの中身を見せない。ディレクトリを消して作り直したときと、whiteout の上にディレクトリを作ったとき（ファイル → ディレクトリ）にできる |
| `r<TAB>path<TAB>転送先` | redirect の付いたディレクトリ。`redirect_dir=nofollow` では作られない |
| `d` / `f` / `l` / `o` | ディレクトリ・ファイル・リンク・その他 |

## 5. エラーの記号

| code | 意味 | ホストの扱い（#14） |
|---|---|---|
| `BAD_REQUEST` | JSON が読めない、知らない op、op の形が違う、base64 が壊れている、mode が 644 / 755 以外 | 不具合。記録してその操作を諦める |
| `BAD_PATH` | パスが相対でない、`.` や `..` を含む | 不具合（ホストの Boundary Guard で先に弾くはず） |
| `UNKNOWN_LAYER` | 知らない層 | 層を作り直してからやり直す（VM の再起動などで消えた） |
| `EEXIST` | 同じ名前の層が違う親でもうある | `reset` して作り直す |
| `TOO_DEEP` | 深さが 400 を超える | 写しの層を作る |
| `TOO_LARGE` | `readMany` の合計が 32 MiB を超える | パスを分けて頼み直す |
| `OPTIONS_TOO_LONG` | mount のオプション文字列が 4096 バイトに収まらない | 写しの層を作る |
| `ENOENT`、`ENOSPC` など | システムコールのエラー（errno の名前） | `ENOSPC` は `reset` して作り直す。ほかは記録して Node 版にフォールバック |
| `EINTERNAL` | それ以外 | 記録して Node 版にフォールバック |

## 6. 版の上げ方

- 応答に項目を足すだけなら版は上げない（ホストは知らない項目を無視する）
- 要求の意味を変える、項目を消す、エラーの記号の意味を変えるときは `protocol` を上げる
- 上げたときは、この文書に v2 の節を足し、v1 の節は残す
