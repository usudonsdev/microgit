#!/usr/bin/env bash
# Mac で最小ゲストを起動し、ゴールデンテストを流す（Issue #17）。
#
# 使い方: mac/run-golden.sh
#   1. mac/build.sh で起動ツールを作る
#   2. guest/out/arm64/Image が無ければ、GitHub Actions の最新の成功した Guest ワークフローから取ってくる（gh が要る）
#   3. scripts/golden/check-guest.mjs で 12 シナリオを流し、結果を guest/out/arm64/guest-result-mac.json に書く
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/guest/out/arm64"
IMAGE="${IMAGE:-$OUT/Image}"

"$ROOT/mac/build.sh"

if [[ ! -f "$IMAGE" ]]; then
    branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
    run_id="$(gh run list -R usudonsdev/microgit -w guest.yml -b "$branch" -s success -L 1 --json databaseId -q '.[0].databaseId')"
    if [[ -z "$run_id" ]]; then
        echo "成功した Guest ワークフローが $branch にない。Actions の画面で確かめる" >&2
        exit 1
    fi
    echo "downloading Image from run $run_id"
    mkdir -p "$OUT"
    gh run download "$run_id" -R usudonsdev/microgit -n microgit-guest-arm64 -D "$OUT"
fi

node "$ROOT/scripts/golden/check-guest.mjs" --json "$OUT/guest-result-mac.json" -- \
    "$ROOT/mac/.build/microgit-vm" --kernel "$IMAGE" --console "$OUT/console-mac.log"
