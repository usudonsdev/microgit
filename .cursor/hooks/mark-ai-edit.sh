#!/usr/bin/env bash
# Agent / Tab がファイルを編集したら pending に記録し、MicroGit 保存時に [AI] 付きで残す。
# stdout は空 JSON。

set -euo pipefail

input="$(cat)"
file_path="$(
  printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
print(data.get("file_path") or data.get("path") or "")
' 2>/dev/null || true
)"

if [[ -z "$file_path" ]]; then
  echo '{}'
  exit 0
fi

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
pending_dir="$root/.microgit/logs"
pending_file="$pending_dir/ai-pending.json"

mkdir -p "$pending_dir"

python3 - "$pending_file" "$file_path" "$root" <<'PY'
import json, os, sys
pending_file, file_path, root = sys.argv[1], sys.argv[2], sys.argv[3]
rel = os.path.relpath(file_path, root).replace("\\", "/")
if rel.startswith("..") or rel == ".microgit" or rel.startswith(".microgit/") or rel.startswith(".microgit_") or rel.startswith(".cursor/"):
    sys.exit(0)
try:
    data = json.load(open(pending_file, encoding="utf-8")) if os.path.exists(pending_file) else []
except Exception:
    data = []
if not isinstance(data, list):
    data = []
if rel not in data:
    data.append(rel)
open(pending_file, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=2))
PY

echo '{}'
exit 0
