# 07. 使えるものを選び、だめなら戻る／プロセス間のデータの通り道／差分テストが不具合を見つける

| 項目 | 内容 |
|---|---|
| 関係する Issue | #14（Linux ネイティブ、Backend Selector、MicroGit への組み込み） |
| 仕様 | [kernel-backend.md](../kernel-backend.md)、[ADR-0006](../adr/0006-windows-named-pipe.md) |
| 実装 | [src/kernel/](../../src/kernel/)、[src/extension.ts](../../src/extension.ts) |

---

## 1. 何のための仕組みか

カーネル版の OverlayFS は、使える環境と使えない環境がある。

- Linux：カーネルが新しく、非特権のユーザー名前空間が許されていれば使える。Ubuntu 23.10 以降は既定で止められている
- Windows：QEMU とゲストがあれば使える。仮想化機能が無効なら遅い方法（TCG）になる
- macOS：Virtualization.frameworkをApple silicon実機で確認。virtio-consoleの約64 KiB制限は`stage` / `readChunk`で分割

MicroGit は「どの環境でも動く」ことが最優先なので、**使えるならカーネル版、だめなら今までの Node.js 版**に、利用者が何もしなくても切り替わる必要がある。

---

## 2. 仕組み

### 2.1 優雅な縮退（graceful degradation）

速いが壊れやすい道と、遅いが確実な道を用意し、前者がだめなら後者に落ちる。これを「優雅な縮退」という。大事なのは次の 3 つ。

| 原則 | MicroGit での形 |
|---|---|
| **試してから決める** | 「Linux だから使えるはず」で決めない。agent を起動し、小さな層を 1 枚作って捨てるところまでやって、初めて「使える」とする（probe） |
| **失敗の理由を残す** | 「Node.js 版を使う: unshare: write failed /proc/self/uid_map: Operation not permitted」のように、子プロセスの stderr まで含めて出力に残す。設定で `kernel` を選んだ人には通知する |
| **途中で落ちても続ける** | 過去に戻る操作の途中でカーネル版が失敗したら、その場で Node.js 版でやり直す。agent が落ちたら、次の操作で 2 回まで起動し直す |

### 2.2 遅延起動と、同時に呼ばれたときの 1 回化

仮想マシンの起動には時間（Windows で約 1 秒）とメモリがかかる。VS Code を開いただけで起動すると、MicroGit を使わない人にも負担をかける。そこで **最初に必要になったとき**（最初の保存か、過去に戻る操作）に起動する。

保存が続けて起きると、「起動して」が何度も呼ばれる。そのたびに起動すると仮想マシンが何台も立ち上がるので、**起動中の Promise を覚えておき、2 回目以降はそれを待つ**（`BackendSelector.ensureKernel()` の `starting`）。

```ts
if (!this.starting) {
    this.starting = this.start().finally(() => { this.starting = undefined; });
}
return this.starting;
```

### 2.3 プロセス間の通り道は、測ってから選ぶ

MicroGit（拡張機能）と agent は別のプロセスなので、データを受け渡す通り道（IPC）が要る。

| 通り道 | 例 | 特徴 |
|---|---|---|
| 標準入出力（stdin/stdout） | Linux の `unshare -Urm <agent>` | どこでも使えて単純 |
| 名前付きパイプ | Windows の `\\.\pipe\...` | Windows の標準的な IPC。名前でつなぐ |
| TCP | `127.0.0.1:ポート` | どこでも使えるが、同じ PC のほかのプロセスもつなげる |
| Unix ドメインソケット | `/run/user/1000/x.sock` | ファイルの権限で守れる |

最初は、Windows の QEMU でも stdin/stdout を使っていた。小さな命令しか送らないテストでは問題が無かったが、MicroGit に組み込んで実際の大きさのファイルを流すと、**16 KiB に 1.2 秒、1 MiB では 78 秒かかったうえに中身が壊れた**。名前付きパイプに替えると、1 MiB が 26 ms で壊れなかった。

教訓は 2 つ。

- **小さな入力のテストは、大きな入力の問題を隠す**。実際の大きさで流すテスト（差分テスト）が要る
- **遅いときは、大きさを変えて測る**（16 KiB・64 KiB・256 KiB・1 MiB…）。時間が大きさに比例するのか、急に跳ね上がるのかで、原因の見当がつく

### 2.4 通り道の安全性

名前付きパイプは名前でつなぐので、「別のプロセスが先につないだら？」を考える必要がある。MicroGit では、

- 名前を毎回 128 ビットの乱数にする
- QEMU のパイプは接続を 1 つしか受け付けないので、MicroGit がつないだあとは誰もつなげない
- 先を越されたら MicroGit はつなげず、Node.js 版に切り替わる。先を越したプロセスが手にするのは空のゲストで、利用者のファイルはまだ送っていない

「完全には防げないが、失敗しても安全側に倒れる」形にしてある（ADR-0006）。

### 2.5 差分テストが、既存の不具合を見つけた

カーネル版を作ったあと、同じ Git の履歴から「カーネル版で戻ったワークスペース」「Node.js 版で戻ったワークスペース」「Git のツリーそのもの」の 3 つを比べるテストを書いた（`scripts/test/kernel-backend-e2e.mjs`）。これが 2 つの問題を見つけた。

1. **Node.js 版の既存の不具合（N-7）**：ファイル `p` がディレクトリ `p/` に置き換わった時点へ戻ると、例外で止まる。原因は「書く → 消す」の順番で、まだ残っている古いファイル `p` の上にディレクトリを作ろうとしていた
2. **Boundary Guard の弱点**：中のファイルが全部消える予定のディレクトリでも、「ディレクトリがある」という理由でファイルへの置き換えを断っていた

どちらも「消す → 書く」の順にし、「消したあとファイルが 1 つも残らないディレクトリだけは置き換えてよい」という規則にそろえて直した。**2 つの実装を比べると、片方だけでは気づけない不具合が見つかる**（[01](./01-golden-testing-and-namespaces.md) の差分テスト）。

### 2.6 テストの環境の落とし穴

VS Code の拡張機能テストを、VS Code の中から（例えばこのような AI エージェントの端末から）動かすと、テスト用の VS Code が起動せず、ワークスペースのパスを「JavaScript のファイル」として読もうとして失敗した。原因は環境変数 `ELECTRON_RUN_AS_NODE=1` で、これが引き継がれると Electron のアプリ（VS Code）は普通の Node として動く。テストの起動スクリプトでこの変数を消して直した。**テストが変な失敗をしたら、テストを動かしている環境（環境変数、親プロセス）も疑う**。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| 設定ごとの選び方、遅延起動、1 回化、起動し直し、切り替え | `src/kernel/backendSelector.ts` |
| ホストごとの起動の計画（使えない理由を返す） | `src/kernel/launchers.ts` の `planLaunch()` |
| 起動して確かめる（ready → probe） | `src/kernel/kernelBackend.ts` の `KernelOverlayBackend.start()` |
| stdin/stdout と名前付きパイプの両方で話す | `src/kernel/agentConnection.ts` |
| 拡張機能への組み込み | `src/extension.ts` の `createBackendSelector()`・`applyKernelCheckout()`・`runShadowCommit()` |
| 差分テスト、環境での起動の確認、速さ | `scripts/test/kernel-backend-e2e.mjs`、`scripts/test/native-fallback.mjs`、`scripts/bench-backends.mjs` |

---

## 4. 手を動かして確かめる

1. **自分の PC でどちらが選ばれるか**：`npm run compile && node scripts/test/native-fallback.mjs`
2. **設定を変えてみる**：VS Code の設定で `microgit.overlayBackend` を `nodejs` にし、`MicroGit: Overlay Status` で `active=nodejs` になるのを見る。`kernel` に戻すと、次の保存か過去に戻る操作でカーネル版が起動する
3. **速さを比べる**：`node scripts/bench-backends.mjs`。`FILES=1000` にすると差が広がる
4. **遅さの原因を大きさで探る**：`scripts/test/kernel-backend-e2e.mjs` に大きいファイルのシナリオを足し、`--plan`（拡張機能と同じ起動）で流す

---

## 5. もっと知りたいとき

- 「graceful degradation」「feature detection vs. user-agent sniffing」（Web で、ブラウザの種類ではなく機能の有無を試して決める話と同じ考え方）
- Microsoft のドキュメント「Named Pipes」「Named Pipe Security and Access Rights」
- QEMU のドキュメント「chardev」（`-chardev stdio / pipe / socket` の違い）
- Electron のドキュメント「ELECTRON_RUN_AS_NODE」
