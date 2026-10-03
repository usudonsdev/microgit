# 人は何ミリ秒の遅れに気づくか：保存のときの処理の予算

| 項目 | 内容 |
|---|---|
| 目的 | 「保存のときに、マイクロコミットされていることに気づかなければ合格」（利用者、2026-10-03）を、測れる基準にする。そのために、人が遅れに気づく時間を先行研究から集め、MicroGit の保存の処理の予算に直す |
| 版 | 初版（2026-10-03） |
| 関係 | [ADR-0015](./adr/0015-defer-git-writes.md)（書き出しの遅延と、64 回目の保存の引っかかり）、[overlayfs-research-directions.md](./overlayfs-research-directions.md) |

---

## 1. 先行研究の値

| 操作 | 気づく遅れ | 出典 | 条件 |
|---|---|---|---|
| タッチ画面で指でドラッグ | 1 ms と 6 ms の違いを区別できた | Ng ら、UIST 2012 | 高速なプロジェクタとセンサで 1 ms まで下げた装置。箱をドラッグする課題 |
| タッチ画面でドラッグ | 丁度可知差（JND）11 ms | Deber ら、CHI 2015 | 直接のタッチ。遅れの差に気づく最小の値 |
| タッチ画面でタップ | JND 69 ms | 同上 | 直接のタッチ |
| タッチパッドでドラッグ / タップ | JND 55 ms / 96 ms | 同上 | 間接のタッチ（マウスやキーボードに近い形） |
| 遅れの改善 | 8.3 ms の改善でも気づかれる | 同上 | 幅広い基準の遅れに対して |
| マウスの操作 | 平均 65 ms、中央値 54 ms、人による幅 34〜137 ms | Forch ら、EPCE 2017 | 簡単なマウスの操作。表題は「100 ms で十分か？」 |
| キーボードの入力 | 20 ms と 200 ms を比べ、写すだけの課題では速さに差がなかったが、文章を直す課題では 200 ms で有意に遅くなった。速く打つ人ほど遅れに気づきやすい | Schmid ら、MUM 2023 | 物理キーボード、31 人 |

古くから使われてきた目安：

| 目安 | 出典 | 注意 |
|---|---|---|
| 0.1 秒以内なら「すぐ反応した」と感じる。1 秒で思考の流れが途切れ始め、10 秒で注意がそれる | Miller 1968、Card ら 1991、Nielsen 1993 | Miller の論文は実験に基づかない提案である、という指摘がある（Web Performance Calendar 2018）。上の実験研究では、0.1 秒より短い遅れにも気づく |
| 入力への応答は 50 ms 以内に処理し、100 ms 以内に結果を見せる。空き時間の処理は 50 ms ずつに分ける。動きは 1 コマ 16 ms（処理の予算は約 10 ms） | Google の RAIL モデル（web.dev） | ブラウザ向けの設計指針。0.1 秒の目安の上に作られている |

### 読み取れること

1. **「100 ms なら気づかない」は成り立たない。** マウスで平均 65 ms、早い人は 34 ms で気づく。ドラッグのように連続して画面が動く操作では、10 ms 前後でも気づく。
2. **気づく時間は、操作の種類で 1 桁変わる。** 連続した動き（ドラッグ）は数 ms〜十数 ms、1 回の押下への応答（タップ・クリック）は数十 ms。
3. **キーボードの入力そのものの閾値は、まだはっきりした値がない。** 200 ms は、直す作業の速さと、感じる負担に影響する。

---

## 2. MicroGit にあてはめる

### 2.1 何が止まると、利用者に見えるか

VS Code では、エディタの文字の表示とスクロールは画面のプロセスで動き、拡張機能は別のプロセス（拡張機能ホスト）で動く。VS Code の文書は、拡張機能ホストが「UI の操作を遅くすること」を防ぐ仕組みだとしている。MicroGit の保存の処理は、拡張機能ホストの中の `onDidSaveTextDocument`（保存が終わったあと）で動く。

| MicroGit が拡張機能ホストを止めたとき | 利用者から見えるか |
|---|---|
| 文字の入力と表示、スクロール | 止まらない（別のプロセス） |
| VS Code の保存そのもの | 待たされない（保存が終わってから動く） |
| 拡張機能が出すもの（入力の候補、ホバー、コードアクション、ほかの拡張機能のコマンド） | **止まっていた時間だけ遅れる**。ちょうどその時間に利用者が求めた場合だけ |
| 保存のたびの表示（ステータスバー） | 処理の時間に関係なく、毎回見える（`extension.ts` の「[MicroGit] 記録 …」を 3 秒） |

つまり、MicroGit の同期の処理が気づかれるのは、**止めている間に、利用者が拡張機能に何かを求めたとき** である。これは、入力の候補が出る、クリックしたコマンドが動く、といった「1 回の操作への応答」にあたる。1 の表では、タップ・クリックの数十 ms の帯が近い。ドラッグのような数 ms の帯ではない。

### 2.2 予算（提案）

| 予算 | 値 | 根拠 |
|---|---|---|
| 1 回の同期の処理の目標 | **16 ms 以下** | 1 コマ分。クリックやタップへの応答で気づく最小の値（Forch らの 34 ms、Deber らのタッチパッドでの 55 ms）より十分に短い |
| 1 回の同期の処理の上限 | **50 ms** | RAIL の「空き時間の処理は 50 ms ずつ」。これを超えると、人によっては気づく帯（マウスで 34〜137 ms）に入る |
| 画面への表示 | **保存のたびには出さない** | 時間に関係なく見えるので、「気づかない」に反する |

この予算は、1 の研究の「操作への直接の応答の遅れ」をもとにした、**安全側の見積もり** である。「裏の処理が、たまたま重なった拡張機能の応答を遅らせる」場合の閾値を直接測った研究は見つけられていない。

### 2.3 今の MicroGit との照らし合わせ

| 処理 | 1 回に止める時間 | 予算との関係 |
|---|---|---|
| 保存のときのジャーナルへの追記と fsync | 手元の Windows で記録全体が約 10 ms（ADR-0015） | 目標の範囲 |
| 0.3 秒落ち着いてからの Git のファイルの書き出し | Windows でファイルの作成が約 15〜17 ms（ADR-0015 の前の計測からの見込み） | 目標の境目。保存の直後に打ち始めた人の入力の候補が、その分遅れうる |
| 0.3 秒もあけずに 64 回保存したときの、64 回目の書き出し | 約 0.4 秒（ADR-0015） | **上限を大きく超える**。とても短い間隔の自動保存でだけ起きる |
| 保存のたびのステータスバーの表示 | — | **予算に反する**（毎回見える） |

### 2.4 確かめ方（提案）

- 保存 1 回のあいだに、拡張機能ホストのイベントループが止まった最長の時間を測る（保存の計測 `MICROGIT_TEST_SAVE_BENCH` に足す）。目標 16 ms、上限 50 ms で合否を出す
- 64 回目の書き出しを、16 ms 以下ずつに分けて書く形にして、同じ計測で確かめる
- 保存のたびに画面に何かが出ないことを、拡張機能のテストで確かめる

---

## 参考文献

- A. Ng, J. Lepinski, D. Wigdor, S. Sanders, P. Dietz. Designing for Low-Latency Direct-Touch Input. UIST 2012.
- J. Deber, R. Jota, C. Forlines, D. Wigdor. How Much Faster is Fast Enough? User Perception of Latency & Latency Improvements in Direct and Indirect Touch. CHI 2015.
- V. Forch, T. Franke, N. Rauh, J. F. Krems. Are 100 ms Fast Enough? Characterizing Latency Perception Thresholds in Mouse-Based Interaction. EPCE 2017（HCII 2017）, Springer, pp. 45–56.
- A. Schmid, M. Bierschneider, J. Hoffmann, Y. Liu, R. Wimmer. Effects of Text Input Latency on Performance and Task Load. MUM 2023.
- R. B. Miller. Response Time in Man-Computer Conversational Transactions. AFIPS Fall Joint Computer Conference 1968.
- S. K. Card, G. G. Robertson, J. D. Mackinlay. The Information Visualizer, an Information Workspace. CHI 1991.
- J. Nielsen. Usability Engineering. 1993.
- Google. Measure performance with the RAIL model. web.dev.
- Visual Studio Code. Extension Host. code.visualstudio.com/api/advanced-topics/extension-host.
