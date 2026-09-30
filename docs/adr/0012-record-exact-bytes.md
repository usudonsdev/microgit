# ADR-0012: マイクロ履歴は、保存した中身をそのまま（変換せずに）記録する

| 項目 | 内容 |
|---|---|
| 状態 | 採用 |
| 日付 | 2026-10-01 |
| 決めた人 | Claude（#32）。利用者の確認待ち |
| 関係 | #32、[ADR-0001](./0001-source-of-truth.md)、`src/shadowStore.ts` の `SHADOW_ATTRIBUTES` |

## 背景

shadow の Git は、利用者の Git の設定をそのまま受け継いでいた。Windows 版 Git は、既定のインストールで `core.autocrlf=true`（システムの設定）になる。この設定では、`git add` が CRLF の改行を LF に変えて記録する。

MicroGit の「過去に戻る」は、記録された blob をそのままワークスペースに書き戻す（`git cat-file`、変換なし）。そのため Windows では、CRLF のファイルを保存して過去に戻ると、**改行コードが LF に変わってしまう**。スナップショットを取る道具として正しくない。

また、ワークスペースの `.gitattributes` が shadow にも写るので、`eol=`・`filter=`（Git LFS など）・`ident`・`working-tree-encoding` が記録の中身を変えうる。

#32 の速い記録（`fastMicroCommit.ts`）は、中身を変換せずに blob にする。変換の規則（改行の自動判定、フィルタの実行）を Git と同じに作るのは大きく、間違えやすい。

## 決定

shadow の Git では、保存した中身をそのまま記録する。

- shadow の設定に `core.autocrlf=false` を書く（利用者のシステム・グローバルの設定より優先される）
- shadow の `info/attributes` に次を書く。`info/attributes` は `.gitattributes` より優先されるので、ワークスペースの属性に関係なく変換が止まる

  ```
  * -text -eol -filter -ident -working-tree-encoding
  ```

どちらも `ensureShadowRepoForBranch` が、その実行の中で最初に shadow を使うときに書く。

## 理由

- **スナップショットは、保存したバイト列そのものであるべき。** 過去に戻ったとき、保存したときと同じファイルが戻る
- 速い記録と Git の CLI の記録が、同じ中身を記録する（差分テストの `--crlf` で確かめる）
- 設定は shadow だけに効き、利用者のリポジトリには触らない

## 採らなかった案

- **速い記録で Git の変換を真似る**：改行の自動判定（NUL を含むか、CR だけの行があるかなど）とフィルタの実行を、Git と同じに作る必要がある。間違えると CLI の記録と中身がずれる
- **変換がある環境では速い記録を使わない**：Windows のほとんどの利用者で速い記録が使われなくなる
- **過去に戻るときに逆の変換をする**：元が CRLF だったか LF だったかは、記録された blob からは分からない

## 引き受けること

- この変更より前の記録は LF に変えられた blob のまま。この変更の後に同じファイルを保存すると、改行だけが違う別の中身として記録される（1 回だけ差分が大きく見える）。前と後の「同じ中身」は同じとみなされない（過去の同じ変更に戻る探索が、その境目をまたいで一致しない）
- Git LFS などのフィルタを使うリポジトリでは、マイクロ履歴には実体（大きなファイルの中身）がそのまま入る。shadow の大きさが増えうる
- shadow の履歴を普通の Git で見ると、Windows では CRLF の差分が出ることがある（表示だけの問題）

## 確かめ方

- `node scripts/test/micro-commit-diff.mjs --crlf`：`core.autocrlf=true` の上にこの `info/attributes` を置き、CRLF の中身を書く。CLI の記録と速い記録が一致し、blob に CR が残ることを確かめる
- 以前の振る舞い（変換される）は、`core.autocrlf=true` の空のリポジトリで CRLF のファイルを `git add` し、`git cat-file blob :<ファイル>` で LF になることで確かめた（2026-10-01、Git 2.50.1.windows.1）
