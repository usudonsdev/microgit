# ADR-0005: OverlayFS の mount オプションを固定する

| 項目 | 内容 |
|---|---|
| 状態 | 採用 |
| 日付 | 2026-09-26 |
| 決めた人 | Claude（利用者の「#19 まで自律的に進める」の指示のもとで） |
| 関係 | #12（O-13）、補足 S-4、要件 FR-1、[agent-protocol.md](../agent-protocol.md) |

## 背景

OverlayFS の mount オプションの既定値は、カーネルの版とビルド時の設定で変わる（`redirect_dir`、`metacopy`、`index`、`xino` など）。Linux ホストで VM を使わない経路はホストのカーネル（5.11 以降のどれか）で、最小ゲストは固定の 6.18.53 で動くので、既定値に任せると経路によって挙動が変わりうる（補足 S-4）。

## 決定

agent と期待値の記録（`record-kernel.mjs`）は、どちらも次の値を明示する。

```
userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off
```

| オプション | 値 | 理由 |
|---|---|---|
| `userxattr` | 付ける | 非特権（ユーザー名前空間の root）で mount するのに必須。OverlayFS の管理情報（opaque など）を `trusted.*` ではなく `user.*` の拡張属性に書く。tmpfs を upper にするには、tmpfs の `user.*` 対応（6.6 以降）も要る |
| `redirect_dir` | `nofollow` | 下の層のディレクトリの rename は `EXDEV` になり、コピーで代わりにやる。**`userxattr` と `redirect_dir=on` はカーネルが同時に受け付けない**（6.6 で `overlayfs: conflicting options: userxattr,redirect_dir=on`） |
| `metacopy` | `off` | 属性だけの変更で中身をコピーしない最適化。**`userxattr` と `metacopy=on` も同時に受け付けない**。MicroGit は属性を記録しないので要らない |
| `index` | `off` | ハードリンクの扱いと NFS への公開のための索引。MicroGit はどちらも使わない |
| `xino` | `off` | 層をまたいだ inode 番号の付け方。MicroGit は inode 番号を比べないので、既定値の違いを持ち込まない |

最低のカーネルの版：

| 経路 | 版 | 理由 |
|---|---|---|
| Linux ホストで VM なし | 5.11 以降 | `userxattr`（非特権の OverlayFS）が入った版 |
| 層を tmpfs に置く場合 | 6.6 以降 | tmpfs の `user.*` 拡張属性。これより古ければ層をディスク上に置く（#14） |
| 最小ゲスト | 6.18.53 に固定 | `guest/kernel/version.env` |

## 理由

- 非特権で使う以上、`redirect_dir=on` と `metacopy=on` はそもそも選べない。残りは MicroGit が使わない機能なので、既定値の違いを持ち込まないよう明示して切る
- 固定しても、ゴールデンテストのビューは 1 バイトも変わらなかった（`*.golden` は同じまま、`meta.json` の記録の条件だけが変わった）

## 採らなかった案

- **既定値に任せる**：カーネルの版で挙動が変わりうる。今のところ 6.6・6.8・6.17・6.18 で同じ結果だったが、それは今の既定値がたまたま揃っているだけ
- **root で mount して `redirect_dir=on` を使う**：フォルダの名前変更がコピーにならず速い。しかし Linux ホストの VM なしの経路で root が要り、NFR-1（VS Code と同じ動作要件）に反する。最小ゲストでは root だが、経路によって挙動を変えない（FR-1）

## 引き受けること

- 下の層にある大きなフォルダの名前を変えると、中身がすべてコピーされる。MicroGit の層は保存したファイルだけで小さいので、今は問題にならない

## 確かめ方

- `guest/agent/agent_test.go` の `TestHelloReportsProtocolAndFixedOptions`、`TestInspectShowsWhiteoutOpaqueAndNoRedirect`
- `check-guest.mjs` の `inspect` の確認（redirect の付いたディレクトリがどの層にも無い）
- CI の golden-kernel（6.8・6.17）と guest（6.18.53）
