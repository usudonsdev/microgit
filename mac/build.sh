#!/usr/bin/env bash
# Mac 用の起動ツール microgit-vm をビルドし、ad-hoc 署名する（Issue #17）。
# 必要なもの: Xcode Command Line Tools（xcode-select --install）
# 出力: mac/.build/microgit-vm
#
# ad-hoc 署名（-s -）で手元の実行に足りるかは O-8 の確認項目。配布には Developer ID と notarization が要る見込み。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
swiftc -O -framework Virtualization microgit-vm/main.swift -o .build/microgit-vm
codesign --force --sign - --entitlements microgit-vm/microgit-vm.entitlements .build/microgit-vm
echo "built mac/.build/microgit-vm"
