# 実装の解説：小さな Linux の中で OverlayFS を動かす

| 項目 | 内容 |
|---|---|
| 対象 | `feature/kernel-portability` ブランチの実装（2026-09-26 時点） |
| 読む人 | MicroGit の作者。OS や仮想化の専門知識は前提にしない |
| 関連 | 設計の理由は [初期設計書](./microgit-kernel-feature-portability-design.md)、決定と計測は [Phase 1](./guest-phase1.md)・[Windows](./windows-backend.md)、テストは [ゴールデンテスト](./overlayfs-golden-test.md) |

この文書は「何がどこで動き、保存 1 回のあいだに何が起きるか」を順番に説明する。まず §1 の地図と §2 の旅を読み、気になった部品を §3 で読むのがおすすめ。§5 には手を動かして確かめる課題がある。

---

## 0. まず動かしてみる

Windows なら次の 1 行で、仮想マシンの起動から「保存・削除・過去に戻る・枝分かれ」までを 1 段ずつ見られる。

```powershell
powershell -ExecutionPolicy Bypass -File windows\run-golden.ps1 -Demo -Step
```

画面の各段が、この文書のどこに当たるかは §2 の表に書いた。

---

> MicroGit 本体への組み込み（保存と過去に戻る操作がカーネル版を使う流れ、設定、速さ）は [kernel-backend.md](./kernel-backend.md) にまとめた。この文書はデモを使って、ゲストの中で起きることを追う。

## 1. 全体の地図

```
┌─────────────── あなたの PC（ホスト） ───────────────┐
│                                                     │
│  node scripts/guest/demo.mjs          ← 命令を出す係 │
│        │ 1 行 1 JSON を stdin に書き、stdout で受け取る │
│        ▼                                             │
│  QEMU（Windows） / microgit-vm（Mac）  ← 仮想マシンを作る係 │
│        │ virtio-console という「仮想の線」            │
└────────┼────────────────────────────────────────────┘
         ▼
┌─────────────── 仮想マシンの中（ゲスト） ─────────────┐
│  Linux カーネル 6.18.53（最小構成）                   │
│    └ OverlayFS                        ← 層を重ねる係  │
│  /init = agent（Go で書いた 1 ファイル） ← 命令を実行する係 │
│    └ 層は /run/microgit（メモリ上）に置く            │
└─────────────────────────────────────────────────────┘
```

| ファイル | どこで動くか | 役割 |
|---|---|---|
| [guest/agent/main.go](../guest/agent/main.go) | ゲスト | 起動直後の準備と、命令の受け答え |
| [guest/agent/overlay.go](../guest/agent/overlay.go) | ゲスト | OverlayFS の層を積む・見る・読む |
| [guest/kernel/](../guest/kernel/) | （ビルド時） | カーネルのバージョンと設定 |
| [guest/build.sh](../guest/build.sh) | GitHub Actions | カーネルと agent をビルドして `Image` 1 ファイルにする |
| [scripts/guest/agent-client.mjs](../scripts/guest/agent-client.mjs) | ホスト | 仮想マシンを起動し、agent と JSON でやりとりする |
| [scripts/guest/demo.mjs](../scripts/guest/demo.mjs) | ホスト | デモ |
| [scripts/golden/check-guest.mjs](../scripts/golden/check-guest.mjs) | ホスト | ゴールデンテストをゲストで流して照合する |
| [windows/run-golden.ps1](../windows/run-golden.ps1) | ホスト（Windows） | QEMU の引数を組み立てて、上の 2 つを動かす |
| [mac/microgit-vm/main.swift](../mac/microgit-vm/main.swift) | ホスト（Mac） | Mac 標準の仕組みで仮想マシンを作る（Apple silicon実機確認済み） |

---

## 2. 保存 1 回の旅

デモの「2. 書き換えと削除」で、`src/app.js` を書き換えて `notes/todo.txt` を消すときに起きることを、順番に追う。

### ① ホストが命令を書く

`demo.mjs` の `commit()` が、次の 1 行を QEMU の stdin に書く（[agent-client.mjs](../scripts/guest/agent-client.mjs) の `request()`）。

```json
{"id":5,"op":"commit","layer":"1","parent":"0","ops":[["write","src/app.js","console.log('v2')"],["rm","notes/todo.txt"]]}
```

- `id`：答えと対応づけるための番号。agent は同じ `id` を付けて答える
- `layer`：作る層の名前。名前はホスト（命令を出す側）が決める。デモでは番号、MicroGit に組み込むときは Git のコミットのハッシュを使う
- `parent`：どの層の上に積むか。ここではコミット #0 の上。空文字列なら親の無い層
- 命令の形の全体は [agent-protocol.md](./agent-protocol.md)（v1）
- `ops`：やりたい操作の列。ゴールデンテストのシナリオと同じ形

### ② QEMU がゲストに渡す

QEMU の起動引数のこの部分が、stdin/stdout を仮想マシンの「線」につないでいる（[run-golden.ps1](../windows/run-golden.ps1)）。

```
-device virtio-serial-pci                                  仮想のシリアル通信の装置を差す
-chardev stdio,id=proto,signal=off                         QEMU の stdin/stdout を proto と名付ける
-device virtserialport,chardev=proto,name=microgit         proto を "microgit" という名前の線にする
```

ゲストの中では、この線が `/dev/vport0p1` というファイルとして見える。

### ③ agent が受け取る

agent は起動時に、名前が `microgit` の線を探して開いている（[main.go](../guest/agent/main.go) の `findPort()`）。番号（`vport0p1`）は QEMU と Mac で違うので、名前で探す。

`serveStream()` が 1 行読み、JSON を解釈して `handle()` に渡す。`op` が `commit` なので、`store.commit()` が呼ばれる。

### ④ OverlayFS の層を重ねて mount する

ここが本題（[overlay.go](../guest/agent/overlay.go) の `commit()`）。

```
/run/microgit/
  base/   空っぽの一番下の層
  l0/     コミット #0 の層（README.md、src/app.js v1、notes/todo.txt）
  l1/     ← 今から作るコミット #1 の層（最初は空）
  w1/     OverlayFS が作業に使う場所（凍結したら消す）
  m/      重ねた結果が見える場所（mount 先）
```

agent はカーネルに、次の mount を頼む。

```
mount -t overlay overlay -o lowerdir=l0:base,upperdir=l1,workdir=w1,userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off m
```

- `lowerdir`：読み取り専用で下に敷く層。左ほど上。ここでは「#0 の層」と「空の base」
- `upperdir`：書き込みを受け止める層。空の l1
- 後ろのオプションは固定している（[ADR-0005](./adr/0005-mount-options.md)）。カーネルの版で既定値が変わらないようにするため
- `m` を覗くと、l0 と base を重ねた結果（= コミット #0 の姿）が見える
- 層のディレクトリ名は短い番号にしている。mount のオプション文字列は 4096 バイトまでなので、40 文字の Git のハッシュを並べると余裕が小さい（[ADR-0003](./adr/0003-layer-compaction.md)）

### ⑤ 操作を当てる

agent は `m` の中で普通にファイル操作をする（`applyOp()`）。

- `write src/app.js`：`m/src/app.js` に書く。OverlayFS は l0 のファイルを l1 にコピーしてから書き換える（**コピーアップ**）。l0 は変わらない
- `rm notes/todo.txt`：`m/notes/todo.txt` を消す。l0 のファイルは消せないので、OverlayFS は l1 に「ここは消えた」という目印を置く（**whiteout**。中身は種類 0,0 の特殊なデバイスファイル）

この結果、l1 には「変わったところ」だけが入る。agent の `inspect` 命令で、層の中身をこの形で見られる（`w` が whiteout）。

```
l1/
  src/app.js        console.log('v2')
  notes/todo.txt    （whiteout）
```

### ⑥ unmount して凍結する

agent は `m` を unmount する。l1 はもう書き換えない。これで l1 が「コミット #1」になる。次にコミット #1 の上に積むときは、l1 が lowerdir に入る（`lowerdirs()` が親をたどって l1:l0:base を作る）。

これが要件定義書 FR-2 の「upper を凍結して新しい lower にする」そのもの。保存のたびに 1 枚作る方式に決めた理由は [ADR-0004](./adr/0004-commit-per-save.md)（層のコミットは 0.1 ms ほどで、保存の時間のほとんどは Git の手順が占める）。

### ⑦ 答えを返す

agent は次の 1 行を線に書く。QEMU がそれを stdout に出し、`agent-client.mjs` の `onLine()` が `id` を見て、待っている `commit()` に渡す。

```json
{"id":5,"ok":true,"layer":"1","depth":2,"mountOptions":"rw,relatime,redirect_dir=nofollow,uuid=on,userxattr","elapsedUs":118}
```

`elapsedUs` はゲストの中で ④〜⑥ にかかった時間（マイクロ秒）。WHPX なら 0.1 ms ほど。

### ⑧ 見る・読む

デモはそのあと `view` と `read` を送る（`store.view()`、`store.readMany()`）。`read` の中身は base64 で返るので、バイナリのファイルも送れる。どちらも、そのコミットまでの層を **upperdir なし**（読み取り専用）で mount して中を見て、すぐ unmount する。

- `view`：ファイル一覧を「種類・パス・sha256」で返す（ゴールデンテストと同じ形）
- `read`：1 つのファイルの中身を返す

| デモの段 | この旅のどこか |
|---|---|
| 0. 起動 | §3.1（カーネルが agent を起動するまで） |
| 1〜2. 保存 | ①〜⑦ |
| 3. 過去に戻る | ⑧ を古いコミットで行うだけ。層を書き換えていないので、昔の姿がそのまま見える |
| 4. 枝分かれ | ④ で `parent` に #0 を指定する。#1 と #2 は l0 を共有し、互いの l1・l2 は見ない |
| 5. フォルダの名前変更 | §3.3 の EXDEV |

---

## 3. 部品ごとの解説

### 3.1 最小カーネルと起動の流れ

**ビルド**（[guest/build.sh](../guest/build.sh)、GitHub Actions で実行）

1. agent を Go でビルドする（`GOOS=linux`、`CGO_ENABLED=0` で他に何も要らない 1 ファイルにする）
2. kernel.org からカーネルのソースを取り、sha256 で改ざんがないか確かめる
3. `allnoconfig`（全部オフ）から始めて、[microgit.config](../guest/kernel/microgit.config) に書いたものだけをオンにする
4. agent を「起動時に最初に展開されるファイル群」（initramfs）としてカーネルに埋め込む
5. できたのが `Image`（x86_64 では bzImage）。これ 1 ファイルで起動できる

**設定で気をつけたこと**

- ネットワーク（`CONFIG_NET`）はオフ。外から攻撃される経路がなくなる（NFR-4）。オンになっていたらビルドを止める
- `allnoconfig` だと Go のプログラムが使う機能（FUTEX・EPOLL・EVENTFD）まで切られるので、明示的にオンにしている
- 頼んだ設定が、依存関係のせいで黙って落ちていないかをビルド後に確かめる

**起動**

```
カーネル起動 → initramfs を展開 → /init（= agent）を PID 1 として起動
agent: /proc /sys /dev /run を mount → 名前 "microgit" の線を探す → {"event":"ready"} を送る
```

PID 1 は OS で最初に動くプログラムで、これが終わるとカーネルは止まってしまう（パニック）。そのため agent は `main()` から戻らない作りにしてあり、困ったときは電源を切る（`fatal()` → `powerOff()`）。

シェル（bash など）は入れていない。万一乗っ取られても、攻撃者が使える道具がない（AD-7）。

### 3.2 agent の命令

| op | すること | 実装 |
|---|---|---|
| `hello` | 命令の形の版、カーネルと agent の版、固定している mount オプションを返す | `hello()` |
| `reset` | 層をすべて捨てる | `store.reset()` |
| `commit` | 親の上に層を 1 枚積む。同じ名前・同じ親なら作り直さない | `store.commit()` |
| `view` | ある時点のファイル一覧 | `store.view()` → `dump()` |
| `read` / `readMany` | ある時点のファイルの中身（base64） | `store.readMany()` |
| `inspect` | 層そのものの中身（whiteout・opaque が分かる形） | `store.inspect()` |
| `stats` | 層の数と、置き場所の使用量 | `store.stats()` |
| `poweroff` | 答えてから電源を切る | `powerOff()` |

失敗すると、種類の記号（`UNKNOWN_LAYER`、`BAD_PATH`、`ENOENT` など）が `code` に付く。全体は [agent-protocol.md](./agent-protocol.md)。

agent を仮想マシンではなく普通のプログラムとして起動すると（PID 1 ではないとき）、同じ命令を stdin/stdout で受ける（`runStdio()`）。Linux なら `unshare -Urm guest/out/amd64/init` で、仮想マシンなしで同じことができる。これは「Linux では VM を使わない」（AD-2）経路の原型になる。

### 3.3 EXDEV：フォルダの名前変更

デモの 5 段目。下の層（lowerdir）にあるフォルダの名前を変えようとすると、カーネルは `EXDEV`（「別のファイルシステムをまたぐ移動はできない」）という エラーを返す。

理由は mount オプションの `redirect_dir=nofollow`。フォルダの名前変更を「層をまたいだ転送の記録」として持つ機能（redirect）は、非特権（`userxattr`）の mount では **そもそも使えない**。`userxattr` と `redirect_dir=on` を同時に指定すると、カーネルが `conflicting options` で断る（2026-09-26 に確認）。

agent は、普通の `mv` コマンドと同じく「中身をコピーして元を消す」ことで代わりにやる（`applyOp()` の `mv`）。結果の見え方は同じだが、大きなフォルダだとコピーの分だけ遅くなる。層の中を `inspect` で見ると、元のフォルダの whiteout と、新しい名前のフォルダのコピーが並んでいる。mount オプションの決定は [ADR-0005](./adr/0005-mount-options.md)。

### 3.4 ホスト側：AgentClient

[agent-client.mjs](../scripts/guest/agent-client.mjs) は 3 つのことをしている。

1. 仮想マシン（QEMU など）を子プロセスとして起動する
2. `waitReady()`：agent の `ready` が来るまで待つ（起動の完了を知る）
3. `request()`：`id` を付けて命令を送り、同じ `id` の答えが来たら返す。来なければ 30 秒で諦める

QEMU は起動直後に JSON でない文字を出すことがあるので、JSON として読めない行は無視している（`onLine()`）。

### 3.5 仮想マシンを作る係：QEMU と WHPX／TCG

[run-golden.ps1](../windows/run-golden.ps1) が組み立てる QEMU の引数の意味。

| 引数 | 意味 |
|---|---|
| `-M q35` | 仮想のマザーボードの種類（標準的な PC） |
| `-accel whpx,kernel-irqchip=off -accel tcg` | まず WHPX（Windows の仮想化機能）を試し、だめなら TCG（CPU のエミュレーション） |
| `-cpu max -smp 1 -m 256` | CPU はできるだけ新しい機能を持つもの、1 コア、メモリ 256 MB |
| `-nodefaults -display none` | 画面・キーボードなど、要らない装置を全部外す |
| `-no-reboot` | ゲストが再起動しようとしたら QEMU を終わる |
| `-kernel Image -append "console=hvc0"` | この Linux を直接起動し、ログは hvc0 に出させる |
| `-device virtio-serial-pci` | 仮想のシリアル通信の装置 |
| `-chardev file,...` と `-device virtconsole,...` | hvc0（ゲストのログ）をファイルに書く |
| `-chardev stdio,...` と `-device virtserialport,...,name=microgit` | 命令の線（§2 ②） |

**WHPX と TCG**

- WHPX：Windows の仮想化機能に、ゲストの命令を CPU で直接実行させる。速い。「Windows ハイパーバイザー プラットフォーム」が有効な PC だけ
- TCG：ゲストの命令を 1 つずつ翻訳して実行する。遅いが、どの PC でも動き、管理者権限も要らない

Mac では、QEMU の代わりに macOS 標準の Virtualization.framework を使う（[main.swift](../mac/microgit-vm/main.swift)）。やっていることは同じで、線の作り方の書き方が違うだけ。

### 3.6 正しさの物差し：ゴールデンテスト

```
シナリオ（overlayfs-scenarios.mjs） ─┬→ record-kernel.mjs：本物のカーネルで結果を記録 → *.golden（正解）
                                    ├→ check-node.mjs：今の Node.js 版で流して正解と比べる（食い違いは既知の一覧）
                                    └→ check-guest.mjs：ゲストの agent で流して正解と比べる（食い違いは許さない）
```

CI は push のたびに、arm64 と x86_64 のゲストで `check-guest.mjs` を流している。これで「どの OS・どの動かし方でも、同じシナリオに同じ結果を返す」（FR-1）ことを毎回確かめている。

---

## 4. 今の実装の割り切り

| 割り切り | 理由 | いつ直すか |
|---|---|---|
| 層はゲストのメモリ（tmpfs）に置く。電源を切ると消える | まず正しさと速さを測るため | O-2（#17） |
| ワークスペースのファイルとはまだつながっていない | 同上。ホストへの反映は Boundary Guard を通す必要がある | #16、#17 |
| 命令は 1 本の線で 1 つずつ | 要求と応答が 1 対 1 なら十分 | O-3（#17） |
| 命令の形は仮 | Phase 0 の #12 で正式に決める | #12 |
| QEMU は配布版を借りている（1.2 GB、抜き出しても 123 MB） | まず動くことを確かめるため | 必要な部品だけでビルドする（#18） |

---

## 5. 手を動かして確かめる

1. **デモを 1 段ずつ見る**：`windows\run-golden.ps1 -Demo -Step`。各段で §2 の該当箇所を読む
2. **TCG の遅さを体感する**：`-Demo -Accel tcg` と `-Demo -Accel whpx` で、まとめに出る時間を比べる
3. **ゲストのログを読む**：`guest\out\x86_64\console-windows-auto.log`。最後の `Run /init as init process` と `microgit-agent: ready` が §3.1 の起動の流れ
4. **デモを書き換える**：[demo.mjs](../scripts/guest/demo.mjs) の `commit()` の `ops` を変えて、自分のシナリオを試す（例：同じファイルを消してから作り直す）
5. **テストが壊れるのを見る**：[overlayfs-scenarios.mjs](../scripts/golden/overlayfs-scenarios.mjs) にシナリオを 1 つ足して `npm run golden:record`（WSL が要る）→ ゲストで `windows\run-golden.ps1` を流す。正解を取り直さずに流すと、食い違いとして出る

---

## 6. 用語集

| 用語 | 意味 |
|---|---|
| ホスト／ゲスト | 仮想マシンを動かしている側（あなたの PC）／仮想マシンの中 |
| OverlayFS | 複数のフォルダを透明なフィルムのように重ねて 1 つに見せる、Linux カーネルの機能 |
| lowerdir／upperdir | 読み取り専用で下に敷く層／書き込みを受け止める一番上の層 |
| コピーアップ | 下の層のファイルを書き換えるとき、上の層にコピーしてから書き換えること |
| whiteout | 下の層のファイルを「消えた」ことにする目印。上の層に置く |
| opaque ディレクトリ | 「このフォルダより下の層の中身は見せない」という印の付いたフォルダ |
| mount／unmount | ファイルシステムを、あるフォルダに取り付ける／外すこと |
| initramfs | カーネルが起動直後に展開する小さなファイル群。ここでは agent 1 つだけ |
| PID 1 | OS で最初に動くプログラム。終わるとカーネルが止まる |
| virtio | 仮想マシン用に作られた、軽い仮想装置の規格 |
| virtio-console | virtio のシリアル通信装置。ここではログと命令の線に使う |
| QEMU | 仮想マシンを作るソフト。Windows で使う |
| WHPX／TCG | QEMU の動かし方。仮想化機能を使う／CPU をエミュレーションする |
| Virtualization.framework | macOS に最初から入っている、仮想マシンを作る仕組み |
| EXDEV | 「ファイルシステムをまたぐ移動はできない」というエラー |
| userxattr | 非特権（管理者でない）で OverlayFS を使うための mount オプション |

---

## 7. よくある疑問

**Q. ゲストに Node.js は入っていないのに、ホストで Node.js を使ってよいのか**
A. ゲストに入れないのは大きさのため（数十 MB になる）。ホスト側は VS Code 自体が Node.js で動いているので、追加の負担はない。

**Q. Docker や WSL2 を使えばもっと簡単では**
A. 利用者にそれらを入れてもらう必要がある（NFR-1 に反する）。今回の方式は、必要なものをすべて拡張機能に同梱できる。

**Q. 保存のたびに仮想マシンを起動するのか**
A. しない。起動は最初の 1 回（0.7 秒ほど）で、以降は命令を送るだけ（1 回 0.1 ms ほど）。

**Q. 仮想マシンの中が乗っ取られたらどうなるのか**
A. ゲストは層に書くだけで、ワークスペースのファイルを直接触れない。ホスト側で中身を確かめてから反映する仕組み（Boundary Guard、#16）をこれから作る。ネットワークも持たせていない。
