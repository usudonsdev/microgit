#!/usr/bin/env bash
# collect-licenses.sh を、偽の rpm で試す（#19）。Fedora のコンテナが無くても bash だけで流せる。
#
# 使い方: bash windows/qemu/test-collect-licenses.sh
# 確かめること:
#   1. DLL ごとの出どころのパッケージを 1 行ずつ、名前の順に packages.tsv に書く。DLL は名前の順に並ぶ
#      （最後の DLL が別のパッケージでも止まらない。set -e の下での「条件が偽で終了コード 1」の罠、#19 で CI が止まった）
#   2. rpm -qL のライセンスの文書をパッケージごとにコピーし、「(contains no files)」は無視する
#   3. QEMU と SeaBIOS のライセンスをコピーする
#   4. どのパッケージにも属さない DLL があれば止める
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 偽の rpm。表（dll→パッケージ、パッケージ→版・ライセンス・ソース RPM・ライセンスの文書）を読んで答える
mkdir -p "$work/bin" "$work/sysroot" "$work/src/roms/seabios" "$work/dest" "$work/licdocs"
printf 'libglib-2.0-0.dll\tmingw64-glib2\nlibgio-2.0-0.dll\tmingw64-glib2\nzlib1.dll\tmingw64-zlib\nlibffi-8.dll\tmingw64-libffi\n' > "$work/owners.tsv"
echo "GLib license" > "$work/licdocs/COPYING-glib"
echo "zlib license" > "$work/licdocs/LICENSE-zlib"
printf 'mingw64-glib2\t2.88.3\t1.fc44\tLGPL-2.1-or-later\tmingw-glib2-2.88.3-1.fc44.src.rpm\t%s\n' "$work/licdocs/COPYING-glib" > "$work/pkgs.tsv"
printf 'mingw64-zlib\t1.3.1\t2.fc44\tZlib\tmingw-zlib-1.3.1-2.fc44.src.rpm\t%s\n' "$work/licdocs/LICENSE-zlib" >> "$work/pkgs.tsv"
printf 'mingw64-libffi\t3.4.8\t1.fc44\tMIT\tmingw-libffi-3.4.8-1.fc44.src.rpm\t\n' >> "$work/pkgs.tsv"
cat > "$work/bin/rpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
owners="$work/owners.tsv"
pkgs="$work/pkgs.tsv"
EOF
cat >> "$work/bin/rpm" <<'EOF'
case "$1" in
    -qf)
        # rpm -qf --qf FORMAT FILE
        name="$(basename "$4")"
        p="$(awk -F'\t' -v n="$name" '$1 == n { print $2 }' "$owners")"
        if [[ -z "$p" ]]; then echo "file $4 is not owned by any package"; exit 1; fi
        out="${3//%\{NAME\}/$p}"
        printf '%b' "$out" ;;
    -q)
        # rpm -q --qf FORMAT PACKAGE
        IFS=$'\t' read -r n v r l s _ < <(awk -F'\t' -v n="$4" '$1 == n' "$pkgs")
        out="$3"
        out="${out//%\{NAME\}/$n}"; out="${out//%\{VERSION\}/$v}"; out="${out//%\{RELEASE\}/$r}"
        out="${out//%\{LICENSE\}/$l}"; out="${out//%\{SOURCERPM\}/$s}"
        printf '%b' "$out" ;;
    -qL)
        f="$(awk -F'\t' -v n="$2" '$1 == n { print $6 }' "$pkgs")"
        if [[ -n "$f" ]]; then echo "$f"; else echo "(contains no files)"; fi ;;
    *) echo "fake rpm: unknown $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$work/bin/rpm"

for f in COPYING COPYING.LIB LICENSE; do echo "qemu $f" > "$work/src/$f"; done
for f in COPYING COPYING.LESSER; do echo "seabios $f" > "$work/src/roms/seabios/$f"; done
# 最後（名前の順で最後の zlib1.dll）が、その前と別のパッケージになるように並べる
for dll in libffi-8.dll libgio-2.0-0.dll libglib-2.0-0.dll zlib1.dll; do
    echo "$dll" > "$work/sysroot/$dll"
    cp "$work/sysroot/$dll" "$work/dest/"
done

fail() { echo "NG: $*" >&2; exit 1; }

if PATH="$work/bin:$PATH" bash "$HERE/collect-licenses.sh" "$work/dest" "$work/src" "$work/sysroot" > "$work/out.txt"; then :; else
    fail "collect-licenses.sh が止まった（終了コード $?）"
fi

expected="$(printf 'package\tversion\tlicense\tsource_rpm\tdlls\nmingw64-glib2\t2.88.3-1.fc44\tLGPL-2.1-or-later\tmingw-glib2-2.88.3-1.fc44.src.rpm\tlibgio-2.0-0.dll libglib-2.0-0.dll\nmingw64-libffi\t3.4.8-1.fc44\tMIT\tmingw-libffi-3.4.8-1.fc44.src.rpm\tlibffi-8.dll\nmingw64-zlib\t1.3.1-2.fc44\tZlib\tmingw-zlib-1.3.1-2.fc44.src.rpm\tzlib1.dll')"
got="$(cat "$work/dest/licenses/packages.tsv")"
if [[ "$got" != "$expected" ]]; then
    diff <(echo "$expected") <(echo "$got") || true
    fail "packages.tsv が期待と違う"
fi
[[ "$(cat "$work/dest/licenses/mingw64-glib2/COPYING-glib")" == "GLib license" ]] || fail "GLib のライセンスの文書が無い"
[[ -f "$work/dest/licenses/mingw64-zlib/LICENSE-zlib" ]] || fail "zlib のライセンスの文書が無い"
[[ -d "$work/dest/licenses/mingw64-libffi" ]] || fail "libffi のフォルダが無い"
[[ -z "$(ls -A "$work/dest/licenses/mingw64-libffi")" ]] || fail "(contains no files) をファイルとして扱った"
for f in COPYING COPYING.LIB LICENSE; do [[ -f "$work/dest/licenses/qemu/$f" ]] || fail "QEMU の $f が無い"; done
for f in COPYING COPYING.LESSER; do [[ -f "$work/dest/licenses/seabios/$f" ]] || fail "SeaBIOS の $f が無い"; done
[[ ! -e "$work/dest/licenses/packages.tsv.tmp" ]] || fail "一時ファイルが残った"
echo "OK: packages.tsv とライセンスの文書"

# どのパッケージにも属さない DLL があれば止める
echo stray > "$work/sysroot/stray.dll"
cp "$work/sysroot/stray.dll" "$work/dest/"
rm -rf "$work/dest/licenses"
if PATH="$work/bin:$PATH" bash "$HERE/collect-licenses.sh" "$work/dest" "$work/src" "$work/sysroot" > "$work/out2.txt" 2> "$work/err2.txt"; then
    fail "出どころの分からない DLL があるのに止まらなかった"
fi
grep -q "stray.dll はどのパッケージにも属していない" "$work/err2.txt" || { cat "$work/err2.txt" >&2; fail "止まった理由が違う"; }
echo "OK: 出どころの分からない DLL で止まる"
