# ADR-0002: 永続性の既定は「電源断でも失わない」

| 項目 | 内容 |
|---|---|
| 状態 | 採用 |
| 日付 | 2026-09-26 |
| 決めた人 | Claude（利用者の「#19 まで自律的に進める」の指示のもとで） |
| 関係 | #11（O-11）、補足 S-8、要件 FR-4・NFR-2、[ADR-0001](./0001-source-of-truth.md)、実装 [src/durability.ts](../../src/durability.ts) |

## 背景

補足 S-8 は、FR-4（連続した保存を取りこぼさない）の「取りこぼさない」がどの水準なのかが決まっていないと指摘した。

- プロセス（VS Code・拡張機能）が落ちても失わない
- 電源断や OS の異常終了でも失わない

ADR-0001 で正本を shadow の Git にしたので、永続性は Git への書き込み方で決まる。

Git 2.50.1 の文書（`git help config` の `core.fsync`）によると、ほとんどの環境の既定は `core.fsync=committed,-loose-object` で、「性能は良いが、異常終了で直近の作業を失う恐れがある」。MicroGit は保存のたびに **ばらのオブジェクト**（loose object）と **ref**（`refs/heads/micro-history`）を書くが、既定ではどちらもディスクへの書き込みを待たない。電源断のあと、直前の記録が消える、あるいは ref がディスクに残ったのにオブジェクトが残らずリポジトリが壊れる、ということが起こりうる。

## 決定

**既定を「電源断でも失わない」（`power`）にする。** 設定 `microgit.durability` で `process`（Git の既定のまま）を選べるようにする。

- `power`：Git の呼び出しに `-c core.fsync=loose-object,reference -c core.fsyncMethod=batch` を付ける。拡張機能の `runGit` と、shadow の bare に書く `shadowStore.ts` の `runGitDir` の両方
- `process`：何も足さない
- `batch`：ばらのオブジェクトはまとめて書き出し、最後に 1 回だけディスクのキャッシュを空にさせる。ref は通常の fsync になる

## 理由

計測（`scripts/bench-durability.mjs`、Windows 11・Git 2.50.1、保存 1 回ぶんの 4 手順を 40 回）：

| 回 | process（既定） | power |
|---|---|---|
| 1 回目 | p50 99.9 ms | p50 106.9 ms |
| 2 回目 | p50 100.4 ms | p50 102.5 ms |

差は数 ms で、計測のばらつき（±5 ms 程度）と同じくらいだった。時間のほとんどは Git のプロセスを 4 回起動するのにかかっている。保存の処理はバックグラウンドの列で動いていて、利用者を待たせない。この代償で「保存ジョブが終わった記録は電源断でも失わない」を得られるなら、既定にする価値がある。

## 採らなかった案

- **既定を process にする**：代償がほとんど無いのに、電源断でリポジトリが壊れる可能性を残す理由が無い
- **`core.fsync=all`**：index（`.microgit_shadow` のステージング）まで fsync する。index は shadow の作業ツリーから作り直せるので、守る必要が無い
- **MicroGit 側で fsync を呼ぶ**：Git が書くファイルの順番と場所を MicroGit が知る必要があり、Git の内部に依存する

## 引き受けること

- 遅いディスク（HDD、ネットワークドライブ）では、保存 1 回あたりの時間が目に見えて増える可能性がある。そのときは `process` に切り替えられる
- 「保存ジョブが終わった記録」が対象で、VS Code が保存イベントを出す前や、列に積まれてまだ処理されていない保存は対象外（それは今までどおり）
- ワークスペースのファイルそのものの永続性は、VS Code の保存処理の範囲で、MicroGit は関与しない
- Git 2.36 より古い Git は `core.fsync` を知らず、無視する（fsync されない）。エラーにはならない

## 確かめ方

- 単体テスト `src/test/unit/durability.test.ts`：既定と不明な値は power、process は引数なし、power の引数で保存と同じ Git の手順が通る
- 速さ：`node scripts/bench-durability.mjs`
- 電源断そのものの試験は自動化していない（VM で強制終了して `git fsck` する試験は、必要になったら足す）
