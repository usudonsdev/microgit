#!/usr/bin/env bash
# 最小ゲスト（カーネル＋initramfs に埋め込んだ agent）をビルドする（Issue #15）。
#
# 使い方: ARCH=arm64 guest/build.sh     （ARCH は arm64 か x86_64。既定は arm64）
#         OUT=<出力先> で出力先を変えられる（再現性の確認で 2 回目を別の場所に作るため）
#         STRICT_TOOLCHAIN=1 なら、Go の版が version.env の GO_VERSION と違うと止める（CI）
# 必要なもの（Ubuntu）: build-essential flex bison bc libelf-dev curl xz-utils golang、
#                        クロスビルドなら gcc-aarch64-linux-gnu
# 出力: guest/out/<ARCH>/ に Image（起動するカーネル）、init（agent）、config、sizes.txt
#
# 1 ファイル（Image）で起動できるよう、initramfs はカーネルに埋め込む（CONFIG_INITRAMFS_SOURCE）。
# Virtualization.framework の VZLinuxBootLoader にはカーネルのパスだけを渡せばよい。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="${ARCH:-arm64}"
OUT="${OUT:-$HERE/out/$ARCH}"
CACHE="$HERE/.cache"
# shellcheck source=kernel/version.env
source "$HERE/kernel/version.env"

case "$ARCH" in
    arm64) GOARCH=arm64; KARCH=arm64; IMAGE=arch/arm64/boot/Image; TRIPLE=aarch64-linux-gnu ;;
    x86_64) GOARCH=amd64; KARCH=x86_64; IMAGE=arch/x86/boot/bzImage; TRIPLE=x86_64-linux-gnu ;;
    *) echo "unsupported ARCH: $ARCH" >&2; exit 1 ;;
esac
CROSS=""
if [[ "$(uname -m)" != "$ARCH" && ! ( "$(uname -m)" == aarch64 && "$ARCH" == arm64 ) ]]; then
    CROSS="$TRIPLE-"
fi

# 再現可能なビルドのため、埋め込まれる時刻と名前を固定する（NFR-6）。
# 別の出力先に 2 回ビルドしてハッシュが一致することを CI で確かめている（guest.yml）
export KBUILD_BUILD_TIMESTAMP='1970-01-01 00:00:00 UTC'
export KBUILD_BUILD_USER=microgit KBUILD_BUILD_HOST=microgit
export SOURCE_DATE_EPOCH=0

mkdir -p "$OUT" "$CACHE"

go_have="$(go env GOVERSION)"
if [[ "$go_have" != "go$GO_VERSION" ]]; then
    msg="Go の版が違う: $go_have（version.env は go$GO_VERSION）。できる init のバイト列が変わる"
    if [[ "${STRICT_TOOLCHAIN:-}" == 1 ]]; then echo "$msg" >&2; exit 1; fi
    echo "warning: $msg" >&2
fi

echo "== agent ($go_have)"
(cd "$HERE/agent" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
    go build -trimpath -ldflags "-s -w -buildid=" -o "$OUT/init" .)

echo "== kernel source $KERNEL_VERSION"
tarball="$CACHE/linux-$KERNEL_VERSION.tar.xz"
if [[ ! -f "$tarball" ]]; then
    curl -fsSL -o "$tarball.tmp" "https://cdn.kernel.org/pub/linux/kernel/v${KERNEL_VERSION%%.*}.x/linux-$KERNEL_VERSION.tar.xz"
    mv "$tarball.tmp" "$tarball"
fi
echo "$KERNEL_SHA256  $tarball" | sha256sum -c -
src="$CACHE/linux-$KERNEL_VERSION"
if [[ ! -d "$src" ]]; then
    tar -xJf "$tarball" -C "$CACHE"
fi

echo "== config"
# /dev/console が無いと、カーネルが init の標準入出力を開けない
cat > "$OUT/initramfs.list" <<EOF
dir /dev 0755 0 0
nod /dev/console 0600 0 0 c 5 1
dir /proc 0755 0 0
dir /sys 0755 0 0
dir /run 0755 0 0
file /init $OUT/init 0755 0 0
EOF
fragment="$OUT/fragment.config"
cat "$HERE/kernel/microgit.config" "$HERE/kernel/microgit-$ARCH.config" > "$fragment"
echo "CONFIG_INITRAMFS_SOURCE=\"$OUT/initramfs.list\"" >> "$fragment"

kmake() { make -C "$src" O="$OUT/build" ARCH="$KARCH" CROSS_COMPILE="$CROSS" "$@"; }
kmake -s allnoconfig
"$src/scripts/kconfig/merge_config.sh" -m -O "$OUT/build" "$OUT/build/.config" "$fragment" >/dev/null
kmake -s olddefconfig

# 頼んだ設定が依存関係で黙って落ちていないか確かめる
missing=0
while IFS= read -r line; do
    [[ "$line" =~ ^CONFIG_[A-Z0-9_]+=y$ ]] || continue
    if ! grep -qx "$line" "$OUT/build/.config"; then
        echo "missing: $line" >&2
        missing=1
    fi
done < "$fragment"
if grep -q '^CONFIG_NET=y' "$OUT/build/.config"; then
    echo "CONFIG_NET must stay disabled (NFR-4)" >&2
    missing=1
fi
[[ "$missing" == 0 ]] || exit 1

echo "== build"
kmake -s -j"$(nproc)" "$(basename "$IMAGE")"
cp "$OUT/build/$IMAGE" "$OUT/Image"
cp "$OUT/build/.config" "$OUT/config"

# VSIX は zip で圧縮されるので、利用者がダウンロードする大きさは gzip -9 の値に近い
{
    echo "kernel      $KERNEL_VERSION ($ARCH)"
    echo "go          $go_have"
    echo "Image       $(stat -c %s "$OUT/Image") bytes (initramfs 込み)"
    echo "Image.gz    $(gzip -9 -n -c "$OUT/Image" | wc -c) bytes (参考: 圧縮後)"
    echo "init        $(stat -c %s "$OUT/init") bytes"
    echo "sha256      $(sha256sum "$OUT/Image" | cut -d' ' -f1)  Image"
    echo "sha256      $(sha256sum "$OUT/init" | cut -d' ' -f1)  init"
} | tee "$OUT/sizes.txt"
