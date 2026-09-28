# Phase 1：最小ゲストと macOS バックエンド

| 項目 | 内容 |
|---|---|
| Issue | #15（最小ゲスト）、#17（macOS バックエンド）、#13（agent の言語）。Epic #8 |
| 版 | 第2版（2026-09-28）：Apple silicon Mac実機のVirtualization.frameworkまで確認 |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) AD-5・AD-7・NFR-3・NFR-4、[ゴールデンテスト](./overlayfs-golden-test.md) |

## 1. 全体の形

```
Mac（ホスト）                                   ゲスト（最小 VM）
node scripts/golden/check-guest.mjs             Linux 6.18.53（virtio のみ・ネットワークなし）
   │ stdin/stdout（1 行 1 JSON）                    │
mac/.build/microgit-vm（Swift）  ── virtio-console ──  /init = Go の agent（PID 1）
   Virtualization.framework        ポート "microgit"      OverlayFS の層を /run/microgit（tmpfs）に積む
```

| 置き場所 | 中身 |
|---|---|
| `guest/agent/` | init 兼 agent（Go、標準ライブラリだけ） |
| `guest/kernel/` | 固定したカーネルのバージョン（`version.env`）と設定（`microgit.config`） |
| `guest/build.sh` | カーネルと agent をビルドし、agent を initramfs として埋め込んだ `Image` 1 ファイルを作る |
| `.github/workflows/guest.yml` | arm64 でビルド → QEMU で起動 → ゴールデンテスト → `Image` を成果物として残す |
| `mac/` | Virtualization.framework で `Image` を起動する `microgit-vm` と、Mac で試す `run-golden.sh` |
| `scripts/golden/check-guest.mjs` | stdin/stdout で agent とつながるコマンドを起動し、12 シナリオを照合して計測する |

## 2. 決めたこと

### 2.1 agent の言語：Go（#13、O-4）

| 観点 | Go | 採らなかった案 |
|---|---|---|
| サイズ | 静的バイナリで 2.3 MB（arm64、`-s -w`） | シェル（busybox）も約 1 MB だが、`mount` などのコマンド群と vsock 用の追加ソフトが要る |
| 設計との整合 | ゲストのユーザーランドが agent 1 ファイルで済む（AD-7） | シェルは AD-7「シェルを入れない」に反し、侵入されたときに使える道具が増える |
| システムコール | `syscall` パッケージだけで mount・uname・reboot が書ける。外部依存なし | Rust はより小さくできるが、学習コストが高い |
| クロスビルド | `GOOS=linux GOARCH=arm64` だけで済む | — |

決定：利用者（2026-09-26）。

### 2.2 init と agent を 1 つにした

AD-7 は「最小 init と agent」としていた。PID 1 の仕事は mount 4 つだけなので、agent に含めて 1 ファイルにした。PID 1 が終わるとカーネルがパニックするため、agent は戻らない作りにしてある（致命的なエラーは電源断にする）。

### 2.3 命令の通り道：virtio-console の名前付きポート（O-3 の仮決め）

補足 S-10 は vsock を第一候補としていたが、初版では virtio-console の名前付きポート `microgit` にした。

- QEMU と Virtualization.framework の両方で同じように作れる。ゲストの agent は `/sys/class/virtio-ports/*/name` で名前から探すので、番号の違い（QEMU は `vport0p1`、Mac は `vport1p0` の見込み）を気にしなくてよい
- 命令は要求 1 つに応答 1 つで、順番どおり返す。多重化が要らないので、S-10 が挙げた「多重化を自前で作る」という virtio-console の欠点が今は効かない
- vsock を使わないので `CONFIG_NET` 自体を無効にできる（S-10 の「IP スタックだけ外す」より一段削れる）

並行して複数の命令を流したくなったら、vsock に切り替えるか、要求 ID で多重化する。O-3 の正式な決定は #17 で行う。

### 2.4 層の置き場所：ゲストの tmpfs（O-2 の仮決め）

upper も lower も `/run/microgit`（tmpfs）に置いている。電源を切ると消えるので、今はゴールデンテストと計測のためだけの置き場所である。ワークスペースとの共有方式と合わせて、O-2 は #17 で決める。

`userxattr` で tmpfs を upper にするには tmpfs の `user.*` xattr（6.6 以降）が要るので、`CONFIG_TMPFS_XATTR` を有効にしている。

### 2.5 命令の形

#12 で v1 に確定した（2026-09-26）。仕様は [agent-protocol.md](./agent-protocol.md)。初版（v0）からの主な変更は、層の名前をホストが決める文字列にした（Git のコミットのハッシュを使うため）、中身を base64 でやりとりする（バイナリのファイル）、`readMany`・`inspect`・`stats` を足した、失敗に種類の記号（`code`）を付けた、の 4 つ。

### 2.6 VM なしのモード

agent を PID 1 以外で起動すると、同じ命令を stdin/stdout で受ける。層は一時ディレクトリに置く。Linux では `unshare -Urm guest/out/<arch>/init` で非特権のまま OverlayFS を使えるので、これが AD-2（Linux ではネイティブ）の経路の原型になる（#14）。

### 2.7 カーネル

| 項目 | 値 | 理由 |
|---|---|---|
| バージョン | 6.18.53（長期サポート版） | 2026-09-26 時点の最新の長期サポート版は 6.18.54 だが、kernel.org の sha256sums にまだ載っていなかったので 1 つ前にした |
| 取得の確認 | `version.env` の sha256 で照合 | sha256sums.asc の PGP 署名はまだ検証していない |
| 設定 | `allnoconfig` に `microgit.config` を重ねる | 頼んだ `=y` が依存関係で落ちたらビルドを止める。`CONFIG_NET=y` になっても止める |
| 起動の形 | initramfs を埋め込んだ `Image` 1 ファイル | VZLinuxBootLoader にカーネルだけ渡せば済む。arm64 は圧縮していない `Image` が要る |
| CPU の種類 | arm64（Apple シリコン）と x86_64（Windows、Intel Mac） | 設定は共通の `microgit.config` に、`microgit-<ARCH>.config` を重ねる。arm64 は汎用 ECAM の PCI ホスト、x86_64 は電源断のための ACPI。x86_64 は `ARCH=x86_64` で make する（`ARCH=x86` の allnoconfig は 32 ビットになる） |
| agent の Go | 1.27.1 に固定（`version.env` の `GO_VERSION`、#15） | `go.mod` の `go 1.24` は言語の最低版で、ビルドに使う版ではない。CI はこの値で setup-go し、違う版なら止める |
| 再現性 | 別の出力先に 2 回ビルドし、`Image` と `init` の sha256 が一致するか CI で確かめる（#15） | NFR-6・NFR-7。固定しているものと、まだ固定していないもの（gcc の版）は [学習用 05](./learning/05-reproducible-builds.md) |

**罠：** `allnoconfig` では FUTEX・EPOLL・EVENTFD が切られていて、Go のランタイムが動かない。`microgit.config` で明示的に有効にしている。

## 3. 結果（2026-09-26）

| 環境 | カーネル | 12 シナリオ | ready まで | commit p50 / p95 | view p50 / p95 |
|---|---|---|---|---|---|
| WSL2、VM なし（`unshare -Urm`、x86_64） | 6.6.87.2-microsoft-standard-WSL2 | 全一致 | 4.2 s ※1 | 7.3 / 9.9 ms | 0.3 / 0.5 ms |
| GitHub Actions、QEMU（TCG、arm64） | 6.18.53 | 全一致 | 0.7 s ※2 | 2.7 / 8.3 ms | 1.7 / 2.8 ms |
| Apple silicon Mac（Virtualization.framework） | 6.18.53 | 全一致 | 0.6 s | 0.13 / 0.30 ms | 0.07 / 0.15 ms |

※1 wsl.exe の起動時間を含む。※2 CPU を丸ごとエミュレーションした状態での値。

大きさ（2026-09-26、#15 で Go を 1.27.1 に固定した後。GitHub Actions の成果物の `sizes.txt`）：

| | x86_64 | arm64 |
|---|---|---|
| Image（カーネル＋initramfs） | 3,593,216（bzImage。もともと圧縮済み） | 7,606,280（圧縮していない Image。VZLinuxBootLoader が要求する） |
| Image を gzip -9 した大きさ（VSIX は zip で圧縮されるので、ダウンロードの大きさはこれに近い） | 3,551,442 | 2,928,616 |
| うち agent（`init`） | 3,059,836 | 2,949,244 |

- Go 1.24 系でビルドしていた初版の arm64 は Image 6,950,920・agent 2,293,908 だった。Go 1.27.1 で agent が約 0.65 MB 大きくなった。サイズを削るなら、まず agent（Go のランタイム）を見る
- どちらもダウンロードの大きさは 3.6 MB 以下で、NFR-3（一桁 MB）に収まる

**再現性（#15）**：CI で、別の出力先にもう 1 回ビルドし、`Image` と `init` の sha256 が一致することを確かめている。2026-09-26 の実行（run 36231791916）で両方の CPU とも一致した。

| | Image の sha256 | init の sha256 |
|---|---|---|
| x86_64 | `7a2a9899…0f40cfe8` | `f275575c…496b66df` |
| arm64 | `1b561b15…ec934e66` | `0e81a2c2…dca58523` |

確定した事実：
- 期待値を記録した 6.6（WSL2）とゲストの 6.18.53 で、12 シナリオのビューに差はなかった
- 下の層にあるディレクトリの rename は `EXDEV` になる（どちらの環境でも `exdevRenames=1`、`rename-dir` シナリオ）。agent は coreutils の `mv` と同じく、コピーして元を消すことで代わりにやっている
- mount オプションは両環境とも `rw,relatime,redirect_dir=nofollow,uuid=on,userxattr`
- GitHub Actions の Ubuntu 24.04 では非特権ユーザー名前空間が使えない（`kernel.apparmor_restrict_unprivileged_userns = 1`、`unshare -Urm` が `uid_map` の書き込みで失敗）。補足 S-3 の指摘どおり。WSL2 のカーネルでは使える
- commit（mount → 書き込み → unmount）は 1 回あたり数 ms。補足 S-5 の見積もりどおりで、保存のたびに行うと FR-4・NFR-2 と衝突しうる。#12 の判断材料

## 4. Mac で試す

```bash
xcode-select --install          # swiftc と codesign（入っていれば不要）
gh auth login                   # 成果物の Image を取ってくるため（初回だけ）
git switch feature/kernel-portability && git pull
mac/run-golden.sh
```

`run-golden.sh` は、起動ツールをビルドして ad-hoc 署名し、GitHub Actions の最新の成功した実行から `Image` を取ってきて、12 シナリオを流す。結果は `guest/out/arm64/guest-result-mac.json`、カーネルのログは `guest/out/arm64/console-mac.log` に残る。

未pushのagent変更を含めてMicroGit本体まで試す場合は、固定版のGoをPATHに置いて次を実行する。
外付けinitramfsは開発用で、公開版では`guest/build.sh`が同じagentをImageへ埋め込む。

```bash
mac/build-dev-initrd.sh
npm run compile
node scripts/test/kernel-backend-e2e.mjs --plan --max-depth 2
MICROGIT_TEST_EXPECT_BACKEND=kernel npm test
```

Mac で確かめたこと（2026-09-28、Apple silicon、macOS 26.5.1）：
- [x] ad-hoc 署名で Virtualization.framework が使える。公開版もad-hoc署名とし、止められた環境ではNode.js版へフォールバック（O-8）
- [x] allnoconfig ベースのカーネルが Virtualization.framework で起動する
- [x] 名前付きポートは `/dev/vport1p0` として見つかる
- [x] 12 シナリオ一致。ready まで約0.6秒、commit p50/p95 0.13/0.30 ms、view 0.07/0.15 ms
- [x] MicroGit本体の差分テスト15シナリオ・126回がGitのツリーと一致（3 MiB、700ファイル、日本語、バイナリ、分岐、キャッシュ再構築を含む）
- [x] VS Code内で保存・過去移動、3 MiBの復元、`active=kernel`、成功した`lastCheckout`を確認

実機で見つかった制限：virtio-consoleは約64 KiBを超えるJSON 1行で停止した。stdioを
Unix domain socketへ替えても同じだったため、O-3はvirtio-consoleのまま、Macだけ
24 KiBずつ`stage` / `readChunk`する方式に決めた。vsockへ全面移行するより変更範囲が小さく、
Linux / Windowsの既存経路には往復回数を増やさない。詳細は
[agent-protocol.md](./agent-protocol.md) §4.1.1。

## 5. まだやっていないこと

| 項目 | Issue |
|---|---|
| upperdir の永続化（現在はゲストのtmpfs。正本はGitなので再起動時に再構築） | 将来、実測で必要になったとき |
| ビルドに使うコンテナイメージの固定（gcc の版まで含めた、時間がたっても同じバイト列） | 未起票（必要になったら） |
