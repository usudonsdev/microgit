# カーネル版の Overlay バックエンド（MicroGit への組み込み）

| 項目 | 内容 |
|---|---|
| 版 | 初版（2026-09-26、#14） |
| 要件 | FR-5（ホストに応じた自動選択）、NFR-5（Node.js 版をフォールバックとして維持）、NFR-2（Phase 0：Linux ネイティブが Node.js 版より速い）、AD-2（Linux では VM を使わない）、補足 S-3 |
| 実装 | [src/kernel/](../src/kernel/)（`backendSelector.ts`・`launchers.ts`・`agentConnection.ts`・`layerFeeder.ts`・`kernelBackend.ts`）、[src/extension.ts](../src/extension.ts) の `createBackendSelector`・`applyKernelCheckout`・`runShadowCommit` |
| 関連 | [ADR-0001](./adr/0001-source-of-truth.md)（Git が正本）、[ADR-0003](./adr/0003-layer-compaction.md)（コンパクション）、[ADR-0006](./adr/0006-windows-named-pipe.md)（Windows の通り道）、[agent-protocol.md](./agent-protocol.md)、[boundary-guard.md](./boundary-guard.md)、[学習用 07](./learning/07-backend-selection-and-ipc.md) |

## 1. 何が変わるか（利用者から見て）

MicroGit の「過去に戻る」（タイムトラベル、ブランチの切り替え）が、カーネルの OverlayFS で組み立てた過去の姿から反映されるようになる。使えない環境では、これまでどおり Node.js 版で動く。

| 設定 | 既定 | 意味 |
|---|---|---|
| `microgit.overlayBackend` | `auto` | `auto`：カーネル版を試し、だめなら Node.js 版（黙って切り替える）。`kernel`：カーネル版を使い、だめなら理由を知らせて Node.js 版。`nodejs`：Node.js 版だけ |
| `microgit.kernel.qemuPath` | （空） | Windows の QEMU の場所。空なら同梱のもの |
| `microgit.kernel.accel` | `auto` | Windows の QEMU の動かし方（`whpx` → `tcg`） |
| `microgit.kernel.memoryMb` | `256` | 最小ゲストのメモリ |

`MicroGit: Overlay Status` で、どちらのバックエンドで動いているか、起動にかかった時間、層の数、最後に戻ったときの時間の内訳が見られる。

## 2. 流れ

```
起動時        Backend Selector を作るだけ（カーネル版はまだ起動しない）
最初の保存    shadow にコミット → カーネル版の起動を裏で始める → 今回は Node.js 版の層を書き出す
以降の保存    shadow にコミット → カーネル版が動いていれば、そのコミットの層を agent に作らせる（recordCommit）。
              速い記録（#32）が「親からの変化」を渡したら、Git を起動せずにそれで作る（#37）
過去に戻る    カーネル版が動いていなければ起動を待つ → 層を用意（ensure）→ view → Boundary Guard → ワークスペース
              どこかで失敗したら、その場で Node.js 版で続ける
VS Code 終了  agent（仮想マシン）を止める
```

## 3. ホストごとの起動のしかた（launchers.ts）

| ホスト | 起動 | 必要なもの | 同梱の置き場所（VSIX） | 開発中の置き場所 |
|---|---|---|---|---|
| Linux（x64 / arm64） | `unshare -Urm <agent>`（VM なし） | カーネル 5.11 以降、`unshare` | `resources/kernel/linux-<arch>/microgit-agent` | `guest/out/<x86_64\|arm64>/init` |
| Windows（x64） | QEMU（WHPX → TCG）、名前付きパイプ | — | `resources/kernel/win32-x64/qemu/…`、`resources/kernel/guest/x86_64/Image` | `guest/.cache/qemu-win/`、`guest/out/x86_64/Image` |
| macOS（arm64） | `microgit-vm`（Virtualization.framework） | — | `resources/kernel/darwin-arm64/microgit-vm`、`resources/kernel/guest/arm64/Image` | `mac/.build/microgit-vm`、`guest/out/arm64/Image` |

- 「同梱の置き場所」に部品を置いた VSIX は `scripts/package-vsix.mjs` が作る（[release.md](./release.md)、#19）。Apple silicon Macにはdarwin-arm64、Intel MacにはNode.js版だけのuniversalを配る
- Linux の agent と macOS の `microgit-vm` は、起動の前に実行ビットを確かめ、無ければ付ける（`src/kernel/executable.ts`。VSIX を Windows で作ったり、GitHub Actions の成果物を通したりすると落ちるため）
- Linux で層を tmpfs に置くのは、カーネル 6.6 以降で `$XDG_RUNTIME_DIR` があるとき（tmpfs の `user.*` xattr が要る。ADR-0005）
- **起動できそうでも、本当に使えるかは起動して確かめる**。agent の ready を待ち、小さな層を 1 枚作って捨てるところまでやる（probe）。Ubuntu 23.10 以降のように非特権のユーザー名前空間が止められていると、ここで `unshare` が失敗して Node.js 版に切り替わる（補足 S-3。GitHub Actions の Ubuntu 24.04 で CI が毎回確かめる）
- macOSはApple silicon実機で確認済み（#17）。起動またはprobeに失敗すればNode.js版になる

## 4. Windows の通り道：名前付きパイプ（ADR-0006）

Windows 版 QEMU の stdio の chardev は、ホスト → ゲストが遅く、大きなデータで中身が壊れた。

| 1 回の commit の中身 | stdio | 名前付きパイプ |
|---|---|---|
| 16 KiB | 1,251 ms | 4 ms |
| 256 KiB | 20,139 ms | 3 ms |
| 1 MiB | 78 秒後に **中身が壊れて失敗**（`bad base64`） | 26 ms（往復で一致） |
| 4 MiB | — | 211 ms |
| 16 MiB | — | 2,308 ms（往復で一致） |

（2026-09-26、Windows 11、QEMU 11.1、WHPX）

そこで Windows では `-chardev pipe,id=proto,path=microgit-<128 ビットの乱数>` にし、MicroGit は `\\.\pipe\microgit-<乱数>` につなぐ。Linux の QEMU（CI）と mac の microgit-vm と Linux の VM なしは stdin/stdout のまま。

## 5. 層の供給（layerFeeder.ts、ADR-0003 の実装）

| 場合 | 作る層 |
|---|---|
| 速い記録が「親からの変化」（delta）を渡し、親の層が agent にあり、深さが 32 未満、層の数が 256 未満（#37） | delta の中身で差分の層を作る（`ensureFromDelta`。Git を起動しない）。使えなければ下の行に任せる |
| 親の層が agent にあり、深さが 32 未満 | 親との差分の層（`git diff-tree -r -z --raw`） |
| それ以外（キャッシュが空、親が無い、深すぎる） | そのコミットの完全なツリーの写しの層（親なし）。祖先を積み直さない |
| agent の層が 256 枚 | 全部捨ててから作る |
| agent が `EEXIST`・`UNKNOWN_LAYER`・`ENOSPC` を返した | 全部捨てて、写しの層として作り直す |

- 消えたパスは `rmdir`（無くても失敗しない）、追加・変更は `writeb64`（100755 は `755`、シンボリックリンクはリンク先の文字列のファイル）
- 中身は `git cat-file --batch` を 1 回起動してまとめて読む（ファイルごとに Git を起動しない）
- delta が付くのは、新しいコミットが親から変えたのが保存したファイル 1 つだけで、消えたファイルが無いとき（`src/fastMicroCommit.ts`）。差分テスト（`scripts/test/micro-commit-diff.mjs`）で、delta が `git diff-tree` の結果・中身・モードと一致することを毎回確かめる。手元の Windows で層の作成は 125.4 → 31.9 ms（#37）
- 1 回の commit の中身が 90 MiB を超えたら諦めて Node.js 版で続ける（agent の 1 行の上限 128 MiB に base64 で収めるため）

## 6. ワークスペースへの反映

agent の `view` と `readMany`（`TOO_LARGE` なら半分に分けて頼み直す）の結果を、必ず Boundary Guard（`syncWorkspaceFromGuest`）に通す。ゲストが直接ワークスペースに書く経路は無い（FR-3）。

- 消してよいのは、MicroGit が記録したことのあるパス（Node.js 版の `dag.json` の `managedFiles` と、shadow の履歴に出てきたパスの和）
- ワークスペースのファイルの sha256 は、大きさと更新時刻が同じなら計算し直さない（`.microgit_overlay/meta/kernel-sync-cache.json`）
- 反映しなかったものは出力に理由を出し、件数を通知する

## 7. 速さ（2026-09-26、`scripts/bench-backends.mjs`、ファイル 200・保存 40・行き来 30、中央値）

| 環境 | 保存 1 回ぶんの層 | 過去に戻る操作 | カーネル版の起動 |
|---|---|---|---|
| Linux（WSL2、VM なし、層は tmpfs） | Node.js 36.9 ms → **カーネル 10.8 ms** | Node.js 127.4 ms → **カーネル 21.6 ms** | 29 ms |
| Windows 11（QEMU、WHPX、名前付きパイプ） | Node.js 271.0 ms → **カーネル 135.0 ms** | Node.js 1,425.8 ms → **カーネル 169.7 ms** | 902 ms |

NFR-2 の Phase 0 の受け入れ基準（Linux ネイティブが Node.js 版より速い）を満たす。shadow のコミットを作る Git の時間（約 100 ms、ADR-0002）はどちらにも共通なので含めていない。

## 8. テスト

| テスト | 何を確かめるか | どこで |
|---|---|---|
| `src/test/unit/launchers.test.ts` | ホストごとの起動の計画と、使えない理由 | 単体テスト（Windows・Linux、CI） |
| `src/test/unit/backendSelector.test.ts` | 設定ごとの選び方、起動 1 回、使えないときの切り替え（すぐ終わる agent・mount できない agent・版違い）、落ちたときの起動し直し。偽の agent を使う | 単体テスト（同上） |
| `scripts/test/kernel-backend-e2e.mjs` | 15 シナリオ・126 回の過去に戻る操作で、カーネル版と Node.js 版のワークスペースがどちらも Git のツリーと一致するか。3 MiB、700ファイル、深さの上限 2、キャッシュ再構築も試す | WSL2（VM なし）、Windows（QEMU）、macOS（Virtualization.framework）、CI（QEMU arm64 / x86_64） |
| `scripts/test/native-fallback.mjs` | その環境でカーネル版が起動できるか。GitHub の Ubuntu 24.04 では `uid_map` の理由で Node.js 版に切り替わること（補足 S-3） | WSL2・Windows（kernel）、CI（fallback） |
| `src/test/suite/overlayBackend.test.ts` | 実際の VS Code の中で、MicroGit を有効にして保存し、過去に戻るコマンドでワークスペースが戻るか（日本語の名前、あとから作ったファイルの削除）。使ったバックエンドを Overlay Status で確かめる | Windows（kernel と nodejs の両方）、CI（nodejs） |

差分テストは、Node.js 版の既存の不具合（N-7：ファイル ⇔ ディレクトリの置き換えで過去に戻ると例外）と、Boundary Guard の弱点（中のファイルが消える予定のディレクトリをファイルに置き換えられない）を見つけた。どちらも #14 で直した。

## 9. 既知の制限

| 制限 | 扱い |
|---|---|
| macOSのvirtio-consoleは約64 KiBを超えるJSON 1行で停止する | Macだけ24 KiBずつ`stage` / `readChunk`。詳細はagent-protocol.md §4.1.1 |
| 1 回の commit の中身は 90 MiB まで（超えると Node.js 版） | 記録するのは保存したファイルだけなので、普通は届かない |
| 層はゲストのメモリに置く（既定 256 MB、tmpfs は半分） | 大きいリポジトリでは `microgit.kernel.memoryMb` を増やす。溢れたら `ENOSPC` で捨てて作り直し、それでもだめなら Node.js 版 |
| Dev Containers・Codespaces では試していない | 非特権のユーザー名前空間が使えなければ、probe で失敗して Node.js 版になる（S-3 と同じ仕組み） |
| カーネル版からあとで Node.js 版に切り替わると、Node.js 版の層を最初から作るので、最初の 1 回は遅い | `ensureLayerExists` が必要な分だけ作る |
| Windows on Arm、Intel Mac | 対象外（Node.js 版） |
