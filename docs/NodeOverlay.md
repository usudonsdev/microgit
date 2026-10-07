# Node.js Overlay Engine（空間で時間を買う）

OS mount は使わない。Node.js だけで OverlayFS 意味論を実装し、  
**展開済みビューをストレージに保持して切替時間を短縮する**（OverlayGit の利点）。

次期メジャーではカーネルの OverlayFS を使うバックエンドが加わり（Epic #8）、この Node.js 版はそれが使えない環境の **フォールバック**（NFR-5）になる。

## 方針

| 項目 | 内容 |
|------|------|
| 差分レイヤ | `layers/<hash>/` に変更ファイルのフル実体。消えたパス（whiteout）は層の外の `layers/<hash>.json` |
| 展開ビュー | `views/<hash>/` にそのコミット時点の完全ツリーを永続化 |
| 伸ばし方 | 親ビュー + 新レイヤ（O(変更)）。再訪問はビューをそのまま利用 |
| 合成 | ビュー → `merge/` → `write/<mb-*>/` を最上層 |
| 同期 | 内容同一ファイルはワークスペースへコピーしない |
| OS | Windows / macOS / Linux 同一経路 |
| 正本 | shadow の Git。`.microgit/overlay/` の中身はすべて Git から作り直せるキャッシュ |

```
保存時:  layer 書き出し（親のビューがあれば、そこから差分展開して views/<hash>/ も作る）
切替時:  いちばん近い展開済みのビュー＋必要な層で views/<tip>/ を作る（構築済みなら再計算しない）→ write → workspace
```

### 保存のときにビューを作らない（2026-10-01、#41）

5.0.0 の途中まで、保存のたびに `applyOverlayCheckout(head, { syncWorkspace: false })` でビューと merge を作り直していた。次に過去に戻るときの下ごしらえで、保存には要らない。手元の Windows で保存 40 回のうち最後の 20 回は 1 回 1,190.2 ms（履歴とともに伸びる）かかっていた。これをやめ、保存 1 回の処理全体は 1,317.5 → 124.0 ms、CI の Ubuntu 24.04 で 512.0 → 17.6 ms、macOS で 666.6 → 44.8 ms になった。過去に戻る操作は遅くなっていない（1,854.7 → 1,766.6 ms）。

**残っているもの（#43）**：上の「保存時」の括弧の中、`exportCommitLayer` → `expandViewAfterExport` は、親のコミットのビューがあれば、そのフォルダを丸ごとコピーして新しいビューを作る。保存を続けているだけなら親のビューが無いので動かないが、一度過去に戻った後の保存では毎回走る（ファイル数に比例）。

## レイヤ形式 v2（2026-09-26、#21）

```
.microgit/overlay/
  meta/format.json          {"layerFormat": 2}
  layers/<hash>/            このコミットで追加・変更されたファイルの中身（利用者のファイルだけ）
  layers/<hash>.json        {"version": 2, "whiteouts": ["消えたパス", ...]}
  write/<mb-*>/ と write/<mb-*>.json   書き込みレイヤ（同じ形式）
  views/<hash>/             そのコミット時点の完全なツリー
```

| 決めたこと | 理由 |
|---|---|
| whiteout を層の外のメタデータに持つ | v1 は層の中に `.wh.<名前>` という空ファイルで置いていた（AUFS／OCI イメージと同じ方式）。利用者の `.wh.` で始まるファイルと区別できず、そのファイルが消えた（N-5）。層の外に置けば、どんな名前とも衝突しない |
| メタデータを層の **中** ではなく **横** に置く | 除外対象は `.microgit/`（移行前は直下の `.microgit_*` 3 フォルダ）だけなので、層の中に管理用のファイルを置くと、利用者の同じ名前のファイルとぶつかりうる |
| メタデータを最後に書く | 「メタデータがある＝書き出しが最後まで終わった層」になる。途中で止まった層は `ensureLayerExists` が作り直す。whiteout だけの層（削除だけのコミット）も完成を判定できる |
| Git の出力は `-z` と `--raw` で読む | `-z` ならパスがエスケープされない（N-6）。`--raw` ならモードと状態（追加 A・変更 M・種類の変化 T・削除 D）が分かる。v1 は `git show` の成否でファイルの有無を判断していて、ディレクトリでも成功した（N-3） |
| ファイルに置き換わったディレクトリの子は whiteout にしない | 上の層のファイルは下の層のディレクトリを丸ごと隠す（OverlayFS と同じ）。子の whiteout を書こうとすると、ファイルの下にディレクトリを作ることになり失敗した（N-4） |
| 層を重ねるときは whiteout を先に全部当てる | 同じ層に「ファイル `p` の whiteout」と「新しい `p/q.txt`」が並ぶことがある。v1 は `readdir` の順番（NTFS では名前順、ext4 ではハッシュ順）で処理していたので、OS で成否が変わりえた |
| 古い形式のキャッシュは捨てる | `layers/`・`views/`・`write/`・`merge/` と `checkout.json` を消し、`dag.json` の nodes を空にする。`managedFiles`（ワークスペースから消すべきファイルの判定に使う）は残す。Git が正本なので履歴は失わない |
| 再帰削除は自前の `removeTree` | Windows 版の Node 25.1.0 では、ASCII 以外の名前のディレクトリに `fs.rmSync({ recursive: true })` を使うとプロセスが落ちる（22・24 では起きない）。拡張機能は VS Code の Node（22 系）で動くが、将来に備える |

## カーネルの OverlayFS との違い（残っているもの）

[overlayfs-golden-test.md](./overlayfs-golden-test.md) §4 の N-1・N-2。どちらも Git がディレクトリを記録しないことから来る。

- ディレクトリを中身ごと消す・名前を変えると、空になった元のディレクトリがビューに残る（N-1）
- 空ディレクトリはビューに出ない（N-2）

ワークスペースへの同期はファイル単位なので、利用者から見える影響は無い。

## 設定

| キー | 既定 | 意味 |
|------|------|------|
| `microgit.useOverlayCheckout` | `true` | Overlay checkout を有効化 |

## コマンド

- `MicroGit: Overlay Status` — `backend=nodejs space-for-time=views`

## 検証

```bash
npm run test:overlay   # スモークテスト（CI でも実行）。#21 で直した点の回帰テストを含む
npm run golden:check   # カーネルの OverlayFS との突き合わせ（overlayfs-golden-test.md）
npm run bench          # 速度ベンチ
```
