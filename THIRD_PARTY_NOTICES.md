# Third-party notices / 同梱している第三者のソフトウェア

MicroGit itself is licensed under the terms in [LICENCE.md](LICENCE.md).
The platform-specific packages (VSIX) of MicroGit 5 also contain the third-party software listed below, used by the optional kernel OverlayFS backend.
The universal package contains none of it.

MicroGit 本体のライセンスは [LICENCE.md](LICENCE.md) のとおり。MicroGit 5 のプラットフォーム別の VSIX には、カーネル版の OverlayFS のために、次の第三者のソフトウェアも入っている。universal の VSIX には入っていない。

## What is in which package / どの VSIX に何が入っているか

| Component | Version | License | win32-x64 | linux-x64 / linux-arm64 | Where in the VSIX |
|---|---|---|---|---|---|
| Linux kernel | 6.18.53 | GPL-2.0 (with Linux-syscall-note) | yes (inside the guest image) | no | `resources/kernel/guest/x86_64/Image`, license: `resources/kernel/licenses/linux/` |
| Go standard library and runtime (statically linked into the MicroGit agent) | 1.27.1 | BSD-3-Clause | yes (inside the guest image) | yes | `resources/kernel/linux-*/microgit-agent`, license: `resources/kernel/licenses/go/LICENSE` |
| QEMU (`qemu-system-x86_64`, built by MicroGit with a reduced device set) | 11.1.1 | GPL-2.0 (parts under other GPL-compatible licenses, see `COPYING`, `LICENSE`) | yes | no | `resources/kernel/win32-x64/qemu/`, license: `.../qemu/licenses/qemu/` |
| SeaBIOS (`bios-256k.bin`, from the QEMU source tree) | as shipped with QEMU 11.1.1 | LGPL-3.0 | yes | no | `.../qemu/share/`, license: `.../qemu/licenses/seabios/` |
| QEMU option ROMs (`linuxboot_dma.bin`, `kvmvapic.bin`) | as shipped with QEMU 11.1.1 | GPL-2.0 | yes | no | `.../qemu/share/` |
| DLLs used by QEMU (12 files, see the next table) | Fedora 44 MinGW packages | per package, see the next table | yes | no | `resources/kernel/win32-x64/qemu/*.dll`, licenses: `.../qemu/licenses/<package>/` and `.../qemu/licenses/packages.tsv` |

### DLLs in the win32-x64 package / Windows 用の VSIX の DLL

As recorded by `rpm` when MicroGit 5.0.0 was built (2026-09-26). The license column is the Fedora package's License tag, which covers the whole package; each DLL is under the part that applies to it (for example `libintl-8.dll` is LGPL, and `libgcc_s_seh-1.dll` is GPL-3.0-or-later WITH GCC-exception-3.1).

MicroGit 5.0.0 をビルドしたとき（2026-09-26）に `rpm` が記録したもの。ライセンスの列は Fedora のパッケージの License の値で、パッケージ全体についての記載。DLL ごとには、そのうちの当てはまる部分による（`libintl-8.dll` は LGPL、`libgcc_s_seh-1.dll` は GPL-3.0-or-later WITH GCC-exception-3.1 など）。

| DLL | Fedora package | Version | License (Fedora) | Source RPM |
|---|---|---|---|---|
| libglib-2.0-0.dll, libgio-2.0-0.dll, libgobject-2.0-0.dll, libgmodule-2.0-0.dll | mingw64-glib2 | 2.88.3-1.fc44 | LGPL-2.0-or-later | mingw-glib2-2.88.3-1.fc44.src.rpm |
| libintl-8.dll | mingw64-gettext | 0.26-2.fc44 | GPL-2.0-or-later AND LGPL-2.0-or-later | mingw-gettext-0.26-2.fc44.src.rpm |
| iconv.dll | mingw64-win-iconv | 0.0.10-4.fc44 | LicenseRef-Fedora-Public-Domain | mingw-win-iconv-0.0.10-4.fc44.src.rpm |
| libffi-8.dll | mingw64-libffi | 3.5.2-2.fc44 | MIT | mingw-libffi-3.5.2-2.fc44.src.rpm |
| libpcre2-8-0.dll | mingw64-pcre2 | 10.48-1.fc44 | BSD-3-Clause | mingw-pcre2-10.48-1.fc44.src.rpm |
| libpixman-1-0.dll | mingw64-pixman | 0.46.4-2.fc44 | MIT | mingw-pixman-0.46.4-2.fc44.src.rpm |
| libgcc_s_seh-1.dll | mingw64-libgcc | 16.1.1-1.fc44 | GPL-3.0-or-later WITH GCC-exception-3.1 and others (the full tag is in `packages.tsv`) | mingw-gcc-16.1.1-1.fc44.src.rpm |
| libwinpthread-1.dll | mingw64-winpthreads | 13.0.0-3.fc44 | BSD-3-Clause AND MIT AND LicenseRef-Fedora-Public-Domain | mingw-winpthreads-13.0.0-3.fc44.src.rpm |
| zlib1.dll | mingw64-zlib | 1.3.2-1.fc44 | Zlib | mingw-zlib-1.3.2-1.fc44.src.rpm |

The Fedora packages of zlib and win-iconv install no license files, so there is no folder for them under `licenses/`. The zlib license does not require the notice to be reproduced in binary distributions, and win-iconv is in the public domain.

Fedora の zlib と win-iconv のパッケージにはライセンスの文書が入っていないので、`licenses/` の下にそのフォルダは無い。zlib のライセンスはバイナリの配布で表示を求めず、win-iconv はパブリックドメイン。

`packages.tsv` is written at build time by `windows/qemu/build.sh`, which asks `rpm` which Fedora package each DLL came from, and records the version, license and source RPM of that package.

`packages.tsv` は `windows/qemu/build.sh`（`collect-licenses.sh`）がビルドのときに書く。DLL ごとに、どの Fedora のパッケージから来たかを `rpm` に聞き、そのパッケージの版・ライセンス・ソース RPM を記録している。QEMU を作り直すと版が変わりうるので、正しいのは各 VSIX の中の `packages.tsv`。

## Source code / ソースコード

The complete corresponding source code of the GPL and LGPL components above, and the scripts and configuration used to build them, is published with every release on the GitHub release page of this repository as `third-party-sources-<version>.tar`:

上の GPL・LGPL の部品の完全なソースコードと、ビルドに使ったスクリプトと設定は、リリースごとに、このリポジトリの GitHub のリリースのページに `third-party-sources-<版>.tar` として置く。

- `linux-6.18.53.tar.xz` (from kernel.org, sha256 pinned in `guest/kernel/version.env`)
- `qemu-11.1.1.tar.xz` (from download.qemu.org, sha256 pinned in `windows/qemu/version.env`; includes the SeaBIOS and option ROM sources)
- `qemu-win32-dlls/*.src.rpm` (the Fedora source RPMs of the DLLs, downloaded in the same build container)
- `microgit-build/` (the kernel configuration fragments, `guest/build.sh`, the agent source, `windows/qemu/build.sh`)
- `SHA256SUMS`

The same build scripts are in this repository (`guest/`, `windows/qemu/`), and the GitHub Actions workflow `.github/workflows/package.yml` shows exactly how each package was built.

同じビルドのスクリプトはこのリポジトリ（`guest/`、`windows/qemu/`）にあり、各 VSIX がどう作られたかは GitHub Actions のワークフロー `.github/workflows/package.yml` に残っている。
