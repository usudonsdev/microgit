# Boundary Guard の規則

| 項目 | 内容 |
|---|---|
| 版 | 初版（2026-09-26、#16） |
| 実装 | [src/boundaryGuard.ts](../src/boundaryGuard.ts) |
| テスト | [src/test/unit/boundaryGuard.test.ts](../src/test/unit/boundaryGuard.test.ts)（20 件。Windows と Linux で確認） |
| 要件 | SR-1（ゲストを信用しない）、SR-2（検査はホストに集める）、FR-3（ゲストの書き込みはホストの検証を経て反映する）、O-14（ホストの FS で表せない変更） |
| 解説 | [学習用 06](./learning/06-boundary-guard.md) |

ゲスト（最小 VM の中、または VM なしの agent）から受け取った「あるコミット時点のファイルの一覧（view）」と「ファイルの中身（readMany）」は、ワークスペースに書く前にこのモジュールを必ず通す。ゲストがワークスペースに直接書く経路は無い。

## 1. 一覧（view）の規則

弾いたものは書きも消しもせず、`rejected` に理由を付けて返す。ディレクトリを弾いたら、その下もすべて弾く。

| 規則 | 理由の記号 | 範囲 |
|---|---|---|
| 相対パスで `/` 区切り。空・`.`・`..` の段なし。`\`・NUL・ドライブ名（`C:`）なし | `bad-path` | すべての OS |
| パス全体 4096 バイト、1 段 255 バイトまで | `too-long` | すべての OS |
| どの段も `.git` を指さない。大文字小文字、末尾のドットと空白、NTFS の 8.3 の短い名前（`git~1`）、macOS の HFS+ が無視する文字を含めて判定する | `git-dir` | すべての OS（Git の `core.protectNTFS`・`protectHFS` と同じ範囲） |
| ワークスペース直下の `.microgit_shadow`・`.microgit_logs`・`.microgit_overlay` でない | `microgit-artifact` | すべての OS（大文字小文字を区別しない FS では大文字でも） |
| 種類はファイル（`f`）とディレクトリ（`d`）だけ | `unsupported-type` | シンボリックリンク（`l`）とその他（`o`）は MicroGit の層に入らない（#10 §6） |
| ファイルの行は `f<TAB>path<TAB>sha256`（64 桁の 16 進） | `malformed` | — |
| Windows の予約名（`CON`・`PRN`・`AUX`・`NUL`・`COM0-9`・`LPT0-9`・上付き数字・`CONIN$`・`CONOUT$`。拡張子付きも） | `windows-reserved-name` | Windows |
| `< > : " \| ? *` と制御文字 | `windows-invalid-char` | Windows |
| 段の末尾のドットと空白 | `windows-trailing-dot-or-space` | Windows |
| 大文字小文字（と macOS では Unicode の正規化形）だけが違う名前は、後のほうを弾く | `case-conflict` | Windows・macOS |
| 一覧は 200,000 行まで | `too-many-entries` | — |

## 2. 中身の規則

| 規則 | 理由の記号 |
|---|---|
| 受け取った中身の sha256 が一覧の値と一致する | `hash-mismatch` |
| 1 ファイル 512 MiB まで | `too-large` |
| 頼んだ中身が返ってこない | `malformed` |

## 3. 書き込み先の規則

| 規則 | 理由の記号 |
|---|---|
| 途中のディレクトリがリンク（シンボリックリンク・ジャンクション）でなく、実体のパスがワークスペースの実体の中にある | `escapes-workspace` |
| 置き先に（消す対象でない）ディレクトリがあれば、そのファイルは書かない | `type-conflict` |
| 途中に（消す対象でない）ファイルがあれば、そのファイルは書かない | `type-conflict` |
| 最後の要素がリンクなら、リンクそのものを消してから普通のファイルを置く（リンク先には書かない） | — |

## 4. 反映の順番

1. 一覧を検証する
2. 消すもの（`managedFiles` にあって一覧のファイルに無いもの）と、取ってくるもの（ワークスペースの中身と sha256 が違うもの）を決める。ワークスペースは読むだけ
3. 中身を全部受け取り、検証する。**ここでゲストが落ちたら、ワークスペースには何もしないまま例外を返す**
4. 消す
5. 書く（書く直前に、書き込み先の規則をもう一度確かめる）

- 消すのは `managedFiles`（MicroGit が記録したことのあるパス）だけ。利用者が MicroGit を使わずに置いたファイルは消さない
- ワークスペースのファイルの sha256 は、大きさと更新時刻が前回と同じなら計算し直さない（`WorkspaceHashCache`）

## 5. 範囲外（守らないもの）

| もの | 理由 |
|---|---|
| 確かめてから書くまでのあいだに、別のプログラムがワークスペースにリンクを作る（TOCTOU） | ワークスペースは利用者自身のフォルダで、ホストの OS は信用する（要件 §7.1 の想定しない攻撃） |
| 実行ビット・所有者・拡張属性 | MicroGit はファイルの中身だけを記録する |
| 4・5 の途中の電源断 | 正本（shadow の Git）は無事なので、もう一度過去に戻れば直る（ADR-0001） |

## 6. 使う側（#14）の約束

- 一覧は agent の `view`、中身は `readMany`（`TOO_LARGE` なら分けて頼む）で取り、`syncWorkspaceFromGuest` に渡す
- `rejected` は利用者に知らせる（出力パネルに一覧、件数があれば通知）
- ワークスペースの特性（大文字小文字など）は `hostTraitsFor(process.platform)` を既定にする
