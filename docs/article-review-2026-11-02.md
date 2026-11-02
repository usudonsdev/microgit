# Zenn 記事 3 本のレビュー（2026-11-02）

運営者の依頼「記事についても指摘してください」に対する、読み取りだけのレビューの記録。**記事は変えていない**（記事は書いた時点の記録なので、本文の全置換ではなく「注記」を提案する）。照合先は `docs/research-status.md`、`docs/why-save-is-fast.md`、`docs/perceptible-delay.md`、`docs/save-bottleneck-investigation.md`、`docs/design-rationale.md`、`CHANGELOG.md`、`docs/paper/data/` の生 JSON、`src/`。

対象:

| 記事 | 状態 | 判定 |
|---|---|---|
| `articles/article-zenn-microgit-overlaygit.md`（v4.0.0 の記録） | 公開済み | FIX |
| `articles/microgit-save-bottleneck-was-the-test.md` | 未公開（`published: false`） | FIX |
| `articles/microgit-v5-kernel-overlay.md`（5.0.0 の記録） | 公開済み | FIX |

## 0. 運営者の判断待ち

1. 記事を直すか（直すなら「注記を足す」方式か、本文も直すか）。
2. `microgit-save-bottleneck-was-the-test.md` を公開前に「いまの状態」の節を書き直すか。
3. 公開済み 2 本に「改名後の注記」を足すか（Zenn は `master` への push で反映される。`docs/zenn.md`）。

## 1. 共通の優先修正トップ 5

1. **P5（`research-status.md`）を v5 記事で解消する。** 「記録」はコミット作成のみで層づくりを含まないと定義し、「直す前 0.15〜0.16 秒」の前後比較を同じ範囲に揃える。bottleneck 記事との間（CI Windows の記録 0.021 秒と 7.4 ms）の食い違いには、ADR-0015（Git のファイル書き出しの遅延）による一文を足す。
2. **3 本とも冒頭に「改名後の注記」を足す。** 本文は置換せず、拡張 ID（`usudonsdev.vereve`）・コマンド（`verEve: …`）・設定（`vereve.*`）が 6.0.0 で変わることを書く。GitHub リポジトリ名の変更前に Zenn の再連携手順（`docs/zenn.md` 2026-10-02 の記録）を確認しておく。
3. **古い状態の記述を更新する。** bottleneck 記事は「いまの状態」（5.1.1・ブランチ・次の予定）、v5 記事は「まとめて書く方式を検討」（5.1.0 で実装済み）、overlaygit 記事は v4 当時の形式（`.microgit_overlay`、`.wh.*`）。
4. **数値の食い違いを直す。** 旧方式の戻りは 5.06 秒ではなく中央値 5.31 秒（3.3〜6.2 秒に二分）。v5 記事の 1.4 秒との関係（測定範囲の違い）を説明する。Windows の層づくりの「直す前」が 33.7 と 25.0 の 2 通り（別の CI run）。「1 分→21 秒」は出典なし。
5. **過大・根拠不足の表現を弱める。** 16 ms は「提案」で、対象は同期処理の止まりであり処理全体ではない。「むしろ少し速い」「編集は止まらない」は弱める。Windows の Git 比較は未測定と書く。「最大 13 倍」は出典を確認する。

## 2. 記事ごとの指摘

### 2.1 `article-zenn-microgit-overlaygit.md`（判定 FIX）

- [中] 冒頭〜「全体像」「おわりに」（L34、L261）— 速さの数値が一つもない。v5 記事では v4 の戻りは Mac 約 0.7 秒・Windows 約 1.4 秒で `git checkout` の 20 倍以上遅かった（`research-status.md:28-32`、`design-rationale.md:57-62`）。→ L26 の「v4.0.0 時点の記録」の注記に一文足す。
- [中] L62「チェックアウトが Git 比で最大 13 倍（論文の概要より）」、L48-54 の Scalar/RepoFS の表 — リポジトリ内に出典が無い。検索で見つかる修士論文の要旨は「平均で Git の 3〜5 倍」。→ 出典の節か頁を示し、平均値と不利だった条件も併記。
- [中] L40・L269-270 の論文リンク — 巻号頁（Vol.66 No.11 pp.1462-1472、2025 年）は一致。ただし `pman3.cgi?D=882` は自動取得で HTTP 410（ボット拒否の可能性）。第 2 著者「柗本」の読みは未確認。→ 手元のブラウザで確認。
- [中] 改名の注記が無い。L37-38 のストアのリンクは旧 ID `usudonsdev.microgit`。→ L26 の注記に「現在は verEve に改名。6.0.0 以降は拡張 ID が `usudonsdev.vereve`」と足す。
- [低] L119-128 — `.microgit_overlay` は 5.1.1 で `.microgit/overlay` に（CHANGELOG 5.1.1）。層の中の `.wh.*` は 5.0.0 で層の外のメタデータ JSON に変わった（`src/overlay.ts:19-27`、N-5）。→ 「v4 当時の形式」と添える。
- [低] L143-151 のコード — 実装は `copyTreeBytes`（`src/overlay.ts:403`）で `clearDirContents` 等を省いている。→ 「抜粋・簡略化」と書く。
- [低] 構成 — L9-40 に注記・機能一覧・リンク 4 本が並び、論文の話まで長い。→ リンク集を末尾へ。
- 問題なし: front matter、関連記事の slug 3 本、画像なし。`isViewReady`/`markViewReady`/`'incremental'`（`src/overlay.ts`）、`Main-Head` trailer（`src/mainHead.ts`）、`merge-base --is-ancestor`（`src/shadowStore.ts:367`）は実装と一致。

### 2.2 `microgit-save-bottleneck-was-the-test.md`（判定 FIX。表の数値は CI の生 JSON と一致）

- [高] 「いまの状態」L237-239 が古い。(a)「テストの修正は開発用ブランチ」→ 5.1.3 で master に入った（PR #71、2026-10-10。残るのは計測コードだけ）。(b)「公開版 5.1.1 の動きは変わっていない」→ 5.1.2 は公開済み、5.2.0 で保存後の止まりを解消、6.0.0（verEve）も控える。(c)「次は旧方式の層づくり」→ #66 として `feature/nodejs-backend` で進行中。→ 公開直前の状態に書き直す。
- [中] L193「16 ミリ秒以下…という予算として決めた」— 予算は「提案」（`perceptible-delay.md:55`）、対象は「1 回の同期の処理（拡張機能ホストを止める時間）」（同 :59-60）。中央値だけで「収まっている」とは言えない（CI Windows p95 39.45 ms、`save-bottleneck-investigation.md:318`。64 回に 1 回の書き出しは Windows で約 0.4 秒）。
- [中] L201-207 旧方式の「過去に戻る 5.06 秒（中央値）」— `docs/paper/data/local-win-61/save-bench-nodejs-no-git-poll.json` の travels 10 回の中央値は 5,310.8 ms。5,062 は先頭 1 回の値。10 回は 3.3〜3.5 秒と 5.5〜6.2 秒に二分。カーネル版 513.4 ms は一致、倍率約 10 倍は変わらない。v5 記事の 1.4 秒との差の説明が無い（測定範囲の違い）。`save-bottleneck-investigation.md:169` と `how-microgit-works.md:92` も同様。
- [中] L69 と L103・L163 — Windows の層づくりの「直す前」が 33.7 ms と 25.0 ms の 2 通り（run 37815483559 と 37819226341）。→ 別の回の CI と注記するか片方に揃える。
- [中] L155「テストの実行時間も 1 分から 21 秒」— 出典が無い。→ 足すか削る。
- [低] L148-153 の手元 Windows — 生 JSON の再計算（最後の 20 回の中央値）と 0.5 ms 以内のずれ。→ 窓の取り方を注記。
- [低] L157-163「CI の 5 台」— 表は 3 行。省いた Ubuntu 24.04 Node.js 版と macOS は直っていない行で、旧方式が重い主張の裏付けになる（`save-bottleneck-investigation.md:141-142`）。
- [低] L84-87 — 「VS Code の外（Linux、VM なし）」の 0.12 ms は WSL2 の値（同 :72）。Windows の外側は 3.7 ms（同 :73）で内側より大きく、記事は触れていない。
- [低] P5 — この記事は「記録」「層づくり」「処理全体」を区別しており問題ない。ただし CI Windows の記録が本記事 7.4 ms、v5 記事 0.021 秒（ADR-0015 の遅延書き出しのため）。→ 一文足す。
- [低] 用語 — 「旧方式」が定義前に出る。v5 記事の「新方式/旧方式」と本記事の「カーネル版/Node.js 版」が混在。L211 の「使えない環境」には Windows on Arm も入る（同 :287）。
- [低] 改名の注記が無く、L245-246 は旧 ID のリンク。未公開なので公開前に足せる。
- 問題なし: front matter、slug、前記事リンク、調査記録のリンク先。

### 2.3 `microgit-v5-kernel-overlay.md`（判定 FIX。P5 は未対応）

- [高] P5 未対応（L27、L263-268、L305-322）— 「保存 1 回の記録」が層づくりを含まない説明が無い。同じ CI run で Windows の記録 20.6 ms に対し層づくり 35.1 ms、処理全体 59.1 ms。macOS は記録 12.3 に対し処理全体 48.1（ci-36902155146、`research-status.md:50-52`）。さらに L263-268 の「直す前 0.15〜0.16 秒」はコミット 0.10＋準備（層づくり）0.05 で層づくりを含み、L307-322 の「後」（0.025/0.021）は記録のみ。前後で同じものを比べていない（`why-save-is-fast.md:18`、`docs/paper/data/README.md`。`design-rationale.md` §3.4「記録は全体の約 5%」）。→ L263 に「『記録』はコミットを作る部分だけで、戻るための準備（層づくり）は含まない。処理全体はこれより長い」と書き、表は「記録のみ」に揃えるか層づくりを別行に。
- [中] L324「まとめて書く方式を検討しています」— 5.1.0（2026-10-03）で実装済み（手元 Windows で記録 0.010 秒、Git 0.090 秒。`research-status.md:42`）。→ 追記として書く。
- [中] L242「普通の Git と同じくらい、むしろ少し速い」— `design-rationale.md:67-69` は「Git より速い」を言えないこととしている。記事自身も L244 で打ち消している。→ 「むしろ少し速い」を削る。
- [中] L322「4 倍ほど速く」— Windows・履歴 300 回の値。既定の条件では 1.6〜3.2 倍（`design-rationale.md:86-91`）。→ 範囲を示す。
- [中] L263-268 の Mac の数値（0.15〜0.16 秒、コミット 0.10、準備 0.05、Git 0.05、「Git を 4 回起動」）— `docs/paper/data/` に Mac の記録データが無く出典が確認できない。v4 の 16 回前後（`why-save-is-fast.md:20`）と基準が違う説明も無い。→ 出典を注記に足す。
- [中] L344「Windows ではまだ普通の Git ほどではありません」— Windows の `git checkout` は未計測（`research-status.md:31`、P2）。→ 「測っていない」にする。
- [中] L68・L71・L270「編集は止まらない」— 文字入力は止まらないが、拡張機能ホストが止まると入力候補などは遅れる（`perceptible-delay.md:46-53`）。5.0.0〜5.1.x は保存の 0.3 秒後に約 260 ms、1.5 秒後に約 520 ms 止まっていた（`save-bottleneck-investigation.md` §10.1。5.2.0 で解消）。→ 「文字入力は止まらない」に絞る。
- [中] 改名 — L331「MicroGit を検索」、L332-334 の `MicroGit: Overlay Status` と `microgit.overlayBackend`、L349-350 の旧 ID リンクが 6.0.0 で変わる。一番読まれる記事。→ 冒頭に「5.0.0 当時の記録。現在は verEve（6.0.0 から新拡張）」を足し、本文は置換しない。
- [低] L255「準備 約 0.9 秒」— 文書では WHPX の起動約 1.0 秒（`save-bottleneck-investigation.md:44`）。
- [低] L244・L263 — 数値と「秒」の間の不要な空白。
- [低] 長さ — 350 行・約 36 KB。つまずき談 3 本と「本物と比べたら」は付録扱いにできる。
- 問題なし: front matter、画像 2 枚（`images/` に存在、2000px、約 340〜360 KB）、slug 2 本。戻りの時間、名前付きパイプの表、64 KiB/24 KiB/48 KiB、0.070→0.021 ほかの数値は文書・生 JSON と一致。

## 3. レビューで確認したこと

- 数値の突き合わせは ci-37815483559・ci-37819226341・ci-37824014250・ci-36882411545・ci-36902155146・local-win-61 の JSON で行い、CI は最後の 50 回、手元は最後の 20 回の中央値、旧方式の戻りは travels 10 回の中央値。
- 倍率（60 倍、23 倍、10 倍）と、`research-status.md` §2.2 の「35.1 ms、記録の 1.7 倍」（35.09/20.63）を再計算して一致。

## 4. 未確認

論文 URL（D=882）の生死、「最大 13 倍」の出典、第 2 著者の表記、「21 秒」と Mac の 0.15 秒系の出典、5.2.0 のストア公開の有無。
