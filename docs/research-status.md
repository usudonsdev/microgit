# 研究の現状と今後の進め方

| 項目 | 内容 |
|---|---|
| 目的 | 2026-09-30〜10-03 の調査と議論で分かったこと、検討した案とその状態、今後やるべきことを 1 か所にまとめる。次に作業を始める人（利用者・エージェント）が、ここから読み始められるようにする |
| 版 | 初版（2026-10-03） |
| 詳しい検討 | [overlayfs-research-directions.md](./overlayfs-research-directions.md)（OverlayFS で何を速くできるか）、[perceptible-delay.md](./perceptible-delay.md)（人は何ミリ秒の遅れに気づくか） |
| 関係 | [design-rationale.md](./design-rationale.md)、[why-save-is-fast.md](./why-save-is-fast.md)、[ADR-0001](./adr/0001-source-of-truth.md)・[0013](./adr/0013-guest-is-fallible-not-hostile.md)・[0014](./adr/0014-journal-single-fsync.md)・[0015](./adr/0015-defer-git-writes.md)、[build-verification-engine.md](./build-verification-engine.md)、[release.md](./release.md) |

---

## 1. 目的と合格の基準（利用者の決定）

| 事項 | 内容 | 決めた日 |
|---|---|---|
| 研究の目的 | 保存ごとの記録（マイクロコミット）を速くする。そこに OS ネイティブの機能（まずは OverlayFS）を役立てる | 当初から |
| 速くする対象 | **カーネル版の保存**。カーネル版を使えない環境は、今までどおり Node.js 版でよい | 2026-10-03 |
| 合格の基準 | **保存のときに、利用者がマイクロコミットされていることに気づかない** | 2026-10-03 |
| 指標の組み替え（「保存から戻れるようになるまで」を主な指標にする案） | 採らない。目指す形（記録そのものを速くする）を止めることになるため | 2026-10-02 |

---

## 2. 分かったこと

### 2.1 OverlayFS が速くしたのは「過去に戻る」

| 過去に戻る操作（中央値） | Node.js 版 | カーネル版（OverlayFS） | 普通の `git checkout` |
|---|---|---|---|
| Mac（Apple M5、ファイル 200・保存 40） | 685〜703 ms | 22 ms | 29〜30 ms |
| Windows 11（WHPX） | 1,426 ms | 170 ms | 未計測 |
| Linux（WSL2、VM なし） | 127 ms | 22 ms | 未計測 |

記録（保存）を速くしたのは OverlayFS ではなく、次の 3 つ。

| 変更 | 内容 | 出典 |
|---|---|---|
| #32 | Git のプログラムを起動せず、Git の形式を直接書く | [why-save-is-fast.md](./why-save-is-fast.md) |
| #38（ADR-0014） | 停電への備えを、ジャーナルへの追記 1 回の fsync にする | ADR-0014 |
| #49（ADR-0015、5.1.0） | 保存のときはジャーナルにだけ書き、Git のファイルは保存が 0.3 秒落ち着いてから書く | ADR-0015 |

手元の Windows で、保存 1 回の記録は普通の Git の `git add` → `git commit`（0.090 秒）に対して **0.010 秒**（ADR-0015、停電対策の設定をそろえた比較）。

### 2.2 保存 1 回の内訳（ADR-0015 の前の CI の値）

CI の 5 つの環境、ジャーナル導入後・書き出しの遅延の前（[paper/data/ci-36902155146](./paper/data/README.md)、最後の 50 回の中央値、ms）。

| 環境 | 記録 | うち Git の形式の計算 | うちファイルの作成 | うちジャーナル | 層づくり |
|---|---|---|---|---|---|
| Windows（カーネル版） | 20.6 | 1.5 | 15.1 | 3.0 | 35.1 |
| Ubuntu 22.04（カーネル版） | 3.0 | 0.4 | 1.7 | 0.4 | 7.5 |
| macOS（Node.js 版） | 12.3 | 1.3 | 5.2 | 2.9 | 34.4 |

- Git の形式の計算（ハッシュ・圧縮）は小さい。費用の大半はファイルの作成で、ADR-0015 でこれを保存の経路から外した
- **保存の処理の中でいちばん重いのは層づくり**（OverlayFS の部分）。カーネル版でも、Linux で記録の約 2 倍、Windows で約 1.7 倍。仮想マシンの中で層を確定させること自体は 0.1〜0.4 ms（ADR-0004）なので、大半は通信と mount・unmount と見込む（内訳は未計測）
- ADR-0015 の後の CI の 5 環境の値は、まだ取っていない（§4 の P2）

### 2.3 OS ネイティブの機能を移植して得になる条件

5.0.0 の数字から、次の 2 つが言える（詳しくは [overlayfs-research-directions.md](./overlayfs-research-directions.md)）。

1. **粒度**：境界を 1 回越える費用で、ホスト側の多くの処理をまとめて置き換えられるときだけ速くなる。過去に戻る（数百のファイル操作を 1 回の依頼に）は得、保存（小さなファイル 1 つ）は損
2. **結果の置き場所**：仮想マシンの中の結果は、アプリ自身が命令で受け取る使い方なら成り立つ。ホストのほかのプログラム（ビルドツールなど）がファイルとして使う必要がある場合は、Windows と macOS では成り立たない

### 2.4 層を記録の正本にする案

| 案 | 状態 |
|---|---|
| A：正本は Git のまま。保存の直後はジャーナルが正本で、Git のファイルは落ち着いてから書く | **採用**（ADR-0015、5.1.0）。利用者の判断「保存が高速ならそれで充分」 |
| B：層の保管場所を正本にし、Git は同期と互換のための書き出し先にする | 不採用。保存のときにすることは A とほぼ同じで、層の保管・壊れたときの確かめ方・同期・移行を一から作る必要がある |
| C：層だけにする | 不採用。同上。加えて、カーネル版が使えない環境で履歴を読めなくなる |
| ワークスペース自体を OverlayFS にして「保存＝upper の凍結」にする | 保留。OverlayFS 自身が記録を速くできる唯一の形だが、Windows・macOS では成り立たず、Linux でも root か FUSE が要る。Linux 限定の研究用の試作としてのみ可能 |

層の「信頼」（検証）を強めても速さはほとんど変わらない。検証の費用は小さく（過去に戻る操作全体の 22 ms に収まる、ADR-0013）、時間はファイルの作成・fsync・境界越え・mount にかかっているため。検証は、停電の対策（ジャーナル）と組み合わせて、信頼性を守る役として使う。

### 2.5 人が遅れに気づく時間

詳しくは [perceptible-delay.md](./perceptible-delay.md)。要点：

- 「100 ms なら気づかない」は成り立たない。マウスで平均 65 ms・人によっては 34 ms（Forch ら 2017）、タッチのタップで 69 ms、ドラッグでは 11 ms 前後（Deber ら 2015）で気づく
- VS Code では文字の入力は画面のプロセスで動き、MicroGit の処理は拡張機能ホストで動く。MicroGit が止めて見えるのは、止めている間に利用者が拡張機能に何かを求めたとき（入力の候補など）だけ
- 予算の提案：**1 回の同期の処理は 16 ms 以下を目標、50 ms を上限。保存のたびに画面に何も出さない**

### 2.6 「気づかない」の点検（2026-10-03、5.1.0 の master）

| 気づかれうる箇所 | 状態 | 判定 |
|---|---|---|
| VS Code の保存そのもの | `onDidSaveTextDocument` で動くので待たせない | 合格 |
| 保存のときのジャーナルへの追記 | 記録全体で約 10 ms（手元の Windows） | 目標の範囲 |
| 落ち着いてからの Git のファイルの書き出し | Windows で約 15〜17 ms の見込み | 目標の境目 |
| 間隔をあけずに 64 回保存したときの 64 回目 | 約 0.4 秒止まる（ADR-0015） | **上限を超える**。とても短い間隔の自動保存でだけ起きる |
| 保存のたびのステータスバーの表示 | 「[MicroGit] 記録 abc1234 · mb-1」を 3 秒（`src/extension.ts` の `setStatusBarMessage`）。止める設定はない | **不合格** |
| 起動直後の最初の保存 | 裏で仮想マシンを起動し、その間は Node.js 版で層を作る | 合格 |

---

## 3. 検討した方向と状態

| 方向 | 内容 | 状態 |
|---|---|---|
| 案 1 | 「保存から戻れるようになるまで」を指標にする | 中止（§1） |
| 案 2 | 層を記録の正本にする | A（ADR-0015）を採用。B・C は不採用。「保存＝凍結」の試作は保留（§2.4） |
| 案 3 | 卒業研究のビルドキャッシュを、lane ごとに OverlayFS の層で持つ | 検討済み。固定パスへの mount でキャッシュの再利用を構造で解ける見込み。前提を確かめる実験を設計した（[overlayfs-research-directions.md](./overlayfs-research-directions.md) §3.5〜§3.7）。実施は未定 |
| 移植の汎用化 | OS ネイティブの機能を、別の OS のアプリから部品として使う仕組みを研究の主題にする（要件定義書 §1.3 の最終段階） | 検討中。2 つ目の機能と、損得の分かれ目のモデルが要る |

**未決：卒業研究の主語。** 2026-09-12 に「ビルド検証エンジン」（構成案 P-2）と決めている。移植の汎用化を主題にするなら決め直しになる。どちらにするかで、次の実験が変わる（案 3 の実験か、2 つ目の機能の候補選びか）。

---

## 4. 今後やること（優先順）

| 優先 | やること | 理由 | 状態 |
|---|---|---|---|
| **P1** | 保存のたびのステータスバーの表示をやめる（必要なら設定で戻せるようにする） | 「気づかない」の基準に直接反している | 未着手。動きが変わるので、ブランチで作って利用者が確かめてから master へ |
| **P1** | 64 回目の書き出しを、16 ms 以下ずつに分けて書く（オブジェクトを少しずつ先に書き、ref は最後に 1 回） | 上限 50 ms を大きく超える唯一の箇所 | 未着手（ADR-0015 で「今は作らない」としていた） |
| **P1** | 「気づかない」を測るテストを足す：保存 1 回のあいだに拡張機能ホストが止まった最長の時間（目標 16 ms・上限 50 ms）、保存のときに画面に何かが出ないこと | 速さの計測を、合格の基準で判定できる形にする | 未着手 |
| P2 | ADR-0015 の後の値を、CI の 5 環境で取り直す（層づくりの内訳も） | §2.2 は ADR-0015 の前の値 | 未着手 |
| P2 | 層づくりの内訳（通信・mount・unmount）を測る | 保存の処理の中で最も重い。「保存の直後に戻る」と、資源の使い方に効く | 未着手 |
| P2 | 普通の `git checkout` との比較を Windows でも測り、計測のスクリプトをリポジトリに入れる | 記事の比較が Mac だけ。今のスクリプトはリポジトリの外 | 未着手 |
| P3 | 卒業研究の主語を決める（§3 の未決） | 次の実験を決めるため | 利用者の判断待ち |
| P4 | Marketplace の認証を Entra ID（`vsce publish --azure-credential`）に移す | 今のトークンの種類は 2026-12-01 に廃止 | 未着手（[release.md](./release.md) §3.1） |
| P5 | 記事の「保存 1 回の記録」の数字が、層づくりを含まないことを読者に分かるようにする | 保存の処理全体の時間と混同されうる | 未着手 |

---

## 5. 参考文献

### 人の知覚と応答時間

- A. Ng, J. Lepinski, D. Wigdor, S. Sanders, P. Dietz. Designing for Low-Latency Direct-Touch Input. UIST 2012.
- J. Deber, R. Jota, C. Forlines, D. Wigdor. How Much Faster is Fast Enough? User Perception of Latency & Latency Improvements in Direct and Indirect Touch. CHI 2015.
- V. Forch, T. Franke, N. Rauh, J. F. Krems. Are 100 ms Fast Enough? Characterizing Latency Perception Thresholds in Mouse-Based Interaction. EPCE 2017（HCII 2017）, Springer, pp. 45–56.
- A. Schmid, M. Bierschneider, J. Hoffmann, Y. Liu, R. Wimmer. Effects of Text Input Latency on Performance and Task Load. MUM 2023.
- R. B. Miller. Response Time in Man-Computer Conversational Transactions. AFIPS Fall Joint Computer Conference 1968.
- S. K. Card, G. G. Robertson, J. D. Mackinlay. The Information Visualizer, an Information Workspace. CHI 1991.
- J. Nielsen. Usability Engineering. 1993.
- Google. Measure performance with the RAIL model. https://web.dev/articles/rail
- Web Performance Calendar. Magic numbers（2018）. https://calendar.perfplanet.com/2018/magic-numbers/ （0.1 秒の目安に実験の裏付けがないことの指摘）
- Ink & Switch. Slow Software. https://www.inkandswitch.com/slow-software （閾値の研究の整理）

### OverlayFS と Git

- 三原公平, 柗本真佑, 楠本真二. OverlayGit：OverlayFS を用いた高速な Git ファイルシステム. 情報処理学会論文誌, Vol.66, No.11, pp.1462–1472, 2025.
- Linux カーネルの文書「Overlay Filesystem」（upper を別の lower と組み合わせ直す条件：`index` と `metacopy` が無効なら許される）. https://docs.kernel.org/filesystems/overlayfs.html
- Git 2.50.0 のソース. https://github.com/git/git/tree/v2.50.0

### VS Code と公開

- Visual Studio Code. Extension Host. https://code.visualstudio.com/api/advanced-topics/extension-host
- Visual Studio Code. Publishing Extensions（グローバルなトークンは 2026-12-01 に廃止、`--azure-credential`）. https://code.visualstudio.com/api/working-with-extensions/publishing-extension

### 計測の生データ

- [docs/paper/data/](./paper/data/README.md)（CI の 5 環境の保存の段階ごとの時間、普通の Git との比較）
- 普通の `git checkout` との比較（2026-09-30、Mac）：記事 `articles/microgit-v5-kernel-overlay.md` の計測の注記。スクリプトはリポジトリの外（§4 の P2）

---

## 6. 経緯（日付順）

| 日付 | できごと |
|---|---|
| 2026-09-30 | 5.0.0 の記事の下書きで、普通の `git checkout` と比べた（Mac）。保存の記録は普通の Git の約 3 倍かかることが分かり、目標（記録の高速化）は未達と確認した |
| 2026-10-02 | 5.0.0 を Open VSX と VS Code Marketplace に公開。OverlayFS が速くしたのは「過去に戻る」だと整理した。案 1 を中止し、案 2・案 3 を検討した |
| 2026-10-03 | ADR-0015（書き出しの遅延）を採用し、5.1.0 の版にした。合格の基準を「保存のときに気づかない」に決めた。人が遅れに気づく時間を調べ、保存の処理の予算（16 ms・50 ms）を提案した |
| 2026-10-07 | 5.1.1（生成物を `.microgit/` にまとめる）を VS Code Marketplace、Open VSX、GitHub Release に公開した |
