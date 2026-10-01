# OverlayFS ゴールデンテスト

| 項目 | 内容 |
|---|---|
| Issue | #10（Epic #8、Phase 0 の最初の成果物） |
| 版 | 第 2 版（2026-09-26）：CI での自動実行とカーネルのバージョン差の検出を追加。初版（2026-09-25）はマージ済みビューの比較のみ |
| 関連 | [要件定義書](./microgit-kernel-feature-portability-requirements.md) FR-1・FR-2・NFR-5、[補足](./microgit-kernel-feature-portability-supplement.md) S-4・S-13、[NodeOverlay.md](./NodeOverlay.md) |

## 1. 目的

Linux カーネルの OverlayFS の挙動を正解として記録し、全バックエンドの受け入れ基準をそれに揃える。
FR-1（全ホストで同一の挙動）、FR-2（既存テストが新実装でも通る）、NFR-5（フォールバック維持）の受け入れ基準はどれも「同一テスト」に依存しているのに、そのテストが未定義だった（補足 S-13）。

今回の版で比べるのは **各コミット時点のマージ済みビュー**（FR-2 の `view`）だけ。upper の中身（whiteout の表現、opaque の xattr、redirect）は比べない。Node 実装のレイヤ形式はカーネルと意図的に違う（`.wh.*` ファイル）ので、層そのものを比べても意味がないため。

## 2. 仕組み

```
scripts/golden/overlayfs-scenarios.mjs   シナリオ（正本。両側がこれを読む）
scripts/golden/record-kernel.mjs         カーネルで期待値を記録 → test/golden/overlayfs/*.golden, meta.json
scripts/golden/check-node.mjs            Node 実装で流して照合  → test/golden/overlayfs/node-known-diffs.txt と比較
```

### 2.1 シナリオ

コミットの列。各コミットは親（省略時は直前）と操作（`write` / `rm` / `rmdir` / `mkdir` / `mv`）を持つ。同じ親を持つコミットを置くと枝分かれになる。書式はシナリオファイル冒頭のコメントを参照。

### 2.2 カーネル側（record-kernel.mjs）

- `unshare -Urm` で非特権のユーザー／mount 名前空間に入り、その中で mount する。Windows では `wsl.exe` 経由で同じことをする
- コミット i ＝ 祖先の層を `lowerdir` に積み、空の `upperdir` に操作を書いて unmount したもの。凍結した upper が次のコミットの lower になる（FR-2 の初期案そのまま。補足 S-5 の遅延 mount やバッチ凍結は #12 で決める）
- 期待値 ＝ 祖先＋自分の層だけを `lowerdir` にした読み取り専用 mount の中身
- 出力形式：1 行 1 エントリ、`種別<TAB>パス[<TAB>詳細]`、パスのバイト順。種別は `d`（ディレクトリ）、`f`（ファイル、詳細は sha256）、`l`（シンボリックリンク、詳細はリンク先）、`o`（その他）

**罠：** ユーザー名前空間で mount すると、workdir の中に名前空間の root 所有・パーミッション 000 の `work` ディレクトリが残る。名前空間の外からは消せないので、後片付けは名前空間の中（スクリプトの `trap`）でやる。

### 2.3 Node 側（check-node.mjs）

MicroGit の保存経路と同じ道を通す。操作を shadow Git の作業ツリーに当ててコミットし、`exportCommitLayer` → `ensureExpandedView` で得たビューを 2 通り比べる。

| モード | 中身 |
|---|---|
| saved | 保存時に `expandViewAfterExport` が親ビューから伸ばしたビュー |
| rebuilt | `views/` を消して、レイヤだけから組み直したビュー |

コミットの作者と日時は固定して、コミットハッシュを毎回・どの OS でも同じにしている。Node 側の壊れ方（§4 の N-3）で、ツリーの `git show` 出力がファイルに書かれ、その中にハッシュが混ざるため。

例外はエラーの種類を残さず `! error` とだけ記録する。同じ失敗でも OS でコードが変わるため（ディレクトリの `unlink` は Windows で `EPERM`、Linux で `EISDIR`）。種類は `--verbose` で見られる。

### 2.4 既知の食い違いの一覧

Node 実装がカーネルと食い違う点は `node-known-diffs.txt` にそのまま記録してある。照合結果がこの一覧と **違えば失敗** する。新しい食い違いが出たときも、既知の食い違いが直ったときも気づけるようにするため。直したら `--update-known` で一覧を書き直す。

## 3. 使い方

```bash
npm run golden:check                       # どの OS でも可。CI でも実行する
npm run golden:check -- --update-known     # 既知の一覧を今の結果で書き直す
npm run golden:record                      # 期待値を取り直す。Linux か、WSL2 のある Windows で
node scripts/golden/record-kernel.mjs --check          # 取り直した結果を記録済みの期待値と比べる（書き換えない）
node scripts/golden/record-kernel.mjs --check --sudo   # 同上。非特権のユーザー名前空間が使えない Linux で、root として mount する
```

シナリオを足したら `golden:record` → `golden:check -- --update-known` の順に流し、一覧に増えた行を §4 に分類して書く。

### 3.1 CI で自動的に流れるもの（2026-09-26 から）

| ワークフロー | ジョブ | 中身 |
|---|---|---|
| `ci.yml` | test | `check-node.mjs`：Node 実装の食い違いが既知の一覧どおりか |
| `ci.yml` | golden-kernel（ubuntu-22.04 / ubuntu-24.04） | `record-kernel.mjs --check --sudo`：ランナーのカーネルで期待値を取り直し、記録済みのものと一致するか。2 つのランナーはカーネルのバージョンが違うので、バージョン差で結果が変わらないかを毎回確かめる（補足 S-4） |
| `guest.yml` | guest（arm64 / x86_64） | `check-guest.mjs`：最小ゲスト（Linux 6.18.53）を QEMU で起動して 12 シナリオを流し、期待値と完全に一致するか |

`ci.yml` は `master` と `feature/kernel-portability` への push とプルリクエストで、`guest.yml` はゲスト・シナリオ・期待値に関わるファイルが変わったときに動く。

GitHub Actions の Ubuntu では `kernel.apparmor_restrict_unprivileged_userns = 1` で非特権のユーザー名前空間が止められている（2026-09-26 に確認、補足 S-3）。そのため CI では `sudo unshare -m` で root として mount する。mount オプションは同じ `userxattr` のままなので、非特権での記録と条件は揃っている。

## 4. 現行 Node 実装との食い違い

| 時点 | 食い違うビュー | 内訳 |
|---|---|---|
| 2026-09-25（初版） | 12 シナリオ中 16 | N-1〜N-5 |
| 2026-09-26（#21 の修正後） | 12 シナリオ中 **8** | N-1・N-2 だけ。N-3〜N-5 は直した |

どちらの時点も、Windows と WSL2 上の Linux（Node 22）の両方で同じ一覧になることを確認した。

| # | シナリオ | 食い違い | 原因 | 分類 |
|---|---|---|---|---|
| N-1 | delete-dir、rename-dir | ディレクトリを中身ごと消す・名前を変えると、Node のビューには空になった元のディレクトリ（`d`、`d/sub`）が残る | Git はディレクトリを記録しないので、`exportCommitLayer` はファイル単位の whiteout しか書けない。`applyLayerOntoMerge` はファイルを消すだけで、空になった親は残す | **Git を正本にする限り避けられない** |
| N-2 | empty-dir | 空ディレクトリが Node のビューに出ない | Git は空ディレクトリを記録しない | **同上** |
| N-3 | file-to-dir | 保存時に `exportCommitLayer` が例外で止まる。レイヤにはファイル `p` として `git show <commit>:p`（ツリーの一覧）が書かれ、組み直したビューにその壊れたファイルが出る | `git show <commit>:<path>` が成功すればファイルとみなしている。`p` がツリーになっても成功するため一覧を書き、続く `p/q.txt` の mkdir が失敗する | **#21 で修正**（2026-09-26） |
| N-4 | dir-to-file | 保存時に例外。組み直すときも例外 | 保存時：消えた `p/q.txt` の whiteout を、ファイルになった `p` の下に作ろうとする。組み直し時：既存のディレクトリ `p` を `unlinkSync` で消そうとする | **#21 で修正** |
| N-5 | whiteout-lookalike-name | `.wh.` で始まる普通のファイルが消える。`d/.wh.x` しか持たない `d` はディレクトリごと出ない | Node 実装は whiteout を「`.wh.<名前>` という空ファイル」で表す（AUFS 方式）ので、普通のファイルと区別できない。カーネルの whiteout は 0/0 のキャラクタデバイス | **#21 で修正**（whiteout を層の外のメタデータに持つ、レイヤ形式 v2） |
| N-6 | （シナリオ外。スモークテストで確認） | Git の既定設定（`core.quotepath=true`）では、日本語など ASCII 以外の名前のファイルがレイヤに入らず「削除」扱いになる | `--name-only` の出力が `"ã¡..."` のようにエスケープされ、それをパスとして使っていた | **#21 で修正**（Git の出力を `-z` で読む） |

### 4.1 分類から言えること

- **N-1・N-2 は O-10（正本の定義、#11）の判断材料。** カーネルは「ファイルを 1 つずつ消した」（`delete-file` の commit 3 ではディレクトリが残る）と「ディレクトリごと消した」（`delete-dir` ではディレクトリも消える）を区別するが、Git からはこの 2 つを区別できない。したがって Git を正本にして層を Git から組み直す設計にすると、**カーネルのバックエンドでも組み直した時点で同じ差が出る**。「空になったディレクトリは消す」という対処は、今度は `delete-file` と食い違う
- **N-3〜N-6 は #21 で直した。** カーネル移植とは関係なく、今の MicroGit の利用者にも起きうる不具合だった（ファイルとディレクトリの置き換え、`.wh.` で始まるファイル名、日本語のファイル名）。直し方は [NodeOverlay.md](./NodeOverlay.md) のレイヤ形式 v2 と、[学習用 02](./learning/02-git-objects-and-layer-format.md)
- 残りは N-1・N-2 だけで、どちらも Git がディレクトリを記録しないことから来る。FR-1 の対象にフォールバックを含めるかどうか（補足 S-4）は #11 で決める

## 5. 記録した環境（meta.json）

| 項目 | 値 |
|---|---|
| カーネル | 6.6.87.2-microsoft-standard-WSL2（WSL2 / Ubuntu 24.04） |
| 明示した mount オプション | `userxattr`（非特権 mount に必須） |
| 書き込み mount の実際のオプション | `rw,relatime,redirect_dir=nofollow,uuid=on,userxattr` |
| view mount の実際のオプション | `ro,relatime,redirect_dir=nofollow,userxattr` |

確定した事実：
- WSL2 のカーネルでは、Ubuntu 24.04 でも非特権ユーザー名前空間での overlay mount が通る。補足 S-3 の「Ubuntu 23.10 以降は AppArmor が非特権ユーザー名前空間を制限する」は、WSL2 のカーネルでは効いていない
- `userxattr` 付きの非特権 mount では、`redirect_dir` を指定しないと `nofollow` になった（root での mount とは比べていない）

- `redirect_dir=nofollow` なので、下の層にあるディレクトリの rename は `EXDEV` になる（2026-09-26、Go の agent で確認。[guest-phase1.md](./guest-phase1.md) §3）。`mv` はコピーと削除で代わりにやるので、ビューは一致するが upper にはディレクトリ全体のコピーが入る。大きなディレクトリの rename が遅くなりうるので、#12（O-13）と性能要件（NFR-2）に関わる
- GitHub Actions の Ubuntu 24.04 では非特権ユーザー名前空間が使えない（`apparmor_restrict_unprivileged_userns = 1`）。CI で期待値を取り直すなら、`sudo` を使うか最小ゲストの中で記録する

期待値は **このカーネルとオプションでの結果** であり、#12 で固定する mount オプションと最低カーネルバージョンが決まったら取り直す（`record-kernel.mjs` の `MOUNT_OPTS`）。

## 6. 比べる範囲の決定（2026-09-26、#10 を閉じるときに決めた）

| 項目 | 扱い | 理由 |
|---|---|---|
| ホストへの反映後の一致（大文字小文字だけ違う名前、Windows の予約名、Unicode の正規化差） | **#16（Boundary Guard）に移す** | ホストへ反映する処理そのものが Boundary Guard の責務なので、そこで Node とカーネルの両バックエンドの反映結果を比べる差分テストとして作る |
| 複数のカーネルバージョン | **済み**（§3.1 の golden-kernel ジョブ） | — |
| シンボリックリンク、実行ビット | **シナリオには入れない** | MicroGit が記録するのは VS Code で保存したテキスト文書だけで、shadow の作業ツリーには通常のファイルとして書かれる（`runShadowCommit` の `fs.writeFileSync`）。シンボリックリンクや実行ビットは記録される経路が無い。agent の view は `l`（リンク）と `o`（その他）を出せるので、記録の対象が広がったら足せる |
| ハードリンク、xattr | **入れない** | 同上。Git もこれらを記録しない |
| upper の中身（whiteout・opaque・redirect の表現）とコピーアップの挙動 | **#12 で扱う** | mount オプションを固定するときに、その影響として確かめる |
| 性能（レイテンシ・スループット） | **#14 で扱う** | MicroGit に組み込んだ経路で測る |
