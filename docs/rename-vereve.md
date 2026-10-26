# MicroGit → verEve への改名（調査メモ）

> 2026-10-26。運営者が「MicroGit は **verEve**（versioning everything の略）にする」と決めた（記号どおり、表記は camelCase の `verEve`）。本書はその**事前調査と改名の影響範囲**。**実装は 2026-10-26 に済み（6.0.0。ブランチ `claude/vigilant-rubin-9w4e3a`、PR #82 の中）。公開などは未実施**。進捗は §6、実機で確かめる項目は §7。判断の理由は [design-policy.md §2.5](./design-policy.md)。
> 診断（portfolio_hub の `docs/service-review-2026-10-25.md` L-11）で、「MicroGit」は Git 商標ポリシーの禁止形（Git を音節として含む造語）に当たりうると指摘されていた。**「verEve」は "Git" を含まないので、この論点は解消する**（理由の根拠は同診断の L-11。実際の SFC への照会は不要になる）。

## 1. 名称の衝突調査（2026-10-26。実行環境から調べられた範囲）

調べ方: Web 検索と、各レジストリの公開 API への問い合わせ。**商標データベース（J-PlatPat、USPTO、EUIPO）は到達できず未検索**。

| 対象 | 結果 | 判定 |
|---|---|---|
| VS Code Marketplace | `vereve` の検索結果 0 件（公開 API の拡張検索） | 空き |
| Open VSX | 完全一致なし（近い名前の `Verde` 等のみ） | 空き |
| npm | `vereve` / `verEve` / `vereve-cli` すべて 404 | 空き |
| PyPI / crates.io / Homebrew | `vereve` すべて 404 | 空き |
| GitHub | リポジトリ・ユーザーの検索は、この実行環境の制限で**確認できず** | 未確認 |
| ドメイン | `vereve.com` は名前解決でき、取得済み。`.dev` `.app` `.net` `.org` は RDAP がリダイレクトを返した（登録の可能性あり、内容未確認）。`.io` `.jp` は RDAP が 404（未登録の可能性。レジストリが RDAP 非対応の場合も 404 になるので**確証なし**） | 要確認 |
| Web 検索 | 「verEve」というソフトウェア・拡張・アプリは見つからなかった | 衝突なし（検索エンジンの範囲） |
| 近い名前 | **Evereve**（米国の婦人服小売。文字列 `evereve` が `vereve` を含む。商品区分が違う）、**VEVER**（宝飾・化粧品・眼鏡の商標）。いずれも別分野 | 低リスク |
| 「Eve」を含む開発者向け製品 | **vercel/eve**（AI エージェントの TypeScript フレームワーク。Apache-2.0）、**pyeve/eve**（Python の REST フレームワーク）。ともに開発者向けで、利用者が重なる | 注意（検索・口頭で「Eve」と略さない） |
| 「EVE」の商標 | **EVE（EVE Online）は CCP ehf. の著名な商標**（米国で 27 件の出願のうち EVE を含み、区分 9 が最多という第三者ディレクトリの記載）。`verEve` は語頭に `ver` が付く別語だが、**語尾の "Eve" が強い印象を与えるため、区分 9・42 での類似は専門家の確認が要る** | 要確認 |

【未確認】: 日本の特許庁（J-PlatPat）での「VEREVE」「ヴェルイヴ」「ベルイブ」等の称呼・外観の類似調査。区分は 9（ダウンロード可能なソフトウェア）・42（ソフトウェアの提供・開発）。出願するかは運営者判断（`open-issues.md` D3 の商標方針と同じ段階）。

## 2. 推奨

- **採用してよい**: 名前の空きは広く確保でき、"Git" 由来の商標論点も消える。
- 公開（Marketplace へ出す）前に、**J-PlatPat で称呼・外観を検索**（`VEREVE`、`ヴェルイヴ`、`ヴェレヴ`、`ベルイブ`）。区分 9・42。「EVE」を含む既存商標との類似は、弁理士か特許庁の無料相談で確認すると確実。
- 略称として「Eve」を単独で使わない（vercel/eve・pyeve・EVE Online と衝突する）。表記は **`verEve`**、拡張 ID は小文字の **`vereve`**。
- 由来の説明（versioning everything）を README の冒頭に一文置く（"ver"+"Eve" の切れ目が読みにくいため）。

## 3. 改名の影響範囲（リポジトリの現状）

`package.json`: `name=microgit`、`displayName=MicroGit`、`publisher=usudonsdev`、バージョン 5.2.0。コマンド 10、設定 8。リポジトリ全体で「microgit」を含むファイルは 138、出現は約 1,600 箇所。

| 区分 | 現状 | 改名での扱い（案） |
|---|---|---|
| **拡張 ID** | `usudonsdev.microgit`。Marketplace では**拡張 ID は変更できない** | **新しい拡張として出し直す**（`usudonsdev.vereve`）。旧 `microgit` は「非推奨（deprecated）」にして移行先を案内。インストール 7 の今が最も安い（診断 L-11 と同じ判断） |
| 表示名・説明・アイコン | `MicroGit`、`media/microgit.svg` | 全面置換。アイコンのファイル名も |
| コマンド ID | `microgit.toggle` `microgit.showGraph` `microgit.publishMicroHistory` ほか 10 | `vereve.*` に変更。利用者の `keybindings.json` に旧 ID があると効かなくなる → リリースノートで案内 |
| 設定キー | `microgit.showSaveStatus` `microgit.useOverlayCheckout` `microgit.overlayBackend` `microgit.kernel.qemuPath` ほか 8 | `vereve.*` に変更。**旧キーからの読み替え（移行）を一度だけ実装**（旧キーが設定されていたら新キーへコピーして通知） |
| ビューコンテナ・ビュー ID | `microgit`、`microgit.sidebar` | `vereve` / `vereve.sidebar` |
| **履歴データ（refs）** | **`refs/microgit/*`**（シャドウリポジトリ内、利用者が `Publish` で origin に送る） | **名前を変えない**ことを推奨。変えると既存の履歴が読めなくなり、旧版との互換が切れる。内部の参照名は互換のため据え置き、将来のデータ移行（新旧両方を読む）を別途設計。UI の文言にだけ verEve を使う |
| シャドウリポジトリ等の保存場所 | `.microgit` 系（`src/shadowStore.ts` ほか） | 同上。保存場所は据え置き、または**旧→新の移行処理**を入れる（設計判断。`docs/design-policy.md` に決定を書く） |
| 同梱バイナリ | macOS の `microgit-vm`（Swift）、Linux の agent、ゲストイメージ | ファイル名を `vereve-vm` へ。`THIRD_PARTY_NOTICES.md`、`scripts/package-vsix.mjs`、`mac/build.sh`、`docs/release.md` のパスも |
| GitHub リポジトリ | `usudonsdev/microgit` | リネーム（旧 URL は自動でリダイレクト）。PR #82 などの進行中 PR は影響なし |
| 文書・論文 | `docs/` に 30 以上（`how-microgit-works.md` 等のファイル名も）、`docs/paper/`、`docs/learning/` | 本文の置換。**論文・学習記事は書いた時点の名称の記録なので、必要箇所だけ「旧称 MicroGit」を併記し、全置換はしない**。`CLAUDE.md` / `AGENTS.md` / `.cursor/rules/` も更新 |
| Open VSX | 同じ拡張 | 新しい namespace/名前で出し直し、旧を非推奨に |
| テスト・CI | `microgit` を含む識別子 | 置換。`npm run compile` `lint` `test:unit` を通す |

## 4. 手順案（実装するとき）

1. J-PlatPat で称呼の検索（運営者）。結果に問題なければ進める。
2. ブランチを切る（`feature/rename-vereve`）。**機械的な置換を、1 コミット 1 区分**で（拡張メタデータ → コマンド/設定キー → 文言 → 同梱バイナリ名 → 文書）。
3. **移行処理**: 旧設定キー→新、`keybindings` の案内、旧保存場所の読み取り（互換）を実装し、単体テストを足す。
4. `refs/microgit/*` は据え置く方針を `docs/design-policy.md` に理由付きで書く（却下案: 全面改名 = 既存履歴との互換が切れる）。
5. Marketplace と Open VSX に新拡張として公開し、旧拡張を非推奨にして移行先を案内（公開は運営者の Mac での手作業。`docs/release.md`。**Marketplace の PAT 廃止（2026-12-01）に伴う Entra ID 認証への移行が先**）。
6. GitHub リポジトリ名を変更し、`package.json` の `repository` を更新。
7. portfolio_hub 側（LP、`/legal/`、運営者情報、`docs/handoff/20-sites/microgit.md`、`open-items.md` の O-37）の表記を更新。

## 5. 未決（運営者の判断）

- ~~`refs/microgit/*` と保存場所を据え置くか~~ → **据え置きで実装した**（2026-10-26。理由と却下案は design-policy §2.5）。将来の「新旧両方を読む」移行は未設計。
- 旧拡張をいつ非推奨にするか（新版が公開されて動作確認できた後）。
- 商標を出願するか（区分 9・42）。診断 L-15 の方針（有料 20〜30 人で確認）に従うなら、出願は後。

## 6. 実装の進捗（2026-10-26）

手順案（§4）のうち、リポジトリ内で済むものを実装した。区分ごとに別コミット（`npm run compile`・`lint`・`test:unit` は各コミットのあとに通した）。

| # | 区分 | コミット | 状態 |
|---|---|---|---|
| 1 | 拡張メタデータ（name `vereve`・displayName `verEve`・version 6.0.0）、ビューコンテナ/ビュー/アイコン（`git mv`）、VSIX 出力名、CI の説明文 | d539b21 | 済み |
| 2 | コマンド ID 10 個と内部コマンド（`vereve.*`）、タイトル「verEve: …」 | e336179 | 済み |
| 3 | 設定キー 8 個と状態キー、旧設定の一度きりの引き継ぎ（`src/settingsMigration.ts`、テスト付き） | 5b673d0 | 済み |
| 4 | 旧拡張との共存対策（`src/legacyExtension.ts`、テスト付き） | 330eb68 | 済み |
| 5 | 画面の文言・ログ・通知・クラス名、据え置く名前のコメント、`package.json` とコードの一致検査（`manifestConsistency.test.ts`） | da0738a | 済み |
| 6 | 文書（README・README-marketplace・CHANGELOG 6.0.0・design-policy §2.5・CLAUDE.md/AGENTS.md・THIRD_PARTY_NOTICES・旧称の注記） | この変更 | 済み |

**据え置いたもの**（`refs/microgit/*`、`.microgit/` 系の保存場所、同梱バイナリ・ゲストのファイル名と参照するスクリプト、コミットの作者、`MICROGIT_TEST_*`、CI の成果物名）は design-policy §2.5 の表に理由つきで書いた。

**文書で置換しなかったもの**（書いた時点の記録）：`docs/paper/`、`docs/learning/`、`docs/adr/`、`articles/`、`books/`、`markdowns/`、卒業研究の文書（`build-verification-engine*.md`）、`mac-handoff.md`・`research-status.md`・`work-record-*`・`save-bottleneck-investigation.md`・`mac-kernel-measurement-instructions.md`・`v1.0.md`・`zenn.md`、本書、CHANGELOG の 5.2.0 以前。冒頭に旧称の注記を足したのは `design-rationale.md`・`why-save-is-fast.md`・`perceptible-delay.md`・`release.md`・`microgit-kernel-feature-portability-*.md`・`kernel-portability-walkthrough.md`・`guest-phase1.md`・`overlayfs-*.md`。ファイル名（`how-microgit-works.md` など）は変えていない（リンク切れを作らないため）。

**確かめたこと**：`vsce package --no-dependencies --readme-path README-marketplace.md` が通り、マニフェストは `Id="vereve"` `DisplayName=verEve` `Version=6.0.0`、含まれるファイルは `media/vereve.svg` と `out/**` で、`scripts/package-vsix.mjs` の「入ってよいものの一覧」にも合う。`package-vsix.mjs` 自体は、CI の成果物（ゲストイメージ・QEMU・Mac のヘルパー）が要るので実行していない。

**未実施（範囲外）**：リリース作業と公開（`vsce publish`・Open VSX）、旧拡張の非推奨化、GitHub リポジトリ名の変更（`package.json` の `repository` は旧 URL のまま）、商標の調査（J-PlatPat。§1・§2）、アイコンの再デザイン、portfolio_hub 側（LP・`/legal/`・`docs/handoff/20-sites/microgit.md`・`open-items.md` の O-37）、同梱バイナリ名の改名（Mac の実機検証が先）、`refs/microgit/*` の新旧両対応の移行設計。

## 7. 実機（VS Code）で確かめる項目

単体テストでは確かめられない。VSIX を入れた VS Code（Cursor でも）で見る。

1. **旧キーの読み取り**：旧拡張を入れていない状態で、ユーザーの `settings.json` に `"microgit.overlayBackend": "nodejs"` を書き、verEve を起動する。`vscode.workspace.getConfiguration().inspect('microgit.overlayBackend')` が未登録キーでも `globalValue` を返す前提で作った。返らなければ `inspect` ではなく設定ファイルの直接読み取りに変える必要がある。
2. **引き継ぎの結果**：1. のあと `vereve.overlayBackend` が `nodejs` になり、通知が一度だけ出て、再起動しても出ない。`vereve.*` を先に手で書いてあれば上書きされない。ワークスペースの `.vscode/settings.json` の旧キーも、ワークスペースを開いたときに引き継がれる。
3. **共存対策**：旧 `usudonsdev.microgit` を有効にしたまま verEve を入れる。警告が出て、ステータスバーが警告色（`verEve: 旧 MicroGit と衝突`）になり、`verEve: Toggle` で有効にできず、保存しても `.microgit/` が増えない。旧拡張を無効化して再読み込みすると普通に動く。`getExtension` が無効化済みの拡張を返さない前提。
4. **旧拡張なしの通常動作**：`verEve: Enable` → 保存 → サイドバー（Activity Bar の verEve）に履歴 → 過去へジャンプ → グラフ。コマンドパレットのタイトルが「verEve: …」で、実行できる（`command not found` が出ない）。
5. **既存の履歴の継続**：旧 MicroGit で記録した `.microgit/` と `.git/microgit/repos/` のあるフォルダを、verEve で開いて有効にし、既存の履歴が見えて、続きが記録される。`Fetch`/`Publish` が `refs/microgit/*` で動く。
6. **keybindings**：`keybindings.json` の旧 ID `microgit.toggle` は効かない（README の手順どおり直す）。
7. **VSIX**：`npx vsce package` の VSIX を `code --install-extension` で入れ、拡張フォルダ名が `usudonsdev.vereve-6.0.0`、Activity Bar のアイコンが出る。CI の `package.yml`（5 環境の検証。`runTest.ts` が `usudonsdev.vereve-` を探す）が通る。
8. **出力チャンネル名**：`verEve Output`。
