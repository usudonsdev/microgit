# 08. 別の OS 向けにビルドする（クロスコンパイル）／実行ファイルが頼る部品を集める

| 項目 | 内容 |
|---|---|
| 関係する Issue | #18（Windows バックエンド：同梱用の小さい QEMU） |
| 実装 | [windows/qemu/build.sh](../../windows/qemu/build.sh)、[windows/qemu/version.env](../../windows/qemu/version.env)、[.github/workflows/qemu-windows.yml](../../.github/workflows/qemu-windows.yml) |
| 結果 | [windows-backend.md](../windows-backend.md) §4 |

---

## 1. 何のための仕組みか

Windows でカーネル版を使うには、QEMU を拡張機能に同梱する。配布版の QEMU は、画面・音声・USB・ネットワークなど何でも入りで、展開すると 1.2 GB あった。必要なファイルだけ抜き出しても 123 MB。MicroGit に要るのは「x86_64 の CPU を動かす」「virtio のシリアルで話す」だけなので、**必要な部品だけで QEMU をビルドし直す**。

---

## 2. 仕組み

### 2.1 クロスコンパイル

Windows 用の実行ファイル（.exe）は、Windows の上でなくても作れる。Linux の上で、Windows 用の機械語とファイル形式（PE）を出すコンパイラを使えばよい。これを **クロスコンパイル** という。

| 用語 | 意味 |
|---|---|
| ホスト | ビルドする機械（ここでは GitHub Actions の Linux） |
| ターゲット | できたものを動かす機械（ここでは Windows x64） |
| MinGW-w64 | Windows 用の GCC と、Windows の API のヘッダー・ライブラリ一式。`x86_64-w64-mingw32-gcc` のような名前のコマンドになる |
| sysroot | ターゲット用のヘッダーとライブラリを置いた「ターゲットの根っこ」。Fedora では `/usr/x86_64-w64-mingw32/sys-root/mingw/` |

QEMU の `configure` に `--cross-prefix=x86_64-w64-mingw32-` を渡すと、`gcc` の代わりに `x86_64-w64-mingw32-gcc` を使うようになる。QEMU 自身の CI も、Fedora の MinGW のパッケージで同じことをしている（`fedora-win64-cross`）。

### 2.2 ヘッダーが古いと、新しい機能を使うコードがコンパイルできない

最初に Fedora 42 でビルドしたら、`configure` は通ったのに、WHPX（Windows の仮想化機能を使う部分）のコンパイルで失敗した。

```
whpx-all.c:1428: error: 'WHvCapabilityCodeVmxBasic' undeclared
```

QEMU 11.1 は、Windows の新しい SDK で入った定数（入れ子の仮想化の機能を問い合わせる `WHvCapabilityCodeVmx*`）を使う。Fedora 42 の MinGW のヘッダーはそれより古く、定数が無かった。Fedora 44（mingw64-headers 13.0.0）に替えると通った。**クロスコンパイルでは、ターゲットの OS の API の「版」は、ヘッダーの版で決まる**。

### 2.3 要らないものを外す

QEMU は、`configure` の `--disable-...` で機能を外せる。外したもの：

| 分類 | 外したもの |
|---|---|
| 画面 | GTK、SDL、VNC、SPICE、OpenGL、curses |
| 入出力 | USB、スマートカード、音声（`--audio-drv-list=`） |
| ネットワーク | slirp（ゲストのネットワーク）、curl、libssh |
| 暗号・圧縮 | gnutls、nettle、gcrypt、png、zstd、lzo、snappy、bzip2 |
| その他 | ドキュメント、ツール、ゲストエージェント、プラグイン、デバッグ情報 |

さらに、エミュレートする **装置** も絞れる。既定では x86_64 のあらゆる装置（ネットワークカード、音声カード、USB コントローラなど）が入る。`--without-default-devices` にして、使う装置だけを書いたファイル（`configs/devices/x86_64-softmmu/microgit.mak`）を渡す。

```
CONFIG_Q35=y            # 仮想のマザーボード（q35）
CONFIG_VIRTIO_PCI=y     # virtio の装置を PCI につなぐ
CONFIG_VIRTIO_SERIAL=y  # virtio のシリアル（hvc0 と、命令の通り道）
```

q35 に必要なもの（割り込みコントローラ、ACPI など）は、QEMU の設定の仕組み（Kconfig）の `select` で自動的に入る。

| | 実行ファイル | 全部（DLL・ファームウェア込み） | zip |
|---|---|---|---|
| 装置は QEMU の既定 | 24.5 MB | 32.3 MB | 6.54 MB |
| **装置を絞る** | **7.6 MB** | **15.4 MB** | **5.53 MB** |

装置を絞るだけで、実行ファイルは 3 分の 1 になった。**何が入っているかを知らないまま「全部入り」を配ると、使わないものの分まで利用者に運ばせることになる**。

### 2.4 実行ファイルが頼る部品（DLL）を集める

できた `qemu-system-x86_64.exe` は、単独では動かない。glib などの DLL を実行時に読み込む。どの DLL が要るかは、実行ファイルの「インポート表」に書いてある。

```
$ x86_64-w64-mingw32-objdump -p qemu-system-x86_64.exe | grep 'DLL Name'
        DLL Name: libglib-2.0-0.dll
        DLL Name: KERNEL32.dll
        ...
```

`KERNEL32.dll` のように Windows に最初からあるものは要らない。sysroot にあるものだけをコピーし、コピーした DLL がさらに頼る DLL も同じようにたどる（芋づる式）。こうして、実際に要る 12 個だけになった。

### 2.5 動くかどうかは、ターゲットで確かめる

Linux の上で作ったものが Windows で動くかは、Windows で動かすまで分からない。CI では、ビルドのジョブ（Linux、Fedora のコンテナ）の成果物を、テストのジョブ（Windows のランナー）に渡して、拡張機能と同じ起動計画で起動し、差分テストを流している。

| 動かし方 | 起動 | 差分テスト（14 シナリオ・123 回） |
|---|---|---|
| 自動（WHPX → TCG） | 1.09 秒 | すべて一致、平均 36 ms |
| WHPX だけ | 1.02 秒 | — |
| TCG だけ | 1.82 秒 | すべて一致、平均 44 ms |

（2026-09-26、GitHub の windows-latest）

予想と違ったのは、**GitHub の Windows のランナーでも WHPX が使えた** こと。「WHPX が使えないときに TCG へ切り替わるか」をそのままでは試せなかったので、Windows に存在しない KVM を先頭に置いた `-accel kvm -accel tcg` で代わりに確かめた（`scripts/test/qemu-accel-fallback.mjs`）。QEMU は `invalid accelerator kvm` と出したあと `falling back to tcg` と出して起動した。**試したい状況が作れないときは、同じ仕組みを通る別の状況で確かめ、確かめきれない部分をはっきり書いておく**。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| 版とハッシュの固定 | `windows/qemu/version.env` |
| configure の設定、装置の一覧、DLL の芋づる、ファームウェア | `windows/qemu/build.sh` |
| ビルド（Linux）とテスト（Windows）の 2 つのジョブ | `.github/workflows/qemu-windows.yml` |
| 同梱の置き場所（拡張機能が探す場所） | `src/kernel/launchers.ts` の `planWindows()` |

---

## 4. 手を動かして確かめる

1. **CI の成果物を見る**：Actions の「QEMU for Windows (minimal)」を開き、`microgit-qemu-win32-x64` をダウンロードして、`sizes.txt` と中身（exe・DLL・share）を見る
2. **インポート表を見る**：WSL2 に `binutils-mingw-w64-x86-64` を入れて、`x86_64-w64-mingw32-objdump -p qemu-system-x86_64.exe | grep 'DLL Name'`
3. **動かし方を比べる**：`node scripts/test/native-fallback.mjs --accel whpx` と `--accel tcg` で、起動の時間を比べる

---

## 5. もっと知りたいとき

- QEMU のドキュメント「Build System」「QEMU configure / meson options」、`configs/devices/`
- MinGW-w64 のプロジェクトのページ、Fedora の MinGW の SIG
- 「PE import table」「dependency walker」で検索する
