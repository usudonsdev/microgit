# ADR-0006: Windows の QEMU との通り道は、乱数の名前の名前付きパイプにする

| 項目 | 内容 |
|---|---|
| 状態 | 採用 |
| 日付 | 2026-09-26 |
| 決めた人 | Claude（利用者の「#19 まで自律的に進める」の指示のもとで） |
| 関係 | #14、#18、O-3（制御チャネル）、[agent-protocol.md](../agent-protocol.md)、実装 [src/kernel/launchers.ts](../../src/kernel/launchers.ts)・[src/kernel/agentConnection.ts](../../src/kernel/agentConnection.ts) |

## 背景

agent との命令の通り道は、ゲストの virtio-console の名前付きポート `microgit` で、QEMU の側ではそれを何かの chardev（ホスト側の出入り口）につなぐ。Phase 1・2 の検証では `-chardev stdio`（QEMU の stdin/stdout）を使っていた。

#14 で MicroGit に組み込み、差分テストで実際の大きさのファイルを流したところ、Windows 版 QEMU の stdio の chardev で次のことが起きた（2026-09-26、Windows 11、QEMU 11.1）。

- ホスト → ゲストが毎秒 13 KB ほどしか出ない（16 KiB の commit に 1.25 秒、256 KiB に 20 秒）
- 1 MiB の commit が 78 秒かかったうえ、agent に届いた中身が壊れていた（`bad base64`）

小さな命令しか送らないゴールデンテストでは表に出なかった。原因は確かめていないが、Windows 版 QEMU の stdio の chardev は入力を小さな単位で読む作りだと考えている（推測）。

## 決定

Windows の QEMU では、`-chardev pipe,id=proto,path=microgit-<128 ビットの乱数>` を使う。MicroGit は QEMU を起動したあと、`\\.\pipe\microgit-<乱数>` に（QEMU がパイプを作るまで 50 ms ごとに、最大 30 秒）つなぐ。

Linux の VM なし、Linux の QEMU（CI）、mac の microgit-vm は stdin/stdout のまま。

## 理由

| 1 回の commit | stdio | 名前付きパイプ |
|---|---|---|
| 16 KiB | 1,251 ms | 4 ms |
| 1 MiB | 失敗（中身が壊れた） | 26 ms、往復で一致 |
| 16 MiB | — | 2,308 ms、往復で一致 |

## 採らなかった案

| 案 | 採らなかった理由 |
|---|---|
| TCP（`-chardev socket,host=127.0.0.1`） | 速さは出るはずだが、同じ PC のほかの利用者のプロセスからも、いつでもつなげる。名前付きパイプは名前を知っていて、かつ最初につないだ 1 つだけ |
| Unix ドメインソケット（Windows 10 1803 以降の AF_UNIX） | ファイルの権限で守れるので最も安全だが、Node.js は Windows で AF_UNIX につなげない（`path` は名前付きパイプとして扱われる） |
| 大きな中身だけ別の通り道（共有ディスクなど）で送る | Windows の QEMU では virtio-9p・virtiofs が使えない。仕組みが二重になる |

## 安全面で引き受けること

- 名前付きパイプの名前は `\\.\pipe\` の一覧で見える。名前が乱数でも、一覧を見張っているプロセスには分かる
- QEMU の名前付きパイプは接続を 1 つしか受け付けない。**MicroGit がつないだあとは、ほかのプロセスはつなげない**
- MicroGit より先に別のプロセスがつないだ場合、MicroGit はつなげずに 30 秒で諦め、Node.js 版に切り替わる（安全側に倒れる）。そのとき、先につないだプロセスが手にするのは空のゲストで、MicroGit はまだ利用者のファイルを 1 つも送っていない
- 名前付きパイプの既定の権限（QEMU は権限を指定せずに作る）は、作ったユーザー・管理者・SYSTEM に全権、Everyone に読み取り。上の「1 つだけ」があるので、つないだあとの盗み見は起きない

同じ PC のほかのプロセスは、要件定義書 §7.1 の脅威モデルでは想定していない（ホストの OS は信用する）。それでも、つないだあとに割り込めないこと、先を越されても利用者のデータが渡らないことは確かめておいた。

## 確かめ方

- `scripts/test/kernel-backend-e2e.mjs --plan`（Windows で、拡張機能と同じ起動計画で名前付きパイプを使う。3 MiB のファイルを含む 14 シナリオ）
- `src/test/suite/overlayBackend.test.ts`（実際の VS Code の中で、Overlay Status に `named pipe` と出る）
- `src/test/unit/launchers.test.ts`（パイプの名前が毎回違う 128 ビットの乱数）
