# Zenn の記事の置き場所と公開のしかた

| 項目 | 内容 |
|---|---|
| 置き場所 | このリポジトリの `articles/`（ファイル名から `.md` を除いたものが Zenn の記事のスラッグ） |
| 公開のしかた | 記事の先頭の `published: true` にして、**`master` に入れる**（Zenn の GitHub 連携。`master` への push で zenn.dev/usudonsdev に反映される） |
| 反映の確かめ方 | `curl https://zenn.dev/api/articles/<スラッグ>` の `body_updated_at` と本文。非公開の記事は 403 になる |

## 記録

- **2026-09-30**：EasyToVibe リポジトリにあった記事 2 本（`easy-to-vive.md`、`docs_zenn_article_draft.md`）をこのリポジトリに移した（EasyToVibe の d27f158）。どちらも移したあとで書き直していて、今は `published: false`。2026-10-02 に、利用者が EasyToVibe と Zenn の連携を外した。EasyToVibe には、ほかに記事も画像も無い
- **2026-10-02**：GitHub のリポジトリの名前を `microgit-test` から `microgit` に変えたところ、Zenn との連携が切れ、`master` への push が反映されなくなった（Zenn は連携先をリポジトリの名前で持っている）。利用者が Zenn のダッシュボードで連携し直した。**リポジトリの名前を変えるときは、Zenn の連携も設定し直す**
