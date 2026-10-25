---
name: use-microgit
description: >-
  Works in a workspace where the MicroGit VS Code extension records one micro-commit per editor save.
  Use when MicroGit, .microgit_shadow, micro history, an [AI] save marker, or ai-pending.json is present,
  or when the user edits a project with MicroGit. Treat editor saves as checkpoints, mark agent edits,
  and restore through MicroGit commands instead of rewriting the shadow repository.
---

# MicroGit があるワークスペースで作業する

MicroGit は、VS Code の文書保存ごとにマイクロ履歴を 1 件残す。通常の Git コミットは利用者の明示の操作のままにする。

## 編集したあと

1. 編集したファイルのワークスペース相対パス（`/` 区切り）を `.microgit_logs/ai-pending.json` の JSON 配列へ足す。同じパスがあれば足さない。`.microgit_` で始まるパスと `.cursor/` は足さない。
2. 記録はエディタの保存で起きる。ディスクへ書いただけでは残らない。保存を実行できないときは、利用者に対象ファイルの Save All を頼む。保存前に「記録済み」と言わない。
3. 保存されると、その配列に入っていたパスは `micro: [AI] saved <path>` として残る。Cursor のフックが同じ配列へ足すこともある。二重でも保存時に 1 回だけ消費される。

## 失敗した編集を戻す

利用者に `MicroGit: Jump to Commit or Tag`、またはコントロールパネルでのジャンプを頼む。`.microgit_shadow` の checkout や、そこからのファイルコピーでワークスペースを戻さない。

## 触らないもの

- `.microgit_shadow`、`.microgit_overlay`、`.microgit_logs/timeline.log`
- 親リポジトリの `refs/microgit`
- `MicroGit: Publish Micro History` と `MicroGit: Fetch Micro History`（頼まれたときだけ）
- MicroGit のオンオフ（頼まれたときだけ）
- 進捗を残すための通常 Git への `git commit`、`git reset`、`git checkout`

名前付きブランチ以外では MicroGit は記録しない。detached HEAD のときは、その旨を利用者に伝えてから作業を続ける。

## MicroGit 本体を変更するとき

このリポジトリの実装を変える作業は `AGENTS.md` に従う。その場合も、動いているマイクロ履歴を手で直して作業ツリーをごまかさない。
