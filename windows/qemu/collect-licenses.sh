#!/usr/bin/env bash
# 同梱する QEMU・SeaBIOS・DLL のライセンスと、DLL の出どころを集める（#19、NFR-7。build.sh から呼ぶ）。
#
# 使い方: collect-licenses.sh <qemu-win のフォルダ> <QEMU のソースのフォルダ> <MinGW の sysroot の bin>
# 出力: <qemu-win>/licenses/qemu/          QEMU の COPYING・COPYING.LIB・LICENSE（GPLv2 ほか）
#       <qemu-win>/licenses/seabios/       SeaBIOS の COPYING・COPYING.LESSER（LGPLv3）
#       <qemu-win>/licenses/<パッケージ>/  DLL の出どころの Fedora のパッケージのライセンスの文書（rpm -qL）
#       <qemu-win>/licenses/packages.tsv   パッケージ・版・ライセンス・ソース RPM・その DLL
#
# DLL の出どころは、ビルドしたこのコンテナの rpm に聞く（あとで取り直すと、Fedora の更新で版がずれる）。
# packages.tsv のソース RPM は、qemu-windows.yml が同じコンテナで取ってきて、ソースの成果物にする。
# 試すとき: bash windows/qemu/test-collect-licenses.sh（偽の rpm を PATH の先頭に置いて流す）
set -euo pipefail

dest="$1"
src="$2"
sysroot_bin="$3"
lic="$dest/licenses"

mkdir -p "$lic/qemu"
cp "$src/COPYING" "$src/COPYING.LIB" "$src/LICENSE" "$lic/qemu/"
if [[ -d "$src/roms/seabios" ]]; then
    mkdir -p "$lic/seabios"
    cp "$src/roms/seabios/COPYING" "$src/roms/seabios/COPYING.LESSER" "$lic/seabios/"
fi

if ! command -v rpm >/dev/null; then
    echo "rpm が無いので DLL のライセンスを集められない（Fedora のコンテナで動かす）" >&2
    exit 1
fi

# DLL → パッケージ。どのパッケージにも属さない DLL があれば止める（出どころの分からないものは配らない）
declare -A owner=()
pkgs=()
for dll in "$dest"/*.dll; do
    name="$(basename "$dll")"
    if ! p="$(rpm -qf --qf '%{NAME}\n' "$sysroot_bin/$name")"; then
        echo "$name はどのパッケージにも属していない: $p" >&2
        exit 1
    fi
    owner[$name]="$p"
    if [[ " ${pkgs[*]} " != *" $p "* ]]; then pkgs+=("$p"); fi
done

# パッケージごとに 1 行。set -e の下で、条件が偽のときに終了コードが 1 になる書き方（[[ ]] && ...）は使わない
{
    printf 'package\tversion\tlicense\tsource_rpm\tdlls\n'
    for p in "${pkgs[@]}"; do
        dlls=""
        for name in "${!owner[@]}"; do
            if [[ "${owner[$name]}" == "$p" ]]; then dlls+="${dlls:+ }$name"; fi
        done
        dlls="$(tr ' ' '\n' <<<"$dlls" | sort | tr '\n' ' ')"
        rpm -q --qf "%{NAME}\t%{VERSION}-%{RELEASE}\t%{LICENSE}\t%{SOURCERPM}\t${dlls% }\n" "$p"
        mkdir -p "$lic/$p"
        while read -r f; do
            if [[ -f "$f" ]]; then cp "$f" "$lic/$p/"; fi
        done < <(rpm -qL "$p")
    done
} > "$lic/packages.tsv.tmp"
# パッケージの名前の順にそろえる（見出しの行は先頭のまま）
{ head -n 1 "$lic/packages.tsv.tmp"; tail -n +2 "$lic/packages.tsv.tmp" | sort; } > "$lic/packages.tsv"
rm "$lic/packages.tsv.tmp"
cat "$lic/packages.tsv"
