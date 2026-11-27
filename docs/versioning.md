# 版（バージョン）の決まり

| 項目 | 内容 |
|---|---|
| 決めた日 | 2026-11-27（運営者の依頼「アプリとサーバーの版を管理したい。更新のたびに版を上げ、過去の更新にもさかのぼって版を付ける」） |
| 確かめる仕組み | [scripts/check-versions.mjs](../scripts/check-versions.mjs)（`npm run check:versions`。CI の `ci.yml` で毎回流す） |
| 公開の手順 | [release.md](./release.md) |

---

## 1. 版を持つ部品

| 部品 | 呼び方 | 版の置き場所 | 変更履歴 | タグ |
|---|---|---|---|---|
| 拡張機能（VS Code / Cursor の拡張。verEve 本体） | **アプリ** | `package.json` の `version`（`package-lock.json` も同じ値） | [CHANGELOG.md](../CHANGELOG.md) | `v<版>`（例 `v5.2.0`） |
| `microgit-agent`（ゲストの中、または Linux の `unshare -Urm` の中で、ホストからの命令を受けて層を作る） | **サーバー** | `guest/agent/main.go` の `agentVersion` | [guest/agent/CHANGELOG.md](../guest/agent/CHANGELOG.md) | `agent-v<版>`（例 `agent-v1.1.0`） |

agent の命令の形には、これとは別に **protocol の版**（`main.go` の `protocolVersion`、今は 1）がある。ホストは `ready` の `protocol` が知らない値なら agent を使わない（[agent-protocol.md](./agent-protocol.md)）。agent の版を上げても protocol は上げないことが多い（命令を足すだけなら protocol は同じ）。

### 版を持たせないもの（と理由）

| もの | 扱い | 理由 |
|---|---|---|
| `microgit-vm`（Mac の起動ツール）、`guest/build.sh`・カーネルの設定、Windows の QEMU のビルド | 拡張機能の版に含める | 単独で配らず、VSIX に同梱するだけ。ホストとの間に版を確かめる約束（protocol のようなもの）も無い |
| Linux カーネル・Go・QEMU | 上流の版を `guest/kernel/version.env`・`windows/qemu/version.env` に固定する | 自分たちの版ではない。上げたら拡張機能の版を上げる |
| 履歴の保存形式（`refs/microgit/*`、`.microgit/`、ジャーナル） | 今は版を持たない | 形を変えるときは移行の設計とあわせて決める（[rename-storage-migration-draft.md](./rename-storage-migration-draft.md)） |

却下した案：
- **部品ごとに版を持たせる（microgit-vm にも版）** — 却下。配る単位が VSIX 1 つなので、版が増えるほど上げ忘れと食い違いが増えるだけ
- **agent の版を拡張機能の版にそろえる** — 却下。agent は protocol で拡張機能とつながり、ログや `Overlay Status` に `agent=1.1.0` として出る。拡張機能の UI の変更のたびに agent の版が動くと、ゲストのイメージが変わったかどうかが版から読めなくなる

## 2. 版の上げ方（SemVer）

`MAJOR.MINOR.PATCH`。

| 部品 | MAJOR | MINOR | PATCH |
|---|---|---|---|
| 拡張機能 | 利用者が手で直す必要がある変更（コマンド ID・設定キー・拡張 ID の変更、履歴の形の互換の無い変更） | 機能を足す、動きが目に見えて変わる | 不具合の修正、ストアの説明文の変更、目に見えない改善 |
| agent | protocol の版を上げる変更（互換の無い命令の形） | protocol を変えずに命令・項目を足す | 動きの修正、内部の改善 |

## 3. いつ上げるか（更新のたびに）

**配るもの（下の表）を変えたら、同じ変更セットで版を上げ、変更履歴に書く。** ただし、今の版がまだ公開されていない（その版のタグが無い）あいだは、版はそのままで、その版の見出しの下に書き足す。

| 状態 | すること |
|---|---|
| 今の版のタグがある（公開済み） | 配るものを変えるなら、版を上げる（§2）。`CHANGELOG.md` に `## [新しい版] - 未公開` を足す |
| 今の版のタグが無い（未公開、例：2026-11-27 時点の 6.0.0） | 版はそのまま。その版の見出しの下に書き足す。変更が大きくなって版の段（MAJOR・MINOR・PATCH）が変わるなら、上げ直してよい（公開前なので番号を使い捨てない） |
| 配るものを変えていない（文書・記事・テスト・開発用のスクリプト・CI だけ） | 版は上げない |
| agent を変えた | agent の版を上げ、**拡張機能の版も上げる**（VSIX に同梱するため） |

「配るもの」（`scripts/check-versions.mjs` の `extensionShips`・`agentShips`）：

| 部品 | 配るもの |
|---|---|
| 拡張機能 | `src/`（`src/test/` を除く）、`media/`、`package.json`、`README-marketplace.md`、`LICENCE.md`、`THIRD_PARTY_NOTICES.md`、`.vscodeignore`、同梱の部品（agent のソース、`guest/build.sh`、`guest/kernel/`、`mac/microgit-vm/`・`mac/build.sh`、`windows/qemu/build.sh`・`version.env`） |
| agent | `guest/agent/` の `.go`（`_test.go` を除く）、`go.mod`・`go.sum` |

コメントと空白だけの変更は数えない（2026-10-15 の #81 のような、全ソースにコメントを足す変更で版を上げないため）。

### 公開したとき

1. 版が正しいことを `npm run check:versions` で確かめる
2. `CHANGELOG.md` の見出しの「未公開」を公開日に直す
3. master の公開するコミットに、注釈つきのタグ `v<版>` を打って push する（`package.yml` が走り、VSIX と GitHub Release の下書きができる。[release.md](./release.md) §3）
4. agent の版が変わっていれば、同じコミットに `agent-v<版>` も打つ（`agent-v*` は `package.yml` を起こさない）

タグを打ったあとで配るものを変えると、`check:versions` が「版を上げ忘れている」で失敗する。これが「更新のたびに版を上げる」を守らせる仕組み。

### 罠

- CI は `actions/checkout` の `fetch-depth: 0`（タグごと取る）で流す。`--strict` は浅い clone やタグが 1 つも無いときに失敗する。部品のタグ（`agent-v*` など）がまだ 1 つも無いときは注意だけ（その部品の上げ忘れは確かめられない）
- タグ `v*` を push すると、**そのコミットの** `package.yml` が走る（2026-09 以降のコミット）。さかのぼってタグを打つときは気をつける（§4）
- 一度 Marketplace に出した版の番号は使い直せない（release.md §3）

## 4. さかのぼって付けた版とタグ（2026-11-27）

`package.json` の `version` が変わったコミットを、master の first-parent の履歴からたどり、その版が初めて出たコミットにタグを打った（5.x のタグがマージコミットに打ってあるのに合わせた）。注釈つきタグの日付はコミットの日付にそろえ、本文に「さかのぼって付けた」と書いた。

**タグを打つのは [scripts/tag-past-versions.sh](../scripts/tag-past-versions.sh)**（すでにあるタグは飛ばす。`--push` で origin へ送る。`v5.1.3` だけは送ると package.yml が走るので `--push-5.1.3` を足したときだけ送る）。

> 2026-11-27 時点：Claude Code のクラウドのセッションからはタグを push できなかった（作業ブランチ以外への push は HTTP 403）。そのため、下の表のタグは**まだ origin に無い**。運営者が手元で `bash scripts/tag-past-versions.sh --push` を流すと揃う。それまで `check:versions` は「タグ agent-v* が見えない」の注意を出し、agent の版の上げ忘れは確かめられない（CI は落とさない）。

### 拡張機能

| 版 | コミット | 日付 | タグ | 備考 |
|---|---|---|---|---|
| 0.0.1 | b578868 | 2026-06-22 | `v0.0.1` | 最初のコミット |
| 1.0.0 | 2b702ce | 2026-06-23 | `v1.0.0` | 「製品版 v1.0.0 として公開」 |
| 1.0.1 | f6e2ce2 | 2026-06-23 | `v1.0.1` | |
| 2.0.0 | c6929e9 | 2026-06-29 | `v2.0.0` | |
| 2.0.1 | 56fb486 | 2026-06-29 | `v2.0.1` | |
| 3.0.0 | 8409cac | 2026-06-29 | `v3.0.0` | |
| 3.1.0 | aa24e14 | 2026-07-04 | `v3.1.0` | dev 側のコミット（master の first-parent には 3.1.0 の状態が無い。3.2.0 のマージで入った） |
| 3.2.0 | d08f5d1 | 2026-07-09 | `v3.2.0` | #7 のマージ |
| 3.3.0 | cdd3309 | 2026-07-25 | `v3.3.0` | |
| 3.4.0 | 53c4391 | 2026-07-26 | `v3.4.0` | |
| 3.4.1 | 6caf5a0 | 2026-07-26 | `v3.4.1` | |
| 3.5.0・3.6.0 | — | 2026-07-26 | 無し | package.json の版として一度も出ていない（3.4.1 の次のコミットで 3.6.1）。中身は 3.6.1 に入っている |
| 3.6.1 | 4bd8431 | 2026-07-26 | `v3.6.1` | |
| 3.7.0 | 11365ef | 2026-07-26 | `v3.7.0` | |
| 4.0.0 | c1de64a | 2026-07-26 | `v4.0.0` | |
| 5.0.0〜5.1.2 | — | — | 既存 | 公開のときに打ったもの（release.md） |
| 5.1.3 | ac26c85 | 2026-10-11 | `v5.1.3` | ストアに出していない版（5.2.0 にまとめた）。push すると package.yml が走り GitHub Release の下書きができるので、push は運営者の判断を待つ |
| 5.2.0 | — | — | 既存 | |
| 6.0.0 | — | — | まだ無い | 未公開。公開のときに打つ |

2.0.1 以前は当時 CHANGELOG が無かったので、コミットの記録から書き起こした。

### agent

| 版 | コミット | 日付 | タグ |
|---|---|---|---|
| 0.1.0 | 0bd6732 | 2026-09-26 | `agent-v0.1.0` |
| 0.2.0 | 0ecca56 | 2026-09-26 | `agent-v0.2.0` |
| 1.0.0 | a18ab36 | 2026-09-26 | `agent-v1.0.0`（protocol 1） |
| 1.1.0 | cd11b6b | 2026-09-28 | `agent-v1.1.0` |
| 1.2.0 | — | — | 使わない（計測用ブランチだけで名乗った。guest/agent/CHANGELOG.md） |

### 版を付けなかったもの

版を上げるコミットのあいだの、版を上げずに入った変更（例：4.0.0〜5.0.0 のあいだの 2 か月分）には、新しい版を作らなかった。当時その番号で配ったものは無く、あとから番号を作ると、配った版と番号が合わなくなるため。それぞれ、次の版に含まれる。

1 つだけ手で打つときの手順：

```bash
GIT_COMMITTER_DATE="$(git log -1 --format=%cI <コミット>)" git tag -a v<版> <コミット> -m "MicroGit <版>" -m "さかのぼって付けたタグ（docs/versioning.md §4）"
```
