# MicroGit 5 の公開の手順と、同梱する部品の扱い

| 項目 | 内容 |
|---|---|
| 関係する Issue | #19（MicroGit の内部機能として Marketplace に公開する） |
| 版 | 初版（2026-09-26）。公開はまだしていない |
| 仕組み | [.github/workflows/package.yml](../.github/workflows/package.yml)、[scripts/package-vsix.mjs](../scripts/package-vsix.mjs)、[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| 学習用 | [learning/10-packaging-and-licenses.md](./learning/10-packaging-and-licenses.md) |

---

## 1. 配るもの

プラットフォーム別の VSIX（`vsce package --target`）を 5 つ作る。Marketplace は、VS Code を動かしている環境に合う VSIX を配り、合うものが無い環境には `--target` を付けずに作った VSIX（universal）を配る（vsce の文書「Platform-specific extensions」）。

| VSIX | 入っている部品 | 大きさ（5.0.0、CI の run 36250700521） | 配られる環境 |
|---|---|---|---|
| win32-x64 | 同梱の QEMU（#18）、x86_64 の最小ゲスト（カーネル＋agent） | 9,444,940 バイト | Windows x64 |
| linux-x64 | x86_64 の agent | 1,429,604 バイト | Linux x64 |
| linux-arm64 | arm64 の agent | 1,303,331 バイト | Linux arm64 |
| darwin-arm64 | `microgit-vm`、arm64 の最小ゲスト | 3,138,730 バイト（CI run 36690904344） | Apple silicon Mac |
| universal | 無し（Node.js 版だけ） | 82,916 バイト | Intel Mac、Windows on Arm、Linux armhf、Alpine など |

- **macOS**：Apple silicon実機（macOS 26.5.1）でVirtualization.framework、ad-hoc署名、12シナリオのゴールデンテスト、3 MiBと700ファイルを含む15シナリオ・126回の差分テスト、VS Code内の保存・復元まで確認した。配布するdarwin-arm64 VSIXそのものでのkernel経路の確認は、CIでは代わりにならないので実機で行う（§2 の公開条件）
- **Alpine（musl）**：agent は静的リンクなので動く見込みだが、確かめていない。今は universal が配られる
- 中身の確認：`package-vsix.mjs` は、できた VSIX の中身を「入ってよいものの一覧」と照らし、同梱の部品を除いた中身が 1 MB を超えたら止める。最初は「入っていてはいけないもの」の一覧で確かめていて、CI で成果物を落としたフォルダ（`artifacts/`、GCC のソース RPM など）が VSIX に入り、142〜150 MB になったのを見逃した
- 実行ビット：VSIX は Linux で作る（Windows で作ると実行ビットが落ちる）。拡張機能も、起動の前に実行ビットを確かめて無ければ付ける（`src/kernel/executable.ts`）

## 2. どう確かめているか

`package.yml` は、ゲスト（guest.yml）と QEMU（qemu-windows.yml）を同じ実行の中でビルド・テストし、VSIX を作ってから、次の 5 つの環境で **VS Code の CLI（`--install-extension`）で入れた拡張機能** に対して拡張機能テストを流す。

| 環境 | VSIX | 期待するバックエンド | 確かめること |
|---|---|---|---|
| windows-latest | win32-x64 | kernel | 同梱の QEMU とゲストで動く |
| ubuntu-22.04 | linux-x64 | kernel | 同梱の agent が実行ビット付きで入り、`unshare -Urm` で動く |
| ubuntu-24.04 | linux-x64 | nodejs | 非特権のユーザー名前空間が止められた環境で、公開版でも Node.js 版になる（NFR-5、補足 S-3） |
| ubuntu-24.04-arm | linux-arm64 | kernel | arm64 の agent（止めている設定を外して試す） |
| macos-14 | darwin-arm64 | nodejs | GitHub-hosted runner は Apple silicon でも Virtualization.framework を使えないため、同梱物・インストール・3 MiBの保存と復元・Node.js版への安全なフォールバックを確認 |

Macのkernel経路はCIでは代替できない。実際に `macos-14` runnerで起動すると
`Virtualization is not available on this hardware`（VZErrorDomain Code=2）になることを
run 36388874335（2026-09-28）で確認した。したがって、CIはdarwin-arm64 VSIXの
フォールバックまでを毎回確認し、kernel経路はApple silicon実機で同じVSIXを入れて
`active=kernel`、agent 1.1.0、成功した `lastCheckout` を確認する。CI run 36690904344 の
darwin-arm64 VSIX は2026-09-30に実機でこの条件を満たした（§2.1）。

**公開条件：設計で規定したすべての OS（FR-5 の Linux・Apple silicon macOS・Windows x64）で、OverlayFS の本実装（kernel）が成功すること。**
Node.js 版へのフォールバックが通っても、その OS の条件を満たしたことにはならない（ubuntu-24.04 と macos-14 の `expect: nodejs` は、フォールバックが壊れていないことの確認）。

| 設計で規定した OS | kernel の成功をどこで確かめるか |
|---|---|
| Windows x64 | package.yml の windows-latest（`expect: kernel`） |
| Linux x64 | package.yml の ubuntu-22.04（`expect: kernel`） |
| Linux arm64 | package.yml の ubuntu-24.04-arm（`expect: kernel`） |
| Apple silicon macOS | Apple silicon 実機に、公開する darwin-arm64 VSIX そのものを入れて `active=kernel` と成功した `lastCheckout` を確かめる |

どれか 1 つでも kernel で成功していなければ公開しない。

### 2.1 Apple silicon 実機での確認の記録

#### 2026-09-30：合格（4 / 4 通過）

| 項目 | 内容 |
|---|---|
| 機械 | Apple M5、macOS 26.5.1 |
| VSIX | CI run 36690904344 の成果物 `microgit-5.0.0-darwin-arm64.vsix`（3,138,730 バイト、sha256 `4e95023f2839e36867e29bb148b4e73ce27c58e9482e79537a60aed154676207`） |
| 手順 | `MICROGIT_TEST_VSIX=<VSIX> MICROGIT_TEST_EXPECT_BACKEND=kernel node out/test/runTest.js`（VS Code 1.139.1） |
| 結果 | 保存・過去に戻る、日本語の名前、3 MiB、Overlay Status の4テストがすべて通過 |
| Overlay Status | `active=kernel`、`backend=kernel (vz)`、`agent=1.1.0` protocol=1 kernel=6.18.53、boot=632ms、`commitsRecorded=3`、`layers(host view)=4`、成功した `lastCheckout` あり |

同日に不合格だった3,044,482バイトの手元候補は、9/26に作ったagent 1.0.0入りの
古い `Image` を使っていた。リポジトリからの開発テストだけは外付けinitramfsの
agent 1.1.0を使うため、この混在を見逃した。公開判定では手元で組み合わせた候補を
使わず、同じCI実行でゲストから作り直したVSIX成果物そのものを実機試験する。

#### 2026-10-02：5.0.0 の公開では、Mac 用の VSIX の実機での再確認を省いた（利用者の判断）

公開する Mac 用の VSIX（v5.0.0 のタグの package.yml の成果物）は、上の合格した VSIX（run 36690904344）のあとにコードが変わっているので、公開条件どおりなら実機で確かめ直す必要があった。この PC には Apple silicon の実機が無い。

同梱の部品（`extension/resources/` の 6 ファイル）を、合格した VSIX と run 36904193252 の VSIX で比べた。違ったのはゲストの `arm64/Image` だけで、違うバイトは 3 か所、合わせて 116 バイトだった。

| 場所 | バイト数 | 中身 |
|---|---|---|
| カーネルの GNU build-id | 20 | 中身から計算される値。下の 2 つが変わると変わる |
| initramfs の中の agent（2 か所） | 48 × 2 | Go が自動で埋め込むビルドの情報 `vcs.revision`（コミット番号）と `vcs.time`。agent のソース・Go の版・カーネルの設定は変わっていない |

つまり、Mac で仮想マシンを動かす部品は、実機で合格したものと実質同じ。変わったのは拡張機能の JavaScript（保存の記録・ジャーナルなど）で、これは CI の macos-14（Node.js 版）と、ほかの 3 つの OS のカーネル版で確かめている。利用者が「このまま公開する」を選んだ（2026-10-02）。

次の版からは、ビルドの情報の埋め込みを止める（`go build -buildvcs=false`）と、ソースが同じなら Image も同じバイト列になり、実機で確かめた VSIX との比較が簡単になる（#52 で検討）。

手元（Windows 11）でも、`MICROGIT_TEST_VSIX=<VSIX> MICROGIT_TEST_EXPECT_BACKEND=kernel node out/test/runTest.js` で同じことができる。

## 3. 公開の手順

**公開（Marketplace への `vsce publish`）と、`feature/kernel-portability` から `master` へのマージは、元に戻せない（Marketplace の版は取り消しても同じ版番号を使い直せない）。利用者が §4 を決めてから行う。**

1. `feature/kernel-portability` を `master` にマージする（PR を作り、CI がすべて通ることを確かめる）
2. `master` で `v5.0.0` のタグを打って push する → `package.yml` が走り、VSIX の作成と 5 つの環境での確認のあと、GitHub Release の **下書き** を作る（VSIX、`vsix.json`、`third-party-sources-v5.0.0.tar`）
3. 下書きの VSIX を手元の VS Code に入れて、`MicroGit: Overlay Status` で `active=kernel` と `lastCheckout:` を確かめる（Windows・Linux・Apple silicon Mac）
4. Marketplace に公開する。プラットフォームごとに VSIX を渡す：
   ```
   npx vsce publish --packagePath microgit-5.0.0-win32-x64.vsix microgit-5.0.0-linux-x64.vsix microgit-5.0.0-linux-arm64.vsix microgit-5.0.0-darwin-arm64.vsix microgit-5.0.0-universal.vsix
   ```
   （発行者 `usudonsdev` の Personal Access Token が要る。CI からの自動公開は、トークンを Secrets に置く判断が要るので、今は手で行う）
5. GitHub Release の下書きを公開する（GPL・LGPL の部品のソースを誰でも取れるようにする。§5）
6. `CHANGELOG.md` の `[5.0.0]` に公開日を入れる

### 3.1 5.0.0 の公開の記録

| 日付 | できごと |
|---|---|
| 2026-10-02 | `master` に統合（#51、#53）。`v5.0.0` のタグで package.yml（run 36944669077）が 5 つの環境の確認を通り、リリースの下書きを作った |
| 2026-10-02 | **Open VSX に公開**（`ovsx publish`、5 つの VSIX）。Open VSX から配られる VSIX のハッシュが、`vsix.json` と一致することを確かめた。GitHub Release `v5.0.0` を公開した（GPL・LGPL の部品のソースを同時に取れるようにするため） |
| 2026-10-02 | VS Code Marketplace は、発行者のトークンの期限切れで未公開（新しいトークン待ち） |
| 2026-10-02 | 利用者が Azure DevOps で新しいトークン（組織は All accessible organizations、範囲は Marketplace の Manage だけ）を作り、`vsce login usudonsdev` で登録した。**VS Code Marketplace に公開**（`vsce publish --packagePath` に GitHub Release `v5.0.0` の 5 つの VSIX を渡した。公開の前に `vsix.json` の sha256 と一致することを確かめた）。Marketplace から配られる 5 つの VSIX（`vspackage?targetPlatform=…`）を展開し、公開したファイルとバイト単位で一致することを確かめた |

**次の版への宿題：Marketplace の認証を Microsoft Entra ID に移す。** Marketplace に公開できるトークン（「All accessible organizations」のグローバルなトークン）は、Azure DevOps で **2026-12-01 に廃止** される。それ以降は `vsce publish --azure-credential`（Microsoft Entra ID）で公開する必要がある（VS Code の文書「Publishing Extensions」）。今回のトークンの期限も 12 月 1 日までにした。次の版を出す前に、手元から `--azure-credential` で公開できるか（Azure CLI でのサインインと、そのアカウントが発行者 `usudonsdev` の一員であること）を確かめる。

途中の失敗も残す。最初のマージが GitHub のエラーで止まったのに気づかず、古い master（4.0.0）に `v5.0.0` のタグを打って push した。数十秒で消し、それによるビルドもリリースも作られていない。その後、Windows の公開前の確認で EPERM の競合（#53）が見つかったため、まだ公開していなかった `v5.0.0` のタグを、直したあとのコミットに付け直した。

### 3.2 5.1.0 の公開の記録

利用者の決定（2026-10-03）：#49 の内容で、マイナーアップデート（5.1.0）として、テストが通ったら公開する。

| 日付 | できごと |
|---|---|
| 2026-10-03 | PR #59 の確認がすべて通った。途中で 2 つ直した：停電の試験の deferred の場面が Linux で失敗（写しの更新時刻を保たなかった。試験の作り方の問題）、Zenn の記事の図（リポジトリ直下の `images/`）が VSIX に入っていた（`.vscodeignore` に足した。公開した 5.0.0 には入っていない） |
| 2026-10-03 | `master` に統合（#59、d32c525）。版が 5.1.0 であることを確かめてから `v5.1.0` のタグを打った |
| 2026-10-03 | タグの package.yml（run 37093632986）の `qemu / test` が、Windows の QEMU の中の Linux が 60 秒以内に起動せず失敗。同じコードは PR の確認で通っていたので、CI の機械の一時的な遅さと判断し、失敗した部分だけ走らせ直して通った。5 つの環境の確認とリリースの下書きの作成まで通過 |
| 2026-10-03 | Mac 用の VSIX の同梱の部品を、実機で合格した VSIX（run 36690904344）と比べた。5.0.0 と同じく、違いはゲストの `arm64/Image` の、Go が埋め込むビルドの情報（`vcs.revision`・`vcs.time`）と、それに伴うカーネルの build-id だけ。実機での確認し直しは、5.0.0 と同じ判断で省いた（#52） |
| 2026-10-03 | **Open VSX に公開**（5 つの VSIX）。Open VSX から配られる 5 つの VSIX が、`vsix.json` のハッシュと一致することを確かめた。GitHub Release `v5.1.0` を公開した |
| 2026-10-03 | VS Code Marketplace は、発行者のトークンの期限切れで未公開（新しいトークン待ち） |

### 3.3 5.1.1 の公開の記録

利用者の決定（2026-10-07）：生成物を `.microgit/` にまとめた変更を、パッチ 5.1.1 として公開する。

| 日付 | できごと |
|---|---|
| 2026-10-07 | `master` に `v5.1.1`（d249d52）のタグを打って push した。package.yml（run 37587464687）が 5 つの環境の確認を通り、GitHub Release の下書きを作った |
| 2026-10-07 | v5.1.0 からのソースの差分は、拡張機能の JavaScript（生成物の置き場所）と試験・文書だけ。`guest/`・`windows/`・`mac/` は変わっていない。darwin-arm64 VSIX の同梱部品を v5.1.0 の VSIX と比べると、違いは `arm64/Image` の 108 バイト（13 か所）だけで、内訳はカーネルの GNU build-id（20 バイト）と、Go が埋め込む `vcs.revision`（d249d52）・`vcs.time`（2 か所）だった。Mac の kernel の実機での確認し直しは、5.1.0 と同じ判断で省いた |
| 2026-10-07 | **VS Code Marketplace に公開**（`vsce publish --packagePath`、5 つの VSIX）。手元に残っていた `vsce login usudonsdev` のトークンで公開できた。5.1.0 は Marketplace に出ていないので、ストア上は 5.0.0 の次が 5.1.1 である（5.1.0 の内容は 5.1.1 に含まれる）。linux-arm64 の 1 回目はギャラリー API のタイムアウトで失敗したので、linux-arm64・darwin-arm64・universal を出し直して通った。公開の前に `vsix.json` の sha256 と一致することを確かめた。Marketplace から取った 5 つの VSIX は gzip されていたので展開し、中身の sha256 が `vsix.json` と一致することを確かめた |
| 2026-10-07 | GitHub Release `v5.1.1` を公開した（下書きをやめた） |
| 2026-10-07 | Open VSX は未公開。この機械には名前空間 `usudonsdev` のトークンが残っていなかった（`ovsx verify-pat` がトークンの入力を求めた）。Open VSX に出ている最新は 5.1.0 のまま。トークンを `ovsx login usudonsdev` で登録すれば、同じ 5 つの VSIX を `ovsx publish --packagePath` で出せる |

## 4. 公開方針（2026-09-28 確定）

| # | 事項 | 決定 |
|---|---|---|
| 1 | Marketplace のリポジトリURL | `https://github.com/usudonsdev/microgit`（2026-10-02、利用者の決定でリポジトリの名前を microgit-test から microgit に変えた。古い URL は GitHub が転送する）。Go の agent のモジュール名（`guest/agent/go.mod`）は、ゲストの部品を作り直さないように古い名前のまま |
| 2 | 著作権者 | `usudonsdev` |
| 3 | O-5：自作のOverlayFS部品 | MicroGit本体と同じMIT。別リポジトリへ分離する時点で再検討 |
| 4 | GPL / LGPLのソース | 各GitHub Releaseに、対応する実行物と同時にソース一式を置く。書面による申し出方式は採らない |
| 5 | Windows / macOS のコード署名 | Windowsは未署名、Macはad-hoc署名。Developer ID / notarizationは行わず、OSに止められた場合はNode.js版へフォールバック |
| 6 | OverlayFS部品の置き場所 | 5.xではMicroGit本体に同梱。Phase 4で分離の必要性を再評価 |

## 5. ライセンスとソース（NFR-7）

- 同梱する部品とライセンスは [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。ライセンスの文書は VSIX の `resources/kernel/licenses/` と `resources/kernel/win32-x64/qemu/licenses/` に入る
- DLL（GLib など）は Fedora 44 の MinGW のパッケージのもの。どの DLL がどのパッケージから来たか、その版・ライセンス・ソース RPM は、ビルドのときに `rpm` に聞いて `packages.tsv` に書く（`windows/qemu/build.sh`）。ソース RPM も同じコンテナで取る（あとで取り直すと版がずれる）
- ソース一式（カーネルと QEMU の tarball、DLL のソース RPM、ビルドの設定と手順、`SHA256SUMS`）は `package.yml` の成果物 `third-party-sources` と、タグのときは GitHub Release の `third-party-sources-<tag>.tar`
- GPLv2 の第 3 節は、実行形式を配るときに、ソースを一緒に渡すか、書面で申し出るかを求める。ダウンロードの場所で配るなら「同じ場所から」ソースを取れるようにすることでもよい。Marketplace（VSIX の置き場所）と GitHub Release（ソースの置き場所）は別の場所なので、厳密さを求めるなら §4 の 4 で書面による申し出を足す

## 6. Windows のセキュリティ機能と、同梱の QEMU

- **SmartScreen**：インターネットから取ってきた印（Mark of the Web）の付いたファイルを、エクスプローラーなどから開くときに確かめる。MicroGit は VS Code が自分で展開した VSIX の中の QEMU を子プロセスとして起動するので、ふつうは出ない（手元の Windows 11 で、VSIX を VS Code の CLI で入れて起動し、警告は出なかった）
- **Smart App Control**（Windows 11）：有効にしていると、クラウドでの評判が無く、有効な署名も無い実行ファイルと DLL を、子プロセスとして起動しても止める。自前でビルドした QEMU は評判が無いので、止められる見込みが高い。MicroGit は QEMU を起動したあと agent の「準備完了」の応答を待つので、止められれば起動の失敗として扱い、Node.js 版に切り替わる（機能は失われない）。避けるには Authenticode のコード署名が要る（§4 の 5）。Smart App Control が有効な PC での確認はしていない
- **ウイルス対策ソフト**：QEMU そのものは広く使われているが、見慣れない場所から仮想マシンを起動する動きを止める製品がありうる。その場合も Node.js 版に切り替わる
- **仮想化機能の有無**：WHPX（Windows ハイパーバイザー プラットフォーム）が無効なら TCG（CPU のエミュレーション）で動く。管理者権限は要らない

## 7. セキュリティの境界（TCG）

QEMU のセキュリティの方針では、TCG（CPU のエミュレーション）で動かす使い方は「仮想化の使い方ではない」とされ、TCG の不具合はセキュリティの不具合として扱われない（ゲストの隔離を当てにしてはいけない）。仮想化の使い方として挙がっているのは KVM や HVF のようなハードウェアの仮想化で、マシンの種類では x86_64 の `q35` がその対象に入っている。

MicroGit では：

- ゲストに入るのは MicroGit が作ったカーネルと agent だけで、外から届くのは **利用者のワークスペースのファイルの名前と中身** だけ。ゲストの OverlayFS はファイルの中身を解釈しない（バイト列として置くだけ）
- ゲストから返ってくるものは、ホストの Boundary Guard が検証してから反映する（ADR-0009）。ゲストが乗っ取られても、ワークスペースに書かれるのは検証を通ったものだけ
- ただし、WHPX が無効で TCG で動いている PC では、「ゲストのカーネルが乗っ取られても QEMU の外には出られない」とは言えない。要件定義書 §7.3 が「ゲストカーネルの更新頻度」を緩められる理由に挙げた「侵害されても VM 内に閉じる」は、TCG では弱まる（要件定義書 §7.5）。心配な利用者は `microgit.kernel.accel` を `whpx` にする（WHPX が使えなければ Node.js 版になる）か、`microgit.overlayBackend` を `nodejs` にする

## 8. 同梱する部品の更新方針（O-6）

| 部品 | 追う系列 | 定期の更新 | 臨時の更新 | 更新の確かめ方 |
|---|---|---|---|---|
| Linux カーネル | kernel.org の長期サポート版（今は 6.18.y） | MicroGit のマイナー版を出すたびに、その系列の最新に上げる | 有効にしている機能（OverlayFS、tmpfs、virtio-console・virtio-pci、agent が使うシステムコール）に関わる脆弱性が出たとき。`CONFIG_NET` を無効にしているので、ネットワークの脆弱性は関係ない | `guest/kernel/version.env` を kernel.org の `sha256sums.asc` の値で更新 → guest.yml（ゴールデンテスト、差分テスト、再現可能なビルド）→ package.yml |
| QEMU | 安定版の最新のパッチ版 | 同上 | `q35`、virtio-serial、WHPX に関わるセキュリティの勧告が出たとき（TCG はセキュリティの対象外、§7） | `windows/qemu/version.env` → qemu-windows.yml → package.yml |
| DLL（GLib など） | Fedora の MinGW のパッケージ | QEMU を作り直すたびに、そのときの最新が入る | GLib などに脆弱性が出たとき、QEMU を作り直す | `packages.tsv` の版を前の版と比べる |
| Go（agent） | Go のサポート中の版（新しい 2 つ） | 同上 | agent が使う標準ライブラリ（os、syscall、encoding/json、bufio など）に関わるセキュリティのリリースが出たとき | `guest/kernel/version.env` の `GO_VERSION` → guest.yml |

- 系列を変えるとき（6.18 から次の長期サポート版へ、など）は、ゴールデンテストをそのカーネルで取り直して、期待値が変わらないことを確かめる（変われば ADR を書く）
- 新しい版が出たかを自動で知らせる仕組み（kernel.org の `releases.json` などを定期的に見て Issue を立てるワークフロー）はまだ無い
