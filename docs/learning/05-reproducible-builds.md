# 05. 再現可能なビルド：同じソースから、同じバイト列を

| 項目 | 内容 |
|---|---|
| 関係する Issue | #15（最小ゲストのビルド）、NFR-6・NFR-7 |
| 実装 | [guest/build.sh](../../guest/build.sh)、[guest/kernel/version.env](../../guest/kernel/version.env)、[.github/workflows/guest.yml](../../.github/workflows/guest.yml) の「Rebuild in another directory and compare」 |
| 結果 | [guest-phase1.md](../guest-phase1.md) §3 |

---

## 1. 何のための仕組みか

MicroGit は、Linux カーネルと agent をビルドした `Image` を配る。配る人（作者）と使う人は別なので、使う人は次のことを確かめたくなる。

- この `Image` は、公開されているソースから本当に作られたものか（途中で何か混ぜられていないか）
- GPLv2 で公開しているソースと設定は、配っているバイナリと本当に対応しているか（NFR-7）

**同じソースと手順からビルドすると、誰がいつどこでやっても 1 バイトも違わない同じファイルができる**なら、使う人は自分でビルドしてハッシュを比べるだけで確かめられる。これが再現可能なビルド（reproducible build）である。

逆の例として、2024 年に見つかった xz-utils のバックドアでは、配布された tarball に Git のリポジトリに無い細工が入っていた。「配っているものは、公開しているソースから作ったものだ」と誰でも確かめられることは、この種の攻撃への備えになる。

---

## 2. 仕組み

### 2.1 何もしなければ、ビルドは毎回違うバイト列になる

同じソースでも、ビルドのたびに違いが混ざる。

| 混ざるもの | 例 | 固定のしかた |
|---|---|---|
| 時刻 | カーネルの版の文字列にビルドした日時が入る（`uname -v`）。アーカイブの中のファイルの更新時刻 | `KBUILD_BUILD_TIMESTAMP`、`SOURCE_DATE_EPOCH` |
| 人と機械の名前 | カーネルにビルドしたユーザー名とホスト名が入る | `KBUILD_BUILD_USER`、`KBUILD_BUILD_HOST` |
| 置き場所 | バイナリに絶対パスが入る（デバッグ情報、Go のファイル名） | Go の `-trimpath`。カーネルは `O=` の出力先が違っても同じになるか確かめる |
| 乱数・ID | Go のビルド ID | Go の `-ldflags "-buildid="` |
| 道具の版 | Go や gcc の版が変わると、同じソースから違う機械語ができる | Go は `GO_VERSION` で固定。gcc はまだ固定していない（§2.4） |
| 入力 | ダウンロードしたカーネルのソースが途中で違うものにすり替わる | `KERNEL_SHA256` で照合 |
| 設定 | 既定値の違いで違う設定になる | `allnoconfig` から始めて、使うものだけを明示する |

### 2.2 このリポジトリで固定しているもの

```
guest/kernel/version.env
  KERNEL_VERSION=6.18.53          ← ソースの版
  KERNEL_SHA256=4d6fba95...       ← ソースのハッシュ（kernel.org の sha256sums から写した）
  GO_VERSION=1.27.1               ← agent をビルドする Go の版

guest/build.sh
  KBUILD_BUILD_TIMESTAMP='1970-01-01 00:00:00 UTC'
  KBUILD_BUILD_USER=microgit  KBUILD_BUILD_HOST=microgit
  SOURCE_DATE_EPOCH=0
  go build -trimpath -ldflags "-s -w -buildid="
```

`go.mod` の `go 1.24` と `GO_VERSION` は意味が違う。前者は「この言語の版の機能までしか使わない」という最低版で、後者は「実際にビルドに使う Go」。`go.mod` だけで CI の Go を決めていたときは、CI が走った時点の 1.24 系の最新が毎回入っていた。

### 2.3 確かめ方：2 回ビルドして比べる

固定したつもりでも、漏れがあるかもしれない。CI では、1 回目と **別の出力先** にもう 1 回ビルドし、`Image` と `init` の sha256 を比べる。出力先を変えるのは、置き場所（パス）が混ざっていないかも一緒に確かめるため。

違ったら、`cmp -l` でどこが違うかを出す。本格的に調べるときは diffoscope（ファイルの違いを中身の意味の単位で見せる道具）を使う。

### 2.4 結果（2026-09-26）

CI の実行（run 36231791916）で、1 回目と、別の出力先に作った 2 回目が、x86_64・arm64 ともに 1 バイトも違わなかった。

```
Image  first=7a2a989965e35330d3f0101dbad8ff350b86fa23df344bfbb6643b6a0f40cfe8  second=7a2a989965e35330d3f0101dbad8ff350b86fa23df344bfbb6643b6a0f40cfe8
init   first=f275575c180fa6822b49194b9dd6f8c1842a4176e1163abea75bd457496b66df  second=f275575c180fa6822b49194b9dd6f8c1842a4176e1163abea75bd457496b66df
reproducible: Image と init が 2 回のビルドで一致          （x86_64。arm64 も同じく一致）
```

おまけの発見：Go を 1.24 系から 1.27.1 に上げたら、agent が約 2.3 MB から約 3.0 MB に大きくなった。道具の版はバイト列だけでなく大きさにも効く。版を固定していなければ、「ある日から急に大きくなった」理由が分からなかったはずである。

### 2.5 まだ固定していないもの

- **C コンパイラ（gcc）と binutils の版**：CI は GitHub の Ubuntu 24.04 のランナーに apt で入れている。ランナーのイメージが更新されると、gcc の版が変わり、カーネルのバイト列も変わりうる。「同じ日の同じランナーなら一致する」は確かめたが、「何か月後でも一致する」はまだ保証していない。完全にするには、ビルドに使うコンテナイメージをハッシュ（digest）で固定する
- **成果物の署名**：ハッシュを比べれば中身は確かめられるが、「作者が配ったもの」であることは確かめられない。VSIX の署名（Marketplace）に頼る（補足 S-11、#19）

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| 版とハッシュの固定 | `guest/kernel/version.env` |
| 時刻・名前・パス・ビルド ID の固定 | `guest/build.sh` の `export KBUILD_*`、`go build -trimpath -ldflags "-s -w -buildid="` |
| Go の版の確認（CI では違えば止める） | `guest/build.sh` の `STRICT_TOOLCHAIN` |
| ソースのハッシュの照合 | `guest/build.sh` の `sha256sum -c` |
| 2 回ビルドして比べる | `guest.yml` の「Rebuild in another directory and compare」 |
| 大きさとハッシュの記録 | `guest/build.sh` の `sizes.txt`（CI の成果物に入る） |

---

## 4. 手を動かして確かめる

1. **CI の成果物の sizes.txt を見る**：GitHub の Actions で Guest ワークフローを開き、`microgit-guest-x86_64` をダウンロードして `sizes.txt` の sha256 を見る。同じコミットの別の実行でも同じ値になっているか比べる
2. **固定を外すとどうなるか**：WSL2 にビルドの道具を入れて（`sudo apt install build-essential flex bison bc libelf-dev golang`）、`KBUILD_BUILD_TIMESTAMP` の行を消してビルドし、`strings guest/out/x86_64/Image | grep -m1 'Linux version'` で日時が入ることを確かめる
3. **Go の版の違いを見る**：`GO_VERSION` と違う Go で `ARCH=x86_64 guest/build.sh` を流すと警告が出る。`STRICT_TOOLCHAIN=1` を付けると止まる

---

## 5. もっと知りたいとき

- reproducible-builds.org（考え方、`SOURCE_DATE_EPOCH` の仕様、diffoscope）
- Linux カーネルのドキュメント「Reproducible builds」（docs.kernel.org/kbuild/reproducible-builds.html）
- `go help build` の `-trimpath`、Go の「Perfectly Reproducible, Verified Go Toolchains」（go.dev/blog）
