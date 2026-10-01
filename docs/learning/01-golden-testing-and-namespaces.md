# 01. テストの正解をどこから持ってくるか／名前空間で安全に mount する

| 項目 | 内容 |
|---|---|
| 関係する Issue | #10（OverlayFS ゴールデンテスト） |
| 実装 | [scripts/golden/](../../scripts/golden/)、[.github/workflows/ci.yml](../../.github/workflows/ci.yml) の golden-kernel ジョブ |
| 詳しい仕様 | [overlayfs-golden-test.md](../overlayfs-golden-test.md) |

---

## 1. 何のための仕組みか

テストを書くときは「正しい答え」が要る。普通は人が考えて書く（`assert.equal(add(1, 2), 3)`）。

ところが今回確かめたいのは「OverlayFS と同じ挙動か」（要件 FR-1）である。OverlayFS の挙動は細かい。

- 下の層のファイルを消したら、上の層に何が置かれるのか
- フォルダを消して同じ名前で作り直したら、下の層の中身は見えるのか
- フォルダの名前を変えたらどうなるのか

これを人が全部正しく書き下すのは難しく、書き間違えたら「間違った正解」でテストすることになる。

そこで **本物の Linux カーネルに実際にやらせて、その結果を正解として記録する**。これがゴールデンテスト（golden test）である。

---

## 2. 仕組み

### 2.1 テストの正解の 3 つの作り方

| 作り方 | 正解の出どころ | 例 |
|---|---|---|
| 手で書く | 人の頭 | 普通の単体テスト |
| **ゴールデンテスト**（スナップショットテスト） | 過去の実行結果や、信頼できる実装の結果をファイルに保存したもの | Jest の Snapshot Testing、このリポジトリの `*.golden` |
| **差分テスト**（differential testing） | 別の実装に同じ入力を与えた結果 | 同じシナリオを Node 版とカーネル版で流して比べる |

このリポジトリは 2 つを組み合わせている。

```
                 ┌─→ 本物のカーネル（record-kernel.mjs）─→ *.golden（正解）
シナリオ 12 本 ──┼─→ Node.js 版（check-node.mjs）     ─→ 正解と比べる。食い違いは既知の一覧と照合
                 └─→ 最小ゲスト（check-guest.mjs）    ─→ 正解と比べる。食い違いは許さない
```

「正解を出してくれる別の実装」のことを **テストオラクル**（test oracle）と呼ぶ。ここでは Linux カーネルがオラクルになっている。

### 2.2 既知の食い違いの一覧（approval testing）

Node 版は、正解と一致しない点がある（空ディレクトリなど。[overlayfs-golden-test.md §4](../overlayfs-golden-test.md)）。一致しないたびに失敗させると CI がずっと赤くなるので、**今の食い違いをそのままファイルに記録し、それと同じかどうかを確かめる**ようにしている（`node-known-diffs.txt`）。

- 新しい食い違いが出た → 失敗（壊した）
- 既知の食い違いが消えた → これも失敗（直ったなら一覧を更新して、直したことを記録に残す）

このやり方は approval testing とも呼ばれる。「今の出力を人が確認して承認（approve）し、以後はそれと比べる」という考え方である。

### 2.3 mount するには権限が要る

OverlayFS を使うには mount（ファイルシステムの取り付け）が必要で、普通は root（管理者）しかできない。テストのたびに root で mount すると、失敗したときに mount が残ったり、ほかのプログラムから見えたりする。

そこで Linux の **名前空間**（namespace）を使う。名前空間は「プロセスごとに、世界の見え方を分ける」仕組みである。

| 名前空間 | 分けるもの | `unshare` のオプション |
|---|---|---|
| mount 名前空間 | どこに何が mount されているか | `-m` |
| ユーザー名前空間 | ユーザー ID の対応（中では root、外では普通のユーザー） | `-U`（`-r` で自分を中の root に対応づける） |

`unshare -Urm bash` は、次のような部屋を作ってその中で bash を動かす。

```
外の世界（普通のユーザー usudon）
  └ 新しい部屋（ユーザー名前空間＋mount 名前空間）
       中では root として振る舞える（ただし外の root の権限は無い）
       ここでした mount は、部屋の外からは見えない
       部屋が無くなると（bash が終わると）mount も消える
```

カーネル 5.11 以降は、この「部屋の中の root」でも OverlayFS を mount できる。そのとき必要なのが `userxattr` オプションで、OverlayFS が管理用の情報（opaque の印など）を `trusted.*` ではなく `user.*` の拡張属性に書くようにする。

### 2.4 それでも止められることがある

ユーザー名前空間は便利だが、「部屋の中の root」になれることは、カーネルの攻撃面を広げる。実際に、ユーザー名前空間と OverlayFS を組み合わせた権限昇格の脆弱性がある（CVE-2023-0386 など）。

そのため Ubuntu 23.10 以降は、AppArmor というセキュリティの仕組みで、非特権のユーザー名前空間を既定で制限している。GitHub Actions の Ubuntu 24.04 でも止められていた。

```
$ sysctl kernel.apparmor_restrict_unprivileged_userns
kernel.apparmor_restrict_unprivileged_userns = 1
$ unshare -Urm true
unshare: write failed /proc/self/uid_map: Operation not permitted
```

WSL2 のカーネルでは AppArmor が有効になっておらず、同じ Ubuntu 24.04 でも使えた。**同じディストリビューションでも、カーネルと設定によって使えたり使えなかったりする**。これは #14（Linux で VM を使わない経路）で、使えないときに自動で切り替える理由になっている。

CI では `sudo unshare -m`（本物の root で、mount 名前空間だけ分ける）で代わりにやっている（`record-kernel.mjs --sudo`）。mount オプションは同じ `userxattr` なので、条件は揃う。

### 2.5 カーネルのバージョンで挙動が変わりうる

OverlayFS の mount オプションの既定値（`redirect_dir`、`metacopy`、`index` など）は、カーネルのバージョンで変わってきた。同じシナリオでも、カーネルが違えば結果が変わるかもしれない（補足 S-4）。

そこで CI では、カーネルのバージョンが違う 2 つのランナー（ubuntu-22.04 と ubuntu-24.04）で期待値を取り直し、記録済みのものと一致するかを毎回確かめている（`golden-kernel` ジョブ）。加えて、最小ゲストは Linux 6.18.53 で動いていて、期待値を記録した WSL2 は 6.6 である。今のところ、どれも同じ結果になっている。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| シナリオの定義 | [overlayfs-scenarios.mjs](../../scripts/golden/overlayfs-scenarios.mjs) の `scenarios` |
| シナリオを bash の手順に変換する | [record-kernel.mjs](../../scripts/golden/record-kernel.mjs) の `buildScript()`、`opToShell()` |
| 名前空間に入って実行する | 同 `runInLinuxNamespace()`（`unshare -Urm`、`--sudo` なら `sudo unshare -m`、Windows なら `wsl.exe` 経由） |
| mount の後片付けを名前空間の中でする | 同 `buildScript()` の `trap 'rm -rf "$T"' EXIT` |
| 記録済みの期待値と比べる | 同 `matchesRecorded()`（`--check`） |
| Node 版と比べて既知の一覧と照合する | [check-node.mjs](../../scripts/golden/check-node.mjs) |
| CI で自動実行 | [ci.yml](../../.github/workflows/ci.yml) の `test` と `golden-kernel` |

---

## 4. 手を動かして確かめる

WSL2 のある Windows か、Linux で試せる。

1. **正解が本物のカーネルから来ていることを確かめる**
   ```bash
   node scripts/golden/record-kernel.mjs --check
   ```
   `OK: 12 scenarios がこのカーネルでも記録済みの期待値どおり` と出る。

2. **正解を壊して、失敗のしかたを見る**：`test/golden/overlayfs/delete-dir.golden` の `## commit 2` の下にある `f	keep.txt	...` の行を消して、もう一度 1 を流す。`+ f	keep.txt ...`（カーネルの結果にだけある行）と出て失敗する。見終わったら `git checkout -- test/golden` で戻す。

3. **部屋の外から mount が見えないことを確かめる**（WSL2 で）
   ```bash
   unshare -Urm bash -c 'mkdir -p /tmp/l /tmp/u /tmp/w /tmp/m; mount -t overlay overlay -o lowerdir=/tmp/l,upperdir=/tmp/u,workdir=/tmp/w,userxattr /tmp/m && grep /tmp/m /proc/mounts; sleep 30' &
   grep /tmp/m /proc/mounts   # 何も出ない（部屋の外からは見えない）
   ```

4. **CI の結果を読む**：GitHub の Actions で `Continuous Integration` の `OverlayFS golden on ubuntu-22.04 kernel` を開き、`Kernel version` の行と、最後の `OK:` の行を見る。

---

## 5. もっと知りたいとき

- `man 7 namespaces`、`man 7 user_namespaces`、`man 7 mount_namespaces`、`man 1 unshare`（man7.org で読める）
- Linux カーネルのドキュメント「Overlay Filesystem」（docs.kernel.org/filesystems/overlayfs.html）の「Non-standard behavior」と「Permission model」
- Ubuntu 23.10 のリリースノートの、非特権ユーザー名前空間の制限の項
- テストの考え方：「test oracle」「golden file testing」「differential testing」「approval testing」で検索する
