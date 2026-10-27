# Claude Code instructions

Cursor と併用する。指示の正本は [AGENTS.md](AGENTS.md)。内容が食い違う場合は AGENTS.md と [docs/design-policy.md](docs/design-policy.md) を優先し、本ファイルを合わせて更新する。

## 最重要: 会話成果物をリポジトリに残す

チャット履歴は Cursor 側と共有されない。トークン限界後のやり直しも高い。そのため:

1. **設計判断・トレードオフ・却下した案** → `docs/design-policy.md` または `docs/` へ、理由付きで詳細に追記・更新する
2. **Agent Skills や繰り返し手順** → `AGENTS.md` / 本ファイル / `.cursor/rules/` へ残す
3. **実装の不変条件・罠** → 該当ソース近傍コメント、または `docs/`
4. チャット内の長い説明で終わらせない。**後続エージェントがファイルだけ読んで再開できる**粒度にする
5. 秘密情報は書かない

作業単位の終わりに「ドキュメントを更新したか」を自分で確認してから完了とする。

## プロジェクト要約

- VS Code / Cursor 拡張: 保存ごとのマイクロ履歴（verEve。旧称 MicroGit）
- 設計方針: [docs/design-policy.md](docs/design-policy.md)
- 利用者向け: [README.md](README.md)
- 卒業研究（ビルド検証エンジン・計画段階）: [docs/build-verification-engine.md](docs/build-verification-engine.md)
- 次期メジャー（カーネル機能ポータブル化・要件確定）: [要件定義書](docs/microgit-kernel-feature-portability-requirements.md) / [初期設計](docs/microgit-kernel-feature-portability-design.md) / [補足](docs/microgit-kernel-feature-portability-supplement.md)。進捗は Issue #8（Epic）、ブランチ `feature/kernel-portability`
- AI 編集の `[AI]` 印は Cursor フックの観測で付ける。Agent Skill にはしない（`docs/design-policy.md` §2.3）
- **名称は verEve（versioning everything の略）に改めた**（運営者の決定 2026-10-26。旧称 MicroGit）。**6.0.0 として実装済み・未公開**（リリース作業・Marketplace/Open VSX への公開・旧拡張の非推奨化・GitHub リポジトリ名の変更は未実施）。拡張 ID `usudonsdev.vereve`、コマンド・設定は `vereve.*`。**履歴の `refs/microgit/*`、保存場所 `.microgit/`、同梱バイナリ名（`microgit-agent`・`microgit-vm`）は互換のため旧名のまま**（これらを改名しない。理由と却下案は `docs/design-policy.md` §2.5）。調査・進捗・未決・実機確認の項目は [docs/rename-vereve.md](docs/rename-vereve.md)
