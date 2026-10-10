# 引き継ぎ：Mac で続ける作業（2026-10-09）

| 項目 | 内容 |
|---|---|
| 読む人 | Mac で作業を続ける利用者と、Mac で動かすエージェント |
| 目的 | Windows の機械で 2026-10-09 に進めた作業（#61 の調査、5.1.2 の公開の途中）を、チャットの履歴なしで Mac から続けられるようにする |
| 先に読むもの | [save-bottleneck-investigation.md](./save-bottleneck-investigation.md) §1（結論）・§8（保存の処理の今の姿）・§9（Windows の fsync） |

---

## 0. 守ること

- 報告・文書・コミットのメッセージは **すべて日本語**
- **計測のためだけの変更は master に入れない。** ブランチ `measure/<issue>-<名前>` で行う（利用者の方針、2026-10-09）
- master へのマージ、ストアへの公開は、利用者が決めたものだけ行う
- トークンなどの秘密は、チャットにもリポジトリにも書かない
- 数字には、機械・回数・どの区間の中央値かを添える。確かめていないことは、そう書く

---

## 1. 今の状態

| もの | 状態 |
|---|---|
| `master` | d0c5106（PR #63 のマージ）。5.1.2。#61 の文書・記事・Mac の指示書・ストアの説明文（`README-marketplace.md`）が入っている |
| タグ `v5.1.2` | d0c5106 に付けて push 済み。package.yml（run 37880129730）が通り、GitHub Release の **下書き** がある |
| VS Code Marketplace | **5.1.1 のまま**。5.1.2 の公開はトークンの期限切れで失敗（§2）。2026-10-10 に master は 5.1.3（テストの修正）になった。5.1.3 のタグと公開は利用者の許可待ち。許可が出て 5.1.3 を出すなら、5.1.2 を飛ばして 5.1.3 を公開してよい（5.1.3 は 5.1.2 の内容を含む） |
| Open VSX | 5.1.1 のまま。5.1.2 は後で（利用者の判断） |
| 記事 `articles/microgit-save-bottleneck-was-the-test.md` | master にあるが `published: false`（Zenn では非公開）。公開するときは `true` にして master へ |
| ブランチ `measure/61-layer-breakdown` | #61 の計測のコード。層づくりの内訳（agent 1.2.0 の `phasesUs`、`layerPhases`）、テストが保存の最中に Git を起動しない修正（`microgit.internal.lastSave`）、`scripts/bench-agent-rtt.mjs`。**master には入れていない** |
| Issue #61 | 開いたまま。途中経過と結果をコメント済み |

---

## 2. 5.1.2 を VS Code Marketplace に公開する

5.1.2 の中身は、ストアの説明文の書き直しだけ（拡張機能の動きは変えていない）。手順は [release.md](./release.md) §3 と同じ。経過は §3.4 に書いてある。

### 2.1 準備

```bash
brew install node@20 gh          # 入っていれば不要
gh auth login                    # 初回だけ
```

### 2.2 新しいトークンを登録する

1. https://dev.azure.com/ にサインインし、右上の「User settings」→「Personal access tokens」→「New Token」
2. Organization：**All accessible organizations**、Scopes：「Custom defined」→ **Marketplace** の **Manage**、期限：**2026-12-01 まで**（この種類のトークンは 12 月 1 日に廃止される）
3. ターミナルで登録する（トークンはここに貼る。チャットには貼らない）

```bash
npx @vscode/vsce login usudonsdev
npx @vscode/vsce ls-publishers   # usudonsdev が出れば登録できている
```

### 2.3 下書きの VSIX を取って確かめる

```bash
mkdir -p ~/microgit-512 && cd ~/microgit-512
gh release download v5.1.2 -R usudonsdev/microgit -p '*.vsix' -p 'vsix.json'
# 5 つの sha256 が vsix.json に載っているか
node -e "const fs=require('fs'),c=require('crypto');const j=fs.readFileSync('vsix.json','utf8');for(const f of fs.readdirSync('.').filter(f=>f.endsWith('.vsix'))){const h=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');console.log(f, j.includes(h)?'一致':'不一致')}"
# ストアの説明文が初めての人向けの文か
unzip -p microgit-5.1.2-darwin-arm64.vsix extension/readme.md | head -3
```

5 つとも「一致」、説明文の 1 行目の次が「**ファイルを保存するたびに、そのときの状態を自動で残しておく拡張機能です。**」なら次へ。

### 2.4 公開する

```bash
npx @vscode/vsce publish --packagePath \
  microgit-5.1.2-win32-x64.vsix microgit-5.1.2-linux-x64.vsix microgit-5.1.2-linux-arm64.vsix \
  microgit-5.1.2-darwin-arm64.vsix microgit-5.1.2-universal.vsix
```

- 5.1.1 のときは、linux-arm64 の 1 回目がギャラリーの API のタイムアウトで失敗した。そのときは、失敗したものから後ろだけを出し直す（同じ版を二重に出そうとすると、出ているものはエラーになる）
- 公開できたら、ストアの版を確かめる

```bash
curl -s "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Content-Type: application/json" -H "Accept: application/json;api-version=7.2-preview.1" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"usudonsdev.microgit"}]}],"flags":1}' | grep -o '"version":"[0-9.]*"' | head -3
```

### 2.5 後始末

1. GitHub Release を公開する：`gh release edit v5.1.2 -R usudonsdev/microgit --draft=false`
2. [release.md](./release.md) §3.4 の表に、公開した日と確かめたことを足し、「（途中）」を消す。CHANGELOG の `[5.1.2]` の日付が公開日と違えば直す
3. この 2 の変更は、文書のブランチで作って master へ（利用者に確かめてから）

### 2.6 後でやること

- **Open VSX**：`npx ovsx login usudonsdev`（利用者がトークンを入れる）→ 同じ 5 つを `npx ovsx publish --packagePath ...`。公開直後は版が有効になるまで公開 API から見えないことがある。無効のまま残った版を消すと、その版番号は二度と使えない
- **Marketplace の認証を Microsoft Entra ID に移す**（2026-12-01 まで）。Azure CLI でサインインし、`vsce publish --azure-credential` で公開できるかを確かめる

---

## 3. Mac のカーネル版の保存の速さを測る

[mac-kernel-measurement-instructions.md](./mac-kernel-measurement-instructions.md) のとおり。要点：

- ブランチ `measure/61-layer-breakdown` で行う。VSIX はそのブランチの最新の成功した Package VSIX の実行（2026-10-09 時点では run 37824014250）から取る
- VS Code の外（`scripts/bench-agent-rtt.mjs --plan`）と中（拡張機能テストで保存 100 回）の両方を、カーネル版と Node.js 版で測る
- Mac は 1 行 48 KB の上限のため、小さいファイルでも保存のたびに stage → commit の 2 往復がある見込み。測って確かめ、効いていれば「1 行に収まる小さいファイルはそのまま送る」修正を、別の Issue のブランチで作る

---

## 4. Windows のジャーナルの fsync を調べる

[save-bottleneck-investigation.md](./save-bottleneck-investigation.md) §9。CI の Windows では、保存 1 回 15.34 ms のうちジャーナルの fsync が 5.29 ms（p95 17 ms）で、しかも `fs.fdatasyncSync` で同期に呼んでいる。

Mac からでも、CI の Windows（遅いディスク）で測れる。

1. ブランチ `measure/<新しい Issue>-journal-fsync` を作る
2. 小さなベンチ（例：`scripts/bench-journal-fsync.mjs`）を書く。同じ大きさ（保存 1 回分、数 KB）の追記を、次の方法で数百回ずつ行い、1 回の時間の中央値・p95 を出す
   - 今と同じ：`fs.openSync(file, 'a')` → `writeSync` → `fdatasyncSync`
   - 先に広げたファイル：あらかじめ大きさを取ったファイルに、位置を指定して `writeSync` → `fdatasyncSync`
   - write-through：`fs.constants.O_DSYNC` を付けて開き、`writeSync` だけ（Windows で効くかも確かめる）
   - 非同期：`fs.fdatasync`（コールバック）にして、待つあいだにイベントループが止まらないこと（`setImmediate` のすき間）も測る
3. `windows-latest` と `ubuntu-latest`・`macos-latest` で走る、`workflow_dispatch` だけの小さなワークフローを計測用ブランチに足して回す（master には入れない）。手元の Mac の値も取る
4. 結果を §9 に書き足し、どの案を製品に入れるかを利用者と決める

---

## 5. 決まっていないこと

| 事項 | 選択肢・状況 |
|---|---|
| ~~テストの修正（`microgit.internal.lastSave`）を master に入れるか~~ | **済み**（2026-10-10、5.1.3 として master へ。利用者の決定） |
| Node.js 版の層づくりを速くするか | 保存の処理で最も重い（CI 14.8〜34 ms、手元の Windows 157 ms）。カーネル版の `ensureFromDelta` と同じ「親からの変化」を使えば、Git の起動と遅らせた書き出しの強制をやめられる見込み |
| 「気づかない」を測るテスト（拡張機能ホストが止まった最長の時間） | research-status.md §4 の P1。保存のあとの同期の Git（timeline.log・publish）と、保存の直後の同期処理も一緒に測れる |
| 記事の公開 | `published: true` にして master へ入れると Zenn に出る |

---

## 6. Windows の機械にだけ残っているもの（Mac からは見えない）

| もの | 場所 | 注意 |
|---|---|---|
| **別の作業の未コミットの変更**（利用者の LLM 向けスキル `use-microgit`：`src/agentSkill.ts`・`skills/`・README などの変更、QEMU の削減の境界の文書） | Windows の `microgit-test` の作業フォルダ（ブランチ `docs/release-5.1.0`） | **push されていない。** 5.1.1 より前の置き場所（`.microgit_logs` など）を書いているので、取り込むときは直す。README は、5.1.2 で README.md（GitHub 向け）と README-marketplace.md（ストア向け）に分かれたことに合わせる |
| worktree `microgit-issue-61`・`microgit-docs-61` | Windows の `Documents/GitHub/` | 中身はすべて push 済み（`measure/61-layer-breakdown`、`docs/61-*`）。消してよい |
| WSL の Go 1.27.1・Node 20 | WSL の `~/.local/go`・`~/.local/node` | agent のテストと VS Code の外の計測に使った |
| 図解のページ | claude.ai の Artifact（利用者の非公開のページ） | 文書と記事にも同じ図（mermaid）がある |
