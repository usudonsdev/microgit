# Phase 2：Windows バックエンド（QEMU 同梱）

| 項目 | 内容 |
|---|---|
| Issue | #18（O-1、O-9）。Epic #8 |
| 版 | 第 2 版（2026-09-26、#18）：同梱用の小さい QEMU をクロスビルドし、GitHub の Windows のランナーで確かめた。初版は配布版の QEMU で起動と計測まで |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) NFR-1・NFR-3、[補足](./microgit-kernel-feature-portability-supplement.md) S-1・S-2、[Phase 1](./guest-phase1.md) |

## 1. 決めたこと：QEMU を同梱する（O-1）

決定：利用者（2026-09-26）。Phase 1 と同じ最小ゲスト（x86_64 版）を、同梱した QEMU で起動する。

| 案 | 採否 | 理由 |
|---|---|---|
| **A. QEMU を同梱** | **採用** | VM を自作しなくてよい（C-4）。WHPX が無効でも TCG で動く。Mac と同じゲストを使えるので挙動を揃えやすい（FR-1） |
| B. WSL2 を借りる（`wsl --import`） | 不採用 | WSL2 が入っている PC でしか使えない（NFR-1）。カーネルは Microsoft 製でバージョンを固定できない。ただし実装は簡単なので、将来の高速化オプションとしては残せる |
| C. WHP で VM を自作 | 不採用 | virtio のエミュレーションを含む VMM を自前で書くことになり、個人開発には大きすぎる（補足 S-2） |
| D. LKL（O-9） | 保留 | Windows 対応の保守状況が分からない。A で NFR-1 を満たせる見込みが立ったので、急がない |

### 1.1 補足 S-2 への答え

S-2 は「Windows の VM バックエンドは、仮想化機能（仮想マシン プラットフォーム／ハイパーバイザー プラットフォーム）が有効な PC でしか使えず、NFR-1 と両立しない」と指摘した。QEMU は同じゲストを **TCG（CPU のエミュレーション）でも動かせる**。TCG は仮想化機能も管理者権限も要らない。

#18 で、同梱用にビルドした QEMU を GitHub の Windows のランナーで **TCG だけ** に固定して動かし、起動 1.8 秒、差分テスト（14 シナリオ・123 回の過去に戻る操作）がすべて Git と一致、平均 44〜47 ms だった（WHPX の自動選択では 36〜38 ms。2 回の実行の幅）。仮想化機能が無い PC でも、実用的な速さで動く。

- 仮想化機能が有効な PC：WHPX で速く動く
- 無効な PC：TCG で動く（遅いが、機能は同じ）
- どちらも同じカーネル・同じ agent なので、挙動は同じ

## 2. 仕組み

```
Windows（ホスト）
  node scripts/golden/check-guest.mjs
     │ stdin/stdout（1 行 1 JSON）
  qemu-system-x86_64.exe -M q35 -accel whpx,kernel-irqchip=off -accel tcg ...
     │ virtio-serial：hvc0（ログ）と名前付きポート "microgit"
  最小ゲスト（guest/out/x86_64/Image = bzImage、agent 込み 3.3 MB）
```

- `-accel` を複数並べると、QEMU は前から順に試す。WHPX が使える PC では WHPX が選ばれた（コミット 0.1 ms で判別）
- **先頭が使えないときの切り替え**：WHPX を無効にした PC は用意できず、GitHub の Windows のランナーでも WHPX が使えた（WHPX だけで起動 1,024 ms）。そこで、Windows に存在しない KVM を先頭に置いた `-accel kvm -accel tcg` で、「前から順に試す」仕組みそのものを確かめた。QEMU は `-accel kvm: invalid accelerator kvm` のあと `falling back to tcg` と出して TCG で起動した（`scripts/test/qemu-accel-fallback.mjs`。手元は配布版の QEMU、CI は同梱用のビルドで、CI では 1,878 ms で起動した）。ただしこれは「知らないアクセラレータ」の分岐で、「WHPX の初期化に失敗する」分岐は同じ繰り返しの別の枝で、直接は試していない
- QEMU が stderr に出したこと（`falling back to tcg` など）は、`MicroGit: Overlay Status` の `launcher stderr` に出る
- 命令の通り道は名前付きパイプ（[ADR-0006](./adr/0006-windows-named-pipe.md)）。stdio は遅く、大きなデータで中身が壊れた
- `kernel-irqchip=off` は QEMU の WHPX でよく必要になる設定として付けている。外した場合は試していない
- 試すときは `windows/run-golden.ps1`（`-Accel auto|whpx|tcg`）

**罠：** Windows PowerShell 5.1 は BOM の無い UTF-8 のスクリプトを Shift_JIS として読み、日本語のコメントで構文が壊れる。`.ps1` は BOM 付き UTF-8 で保存する。

### 2.1 x86_64 のカーネル設定

`guest/kernel/microgit-x86_64.config`。共通の設定に次を足す。

- `CONFIG_ACPI=y`：電源断に要る。無いと poweroff が停止になり、QEMU が終わらない
- `ARCH=x86_64` で make する。`ARCH=x86` の allnoconfig だと 32 ビットのカーネルになる

## 3. 結果（2026-09-26、x86_64、Linux 6.18.53、12 シナリオはすべて一致）

| 環境 | ready まで | commit p50 / p95 | view p50 / p95 |
|---|---|---|---|
| Windows 11 Home、QEMU 11.1、**WHPX** | 0.63〜0.71 s | 0.10〜0.12 / 0.25 ms | 0.06〜0.07 / 0.10 ms |
| Windows 11 Home、QEMU 11.1、**TCG** | 1.1〜1.2 s | 1.6〜1.9 / 6.3〜6.5 ms | 1.0〜1.2 / 1.8〜1.9 ms |
| GitHub Actions（Linux）、QEMU（TCG） | 1.3 s | 2.3 ms | 1.4 ms |
| **GitHub Actions（windows-latest）、同梱用の QEMU 11.1.1、WHPX**（#18） | 1.02〜1.14 s | 差分テストの過去に戻る操作 平均 36〜38 ms ※2 | |
| **同上、TCG だけ**（#18） | 1.82〜1.87 s | 同 平均 44〜47 ms ※2 | |
| 参考：WSL2 で VM なし（`unshare -Urm`、層は ext4） | 4.2 s ※ | 7.3 / 9.9 ms | 0.3 / 0.5 ms |

※ wsl.exe の起動時間を含む。※2 ホストから見た 1 回の過去に戻る操作（層の用意・view・Boundary Guard・ワークスペースへの反映）の平均で、上の行のゲストの中の時間とは測っているものが違う。

- WHPX ではコミットが 0.1 ms 程度。補足 S-5 の「保存 1 回あたり数 ms」は、ゲストの層を tmpfs に置く限り当てはまらなかった。WSL2 との差は主に層の置き場所（tmpfs と ext4）によるものと見ているが、切り分けはしていない
- ゲストの中の処理時間（`elapsedUs`）であり、ホストとの往復や、ワークスペースとのファイルのやりとり（O-2）は含まない

## 4. 同梱する QEMU（#18、NFR-3）

配布版（qemu.weilnetz.de の 2026-08-11 版）は展開すると 1.2 GB で、GUI・音声・USB・ネットワークなどのために 104 個の DLL に依存していた。必要なファイルだけ抜き出しても 123 MB。そこで、必要な部品だけで QEMU 11.1.1 をクロスビルドした（`windows/qemu/build.sh`、`.github/workflows/qemu-windows.yml`）。

| | 実行ファイル | DLL | 合計 | zip（VSIX に近い） |
|---|---|---|---|---|
| 配布版（qemu.weilnetz.de） | 25.5 MB | 104 個 | 1.2 GB（必要な分だけで 123 MB） | — |
| 自前ビルド、装置は QEMU の既定 | 24,498,176 | 12 個 7,526,572 | 32,297,644 | 6,540,852 |
| **自前ビルド、装置を絞る（採用）** | **7,579,648** | 12 個 7,526,572 | **15,379,116** | **5,526,604** |

（バイト。2026-09-26、run 36235937359）

- ビルド：Fedora 44 のコンテナ（mingw64-headers 13.0.0、mingw64-gcc 16.1.1、mingw64-glib2 2.88.3）。Fedora 42 の MinGW のヘッダーは古く、QEMU 11.1 の WHPX が使う `WHvCapabilityCodeVmx*` が無くてコンパイルできなかった
- `--target-list=x86_64-softmmu`、`--enable-whpx --enable-tcg`。GUI・VNC・SPICE・OpenGL・USB・スマートカード・ネットワーク（slirp）・curl・暗号・画像と圧縮・音声・プラグインなどを外す
- 装置は `--without-default-devices` にし、`configs/devices/x86_64-softmmu/microgit.mak`（`CONFIG_Q35`・`CONFIG_VIRTIO_PCI`・`CONFIG_VIRTIO_SERIAL`）で指定する。q35 に要るものは Kconfig の `select` で入る。これで実行ファイルが 24.5 MB → 7.6 MB になった
- DLL は `objdump -p` のインポート表をたどって、実際に要る 12 個だけ（glib 系 5 個、libintl、iconv、libffi、libpcre2-8、libpixman、libgcc_s_seh、libwinpthread、zlib1）
- ファームウェアは SeaBIOS（`bios-256k.bin`）、`linuxboot_dma.bin`、`kvmvapic.bin` だけ（272,896 バイト）
- ソースは download.qemu.org の tarball で、sha256 を `windows/qemu/version.env` に固定（取得した tarball から計算した値。`.sig` の署名はまだ検証していない）

Windows 用の VSIX の見積もり：QEMU（zip で 5.53 MB）＋最小ゲスト（bzImage はもともと圧縮済みで 3.59 MB）＋拡張機能で約 9.6 MB。NFR-3（一桁 MB）に収まる見込み。実際の大きさは #19 で測る。

## 5. 次にやること

| 項目 | 内容 |
|---|---|
| ~~小さい QEMU のビルド~~ | **済み**（§4。Fedora の MinGW でクロスビルド） |
| TCG への切り替えの確認 | 「前から順に試す」仕組みは `-accel kvm -accel tcg` で確認済み（§2）。WHPX の初期化に失敗する PC での確認は残る（利用者の環境で起きたら Overlay Status の `launcher stderr` に出る） |
| QEMU の `.sig` の署名の検証 | QEMU のリリースの署名鍵を確かめて、ビルドで検証する |
| microvm の検討 | virtio-mmio に切り替えて、QEMU とカーネルの両方をさらに削れるか（今は不要：一桁 MB に収まる見込み） |
| Windows on Arm | arm64 版の QEMU と arm64 のゲストで動くか |
| WSL2 を借りる方式（B） | WSL2 がある PC 向けの高速化オプションとして残すかどうか |
