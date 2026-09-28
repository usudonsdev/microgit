#!/usr/bin/env bash
# 未pushの agent を、既存の Image と組み合わせて Mac 実機で試すための外付け initramfs。
# 公開版は guest/build.sh が同じ agent を Image に埋め込む。このファイルは開発時だけ使う。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/guest/out/arm64}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"
(cd "$ROOT/guest/agent" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -ldflags "-s -w -buildid=" -o "$TMP/init" .)
chmod 755 "$TMP/init"
(cd "$TMP" && printf './init\n' | cpio -o -H newc) > "$OUT/initrd.cpio"
echo "built guest/out/arm64/initrd.cpio"
