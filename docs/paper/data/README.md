# 計測の生データ（#32：マイクロコミットの速さ）

どれも `scripts/bench-micro-commit.mjs` の `--json` の出力。ファイル 200 個の作業ツリーで、保存を 1,000 回。履歴の長さ（10・100・300・1,000 回）ごとに、直前の window 回（`window` の値）の p50・p95・Git の起動回数・1 秒に追いつける保存の回数を記録している。

機械：AMD Ryzen 7 5700X、Windows 11（Git 2.50.1.windows.1）、同じ機械の WSL2（Ubuntu、Git 2.43.0、カーネル 6.6）。2026-10-01。

| ファイル | 比べたもの | 永続性の条件 | 注意 |
|---|---|---|---|
| `micro-commit-baseline-win32.json` | 5.0.0 までの記録（`microgit`＝CLI）と、ふつうの Git | CLI は power、Git は Git の既定（fsync なし） | **条件がそろっていない**。最後の区間（1,000 回）は差分テストと同時に走っていた。5.0.0 までの記録が履歴とともに遅くなることを示すために残す |
| `micro-commit-fast-win32.json` | 速い記録と、ふつうの Git | 速い記録は power、Git は既定 | **条件がそろっていない**（ベンチに `--durability` を足す前） |
| `micro-commit-linux-wsl2.json` | CLI・速い記録・ふつうの Git | CLI と速い記録は power、Git は既定 | **条件がそろっていない**。WSL2 の起動直後で、最初の区間（10 回）は仮想ディスクの暖まりの影響が大きい |
| `micro-commit-fast-vs-git-win32-power.json` | 速い記録と、ふつうの Git | 両方 power（Git は `core.fsync=loose-object,reference`・`core.fsyncMethod=batch`） | 条件をそろえた比較。Windows の計測は回によるばらつきが大きい |
| `micro-commit-fast-vs-git-win32-process.json` | 同上 | 両方 fsync なし | 同上 |
| `micro-commit-fast-vs-git-linux-wsl2-power.json` | 同上（WSL2） | 両方 power | 条件をそろえた比較 |
| `micro-commit-fast-vs-git-linux-wsl2-process.json` | 同上（WSL2） | 両方 fsync なし | 条件をそろえた比較 |

## 保存 1 回の処理全体（#37）

VS Code の中で保存を繰り返して計った、1 回ごとの段階ごとの時間（`src/test/suite/overlayBackend.test.ts`、`MICROGIT_TEST_SAVE_BENCH`）。

| ファイル | 内容 |
|---|---|
| `save-pipeline-win32-before.json` | 手元の Windows、#37 の前（保存 200 回） |
| `save-pipeline-win32-offqueue.json` | 画面の更新などを列の外へ出した後 |
| `save-pipeline-win32-policy.json` | ブランチの確認で Git を起動しなくした後 |
| `save-pipeline-win32-delta.json` | 層の作成で Git を起動しなくした後 |
| `ci-36807397421/save-bench-*.json` | CI の 5 つの環境（公開版と同じ形、保存 100 回）。Ubuntu 22.04・24.04 arm・Windows はカーネル版、Ubuntu 24.04・macOS は Node.js 版 |

論文や記事に使うときは、条件をそろえた 4 つ（`fast-vs-git-*`）と、5.0.0 までの記録の伸び方（`baseline-win32` と `linux-wsl2` の `cli`）を分けて書く。
