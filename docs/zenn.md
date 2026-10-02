# Zenn の記事の置き場所と公開のしかた

| 項目 | 内容 |
|---|---|
| 置き場所 | このリポジトリの `articles/`（ファイル名から `.md` を除いたものが Zenn の記事のスラッグ） |
| 公開のしかた | 記事の先頭の `published: true` にして、**`master` に入れる**（Zenn の GitHub 連携。`master` への push で zenn.dev/usudonsdev に反映される） |
| 反映の確かめ方 | `curl https://zenn.dev/api/articles/<スラッグ>` の `body_updated_at` と本文。非公開の記事は 403 になる |

## 記録

- **2026-09-30**：EasyToVibe リポジトリにあった記事 2 本（`easy-to-vive.md`、`docs_zenn_article_draft.md`）をこのリポジトリに移した（EasyToVibe の d27f158）。どちらも移したあとで書き直していて、今は `published: false`。2026-10-02 に、利用者が EasyToVibe と Zenn の連携を外した。EasyToVibe には、ほかに記事も画像も無い
- **2026-10-02**：GitHub のリポジトリの名前を `microgit-test` から `microgit` に変えたところ、Zenn との連携が切れ、`master` への push が反映されなくなった（Zenn は連携先をリポジトリの名前で持っている）。利用者が Zenn のダッシュボードで連携し直した。**リポジトリの名前を変えるときは、Zenn の連携も設定し直す**
- **2026-10-02**：#57 のデプロイが、`images/microgit-v5-restore-flow.png` のアップロードで「`wrong number of arguments (given 2, expected 1)`」となって中断し、記事も画像も反映されなかった（このリポジトリから画像を送るのは初めて）。画像は Zenn の条件（リポジトリ直下の `images/`、`.png`、3 MB 以内、`/images/...` の絶対パスで参照）を満たしていて、壊れてもいなかったので、Zenn 側の不具合とみた。PNG を画素はそのまま圧縮し直し（バイト列だけ変わる）、本文の画像に表示幅 `=680x` を付けて記事も変更として送ったところ、同日 17:37 に記事と画像 2 枚が反映された（64ebbcb）。**デプロイは push で変わったファイルだけを送るので、送り直すときは対象のファイルそのものを変える**（空のコミットでは送られない）。同じエラーが続くときは、Zenn のダッシュボードのアップローダーで画像を上げ、その URL を本文に書く
