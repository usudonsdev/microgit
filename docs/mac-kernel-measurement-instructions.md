# 指示書：Apple silicon の Mac で、カーネル版の保存の速さを測り、直す（#61 の続き）

| 項目 | 内容 |
|---|---|
| 読む人 | Apple silicon の Mac で作業する人（利用者、または Mac で動かすエージェント） |
| 目的 | Windows・Linux で行った「層づくりの内訳の計測」と「テストの待ちの除去」を Mac のカーネル版（Virtualization.framework）でも行い、Mac に固有の遅さがあれば直す |
| 前提の調査 | [save-bottleneck-investigation.md](./save-bottleneck-investigation.md)。先に §1 と §2.5 を読む |
| 版 | 初版（2026-10-09） |

---

## 0. 守ること

- **計測のための変更は master に入れない。** 計測はブランチ `measure/61-layer-breakdown` で行う（利用者の方針、2026-10-09）
- **製品の動きを変える修正（§5）は、計測とは別の Issue・ブランチ（`issue/<番号>-...`）で作る。** master へのマージと、ストアへの公開は利用者に確かめてから
- コミットのメッセージ・文書・報告は日本語。コミットには「なぜ・したこと・確かめたこと・確かめていないこと」を書く
- 数字には、機械（チップ、macOS の版）・回数・どの区間の中央値かを必ず添える
- 確かめられなかったことは、確かめられなかったと書く

---

## 1. 背景（なぜ Mac で測るのか）

- Windows と Linux では、テストが保存の直後に Git を同期で起動していた待ちを取り除くと、カーネル版の保存 1 回の処理全体は Linux 3.3〜3.7 ms、手元の Windows 7.3 ms になった
- **Mac のカーネル版は CI で測れない。** GitHub Actions の macOS では Virtualization.framework が使えず（`VZErrorDomain Code=2`）、Node.js 版で動く
- **Mac には固有の事情がある。** virtio-console の 1 行が約 64 KiB を超えると止まるので、Mac だけ 1 行を 48 KiB までに抑えている（`src/kernel/launchers.ts` の `planMac` の `maxFrameBytes`）。このとき `src/kernel/layerFeeder.ts` は、**ファイルが小さくても** 中身を先に `stage` で送り、そのあと `commit` を送る。保存 1 回につき、ゲストとの往復が最低 2 回ある（Windows・Linux は 1 回）
- そのため Mac では、層づくりの「stage」と「通信」が Windows より大きく出る見込み。測って確かめる

---

## 2. 準備

```bash
xcode-select --install            # swiftc と codesign（入っていれば不要）
brew install node@20 gh           # Node.js 20 と GitHub CLI（入っていれば不要）
gh auth login                     # 成果物を取ってくるため（初回だけ）

git clone https://github.com/usudonsdev/microgit.git   # まだ無ければ
cd microgit
git fetch origin
git switch measure/61-layer-breakdown
npm ci
npm run compile
```

計測用ブランチには、次のものが入っている（Windows・Linux と同じ）。

| もの | 場所 |
|---|---|
| 層づくりの内訳（prepare・stage・send・wire・resume・loop.*・guest.*） | `src/kernel/layerFeeder.ts`、`src/kernel/agentConnection.ts` |
| agent の段階の時間（`phasesUs`、agent 1.2.0） | `guest/agent/overlay.go` |
| テストが保存の最中に Git を起動しない（`microgit.internal.lastSave`） | `src/extension.ts`、`src/test/suite/overlayBackend.test.ts` |
| VS Code の外で往復を測るスクリプト | `scripts/bench-agent-rtt.mjs` |
| 結果をまとめるスクリプト | `scripts/summarize-save-bench.mjs` |

**この「テストの修正」は OS に関係なく効く。** Mac で新しく作り直す必要はない。Mac でやるのは、§3〜§4 の計測と、§5 の Mac に固有の修正。

---

## 3. 配布する形の VSIX を取ってくる

公開の判定と同じく、手元で組み合わせた部品ではなく、CI で作り直した VSIX を使う（古い部品が混ざった前例がある。[記事](../articles/microgit-v5-kernel-overlay.md) の「実機テストで、古い部品が混ざっていた」）。

```bash
# 計測用ブランチの最新の成功した Package VSIX の実行（2026-10-09 時点では 37824014250）
RUN=$(gh run list -R usudonsdev/microgit -w package.yml -b measure/61-layer-breakdown -s success -L 1 --json databaseId -q '.[0].databaseId')
echo "run: $RUN"
mkdir -p ~/microgit-61 && cd ~/microgit-61
gh run download "$RUN" -R usudonsdev/microgit -n vsix -D vsix
mkdir -p darwin && unzip -q vsix/*darwin-arm64.vsix -d darwin
ls darwin/extension/resources/kernel/darwin-arm64/microgit-vm darwin/extension/resources/kernel/guest/arm64/Image
cd -   # リポジトリに戻る
```

確かめること：

- `microgit-vm` と `Image` の 2 つがある
- 次の §4.1 の出力の `agent=1.2.0` で、計測用の agent が入っていると分かる（`1.1.0` なら古い）

---

## 4. 測る

### 4.1 VS Code の外（往復そのものの費用）

```bash
for i in 1 2; do node scripts/bench-agent-rtt.mjs --plan ~/microgit-61/darwin/extension --n 300; done
```

出力の例（値は Windows のもの）：

```
launch: Virtualization.framework: ...  agent=1.2.0 kernel=6.18.53
n=100 p50 ms: roundTrip 3.988  guest 0.213  send 0.039  wire 3.659 (p95 4.862)  resume 0.046
```

注意：このスクリプトは中身を 1 行で送る（`writeb64`）ので、**stage の往復は含まない**。Mac の拡張機能が実際にする「stage → commit」の 2 往復分は、§4.2 の `stage` の列で見る。

### 4.2 VS Code の中（拡張機能テストで保存を 100 回）

```bash
OUT=~/microgit-61/data && mkdir -p "$OUT"

# カーネル版
MICROGIT_TEST_VSIX=$(ls ~/microgit-61/vsix/*darwin-arm64.vsix) \
MICROGIT_TEST_SAVE_BENCH=100 \
MICROGIT_TEST_SAVE_BENCH_OUT="$OUT/save-bench-kernel.json" \
MICROGIT_TEST_EXPECT_BACKEND=kernel \
npm test

# 比べるための Node.js 版（同じ機械・同じ VSIX）
MICROGIT_TEST_VSIX=$(ls ~/microgit-61/vsix/*darwin-arm64.vsix) \
MICROGIT_TEST_SAVE_BENCH=100 \
MICROGIT_TEST_SAVE_BENCH_OUT="$OUT/save-bench-nodejs.json" \
MICROGIT_TEST_EXPECT_BACKEND=nodejs \
MICROGIT_TEST_BACKEND_SETTING=nodejs \
npm test
```

- 5 件のテストが通ること（`5 passing`）。カーネル版で `guest.mount と wire が付いた保存が … 回しかない` と落ちたら、カーネル版で層を作れていない。`MicroGit: Overlay Status` のログ（テストの出力の `active=`）と、`launcher stderr` を見る
- ログの `[save-bench] 最後の区間` の表と、`l.*` の行（層づくりの内訳）を記録する

### 4.3 まとめる

```bash
node scripts/summarize-save-bench.mjs ~/microgit-61/data --last 50
```

`層づくりの内訳` の表が出る。ファイル名が `save-bench-*.json` になっていれば、環境の名前は `kernel`・`nodejs` になる。

---

## 5. 結果の読み方と、直す候補

### 5.1 読み方

| 見えたこと | 意味 | 次にすること |
|---|---|---|
| `loop.blocked`・`loop.maxGap` が往復とほぼ同じ | 拡張機能ホストのループが、ほかの同期処理でふさがれている | テストや MicroGit のほかの処理に、同期の Git の起動などが残っていないか探す（[調査](./save-bottleneck-investigation.md) §2.5 と同じ） |
| ループは空いている（`loop.blocked` ≒ 0）が `wire` が大きい | 通り道（virtio-console と microgit-vm）そのものが遅い | §4.1 の外の値と比べる。外でも同じなら、通り道の費用 |
| `stage` が層づくりの大半 | 小さいファイルでも stage → commit の 2 往復をしている（§1） | §5.2 の修正 |
| `guest.*` の合計が数 ms 以上 | ゲストの中が遅い（Windows・Linux では 1 ms 前後だった） | `guest.mount`・`guest.ops` のどれかを見る。値と一緒に報告する |

### 5.2 直す候補：1 行に収まる小さいファイルは、stage せずに送る

今は、`maxFrameBytes` が決まっている通り道（Mac）では、ファイルの大きさにかかわらず `writeupload`（先に `stage` で送った中身を使う）にしている。

| 場所 | 今の動き |
|---|---|
| `src/kernel/layerFeeder.ts` の `ensureFromDelta` | `if (this.agent.spec.maxFrameBytes)` なら、すべてのファイルを `uploads` に入れ、`['writeupload', ...]` にする |
| 同じファイルの `buildOps` | 同じ |
| 同じファイルの `commitRequest` | commit の JSON が `maxFrameBytes` 未満なら 1 回で送り、超えるときだけ `stageOp` に分ける（**op はすでに「収まるならまとめて送る」になっている**） |

直し方の案：

1. 各ファイルについて、`['writeb64', path, base64, mode]` にしたときの大きさを見積もる
2. commit の JSON 全体が `maxFrameBytes` に収まる範囲なら、そのファイルは `writeb64` のまま送る（stage しない）
3. 収まらないファイルだけ、今までどおり `stage` → `writeupload` にする

これで、Mac の普段の保存（数 KB のソースファイル 1 つ）は、往復が 2 回から 1 回になる見込み。

確かめること：

- 単体テスト（`src/test/unit/layerFeeder.test.ts`）
  - 今あるテスト「上限がある通り道では stage に分け、commit は writeupload だけを送る」（100 KiB のファイル）は、そのまま通ること
  - 新しく「上限がある通り道でも、1 行に収まる小さいファイルは stage せず writeb64 で送る」を足す
  - 新しく「小さいファイルと大きいファイルが混ざると、大きいほうだけ stage する」を足す
  - どれも、送った要求の JSON が 1 つも `maxFrameBytes` を超えないこと
- Mac の実機
  - `mac/run-golden.sh`（12 シナリオ）
  - `node scripts/test/kernel-backend-e2e.mjs --plan --max-depth 2`（差分テスト。3 MiB と 700 ファイルを含む）
  - §4.2 のベンチを、直す前と後で取り、`stage` と層づくりの値を比べる
- **約 64 KiB で止まる問題が再発しないこと。** 48 KiB（`maxFrameBytes`）を超える 1 行を送らない

### 5.3 直さないもの

- Mac の通り道を vsock などに替えること（変更が大きい。測った結果、通り道そのものが律速だと分かってから考える）
- Windows・Linux の動き（`maxFrameBytes` が無い通り道は、今までどおり 1 行で送る）

---

## 6. 残すもの

1. **データ**：`~/microgit-61/data/*.json` を、計測用ブランチの `docs/paper/data/local-mac-61/` にコミットする。§4.1 の出力も、同じ場所に `rtt.txt` として残す
2. **機械の情報**：チップ（例：Apple M5）、macOS の版、`node --version`、VS Code の版（テストの出力に出る）、使った VSIX の run の番号
3. **報告**（Issue #61 にコメント）：次の表を埋める

| Mac（チップ、macOS の版） | カーネル版 | Node.js 版 |
|---|---|---|
| 保存 1 回の処理全体 | | |
| うち記録 | | |
| うち層づくり | | |
| 層づくりのうち stage | | |
| 層づくりのうち通信（wire） | | |
| ループがふさがれた時間（loop.blocked） | | |
| 過去に戻る操作（10 回の中央値） | | |
| VS Code の外の往復（§4.1） | | — |

4. §5.2 の修正をした場合は、直す前と後の値を並べ、[save-bottleneck-investigation.md](./save-bottleneck-investigation.md) に「Mac」の節を足す（文書の変更は文書用のブランチで行い、master へは利用者に確かめてから）

---

## 7. つまずいたとき

| 症状 | 見るところ |
|---|---|
| `Virtualization is not available on this hardware` | 仮想マシンの中の macOS など、仮想化が使えない環境で動かしている。実機で動かす |
| 起動ツールが署名の問題で止まる | `codesign -dv --entitlements - ~/microgit-61/darwin/extension/resources/kernel/darwin-arm64/microgit-vm` で、ad-hoc 署名と entitlements を見る。手元でビルドするなら `mac/build.sh` |
| テストで `active=nodejs` になる | テストの出力の `launcher stderr` と、ゲストのコンソールのログ `microgit-guest-console.log`（拡張機能の中では VS Code の拡張機能用のログフォルダ（`context.logUri`）、§4.1 のスクリプトでは `$TMPDIR`） |
| 保存の途中で応答が返ってこない | 64 KiB を超える 1 行を送っていないか。§5.2 の修正のあとなら、まず疑う |
| `agent=1.1.0` と出る | 古い VSIX か `Image`。§3 を run の番号から取り直す |
