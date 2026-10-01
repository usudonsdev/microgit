#!/usr/bin/env bash
# Node.js Overlay（空間で時間を買う）スモーク
# 使い方: ./scripts/overlay-smoke.sh   （npm run test:overlay と同じ）
# 中身は scripts/overlay-smoke.mjs にまとめた（以前はここに同じ内容の複製があった）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run compile >/dev/null
node scripts/overlay-smoke.mjs
