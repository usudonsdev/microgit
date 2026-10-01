# MicroGit 設計方針

最終更新: 2026-07-27（エージェント成果物のリポジトリ内ドキュメント化／Claude Code 併用）

## 1. 現段階のスコープ

### サポートする

- **個人開発**: 保存のたびにマイクロ履歴を記録し、タイムトラベルする
- **メインリポジトリの push / pull を通じた他デバイス共有**: 大元ブランチの通常の push / pull だけで、別端末でも同じマイクロ履歴を復元・継続できること

### サポートしない（現段階）

- 専用リモートブランチへの自動 push / pull（`micro-history` 専用同期など）
- チーム間のライブ同期 UI

チーム向けの直接同期・PR 自動レビュー連携は将来機能（後述）。

## 2. コア設計の前提

| 項目 | 方針 |
|------|------|
| 記録単位 | 保存イベント（＋ AI 編集検知時）。通常 Git への自動コミットはしない |
| タイムトラベル | **Git と同様、その時点のツリー全体へワークスペースを同期する**（部分復元は既定にしない） |
| メインブランチ ↔ マイクロ履歴 | **メインの各ブランチに専属のマイクロ履歴空間**を持つ（ブランチ横断で1本共有しない） |
| 共有経路 | メインリポジトリの push / pull。リモート専用マイクロブランチは使わない |
| checkout | Node.js ユーザー空間 Overlay（`microgit.useOverlayCheckout`）を既定 |
| セキュリティ | `execFileSync` + 引数配列。シェル連結禁止。パス／参照を検証 |

### 2.1 タイムトラベル（全体同期）は仕様

ファイル1つの内容が過去コミットと一致して HEAD が巻き戻る場合も、**意図としてそのコミット時点の全体状態へ同期する**（通常の `git checkout <commit>` に揃える）。

「他ファイルまで戻る」はバグではなく、Git 互換の望ましい挙動とする。

### 2.2 将来機能: Cherry-pick（部分適用）

全体同期とは別に、**特定マイクロコミットから一部パスだけを現在の tip に取り込む**操作を将来実装する。

| 項目 | 案 |
|------|-----|
| 名称 | Cherry-pick（仮） |
| UI | グラフ／サイドバーでコミットを選び「この変更だけ取り込む」 |
| 意味 | 選んだコミットの差分（または指定パス）を現在のマイクロ tip 上に新コミットとして載せる。HEAD を過去へは動かさない |
| 用途 | 「あの試行の `a.py` だけ欲しい」など、全体巻き戻しではやりすぎな場合 |
| 優先度 | 全体同期の挙動を安定させた後。PR レビュー WF より後でも可 |

※ 現行の「1ファイル一致で過去コミットへ HEAD 移動＋全体同期」を Cherry-pick に置き換えるのではなく、**全体同期を既定・Cherry-pick を明示操作**とする。

## 3. メインブランチ専属のマイクロ履歴

### 現状の問題

- 有効化時の「対象ブランチ」1本＋他ブランチでは退避、というモデル
- 保存ジョブが実行時にブランチを再確認しないと、退避後に別ブランチ上でシャドウを再作成しうる

### 目標モデル

```
main     → マイクロ空間 A（独自 tip / mb-* / overlay write）
feature  → マイクロ空間 B
hotfix   → マイクロ空間 C
```

- メイン側のブランチを切り替えると、**そのブランチ専属のマイクロ履歴**が載る（他ブランチの履歴は混ざらない）
- 保存ジョブ実行時は「いまのメインブランチ」に紐づく空間へだけ書く（投入時ブランチと異なればスキップ or 現ブランチ空間へ振り直し）

実装候補（ストレージは §5 の選定に依存）:

- 親リポジトリ内 refs: `refs/microgit/<main-branch>/...`
- またはブランチ名キーのバンドル／ディレクトリ（作業ツリーにネスト `.git` を置かない）

## 4. 他デバイス共有（メインの push / pull）

### 意図

専用リモート同期なしで、**いつもの `git push` / `git pull`（メインブランチ）**だけで別 PC にマイクロ履歴が届くこと。

### 現状の欠陥

作業ツリー内の `.microgit_shadow/.git`（ネスト Git）をそのまま `git add` すると gitlink になりやすく、受け手にオブジェクトが渡らない。

### 目標

- メインのコミットに「普通の追跡可能データ」としてマイクロ履歴が載る（または親 `.git` の refs が push に含まれる明確な手順）
- pull 後、拡張が自動で読み込み、同じマイクロ tip から続きの保存ができる
- ネストした第二の `.git` を作業ツリーに晒して add させる方式はやめる

### 4.1 安全性: Fetch / Publish の非破壊化（分岐のみ・合流なし）

#### 現状の欠陥（2026-07-27 レビューで判明）

`refs/microgit/*` の同期処理が全経路で**強制上書き**になっている。

| 箇所 | 処理 | 危険性 |
|------|------|--------|
| `fetchMicrogitRefsFromOrigin`（`shadowStore.ts`） | `git fetch origin +refs/microgit/*:refs/microgit/*` | ローカルに未 publish のマイクロ履歴があっても origin の内容でその場で丸ごと上書き |
| `importFromParentRefs`（`shadowStore.ts`） | bare へ `+prefix/micro-history:refs/heads/micro-history`（強制 fetch） | ローカル bare の未 publish tip を親の `refs/microgit/*` で問答無用に上書き |
| `publishToParentRefs`（`shadowStore.ts`） | 親 `.git` へ `push --force` | ローカル→親自体は実害小さいが、最終的に origin を取り合う形になる |

「Fetch を実行しただけで、ローカルの未 publish マイクロ履歴が警告なしに消える」が最悪シナリオ。

#### 確定方針: マージはしない。発散は常に新しい分岐（`mb-N`）として扱う

**採らない案: 3-way マージによる自動コンフリクト解決**

- 却下理由: マイクロ履歴のコミットはすべて `commit-tree -p <parent>` で**単一親のみ**を持つ（`extension.ts` の `runShadowCommit`）。merge commit（複数親）を作る経路がそもそも存在せず、これは意図的な不変条件である
- 履歴同士の「本線」は常に一本の線でしかつながらない。合流点を作る発想自体を持ち込まない
- §2.1「全体同期は仕様」（部分マージをデフォルトにしない）とも整合する。合流の仕組みを作るくらいなら、Cherry-pick（§2.2、将来機能）で必要な差分だけ拾えばよい

**採る案: 発散検知 → 上書きせず新規タグとして分岐**

1. 取り込み予定の tip はまず別の一時 ref（`refs/microgit-remote/incoming`、tag は `refs/microgit-remote/tags/<tag>`）に fetch し、`micro-history` 本体には触れない
2. `git merge-base --is-ancestor <local> <incoming>` で関係を判定
   - incoming が local の子孫（fast-forward）→ そのまま前進。これまで通り
   - local が incoming の子孫（相手に新しい情報なし）→ 何もしない
   - **発散**（合流ではなく分岐として処理）→ `micro-history`（現在の tip）には触れず、incoming の tip に新規 `mb-N` タグを打つだけ。ユーザーには「他デバイスの履歴を新しい分岐として取り込みました（mb-N）」と通知。以後は既存の `jumpToCommit` / グラフ UI でどちらの分岐を続けるか選べる
   - 取り込んだ `mb-*` タグ名がローカルの既存タグと衝突し、かつ指すコミットが異なる場合も上書きせず新番号で採番し直す（`adoptIncomingTags`）
3. **明示的な backup ref は採用しなかった**: 上記のロジックは fast-forward・no-op・新規タグ追加の3パターンしか存在せず、いずれも既存 ref を破壊的に上書きしない。したがって「上書き前の保険」を別途持つ必要がない（採らなかった案として記録）
4. `fetchMicrogitRefsFromOrigin`（origin ⇄ 親 `.git` の `refs/microgit/*` ミラー）は force fetch のまま変更していない。理由: `refs/microgit/*` は `publishToParentRefs` が bare の実体（`micro-history` tip + `mb-*`）から毎回まるごと再生成する**完全な派生ミラー**であり、それ単独でしかユーザーの作業を記録している箇所は無い。実際にユーザーの作業を一意に保持するのは常に bare の `refs/heads/micro-history` であり、そこを守る #1-2 だけで安全性は担保される
5. `publishToParentRefs` の origin 側は現状すでに非 force。非 fast-forward で弾かれた場合、現状は失敗ログに埋もれるだけなので「先に Fetch してください」と明示的にユーザーへ通知する（未実装・残タスク）

#### 実装状況（2026-07-28）

- `shadowStore.ts` の `importFromParentRefs` を上記の非破壊ロジックに書き換え済み（`ImportResult` として `outcome: 'no-remote' | 'up-to-date' | 'initial' | 'fast-forward' | 'diverged' | 'error'` を返す）
- `microgit.fetchMicroHistory` コマンドは `diverged` のとき通常の情報メッセージではなく警告メッセージで新規タグ名を明示
- ブランチ切替時の自動 import（`prepareShadowForBranch`）は戻り値を使わずログ出力のみ（バックグラウンド処理のため画面通知は不要と判断）
- 検証: 2デバイス相当（bare リポジトリ2つ）を模した手動シナリオで「初回 import」「fast-forward」「発散（片方に未 publish ローカルコミットがある状態での fetch）」の3パターンを実行し、発散時にローカルの未 publish コミットが tip として保持されたまま失われないことを確認済み。自動テストへの組み込みは未実施（§ テスト方針は別途要検討）

#### 速度とのトレードオフ

すべて Fetch / Publish という低頻度の明示操作にのみ挟まる。保存のたびに走る `runShadowCommit` のホットパスには一切手を入れない。

| 対策 | 追加コスト | 発生頻度 | 評価 |
|------|-----------|---------|------|
| `merge-base --is-ancestor` 判定 | git 呼び出し1回 | Fetch/Publish 実行時のみ | 無視できる |
| 上書き前の backup ref | ref 作成1つ（オブジェクト複製なし） | 同上 | ほぼゼロコスト |
| 発散を `mb-N` 新分岐として取り込む | Overlay の view/layer が新分岐分だけ後で生成される | 発散時のみ（稀） | Overlay は元々兄弟分岐前提の設計。追加コストは通常の分岐作成と同等。ディスク使用量のみ増加 |
| `dag.json` のアトミック書き込み（tmp+rename） | 追加ファイル I/O 1回 | 保存のたび | 無視できる（複数ウィンドウでの読み書き競合対策として別途推奨） |

## 5. アーキテクチャ比較: 既存 Git 利用 vs Git 再構築

共有・ブランチ専属・UI を進めるにあたり、ストレージエンジンをどうするか。

| 観点 | A. 既存 Git をストレージに使い続ける | B. Git を再構築し専用ストア＋専用 UI |
|------|--------------------------------------|--------------------------------------|
| オブジェクト／整合性 | pack・hash・検証が既製品 | 自前 CAS・破損検知・GC を全部書く |
| グラフ・分岐 | `commit-tree` / parent でそのまま | 同様の DAG を再発明 |
| メイン経由共有 | **形式の直しが必要**（ネスト `.git` 廃止）。bundle を通常ファイルでコミット、または親 repo の `refs/microgit/*` を push に含める | ディレクトリを普通にコミットすれば共有は簡単 |
| ブランチ専属 | refs 名前空間 or ブランチ鍵付き bundle で自然 | ディレクトリ分割で自然 |
| Overlay / タイムトラベル UI | 既に専用 UI あり。ストレージは Git のままでよい | UI はどちらでも必要。再構築の主因にはならない |
| 実装コスト | 中（共有形式＋ブランチ鍵の付け替え） | 大（エンジン＋移行＋検証） |
| リスク | Git の制約（短いハッシュ、ref 命名）に従う | 独自バグ・互換・パフォーマンスの責任が全部自前 |
| PR レビュー WF | bundle / JSON export を Action が読む | 独自形式を Action が読む（同等） |

### 確定方針

**A. 既存 Git をストレージエンジンとして維持**し、Overlay（空間で時間を買う）は現状どおり Node ユーザー空間で継続する。  
共有相手も MicroGit 導入済み前提のため、クライアント負担の少ない **α（親リポジトリの `refs/microgit/<branch>/*` ＋ MicroGit による companion fetch/push）** を採用する。

| 選択 | 内容 |
|------|------|
| エンジン | A（Git 維持）。B（再構築）は採らない |
| Overlay | 維持（軽量 checkout の恩恵はストレージ形式と独立） |
| 共有 | α。作業ツリーにネスト `.git` を置かず、`.git/microgit/repos/<branch>.git` 等に分離。MicroGit が `refs/microgit/*` を fetch/push |
| β を採らない理由 | bundle を通常ファイルで持つと差分肥大・展開コストが増え、双方 MicroGit ありなら α の方が軽い |

### 実装順（確定）

1. メインブランチ専属のマイクロ空間（ブランチ切替で載せ替え）  
2. 共有形式 α（ネスト `.git` 廃止 + refs 同期）  
3. 保存ジョブ実行時のブランチ再確認  

各段階の後にコミット。push はメンテナがまとめて行う。

4. （将来）メインコミット区間 UI（§6）→ Cherry-pick / PR レビュー WF

## 6. 二重の見え方: ストレージは一本、UI は区間

### 意図

| 用途 | 望ましい見え方 |
|------|----------------|
| **AI / PR レビュー** | ブランチのマイクロ履歴が**一本にまとまっている**（全体の試行錯誤を渡せる） |
| **拡張 UI（人間）** | メインの **コミット A → 次のコミット B のあいだ**に積まれたマイクロコミットだけを確認できる |

ストレージをコミットごとに分割すると PR 向けが不便になる。逆に UI が常に全期間一本だと「この提出の直前に何を試したか」が分かりにくい。  
よって **記録はブランチ専属の一本のまま、表示だけメイン HEAD で区間分割する**。

```
メイン:   … → [commit A] ----作業----→ [commit B] ----作業----→ [commit C]
マイクロ:        m1 m2 m3（A 上）         m4 m5（B 上）           m6 …
UI:              「A→B 区間」で m1–m3      「B→C 区間」で m4–m5
PR/AI:           feature ブランチの m1…m6 をまとめて渡す
```

### 紐づけ方（実装方針）

各マイクロコミット作成時に、親リポジトリの当時の `HEAD`（フルハッシュ）をメタとして残す。

| 候補 | 内容 |
|------|------|
| 推奨 | コミットメッセージ末尾や trailer: `Main-Head: <sha>` |
| 併用可 | Overlay DAG / サイドカー JSON に `mainHead` を持つ |

UI:

1. メインの `git log` からコミット列を取る  
2. マイクロ履歴を `Main-Head` でグループ化  
3. サイドバー／グラフに「区間フィルタ」（例: `B ← いまの作業` / `A → B`）を置く  
4. フィルタなし＝従来どおりブランチ全体（PR プレビューにも近い）

タイムトラベルは区間表示でも、対象は従来どおり**そのマイクロコミットのツリー全体**（§2.1）。

### 注意

- メインを commit する前の作業は、すべて「当時の HEAD（例: A）」に紐づく  
- メインを amend / rebase すると sha が変わり区間がずれる → 既知の制限としてドキュメント化する  
- 過去データに trailer が無い分は「未分類」区間に落とす（前方互換）

### 実装状況（v4.0.0）

- 保存時に `Main-Head: <sha>` trailer を付与（`src/mainHead.ts`）
- サイドバー／グラフに区間セレクト（ホスト側でフィルタ、同期）
- 既定表示は「すべて」。未分類・rebase ずれは設計どおりの制限

### 優先度（残り）

PR レビュー WF のエクスポートで `mainHead` 区間切り出しを再利用する。

## 7. 将来: PR レビュー用 GitHub ワークフロー（方針メモ）

### 目的

通常の PR diff だけでなく、micro-git 上の試行錯誤（分岐・全体巻き戻し・`[AI]`・将来の Cherry-pick）をレビュー材料にする。  
エクスポートは **ブランチ全体を一本**で渡しつつ、必要なら §6 の `Main-Head` 区間で「この PR のコミット範囲に対応するマイクロ履歴」だけに絞れるようにする。

### やらないこと

- PR オープン時の自動 remote push / pull
- シャドウ専用リモートブランチへの常時同期

### やること（段階案）

1. 移植可能なエクスポート（bundle / JSON）。共有形式（§5）と揃える。JSON に `mainHead` を含める  
2. PR への添付は明示オプトイン  
3. GitHub Actions が読み取り専用でサマリコメント（全体＋任意で区間）  
4. 拡張と Action でスキーマ共有。CI 上では auto-save しない  

### プライバシー

マイクロ履歴に秘密情報が残りうる。PR 添付はオプトイン。除外／redaction を設計に含める。

## 8. エージェント成果物のリポジトリ内ドキュメント化

Cursor と Claude Code を併用する。チャット履歴・コンテキスト窓は端末／セッション／ツールごとに分断され、トークン限界後は再投入コストも高い。そのため **エージェントとの会話で得た知見は、チャットに残さずリポジトリのドキュメント／コメントとして残す**。

### 対象となる成果物

| 種別 | 例 | 置き場所の目安 |
|------|-----|----------------|
| 設計判断・トレードオフ | A vs B の選定理由、採らなかった案 | `docs/design-policy.md` または `docs/` 配下の専用メモ |
| Agent Skills / ルール由来の運用 | スキル適用結果、繰り返し守る手順 | `AGENTS.md` / `CLAUDE.md`、必要なら `.cursor/rules/` |
| 実装上の不変条件・罠 | なぜこの順序か、壊してはいけない前提 | 該当ソースの近傍コメント、または `docs/` |
| 調査結果・既知の制限 | amend で区間がずれる、など | 設計方針または該当モジュールの README 相当 |

### エージェントへの要求（Cursor / Claude Code 共通）

1. **設計判断を確定・変更したら**、チャット要約だけで終わらせず、該当ドキュメントを同じ作業単位で更新する  
2. **「なぜそうするか」を残す**（何を変えたかより、採択理由・却下理由・前提・制約を詳細に）  
3. **Skills・ルール・フックで得た手順**も、再利用されるならリポジトリ側に書く（個人チャット専用にしない）  
4. 新規ドキュメントは既存の `docs/` 構成に合わせ、§9 の関連一覧へリンクを足す  
5. 秘密情報・トークン・個人の請求情報はドキュメントに書かない  

詳細な作業指示はリポジトリ直下の [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) を正とする。

## 9. 関連ドキュメント

- 利用者向け: [README.md](../README.md)
- Overlay: [NodeOverlay.md](./NodeOverlay.md)
- 卒業研究レビュー: [build-verification-engine-review.md](./build-verification-engine-review.md) — エンジン設計の前提を実装と突き合わせた指摘。R-01/R-02 は本ドキュメント §2（記録単位）の変更を要求する
- 卒業研究（ビルド検証エンジン）: [build-verification-engine.md](./build-verification-engine.md) — マイクロコミット単位のビルド成否の悉皆記録と、ブランチ追従 CoW キャッシュ。MicroGit 本体とは別プロセス（同 §14 に接続点）
- 次期メジャー（カーネル機能ポータブル化）: [要件定義書](./microgit-kernel-feature-portability-requirements.md) / [初期設計](./microgit-kernel-feature-portability-design.md) / [補足（レビュー所見 S-1〜S-13）](./microgit-kernel-feature-portability-supplement.md) — Linux カーネルの OverlayFS を Linux 以外のホストにも提供する部品。現行の Node.js 仮想 Overlay はフォールバックとして残す。作業ブランチ `feature/kernel-portability`、進捗は Issue #8（Epic）
- 設計判断の理由（記事・論文向けのまとめ）: [design-rationale.md](./design-rationale.md) — 計測で分かったこと、判断ごとの理由・採らなかった案・引き受けること、まだ確かめていないこと、主張の強さの注意（#34）
- 設計判断の記録（ADR）: [adr/README.md](./adr/README.md) — 1 件 1 ファイル。ADR-0001 正本は shadow の Git、ADR-0002 永続性の既定は電源断でも失わない、ADR-0003 層キャッシュのコンパクション、ADR-0004 保存ごとに層を作る、ADR-0005 mount オプションの固定、ADR-0006 Windows の名前付きパイプ、ADR-0007〜0011 初期設計の ADR 候補 5 件（機能単位の部品、Linux は VM なし、ゲストを信用しない、CONFIG_NET 無効、Go の静的 agent）
- カーネル版の Overlay バックエンド（MicroGit への組み込み）: [kernel-backend.md](./kernel-backend.md) — 設定、ホストごとの起動、Windows の名前付きパイプ、層の供給、速さ、テスト、既知の制限（#14）
- Boundary Guard の規則: [boundary-guard.md](./boundary-guard.md) — ゲストから受け取ったファイルの一覧と中身を、ワークスペースに書く前にホストで検証する（#16）
- agent の命令の形（プロトコル v1）: [agent-protocol.md](./agent-protocol.md) — ホストと最小ゲスト（または VM なしの agent）のあいだの約束
- 学習用ドキュメント（技術ごとの解説）: [learning/README.md](./learning/README.md) — Issue ごとに使った技術（ゴールデンテスト、名前空間など）を、実装と対応づけて解説する
- OverlayFS ゴールデンテスト: [overlayfs-golden-test.md](./overlayfs-golden-test.md) — カーネルの OverlayFS を正解として記録し、Node 実装と突き合わせる（Issue #10）。現行 Node 実装の食い違い N-1〜N-5 の分類あり
- 実装の解説（はじめに読む）: [kernel-portability-walkthrough.md](./kernel-portability-walkthrough.md) — 保存 1 回のあいだにホストとゲストで何が起きるかを順に追う。デモの動かし方と用語集つき
- Phase 1（最小ゲストと macOS）: [guest-phase1.md](./guest-phase1.md) — Go の agent、Linux 6.18.53 の最小カーネル、Virtualization.framework の起動ツール。決めたこと（agent は Go、通り道は virtio-console の仮決め）と計測結果
- Phase 2（Windows）: [windows-backend.md](./windows-backend.md) — QEMU を同梱する方式に決定（O-1）。WHPX が無効でも TCG で動く。計測結果と、同梱用の小さい QEMU のビルド（#18）
- Phase 3（公開）: [release.md](./release.md) — プラットフォーム別の VSIX、5 つの環境での確認、公開の手順と利用者が決めること、ライセンスとソース、Windows の保護機能、TCG の境界、同梱する部品の更新方針（O-6）。同梱物の一覧は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（#19）
- 変更履歴: [CHANGELOG.md](../CHANGELOG.md)
- エージェント共通指示: [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md)
