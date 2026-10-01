# Agent instructions (Cursor / Claude Code)

このリポジトリでは **Cursor と Claude Code を併用**する。チャットはセッションをまたいで失われやすく、トークン限界後の再投入コストも高い。会話で生まれた成果物は、なるべく詳細に **リポジトリ内ドキュメントとして残す**。

設計の本体は [docs/design-policy.md](docs/design-policy.md)（§8 も参照）。卒業研究（ビルド検証エンジン）の設計は [docs/build-verification-engine.md](docs/build-verification-engine.md)。次期メジャー（Linux カーネル機能ポータブル化）は `docs/microgit-kernel-feature-portability-*.md` の 3 本と Issue #8（Epic、未決事項 O-1〜O-14 と Issue の対応表あり）。作業ブランチは `feature/kernel-portability`。

## 必須: 知見の永続化

作業中に次が生まれたら、チャット返答だけで終わらせず、**同じ変更セットでファイルに書く**。

| 成果物 | 書くこと | 置き場所 |
|--------|----------|----------|
| 設計判断 | 選択肢、採択理由、却下理由、前提・制約、既知の制限 | `docs/design-policy.md` または `docs/` の専用メモ |
| Agent Skills / 運用ルール | 繰り返し守る手順、スキル適用で固まった方針 | 本ファイル・`CLAUDE.md`・必要なら `.cursor/rules/` |
| 実装の不変条件・罠 | なぜこの順序／この API か、壊すと何が起きるか | 該当ソース近傍のコメント、または `docs/` |
| 調査・デバッグ結論 | 再現条件、原因、回避策（推測と確定を分けて） | `docs/` または関連モジュール付近 |

### 書き方の基準

- **詳細さ優先**: 「何をしたか」より「なぜそうしたか」を残す。後続の別エージェントがチャット無しで追える粒度にする
- **要約だけにしない**: トレードオフ表、採らなかった案、前方互換・移行メモまで含める
- **既存ドキュメントを更新**: 方針が変わったら古い記述を消し、日付または版の手がかりを残す
- **秘密は書かない**: API キー、PAT、請求・アカウント固有の情報はリポジトリに出さない

## 実装時の注意（要約）

- ストレージは既存 Git、checkout は Overlay、共有は親の `refs/microgit/*`（詳細は design-policy）
- 通常 Git への自動コミットはしない。マイクロ履歴はブランチ専属
- セキュリティ: `execFileSync` + 引数配列。シェル連結禁止

## Claude Code

Claude Code 利用者は同内容の [CLAUDE.md](CLAUDE.md) も読むこと（本ファイルと同期して保つ）。
