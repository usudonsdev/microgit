#!/usr/bin/env bash
# さかのぼって付ける版のタグを打つ（docs/versioning.md §4）。すでにあるタグは飛ばす。
# 使い方: bash scripts/tag-past-versions.sh [--push]
#   --push  打ったタグを origin へ送る。v5.1.3 は送ると package.yml が走り GitHub Release の下書きができるので、
#           送るのは --push-5.1.3 を足したときだけ
# タグの日付はコミットの日付にそろえる（GIT_COMMITTER_DATE）。
set -euo pipefail
cd "$(dirname "$0")/.."

push=0; push513=0
for a in "$@"; do
  case "$a" in
    --push) push=1 ;;
    --push-5.1.3) push513=1 ;;
    *) echo "知らない引数: $a" >&2; exit 2 ;;
  esac
done

# タグ  コミット  タグの見出し
list=(
  "v0.0.1 b578868 MicroGit 0.0.1"
  "v1.0.0 2b702ce MicroGit 1.0.0"
  "v1.0.1 f6e2ce2 MicroGit 1.0.1"
  "v2.0.0 c6929e9 MicroGit 2.0.0"
  "v2.0.1 56fb486 MicroGit 2.0.1"
  "v3.0.0 8409cac MicroGit 3.0.0"
  "v3.1.0 aa24e14 MicroGit 3.1.0"
  "v3.2.0 d08f5d1 MicroGit 3.2.0"
  "v3.3.0 cdd3309 MicroGit 3.3.0"
  "v3.4.0 53c4391 MicroGit 3.4.0"
  "v3.4.1 6caf5a0 MicroGit 3.4.1"
  "v3.6.1 4bd8431 MicroGit 3.6.1"
  "v3.7.0 11365ef MicroGit 3.7.0"
  "v4.0.0 c1de64a MicroGit 4.0.0"
  "v5.1.3 ac26c85 MicroGit 5.1.3"
  "agent-v0.1.0 0bd6732 microgit-agent 0.1.0"
  "agent-v0.2.0 0ecca56 microgit-agent 0.2.0"
  "agent-v1.0.0 a18ab36 microgit-agent 1.0.0"
  "agent-v1.1.0 cd11b6b microgit-agent 1.1.0"
)

to_push=()
for line in "${list[@]}"; do
  read -r tag commit subject <<<"$line"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "あり: $tag"
  else
    GIT_COMMITTER_DATE="$(git log -1 --format=%cI "$commit")" \
      git tag -a "$tag" "$commit" -m "$subject" \
      -m "2026-11-27 にさかのぼって付けたタグ（docs/versioning.md §4）。タグの日付はコミットの日付に合わせた。"
    echo "打った: $tag → $commit"
  fi
  if [ "$tag" != "v5.1.3" ] || [ "$push513" = 1 ]; then to_push+=("$tag"); fi
done

node scripts/check-versions.mjs

if [ "$push" = 1 ]; then
  git push origin "${to_push[@]}"
fi
