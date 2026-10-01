# Change Log

All notable changes to the "MicroGit" extension will be documented in this file.

## [Unreleased]

## [5.0.0] - 未公開（Marketplace に出した日を入れる）

### Added
- **プラットフォーム別の VSIX**（#19）。Windows x64 用には同梱の QEMU と最小の Linux、Linux x64 / arm64 用には agent、Apple silicon Mac 用には `microgit-vm` と arm64 の最小 Linux が入る。それ以外（Intel Mac、Windows on Arm など）には Node.js 版だけの universal が配られる
- `THIRD_PARTY_NOTICES.md`：同梱している第三者のソフトウェア（Linux カーネル、QEMU、SeaBIOS、GLib などの DLL、Go のランタイム）とライセンス、ソースの置き場所
- 同梱の agent に実行ビットが無ければ、起動の前に付ける（付けられなければ Node.js 版で動く）
- **保存の記録を、Git のコマンドを起動せずに拡張機能の中で書く**（#32、設定 `microgit.fastMicroCommit`、既定で有効）。Git の保存形式はそのままで、ふつうの Git で履歴を読める。使えない設定のリポジトリ（sha256、reftable、コミットの署名など）では自動で Git のコマンドを使う
- `MicroGit: Overlay Status` に、保存 1 回の処理の段階ごとの時間（直近 200 回の p50・p95）と、記録に使ったもの（fast / git）を表示（#32、#37）

### Fixed
- ファイルを同じ名前のディレクトリに置き換えた時点（またはその逆）へ過去に戻ると、ワークスペースへの反映が例外で止まる不具合を修正（N-7。反映の順番を「消す → 書く」にした）
- 日本語など ASCII 以外の名前のファイルが、Git の既定設定（`core.quotepath=true`）の環境で Overlay のレイヤに入らず、過去に戻っても中身が復元されない不具合を修正（#21 の N-6）
- ファイルを同じ名前のディレクトリに置き換えて保存すると、レイヤの書き出しが例外で止まり、壊れたファイルが残る不具合を修正（N-3）
- ディレクトリを同じ名前のファイルに置き換えると、保存時・過去に戻る時に例外になる不具合を修正（N-4）
- `.wh.` で始まる名前のファイルが Overlay のビューから消える不具合を修正（N-5）
- 1 MiB を超えるファイルが Overlay のレイヤに入らない不具合を修正（`git show` の出力が execFileSync の既定の上限を超えていた）
- **Windows で過去に戻ると、CRLF のファイルが LF に変わる不具合を修正**（ADR-0012）。Windows 版 Git の既定（`core.autocrlf=true`）でマイクロ履歴に LF で記録されていた。マイクロ履歴は保存した中身をそのまま記録するようにした。この変更より前の記録は LF のまま
- **保存の記録が、履歴が長くなるほど遅くなる不具合を修正**（#32）。保存のたびに履歴全体を読み、過去のコミットごとに Git を起動していた（Windows で履歴 1,000 回のとき 1 回 2.4 秒）

### Added
- **カーネルの OverlayFS を使う Overlay バックエンド**（#14、docs/kernel-backend.md）。Linux は仮想マシンなし（`unshare -Urm`、カーネル 5.11 以降）、Windows は同梱の QEMU と最小の Linux、Apple silicon Mac は Virtualization.framework。使えない環境では自動で Node.js 版に切り替わる。過去に戻る操作が Linux で約 6 倍、Windows で約 8 倍速い（中央値、ファイル 200 の合成の履歴）
- macOS の virtio-console で約64 KiBを超えるJSON 1行が停止する実機挙動に対応。中身は24 KiBずつ `stage` / `readChunk`、多数のパスは`stageOp`に分け、3 MiBと700ファイルを含む15シナリオ・126回の過去移動、VS Code内の保存・復元を確認
- 設定 `microgit.overlayBackend`（`auto` が既定 / `kernel` / `nodejs`）、`microgit.kernel.qemuPath`・`microgit.kernel.accel`・`microgit.kernel.memoryMb`
- `MicroGit: Overlay Status` に、使っているバックエンド、起動にかかった時間、層の数、最後に戻ったときの時間の内訳を表示
- 設定 `microgit.durability`（`power` が既定）。マイクロ履歴の Git のオブジェクトと ref を fsync し、電源断や OS の異常終了でも記録済みの履歴を失わないようにする。`process` で従来どおり（Git の既定）に戻せる（#11、docs/adr/0002-durability.md）

### Changed
- **既定の永続性（`microgit.durability=power`）での記録を、fsync 1 回で確定させる**（#38、ADR-0014）。保存 1 回の記録をジャーナル（`<shadow の Git のディレクトリ>/microgit-journal/`）に追記して fsync し、Git のファイルは確定を待たずに書く。停電などのあとは、次に shadow を開いたときにジャーナルから作り直す。保存 1 回の fsync は 7 → 1 回。記録は CI の Windows で 70.4 → 20.6 ms、macOS で 19.0 → 12.3 ms、Ubuntu で約半分
- **保存 1 回の処理を短くした**（#37、#41）。画面の更新とログは保存が落ち着いてから 1 回だけ行う。カーネル版の層は、記録で分かっている変化から Git を起動せずに作る。Node.js 版は、保存のたびに過去の姿のビューを作り直さない。保存 1 回の処理全体は、手元の Windows（カーネル版）で 405 → 57 ms、Linux（カーネル版）で 12〜17 ms、Node.js 版で 512 → 18 ms（Ubuntu）
- Overlay のレイヤ形式を v2 にした。whiteout を層の中の `.wh.*` ファイルではなく、層の外のメタデータ（`layers/<hash>.json`）に持つ。古い形式のキャッシュ（`.microgit_overlay/layers`・`views`・`write`）は初回に自動で捨てて作り直す。履歴（shadow の Git）は変わらない

- `MicroGit: Fetch Micro History` が、ローカルの未 publish なマイクロ履歴を警告なしに上書き消去しうる欠陥を修正
- `importFromParentRefs` は incoming を一時 ref で受けてから祖先判定し、fast-forward のときだけ tip を前進。発散時は tip に触れず新規 `mb-N` タグとして分岐追加するのみ（マージはしない方針、`docs/design-policy.md` §4.1）

## [4.0.0] - 2026-07-26

### Added
- マイクロコミットに `Main-Head: <sha>` trailer（保存時点のメイン HEAD）
- コントロールパネル／グラフの **メインコミット区間フィルタ**（例: `A → B` / `B → いまの作業`）
- フィルタなし（すべて）でブランチ全体を表示（AI / PR レビュー向けの一本表示と両立）

### Changed
- グラフ log 取得を body 対応（NUL 区切り）にし、Main-Head を UI に渡す

### Notes
- 既存マイクロコミットに trailer が無いものは「未分類」区間に表示
- メインの amend / rebase で sha が変わると区間ラベルがずれる場合あり（既知の制限）

## [3.7.0] - 2026-07-26

### Added
- メインブランチごとに専属のマイクロ空間（切替時に退避／復元）
- 共有形式 α: `.git/microgit/repos/<branch>.git`（bare）+ gitfile。親の `refs/microgit/<branch>/*` へ publish
- コマンド `MicroGit: Publish Micro History` / `MicroGit: Fetch Micro History`
- 設計方針 `docs/design-policy.md`（A+Overlay+α、Cherry-pick / PR レビューは将来）
- 速度ベンチ `npm run bench`（`scripts/speed-bench.mjs`）

### Changed
- 単一「対象ブランチ」ロックを廃止。有効化はワークスペース単位、記録は現在ブランチの空間へ
- 作業ツリーへのネスト `.git` をやめ、通常の `git add` で gitlink 化しない

### Fixed
- 保存ジョブ実行時にブランチ／有効状態を再確認し、切替後の誤記録を防止

## [3.6.1] - 2026-07-26

### Fixed
- 保存ジョブ発行時にファイル内容をスナップショットし、実行時のディスク変化・ジャンプ後状態の影響を受けないようにした

### Changed
- 同一パス・同一内容の連続保存ジョブを省略し、連続保存時のキュー膨張を抑制

## [3.6.0] - 2026-07-26

### Added
- OverlayGit 型「空間で時間を買う」: `views/<hash>/` に完全展開ビューを永続化
- 保存時に親ビュー + 差分レイヤで O(変更) 展開、再訪問・分岐切替はキャッシュヒット
- workspace 同期で内容同一ファイルをスキップ

### Changed
- checkout がフル再マージではなく展開ビュー利用を既定に

## [3.5.0] - 2026-07-26

### Added
- Node.js ユーザー空間 Overlay エンジン（OverlayFS 意味論: レイヤ上書き + `.wh.*` whiteout）
- コマンド `MicroGit: Overlay Status`
- スモーク `scripts/overlay-smoke.sh`（OS mount / Docker 不要）
- ドキュメント `docs/NodeOverlay.md`

### Changed
- checkout を OS 非依存の Node 経路に一本化（kernel OverlayFS / fuse-overlayfs は使わない）
- 設定 `microgit.overlayBackend` を廃止

## [3.4.1] - 2026-07-26

### Changed
- `mb-*` は各マイクロブランチの**先端のみ**に付与（タグ数 = ブランチ数）。同一ブランチ上の前進は tip を移動
- 同一内容の再保存は新規コミットせず HEAD のみ復帰
- 通常 git への Agent 自動コミット hook を廃止（記録はマイクロ履歴のみ）

### Fixed
- 非ホバー表示: 先端は `mb-N (…)`, 途中ノードは短縮ハッシュ

## [3.4.0] - 2026-07-26

### Added
- Cursor Agent / Tab 編集を検知し、マイクロ履歴に `[AI]` 付きで記録
- サイドバー・グラフの非ホバー表示: `[AI] (更新内容)` / `mb-N (更新内容)`
- Agent 編集検知用の afterFileEdit hook（`.cursor/hooks`）

## [3.3.0] - 2026-07-25

### Added
- Stage 1a Overlay checkout（ユーザー空間マージ）: `.microgit_overlay` にレイヤを書き出し、分岐パスだけを materialize して兄弟ブランチのファイル干渉を防ぐ
- 設定 `microgit.useOverlayCheckout`（デフォルト on）。オフで従来の git show 同期に戻せる
- 過去状態検知を拡張: 全体 tree 一致に加え、保存ファイルの blob 一致でも HEAD を巻き戻す（Ctrl+Z / 手編集戻し）

### Changed
- タイムライングラフ: レーン間隔を広げ、ラベルを右外側の共通列に配置して文字被りを解消
- サイドバー / グラフの表示をコンパクト化し、ホバーで詳細を表示

## [3.2.0] - 2026-07-04

### Added
- Activity Bar の専用コントロールパネル（オンオフ、ジャンプ、履歴一覧）
- サイドバー / グラフのリアルタイム更新
- 対象ブランチ以外への切替時にシャドウを退避し、復帰時に復元する仕組み
- オン / オフ切り替えと対象ブランチ管理

### Changed
- 現段階のスコープを個人開発と、メインリポジトリのコミット経由でのマイクロ履歴共有に限定
- チーム間の直接同期（Pull / Push）は将来予定とし、現行機能から削除
- Cursor 互換のため `engines.vscode` を緩和し、起動時にステータスバーを表示

### Fixed
- シャドウリポジトリ未初期化時に記録できない問題
- タイムトラベル後の detached HEAD による記録不安定を解消
- 記録成功 / 失敗のフィードバックを追加

## [3.1.0]

- オンオフ切替とブランチ単位のシャドウ管理を追加

## [3.0.0]

- 初期の公開ライン向け機能一式
