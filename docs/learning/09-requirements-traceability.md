# 09. 要件と実装をつなぐ（追跡）／決めたことを残す（ADR）／レビューの指摘を閉じる

| 項目 | 内容 |
|---|---|
| 関係する Issue | #9（要件定義書・設計書に補足所見 S-1〜S-13 を反映する） |
| 実装 | [要件定義書](../microgit-kernel-feature-portability-requirements.md)（第 2 版）、[初期設計書](../microgit-kernel-feature-portability-design.md)、[補足文書](../microgit-kernel-feature-portability-supplement.md) §0、[docs/adr/](../adr/README.md) |
| 前提 | 01〜08 のどれか 1 本（何を作ったかの雰囲気が分かっていればよい） |

---

## 1. 何のための仕組みか

要件定義書と設計書は、作り始める前に書く。作っているうちに分かることがあり、決め直すことがある。文書を直さないと、次のことが起きる。

- 文書には「Windows は要検証」と書いてあるのに、実際はもう QEMU で動いている。読んだ人は古い前提で判断する
- 「FR-1 を満たした」と言うとき、何を根拠にしたのかが分からない
- 半年後に「なぜ vsock を使わなかったのか」と聞かれて、誰も答えられない

#9 では、補足文書の 13 件の指摘（S-1〜S-13）と、Phase 0〜2 の実装で決めたこと・測ったことを、要件定義書と設計書に書き戻した。この回では、そのときに使った 3 つの考え方を説明する。

---

## 2. 仕組み

### 2.1 要件 → 受け入れ基準 → テスト（追跡）

要件は、それだけでは「満たしたか」を判定できない。**受け入れ基準**（何が起きれば満たしたと言えるか）を決め、それを **自動で確かめるテスト** につなぐ。この対応を表にしたものを **追跡表**（traceability matrix）という。

このリポジトリの主なもの：

| 要件 | 受け入れ基準（第 2 版） | 確かめるもの | どこで動くか |
|---|---|---|---|
| FR-1 同じ挙動 | ゲストのビューがゴールデンテストと一致 | `scripts/golden/record-kernel.mjs --check`、`check-guest.mjs` | ci.yml「OverlayFS golden on … kernel」、guest.yml「Boot in QEMU and run golden scenarios」 |
| FR-1（Node.js 版） | 既知の食い違いの一覧どおり | `scripts/golden/check-node.mjs` | ci.yml「OverlayFS Golden Test (Node fallback)」 |
| FR-1・FR-2 | 過去に戻ったワークスペースが Git のツリーと一致 | `scripts/test/kernel-backend-e2e.mjs` | guest.yml「Kernel vs Node.js backend」、qemu-windows.yml |
| FR-3・SR-2 | 異常な一覧・中身を弾き、半端な状態を残さない | `src/test/unit/boundaryGuard.test.ts` | ci.yml「Unit Tests」 |
| FR-5 | 使えない環境で自動で Node.js 版になる | `scripts/test/native-fallback.mjs` | guest.yml「Linux native falls back on AppArmor-restricted runner (S-3)」 |
| NFR-1（Windows） | 仮想化機能が無くても動く | `kernel-backend-e2e.mjs --accel tcg`、`qemu-accel-fallback.mjs` | qemu-windows.yml |
| NFR-2 | Node.js 版より速い | `scripts/bench-backends.mjs` | 手で動かす（結果は kernel-backend.md） |
| NFR-4 | `CONFIG_NET` が無効 | `guest/build.sh` の検査 | guest.yml「Build guest」 |
| NFR-6 | 2 回のビルドが同じバイト列 | ビルドし直して比べる | guest.yml「Rebuild in another directory and compare」 |

表を作ると、**テストの無い要件** が見える。たとえば NFR-2（性能）は CI では測っていない（CI の機械は速さがばらつくので、比べても意味が薄い）。NFR-3（大きさ）は `sizes.txt` に記録するだけで、上限を超えたら落ちる、という仕組みはまだ無い。こういう「穴」を知っていることが大事で、穴を全部埋める必要はない。

### 2.2 決めたことを残す（ADR）

ADR（Architecture Decision Record）は、設計上の決定を 1 件 1 ファイルで残す書き方。2011 年に Michael Nygard が提案した。

書くこと：

| 見出し | 書く内容 | 例（ADR-0010） |
|---|---|---|
| 背景 | 何に困っていたか、誰が何を言ったか | 補足 S-10 は「vsock を使うために `CONFIG_NET` は残せ」と勧めた |
| 決定 | 何にしたか（1〜3 行） | `CONFIG_NET` ごと無効、通り道は virtio-console |
| 理由 | なぜそれか | 命令は 1 往復ずつなので、vsock の多重化が要らない |
| 採らなかった案 | 他に何を考え、なぜやめたか | — |
| 引き受けること | この決定で諦めたこと、将来の困りごと | 並行して命令を流すなら作り直し |

いちばん大事なのは **採らなかった案** と **引き受けること**。「何にしたか」はコードを読めば分かるが、「なぜ他の案ではないのか」はコードに残らない。

決定を覆すときは、元の ADR を消さない。状態を「置き換え（→ ADR-xxxx）」にして、新しい ADR を足す。過去にどう考えていたかが残るので、同じ議論を繰り返さずに済む。

### 2.3 レビューの指摘を閉じる

補足文書の 13 件の指摘には、#9 で状態を付けた。状態は次の 4 つに分けた。

| 状態 | 意味 | 例 |
|---|---|---|
| 解消 | 指摘された問題そのものが無くなった | S-2（Windows は仮想化機能が要る）→ TCG で動いたので問題が消えた |
| 反映済み | 問題は残るが、文書に書き、対策を決めた | S-3（Ubuntu で動かない）→ 自動で切り替える。環境そのものは変えられない |
| 保留 | 決めなくても困らないので、後で決める | O-9（LKL を使うか） |
| 未決 | 決める必要があり、いつ決めるかも分かっている | O-5（ライセンス）→ #19 |

「保留」と「未決」を分けておくと、次にやることが見える。「保留」は、状況が変わったら（TCG が遅すぎると分かったら）見直す。

### 2.4 消さずに足す

#9 では、初版の本文を消さずに「第 2 版」と印を付けて足した。

- **読む人が、何が変わったかを文書だけで追える**。Git の履歴にも残るが、文書を読む人は Git の差分を見るとは限らない
- **初版の考え方が、決定の背景になっている**。たとえば NFR-4 の「vsock が使えない可能性」という心配は、補足 S-10 の指摘と ADR-0010 の決定のきっかけになった
- 代わりに文書は長くなる。表紙に「改訂履歴」を置いて、何を足したかを 1 か所で分かるようにした

### 2.5 確かめたこと・確かめていないことを分けて書く

第 2 版では、「未確認」をはっきり書いた。

- macOS は実機で動かしていない（#17）
- 「WHPX の初期化に失敗したら TCG に切り替わる」は、同じ仕組みの別の枝（知らないアクセラレータ）で確かめただけ
- Dev Containers と Codespaces での自動フォールバックは試していない

「動くはず」と「動いた」を混ぜると、読んだ人が確かめ直す手間が増えるか、確かめずに信じてしまう。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| 要件と受け入れ基準、結果 | 要件定義書の各 FR・NFR の「第 2 版」「結果」 |
| 補足文書の指摘の状態 | 補足文書 §0 の「状態」の列 |
| 未決事項の状態 | 要件定義書 §12 の「決定の状況」 |
| 決めたことの理由 | `docs/adr/0001`〜`0011`、一覧は `docs/adr/README.md` |
| テストの置き場所 | `scripts/golden/`、`scripts/test/`、`src/test/`、`.github/workflows/` |

---

## 4. 手を動かして確かめる

1. **要件からテストをたどる**：要件定義書の FR-5 の「受け入れ基準（第 2 版）」を読み、`.github/workflows/guest.yml` から、それを確かめているステップを探す。最新の Actions の実行で、そのステップのログに `falls back` の理由が出ているかを見る
2. **テストから要件をたどる**：`src/test/unit/boundaryGuard.test.ts` のテストを 1 つ選び、それがどの規則（docs/boundary-guard.md）と、どの要件（SR-2・FR-3）のためにあるかを書き出す
3. **ADR を 1 本書いてみる**：たとえば「VS Code の設定 `microgit.overlayBackend` の既定を `auto` にする」。採らなかった案（既定を `nodejs` にする）と、引き受けること（初回の保存でカーネル版の起動が裏で走る）を書く
4. **穴を探す**：追跡表で「確かめるもの」が空の要件（NFR-3 の上限、NFR-5 の範囲など）を 1 つ選び、どう自動で確かめられるかを考える

---

## 5. もっと知りたいとき

- Michael Nygard「Documenting Architecture Decisions」（2011）：ADR の元になった短い記事
- adr.github.io：ADR の書式の例と道具
- ISO/IEC/IEEE 29148：要件の書き方と追跡の国際規格（要件が「検証できる」ことの定義がある）
- 「requirements traceability matrix」「acceptance criteria」で検索する
