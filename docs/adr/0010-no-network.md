# ADR-0010: ゲストはネットワークの仕組みを持たない（CONFIG_NET を無効にする）

| 項目 | 内容 |
|---|---|
| 状態 | 採用（初期設計書 §9 の ADR 候補 4 を、実装の結果とともに記録） |
| 日付 | 2026-09-26 |
| 決めた人 | 利用者（要件定義書 AD-6・NFR-4）。範囲を広げたのは Claude（#15）、記録は Claude（#9） |
| 関係 | 要件定義書 NFR-4・O-3、補足 S-10、[guest-phase1.md](../guest-phase1.md) §2.3、[ADR-0006](./0006-windows-named-pipe.md) |

## 背景

要件定義書 NFR-4 は「ゲストはネットワーク機能を持たない」とし、その含意として「vsock 等が使えない可能性」を挙げていた。補足 S-10 は、vsock は TCP/IP を使わないので、`CONFIG_NET` を残して IP スタック（`CONFIG_INET`・IPv6・netfilter・ネットワークドライバ）だけを外せば vsock は使えると指摘し、NFR-4 を「ゲストは IP スタックを持たない」に直し、制御チャネル（O-3）の第一候補を vsock にするよう勧めた。

## 決定

補足 S-10 より一段強く、**`CONFIG_NET` 自体を無効にする**。ホストとの命令の通り道は、ネットワークの仕組みを使わない **virtio-console の名前付きポート `microgit`** にする（O-3）。

## 理由

- 命令は要求 1 つに応答 1 つで順番どおりに返すので、vsock の利点（複数の接続の多重化）が要らない（S-10 が挙げた virtio-console の欠点が効かない）
- virtio-console は QEMU と Virtualization.framework の両方で同じように作れる
- `CONFIG_NET` が無いので、ネットワーク関連のカーネルの脆弱性がまるごと関係なくなる。ビルドで `CONFIG_NET=y` になったら止める（`guest/build.sh`）

## 引き受けること

- 並行して複数の命令を流したくなったら、vsock に切り替えるか、要求 ID で多重化する必要がある（今は要らない）
- Windows の QEMU では、virtio-console のホスト側の出入り口（chardev）に何を使うかが別の問題になった（ADR-0006：名前付きパイプ）
