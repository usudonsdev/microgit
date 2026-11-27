# microgit-agent の変更履歴

ゲストの中（または Linux の `unshare -Urm` の中）で、ホストの拡張機能からの命令を受けるサーバー（`microgit-agent`）の変更履歴。拡張機能（アプリ）の変更履歴はリポジトリ直下の [CHANGELOG.md](../../CHANGELOG.md)。版の決まりは [docs/versioning.md](../../docs/versioning.md)。

- 版は `main.go` の `agentVersion`。`hello` と `ready` の `agent` で返る
- 命令の形の版（`protocolVersion`）は別に持つ。ホストは `protocol` が知らない値なら使わない（[agent-protocol.md](../../docs/agent-protocol.md)）
- タグは `agent-v<版>`。0.1.0〜1.1.0 のタグは 2026-11-27 にさかのぼって付けた
- 拡張機能の VSIX に同梱するので、agent の版を上げたら拡張機能の版も上げる

> **1.2.0 は使わない。** 計測用ブランチ `measure/61-layer-breakdown`（今はタグ `archive/measure/61-layer-breakdown`）で、層づくりの内訳 `phasesUs` を返す計測用の agent を 1.2.0 と名乗らせた（[work-record-2026-10-09-to-14.md](../../docs/work-record-2026-10-09-to-14.md)）。master には入っていない。記録やログの 1.2.0 と混ざらないよう、次の minor は 1.3.0 にする。

## [Unreleased]

（まだ無い）

## [1.1.0] - 2026-09-28（タグ `agent-v1.1.0`、cd11b6b）

protocol 1 のまま、命令を足した（足しただけなので minor）。Apple silicon Mac の virtio-console が約 64 KiB を超える 1 行を受け取れないため（agent-protocol.md §4.1.1）。

### Added
- `stage`（base64 の断片を一時領域へ置く）、`stageOp`（commit の操作を 1 件ずつ置く）、`readChunk`（1 ファイルを最大 32 KiB ずつ読む）
- commit の `opsUpload`（`stageOp` で置いた操作を使う）と、操作 `writeupload`（`stage` で置いた中身を書く）

### その後（版を上げていない変更）
- 2026-10-15（#81）・2026-11-02：コメントと `gofmt` の桁そろえだけ。動きは変わらない（`scripts/check-versions.mjs` はコメントと空白を数えない）

## [1.0.0] - 2026-09-26（タグ `agent-v1.0.0`、a18ab36）

命令の形 v1（protocol 1）。v0 と互換が無いので major。

### Changed（破壊的）
- 層の名前をホストが決める（Git のコミットのハッシュ。ADR-0001）。v0 は agent が番号を振っていた
- `read` は base64 の `data` を返す（v0 は文字列）

### Added
- `hello` と `ready` に `protocol` と固定した `mountOptions`（`userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off`、ADR-0005）
- commit の冪等（同じ layer・parent なら `existed: true`）、応答の `depth`
- 操作 `writeb64`（バイナリ・mode）、命令 `readMany`・`inspect`・`stats`
- 失敗の種類の記号 `code`（`BAD_REQUEST`・`UNKNOWN_LAYER`・`TOO_DEEP`・`TOO_LARGE`・`OPTIONS_TOO_LONG` など）
- 深さ 400 を超える commit は `TOO_DEEP`。1 行の要求の上限 128 MiB。VM なしのモードは `MICROGIT_AGENT_STATE_DIR` の下に層を置く

## [0.2.0] - 2026-09-26（タグ `agent-v0.2.0`、0ecca56）

### Added
- `read`：あるコミット時点のファイルの中身を返す（上限 1 MiB）

## [0.1.0] - 2026-09-26（タグ `agent-v0.1.0`、0bd6732）

### Added
- 最初の版。Go で書いた init 兼 agent（#13）。PID 1 として proc・sys・dev・run を mount し、virtio-console の名前付きポート `microgit` で 1 行 1 JSON の命令（`reset`・`commit`・`view`・`poweroff`）を受ける。PID 1 以外で起動すると stdin / stdout で受ける
