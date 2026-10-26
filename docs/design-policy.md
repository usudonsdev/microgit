# verEve 設計方針（旧称 MicroGit）

最終更新: 2026-10-26（MicroGit → verEve に改名。§2.5。それ以前の節は書いた時点の記述で、製品名だけ verEve に直してある。2026-10-07: 生成物は `.microgit/` にまとめる。AI の印は Cursor フックのまま）

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
| checkout | Node.js ユーザー空間 Overlay（`vereve.useOverlayCheckout`）を既定 |
| セキュリティ | `execFileSync` + 引数配列。シェル連結禁止。パス／参照を検証 |

### 2.1 タイムトラベル（全体同期）は仕様

ファイル1つの内容が過去コミットと一致して HEAD が巻き戻る場合も、**意図としてそのコミット時点の全体状態へ同期する**（通常の `git checkout <commit>` に揃える）。

「他ファイルまで戻る」はバグではなく、Git 互換の望ましい挙動とする。

### 2.1.1 全体同期で未保存の編集を消さない（診断 S-15、2026-10-25）

**問題**: 保存時の自動巻き戻し（rewound）とジャンプ（`sharedTimeTravel`）は、`applyOverlayCheckout(..., {syncWorkspace:true})` でディスク上のファイルを書き換え、その後 `revertTouchedDocuments` が開いている文書に `workbench.action.files.revert` を実行していた。revert は未保存の編集を確認なしで捨てるため、別タブで編集中のファイルの未保存の編集が黙って消えた。

**採用した修正（最小）**: `revertTouchedDocuments` は `isDirty` な文書を読み直さない（判定は純関数 `src/revertPolicy.ts` の `selectDocumentsToRevert`、単体テスト `src/test/unit/revertPolicy.test.ts`）。読み直さなかった文書は verEve Output に WARN を出し、警告を 1 回表示する。ディスクは書き換わっているので、利用者がその文書を保存すると VS Code が「ディスク上で新しくなっている」衝突を知らせる（比較・上書きを選べる）。これでエディタ上の未保存の編集は失われない。

**dirty な文書がある状態で syncWorkspace が走る経路（コードを読んだ結果）**:

| 経路 | 呼び出し | 書き換え先 |
|------|----------|------------|
| 保存時の rewound | `extension.ts` 保存ジョブ → `applyOverlayCheckout(root, head, {syncWorkspace:true})` | カーネル版 `applyKernelCheckout` → `kernel.checkout`、または Node 版 `syncMergeToWorkspace` |
| ジャンプ（Overlay 有効） | `sharedTimeTravel` → `applyOverlayCheckout` | 同上 |
| ジャンプ（Overlay 無効） | `sharedTimeTravel` の `git show` ループ | `fs.writeFileSync` / `unlinkSync`（revert 自体を呼ばない。エディタの内容は残るが、ディスクは書き換わる） |

どの経路も `revertTouchedDocuments` の dirty 判定で、少なくともエディタ上の編集は守られる。

**決定（運営者、2026-10-26）: B を採る。dirty なパスはディスクも書き換えない**。A・C は却下（理由は下の表）。

| 選択肢 | 内容 | 判断 |
|--------|------|------|
| A | ディスクは書き換え、dirty は読み直さない | 却下。ディスクとエディタが食い違い、エディタの内容を保存で上書きすると巻き戻し結果が消える。保存時の衝突確認に頼る形で、利用者に判断を押し付ける |
| **B** | dirty なパスを同期から除外 | **採用**。Git の checkout が dirty なファイルの上書きを拒むのと同じ向き（「Git 互換」に寄せる）。ディスクもエディタも守れる |
| C | dirty が 1 つでもあれば全体同期をスキップまたは確認 | 却下。保存ジョブは非同期で確認 UI と相性が悪い。スキップ時の HEAD とワークスペースのずれの扱いが重い |

**B の実装（2026-10-26）**:

- 純関数 `selectDirtyPaths`（`src/revertPolicy.ts`）が、開いている文書のうち `isDirty` なもののワークスペース相対パスを集める（`extension.ts` の `collectDirtyPaths`）。
- そのパス集合（skip 集合）を、同期の 3 経路すべてに渡す。**書きも消しもしない**。
  - カーネル版: `kernel.checkout({ skipPaths })` → `syncWorkspaceFromGuest({ skipPaths })`（`src/boundaryGuard.ts`）。比較は `collisionKey` なので、大文字小文字を区別しない OS でも取りこぼさない。
  - Node 版: `syncMergeToWorkspace(..., skipPaths)`（`src/overlay.ts`）。
  - Overlay 無効のジャンプ（`sharedTimeTravel` の `git show` ループ）: dirty なパスは飛ばす。
- 除外したパスは結果の `skippedDirty` で返り、verEve Output に WARN を出し、警告を 1 回表示する。
- `revertTouchedDocuments` の dirty 判定（S-15 の最小修正）は**残す**。skip 集合を作った後に編集が始まった（同期中の競合）場合の安全網。

**§2.1（全体同期は仕様）との関係**: B では、dirty なファイルがある間は「巻き戻し後のワークスペースが指定コミットと一致しない」。これは §2.1 の例外として許容する。保存されていない編集は利用者の作業であり、履歴より優先する。

**除外したパスの扱い（仕様）**:

- 除外したパスは、次の同期で拾う。キャッシュ（`kernel-sync-cache.json`、`syncMergeToWorkspace` のキャッシュ）には入れないので、次回はディスクの中身から比べ直す。そのとき dirty でなくなっていれば（保存した・閉じた）、通常どおり指定の時点へ揃う。
- DAG の現在位置（`dag.json` の `current`）は、除外があっても target に更新する。履歴の HEAD は target、ワークスペースの dirty ファイルだけが違う、という状態になる。
- dirty なファイルを利用者が保存すると、そのときの内容が target の次の新しいマイクロコミットになる（保存は 1 ファイル単位の記録なので、他のファイルには影響しない）。つまり「保存すると、いまの内容が新しい記録になる」。巻き戻しの結果を取り戻したい場合は、保存せずに閉じる（またはエディタで元に戻す）→ もう一度同じ時点へジャンプする。
- カーネル版 agent 側の層・`cache` は、ワークスペースではなく履歴（層）に対するものなので影響しない。除外は「ホストがワークスペースへ書く段」だけで行う（ゲストにパスを渡さない。FR-3 を保つ）。

**テスト**: `src/test/unit/boundaryGuard.test.ts`（skipPaths が書かない・消さない・キャッシュに入れない／大文字小文字）、`src/test/unit/revertPolicy.test.ts`（`selectDirtyPaths`）、`scripts/overlay-smoke.mjs` の 9（Node 版の同期。次回の除外なし同期で揃うことまで）。VS Code を起動する結合テスト（実際に dirty な文書を持つ状態での rewound）は未実施 — 実機確認の項目。

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

### 2.3 AI 編集の印はフックのまま（2026-10-07）

v3.4.0 で入った仕組みが、いまも AI 連携の全体である。Cursor の `afterFileEdit` / `afterTabFileEdit`（`.cursor/hooks/mark-ai-edit.sh`）が編集した相対パスを `.microgit/logs/ai-pending.json` に足し、保存時に `consumeAiPending` がそれを消費して件名を `micro: [AI] saved …` にする（`src/mainHead.ts` の `buildMicroCommitMessage`）。グラフとサイドバーはその件名を `[AI]` と表示する。v3.4.1 で、通常 Git へ自動コミットする hook は廃止済み。

2026-10-07 に `feature/kernel-portability`（`83a933d`、#38 ジャーナル ADR-0014 まで）を取り直して見直した。カーネル版の checkout もジャーナルも、この印の経路を通らない。記録の本文は保存のときだけ組み立てる。

**Cursor Agent Skill（`SKILL.md`）にはしない。** 検討した案と却下理由:

| 案 | 却下理由 |
|---|---|
| エージェントにマイクロ履歴の読み書き手順を教える Skill | 記録は保存イベントが正本。モデルが手順を思い出したときだけ残すと、取りこぼしと二重記録が起きる。通常 Git への自動コミットをやめた理由と同じ |
| 拡張機能に Skill を同梱し、入れただけで全ワークスペースに効かせる | VSIX は他リポジトリの `.cursor/skills/` を置けない。利用者が各リポジトリで有効にする操作が残り、フックをコピーするのと手間が同じ |
| Claude Code 向けにも Skill を書く | Claude Code には Cursor の `afterFileEdit` が無い。Skill を足しても編集の観測にはならない |

残る制限（未実装。今回は直さない）:

- フックは verEve 自身のリポジトリにしか無い。拡張機能を入れた他のワークスペースでは、同じ `.cursor/hooks.json` を置くまで `[AI]` は付かない
- シェル経由の書き込みや、フックの無い Claude Code の編集は印が付かない。保存そのものは通常どおり残る
- 配布するなら、拡張機能のコマンドでフック一式をワークスペースへコピーする方が、Skill より観測が確実。コピー先の上書き規則を決めてからにする

### 2.4 生成物は `.microgit/` にまとめる（2026-10-07）

ワークスペース直下に出ていた `.microgit_shadow`、`.microgit_logs`、`.microgit_overlay` は、`.microgit/shadow`、`.microgit/logs`、`.microgit/overlay` に移す。エクスプローラーに並ぶ生成フォルダを 1 つにするため。正本のオブジェクトは今までどおり親リポジトリの `.git/microgit/repos/<branch>.git` にあり、`.microgit/shadow/.git` はそこを指す gitfile のまま。

起動時と、パスを解決するときに `migrateLegacyMicrogitLayout`（`src/layout.ts`）が古いフォルダを移す。新しい場所が空ならフォルダごと移す。同じ名前が既にあるファイルは残し、移しきれなかった古いフォルダも消さない。ブランチ切り替えで拡張機能ストレージへ退避していた古い 3 フォルダは、戻すときに `.microgit/` の対応する子へ入れる。

Boundary Guard は `.microgit` に加え、古い 3 つの名前もワークスペース直下なら拒む。戻した履歴が、また直下にフォルダを作らないようにするため。

### 2.5 名称を MicroGit から verEve に改める（2026-10-26。実装済み・未公開）

運営者の決定（2026-10-26）。**verEve = versioning everything**。表記は camelCase の `verEve`、識別子は小文字の `vereve`。経緯・名称の衝突調査・影響範囲の表・手順案・未決は [rename-vereve.md](./rename-vereve.md)。ここには**実装で下した判断と理由**を残す。6.0.0 として実装した（リリース作業・Marketplace/Open VSX への公開・旧拡張の非推奨化は未実施）。

#### 改名したもの

| 区分 | 旧 | 新 | 備考 |
|---|---|---|---|
| 拡張 ID | `usudonsdev.microgit` | `usudonsdev.vereve` | Marketplace では ID を変えられないので新しい拡張として出し直す |
| 表示名・コマンドのタイトル | MicroGit | verEve | |
| コマンド ID（10 個） | `microgit.*` | `vereve.*` | 機能名は保つ（`vereve.publishMicroHistory`）。テスト用の内部コマンドも `vereve.internal.*` |
| 設定キー（8 個） | `microgit.*` | `vereve.*` | `vereve.kernel.qemuPath` など |
| ビューコンテナ・ビュー・アイコン | `microgit` / `microgit.sidebar` / `media/microgit.svg` | `vereve` / `vereve.sidebar` / `media/vereve.svg` | 絵はそのまま（文字は入っていない） |
| workspaceState / globalState のキー | `microgit.enabled` など | `vereve.*` | 新しい拡張の保存領域は旧と別なので、どのみち引き継がれない |
| 画面の文言・通知・ログ・出力チャンネル | MicroGit | verEve | Publish の確認ダイアログでも verEve。refs は技術名として `refs/microgit/*` と書く |
| クラス名 | `MicroGitUi` | `VerEveUi` | |
| VSIX の出力名 | `microgit-<版>-<target>.vsix` | `vereve-<版>-<target>.vsix` | `scripts/package-vsix.mjs`、CI の説明文 |

#### 据え置いたもの（互換のため旧名のまま）

| 据え置き | 理由 |
|---|---|
| 履歴の ref の名前空間 `refs/microgit/*`（一時 ref `refs/microgit-remote/*` も） | **既存の履歴との互換。** 利用者が `Publish` で origin に送った履歴、他デバイスの旧版が読み書きする履歴が、名前を変えると読めなくなる。名前の移行（新旧両方を読む）は別に設計する |
| 保存場所：`.microgit/`（shadow・logs・overlay）、旧 3 フォルダ名、`.git/microgit/repos/`、`microgit-journal`、`.microgit_view_ok` | 同上。変えると既存の shadow・層・ジャーナルを見失う。Boundary Guard の拒否リスト、`.cursor/hooks/mark-ai-edit.sh`、`.vscodeignore` も同じ名前を参照する |
| 同梱バイナリ・ゲストのファイル名（`microgit-agent`、`microgit-vm`、`microgit-guest-*`）と、それを参照するビルドスクリプト・CI・`launchers.ts`・`THIRD_PARTY_NOTICES.md` のパス、環境変数 `MICROGIT_AGENT_STATE_DIR`、virtio-serial のポート名 `microgit` | **Mac の実機でビルドして検証できない**（Swift の `microgit-vm`、署名、ゲストイメージ）。ゲストの agent・ホストの起動・CI の成果物名は同じ名前でそろっていて、片方だけ変えると起動できなくなる。変えるなら実機検証つきで別の変更にする |
| コミットの作者 `MicroGit <microgit@local>`（`extension.ts` の commitEnv、`fastMicroCommit.ts` の reflog 識別） | 履歴に残るデータ。改名すると、既存の履歴と作者が混在する |
| テスト用の環境変数 `MICROGIT_TEST_*`、CI の成果物名 `microgit-*` | 開発用で利用者に見えない。CI のワークフローと対で変えるべきで、検証できない |
| 内部の関数名（`pushMicrogitRefsToOrigin`、`MICROGIT_ROOT_NAME`、`migrateLegacyMicrogitLayout` など） | 上の据え置きの名前を扱うものなので、名前が合っている |

ソース内の該当箇所には「互換のため旧名のまま」とコメントを付けた（`layout.ts`、`shadowStore.ts`、`boundaryGuard.ts`、`overlay.ts`、`fastGit/journal.ts`、`kernel/launchers.ts`、`extension.ts`、`fastMicroCommit.ts`）。

**却下した案**：
- *`refs/microgit/*` と保存場所まで全面改名*：既存の履歴との互換が切れ、旧版との共有もできなくなる。移行処理（新旧両方を読む・書き換える）の設計と検証が要り、改名とは別の規模になる。
- *同梱バイナリも `vereve-*` に改名*：Mac で実機ビルド・署名・起動の検証ができない。ゲストの agent（Go）・`microgit-vm`（Swift）・CI の成果物名・`launchers.ts`・NOTICES を同時に変える必要があり、取りこぼすとカーネル版が静かに Node.js 版へ落ちる（検出しにくい）。
- *旧設定を新設定と自動で同期し続ける*：旧拡張が残っている間に二重管理になる。一度きりのコピーにした。
- *旧拡張を検出したら自動で無効化*：拡張機能から他の拡張を無効化する API は無い。身を引いて警告する。

#### 旧設定の引き継ぎ（`src/settingsMigration.ts`、`extension.ts` の `migrateLegacySettings`）

- 起動時に一度。旧 `microgit.<名前>` に値があり、**同じ範囲**（グローバル / ワークスペース）の `vereve.<名前>` が未設定なら、そのまま新キーへコピーする。新キーに既にある値は上書きしない。旧キーは消さない（旧拡張が残っていても壊さない）。
- 引き継いだら一度だけ通知する（件数とキー）。0 件なら通知しない。
- 引き継ぎ済みの印：グローバルは `globalState`（`vereve.settingsMigrated.global`）。**ワークスペースは `workspaceState`（`vereve.settingsMigrated.workspace`）に分けた。** ワークスペースの設定はそのワークスペースを開いたときにしか読めないので、`globalState` だけの印にすると、最初にフォルダなしで起動した人の、後から開くワークスペースの旧設定が永久に引き継がれない。
- 失敗したら印を付けず、次の起動でやり直す（例外はログに出すだけで、拡張機能は止めない）。
- 扱わない：`workspaceFolderValue`（マルチルートのフォルダ設定）。範囲が曖昧で、取り違えると別フォルダの設定を書き換える。
- 計画（何をどこへ書くか）は vscode に依存しない純関数 `planSettingsMigration`。単体テスト `src/test/unit/settingsMigration.test.ts`。

#### 旧拡張との共存対策（`src/legacyExtension.ts`）

- 旧 `usudonsdev.microgit` が有効だと、保存のたびに両方が同じ shadow リポジトリへマイクロコミットして競合する（履歴の置き場を据え置いたことの帰結）。
- 起動時に `vscode.extensions.getExtension('usudonsdev.microgit')` で探す。**見つかれば（有効なら。無効化された拡張は返らない）、まだ activate されていなくても**衝突とみなす。
- 衝突のとき：`isEnabled()` を常に `false` にして記録・有効化を止める（toggle/enable も拒む）。警告「旧 MicroGit が有効です。旧拡張を無効化またはアンインストールしてから再読み込みしてください」を通知とログに出し、ステータスバーを警告色にする。旧拡張を止めてウィンドウを再読み込みすれば解ける（実行中の検出はしない）。
- 判定は純関数 `evaluateLegacyConflict`（探す関数を引数で受ける）。単体テスト `src/test/unit/legacyExtension.test.ts`。

#### 不一致を防ぐ検査（`src/test/unit/manifestConsistency.test.ts`）

`package.json` の `contributes`（commands / configuration / views / viewsContainers / menus / keybindings）と `activationEvents` を読み、ソースの `registerCommand`・`executeCommand`・`getConfiguration().get`・`inspect`・`affectsConfiguration`・`viewType` の文字列と過不足なく一致することを確かめる。旧 ID（引用符の直後の `microgit.<名前>`）がソースに残っていないことも確かめる。VS Code を起動しないので CI で常に走る。コマンド・設定・ビューを足すときは、`package.json` と登録コードの片方だけ直すとこのテストが落ちる。

#### 実機でしか確かめられない項目

[rename-vereve.md](./rename-vereve.md) §7 を参照（`inspect` が未登録の旧キーの値を返すか、旧拡張との共存の警告、VSIX のインストールなど）。

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

作業ツリー内の `.microgit/shadow/.git`（gitfile）をそのまま `git add` すると gitlink になりやすく、受け手にオブジェクトが渡らない。

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
- `vereve.fetchMicroHistory` コマンドは `diverged` のとき通常の情報メッセージではなく警告メッセージで新規タグ名を明示
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

### 4.x Webview の CSP と Publish の確認（診断 S-15・L-11、2026-10-26）

**Webview の Content-Security-Policy**（`src/webviewCsp.ts`、適用は `ui.ts` の `applyCsp(getSidebarHtml())` / `applyCsp(getGraphHtml())`）

- ポリシー：`default-src 'none'; style-src 'nonce-N'; script-src 'nonce-N'; base-uri 'none'; form-action 'none'`（N は HTML を作るたびに新しく作る 16 バイトの乱数の base64）
- 根拠：現物（`ui.ts`）を調べると、サイドバーとグラフの 2 画面とも `<style>` 1 つと `<script>` 1 つのインライン、`acquireVsCodeApi()` と `postMessage` による通信だけ。外部の画像・フォント・`<link>`・`src=`・`style="..."` 属性・`on*=` 属性・`eval` は無い。要素の位置は `el.style.x = ...`（CSSOM。CSP の対象外）。よって nonce 付きのインラインだけを許し、あとは全部止める最小の形で動作が変わらない。`'unsafe-inline'` は使わない（コミットのメッセージなどが `innerHTML` 経由で混ざっても、nonce を知らないスクリプトは動かない）
- 却下：`localResourceRoots` / `webview.cspSource` を許す案（今は外部リソースを読んでいないので不要。画像などを足すときにその種別だけ足す）。スクリプトを別ファイルに出す案（変更が大きく、利益が nonce 方式と同じ）
- 罠：今後、テンプレートに `style="..."`・`setAttribute('style')`・`on*=` を足すと CSP で黙って止まる（画面が崩れる）。単体テスト `webviewCsp.test.ts` がソースを走査して検出する。VS Code 上での実表示の確認は、この変更では未実施（Webview を開く統合テストが無いため）
- **【実機確認待ち】** VS Code が Webview に注入する既定のスタイル（`--vscode-*` の CSS 変数、既定のフォント・色）が、この CSP（`style-src` は nonce のみ）の下でも適用されるかは、実機でしか確認できない（自動テストでは未確認）。VS Code は自前のホスト側のスクリプトで変数を設定する（ページの CSP の対象外と理解しているが未検証）。万一止まった場合に画面が読めなくなるのを避けるため、`ui.ts` の `var(--vscode-*)` には fallback 色・フォントを付けた（2026-10-26）。確認手順：拡張機能開発ホストでサイドバーとグラフを開き、テーマ（ライト/ダーク）に追従すること、開発者ツールのコンソールに CSP 違反（Refused to apply inline style / execute inline script）が出ないことを見る。違反が出たら、その種別だけ許可を足す
- Publish の確認に出す origin の URL は `git remote get-url --push origin`（pushurl と insteadOf を適用した、実際の push 先）。`maskRemoteUrl` は、最後の @ までのユーザー情報・クエリ・フラグメント・既知のトークンの形を落とす（パスに @ がある URL は手前も落ちるが、秘密を出さないことを優先）
- テンプレートには `${...}` の埋め込みが無いので、`applyCsp` は文字列の置換（`<head>` の直後に meta、`<script>`・`<style>` に nonce）で足りる

**Publish の確認ダイアログ**（`vereve.publishMicroHistory`、文面は `src/publishConfirm.ts`）

- `git push origin refs/microgit/*` は、今のブランチだけでなく記録してきた全ブランチのマイクロ履歴（保存のたびのファイルの中身）を送る。利用者の想定より広いので、送る前にモーダルで origin の URL（認証情報は取り除く）・全ブランチが対象であること・中身を見せ、「Publish」を選ばなければ何もしない（親 refs の更新もしない）
- origin が無いときは外に出ないので聞かない。自動の共有（保存後の間引き publish）はこのコマンドとは別経路で、今回は変えていない
- **判断待ち（作っていない）**：確認を省く設定（例 `vereve.publish.confirm`）、現在のブランチだけを送る選択、`.gitignore` 対象の除外（診断の規模大の項目）。省く設定は「共有の方針」に関わるので運営者の判断を待つ。今は毎回出す

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
共有相手も verEve 導入済み前提のため、クライアント負担の少ない **α（親リポジトリの `refs/microgit/<branch>/*` ＋ verEve による companion fetch/push）** を採用する。

| 選択 | 内容 |
|------|------|
| エンジン | A（Git 維持）。B（再構築）は採らない |
| Overlay | 維持（軽量 checkout の恩恵はストレージ形式と独立） |
| 共有 | α。作業ツリーにネスト `.git` を置かず、`.git/microgit/repos/<branch>.git` 等に分離。verEve が `refs/microgit/*` を fetch/push |
| β を採らない理由 | bundle を通常ファイルで持つと差分肥大・展開コストが増え、双方 verEve ありなら α の方が軽い |

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
- 卒業研究（ビルド検証エンジン）: [build-verification-engine.md](./build-verification-engine.md) — マイクロコミット単位のビルド成否の悉皆記録と、ブランチ追従 CoW キャッシュ。verEve 本体とは別プロセス（同 §14 に接続点）
- 次期メジャー（カーネル機能ポータブル化）: [要件定義書](./microgit-kernel-feature-portability-requirements.md) / [初期設計](./microgit-kernel-feature-portability-design.md) / [補足（レビュー所見 S-1〜S-13）](./microgit-kernel-feature-portability-supplement.md) — Linux カーネルの OverlayFS を Linux 以外のホストにも提供する部品。現行の Node.js 仮想 Overlay はフォールバックとして残す。作業ブランチ `feature/kernel-portability`、進捗は Issue #8（Epic）
- 設計判断の理由（記事・論文向けのまとめ）: [design-rationale.md](./design-rationale.md) — 計測で分かったこと、判断ごとの理由・採らなかった案・引き受けること、まだ確かめていないこと、主張の強さの注意（#34）
- 設計判断の記録（ADR）: [adr/README.md](./adr/README.md) — 1 件 1 ファイル。ADR-0001 正本は shadow の Git、ADR-0002 永続性の既定は電源断でも失わない、ADR-0003 層キャッシュのコンパクション、ADR-0004 保存ごとに層を作る、ADR-0005 mount オプションの固定、ADR-0006 Windows の名前付きパイプ、ADR-0007〜0011 初期設計の ADR 候補 5 件（機能単位の部品、Linux は VM なし、ゲストを信用しない、CONFIG_NET 無効、Go の静的 agent）
- カーネル版の Overlay バックエンド（verEve への組み込み）: [kernel-backend.md](./kernel-backend.md) — 設定、ホストごとの起動、Windows の名前付きパイプ、層の供給、速さ、テスト、既知の制限（#14）
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
