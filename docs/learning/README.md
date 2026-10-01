# 学習用ドキュメント：カーネル機能ポータブル化

次期メジャー（Epic #8）の実装で使っている技術を、実装と対応づけて解説するシリーズ。
Issue を 1 つ進めるたびに、その Issue で使った技術の解説を 1 本足す。

- 前提にする知識：MicroGit の利用者向けの動き、TypeScript、Git の基本操作
- 前提にしない知識：OS の内部、仮想化、ファイルシステムの実装

まず全体像は [実装の解説（保存 1 回の旅）](../kernel-portability-walkthrough.md) を読む。そのあと、興味のある回を読む。

| 回 | テーマ | 関係する Issue | 実装 |
|---|---|---|---|
| [01](./01-golden-testing-and-namespaces.md) | テストの正解をどこから持ってくるか／名前空間で安全に mount する | #10 | `scripts/golden/`、`.github/workflows/ci.yml` |
| [02](./02-git-objects-and-layer-format.md) | Git のオブジェクトと出力形式／whiteout の表し方／不具合の切り分け方 | #21 | `src/overlay.ts`、`scripts/overlay-smoke.mjs` |
| [03](./03-source-of-truth-and-durability.md) | 正本とキャッシュ／「保存した」はどこまで確かか（fsync）／コンパクション | #11 | `src/durability.ts`、`docs/adr/` |
| [04](./04-protocol-and-mount-options.md) | 2 つのプログラムのあいだの約束（プロトコル）／mount オプション／層の中を覗く | #12 | `guest/agent/`、`docs/agent-protocol.md` |
| [05](./05-reproducible-builds.md) | 再現可能なビルド：同じソースから、同じバイト列を | #15 | `guest/build.sh`、`guest/kernel/version.env` |
| [06](./06-boundary-guard.md) | 信用しない相手からファイルを受け取る（パストラバーサル、.git を狙う攻撃、名前のゆらぎ、半端な状態を残さない） | #16 | `src/boundaryGuard.ts` |
| [07](./07-backend-selection-and-ipc.md) | 使えるものを選び、だめなら戻る／プロセス間のデータの通り道／差分テストが不具合を見つける | #14 | `src/kernel/`、`scripts/test/` |
| [08](./08-cross-compiling-qemu.md) | 別の OS 向けにビルドする（クロスコンパイル）／実行ファイルが頼る部品を集める | #18 | `windows/qemu/`、`.github/workflows/qemu-windows.yml` |
| [09](./09-requirements-traceability.md) | 要件と実装をつなぐ（追跡）／決めたことを残す（ADR）／レビューの指摘を閉じる | #9 | 要件定義書（第 2 版）、`docs/adr/` |
| [10](./10-packaging-and-licenses.md) | 配る形にする：プラットフォーム別の VSIX／zip とファイルのモード／配るものをテストする／ライセンスの義務 | #19 | `scripts/package-vsix.mjs`、`.github/workflows/package.yml`、`THIRD_PARTY_NOTICES.md` |
| [12](./12-measure-the-whole-path.md) | 全体を計ってからボトルネックを決める：段階ごとの計測・後片付けを列の外へ・知っていることを捨てない | #37 | `src/saveTiming.ts`、`src/kernel/layerFeeder.ts` |
| [11](./11-writing-git-from-inside.md) | Git を内側から書く：保存形式・プロセスの起動の費用・キャッシュの無効化・fsync | #32 | `src/fastGit/`、`src/fastMicroCommit.ts` |

各回の構成：

1. **何のための仕組みか**（困りごと）
2. **仕組み**（図と用語）
3. **このリポジトリではどこにあるか**（ファイルと関数）
4. **手を動かして確かめる**
5. **もっと知りたいとき**（一次資料の探し方）
