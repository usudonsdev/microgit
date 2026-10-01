# 10. 配る形にする：プラットフォーム別の VSIX／zip とファイルのモード／配るものをテストする／ライセンスの義務

| 項目 | 内容 |
|---|---|
| 関係する Issue | #19（MicroGit の内部機能として Marketplace に公開する） |
| 実装 | [scripts/package-vsix.mjs](../../scripts/package-vsix.mjs)、[.github/workflows/package.yml](../../.github/workflows/package.yml)、[src/test/runTest.ts](../../src/test/runTest.ts)、[src/kernel/executable.ts](../../src/kernel/executable.ts)、[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) |
| 手順と決めること | [release.md](../release.md) |

---

## 1. 何のための仕組みか

ここまでで、カーネル版の Overlay は開発中のリポジトリ（`guest/out/` や `guest/.cache/` にビルドした部品がある状態）で動いた。利用者に届くのは、それとは別の **VSIX**（拡張機能の配布用のファイル）で、次のことが違う。

- 開発中の置き場所（`guest/out/` など）は無く、部品は VSIX の中の `resources/kernel/` にある
- Windows 用に QEMU、Linux 用に agent と、**環境ごとに要る部品が違う**
- 部品の中に、他人が書いたソフトウェア（Linux カーネル、QEMU、GLib など）がある。配るなら **ライセンスの義務** を果たす
- 利用者の PC には、ウイルス対策ソフトや Windows の保護機能がある

---

## 2. 仕組み

### 2.1 VSIX の中身

VSIX は zip ファイルで、中はこうなっている。

```
[Content_Types].xml        zip の中のファイルの種類（Open Packaging Conventions という形式の決まり）
extension.vsixmanifest     拡張機能の名前・版・対象のプラットフォーム
extension/                 拡張機能のフォルダ（VS Code はここを ~/.vscode/extensions/<発行者>.<名前>-<版> に展開する）
  package.json
  out/extension.js
  resources/kernel/...
```

`vsce package` は、リポジトリのファイルから `.vscodeignore` に書いたものを除いて zip にする。何が入るかは `vsce ls` で見られる。

### 2.2 プラットフォーム別の VSIX

`vsce package --target win32-x64` のように対象を付けると、その環境専用の VSIX になる。Marketplace は、利用者の VS Code の環境に合うものを配る。**対象を付けない VSIX** も一緒に出しておくと、専用の VSIX が無い環境（macOS、Windows on Arm など）にはそれが配られる。

MicroGit は 4 つ作る：win32-x64（QEMU とゲスト、約 9.4 MB）、linux-x64・linux-arm64（agent、約 1.3〜1.4 MB）、対象なし（部品なし、約 0.08 MB）。1 つの VSIX に全部入れると、どの利用者も使わない部品までダウンロードすることになる。

### 2.3 zip とファイルのモード（実行ビット）

Linux の agent は、実行ビット（`chmod +x`）が無いと起動できない。zip は、ファイルごとに「どの OS で作ったか」と「外部属性」を記録していて、UNIX で作った zip では外部属性の上位 16 ビットにファイルのモード（`0o100755` など）が入る。VS Code は VSIX を展開するときに、このモードを付ける。

ところが、モードが落ちる場面がいくつもある。

| 場面 | 何が起きるか |
|---|---|
| Windows で VSIX を作る | Windows のファイルには実行ビットが無いので、zip にも入らない（vsce の文書にも書いてある） |
| GitHub Actions の成果物（upload-artifact / download-artifact）を通す | モードが落ちる |
| WSL の `/mnt/c`（Windows のドライブ）に置く | 既定では chmod が効かない |

MicroGit は 3 段で守る：(1) VSIX は Linux で作る、(2) 置くときに 0755 を付ける、(3) 拡張機能が起動の前に実行ビットを確かめ、無ければ付ける（`src/kernel/executable.ts`）。さらに `package-vsix.mjs` が、できた VSIX の zip を読み直して、agent のモードに実行ビットがあるかを確かめる。

### 2.4 配るものをテストする

開発中のリポジトリでテストが通っても、VSIX で動くとは限らない。#19 では、VSIX を **VS Code 自身のインストーラー**（`code --install-extension`）で一時的な場所に入れ、入ったフォルダに対して拡張機能テストを流すようにした（`MICROGIT_TEST_VSIX`）。

- `.vscodeignore` で外したものは無い → 開発用の置き場所に頼っていたら失敗する
- 展開は VS Code がする → モードも本番と同じ

これをやったら、最初の試しで **VSIX が 155〜164 MB** になった。スクリプトの一時置き場（`.cache/`）に置いたカーネルのソース（148 MB）が VSIX に入っていた。開発中のリポジトリで流すテストでは絶対に見つからない種類の間違いで、「中身の確認」にも抜けがあった（点で始まるフォルダを見ていなかった）。

直したあと、CI では **もう一度 142〜150 MB** になった。今度は、CI が成果物を落としたフォルダ（`artifacts/`、GCC のソース RPM など）が入っていた。テストは全部通った（部品は正しく入っていて、余計なものが増えただけ）。

2 回とも、中身の確認は「**入っていてはいけないもの**」の一覧（`src/`、`scripts/`、…）で作っていた。この方式は、思いつかなかった場所を必ず見逃す。そこで「**入ってよいもの**」の一覧（`package.json`、`out/*.js`、`resources/kernel/` など）に変え、さらに「同梱の部品を除いた中身が 1 MB を超えたら止める」を足した。どちらも、試しに余計なフォルダを置いて、止まることを確かめた。**許可の一覧（allowlist）は、禁止の一覧（denylist）より、知らないものに強い**。Boundary Guard（06）でゲストから受け取るパスを確かめるときと同じ考え方。

### 2.5 ライセンスの義務

| 種類 | 例 | 配るときにすること |
|---|---|---|
| 寛容なライセンス（MIT、BSD） | Go のランタイム（agent に静的にリンクされる）、libffi、pixman | 著作権表示とライセンスの文書を一緒に配る |
| GPL（コピーレフト） | Linux カーネル、QEMU | 上に加えて、**対応するソース**（ソースに加え、ビルドに使った設定とスクリプト）を渡すか、渡すと書面で申し出る |
| LGPL（ライブラリ向けのコピーレフト） | GLib、SeaBIOS | ライブラリのソースを渡す。利用者がライブラリを差し替えられるようにする（DLL なら差し替えられる） |
| 例外つきの GPL | libgcc（GCC Runtime Library Exception） | ライセンスの文書を配る。コンパイラの出力と組み合わせて配ることは例外で許される |

「対応するソース」には、カーネルの設定（`guest/kernel/*.config`）やビルドの手順（`guest/build.sh`）も入る。MicroGit はこれらを最初からリポジトリで管理していたので（NFR-7、再現可能なビルド）、集めるだけで済んだ。

DLL は Fedora のパッケージから持ってきている。Fedora のパッケージは更新されるので、**ビルドしたその場で** `rpm -qf` に「この DLL はどのパッケージのものか」を聞き、そのパッケージのソース RPM を取る。あとで取り直すと、配ったものと版がずれる。

### 2.6 署名とセキュリティの境界

| 仕組み | 何を守るか | MicroGit では |
|---|---|---|
| Marketplace の署名 | VSIX が途中で書き換えられていないか。VS Code がインストールのときに確かめる | 同梱のゲストのイメージもこれで守られる（イメージだけに署名しても上乗せは少ない、補足 S-11） |
| Authenticode（Windows のコード署名） | 実行ファイルを誰が作ったか | 同梱の QEMU は署名していない |
| Smart App Control（Windows 11） | 評判も署名も無い実行ファイルを止める（子プロセスでも） | 有効な PC では QEMU が止められ、Node.js 版に切り替わる見込み |
| ハードウェアの仮想化（WHPX） | ゲストが乗っ取られても外に出られない | TCG（エミュレーション）で動くときは、QEMU の方針でセキュリティの対象外 |

「起動できたか」を、プロセスを作れたかではなく **agent が準備完了と答えたか** で判断しているので、保護機能に止められても MicroGit は正しく Node.js 版に切り替わる。

---

## 3. このリポジトリではどこにあるか

| やっていること | 場所 |
|---|---|
| ターゲットごとに部品を置き、VSIX を作り、中身を確かめる | `scripts/package-vsix.mjs` の `layouts`、`checkVsix`、`zipEntries` |
| VSIX に入れないもの | `.vscodeignore` |
| 実行ビットを付ける | `src/kernel/executable.ts`、`src/kernel/launchers.ts` の `executableOrReason` |
| VSIX を入れてテストする | `src/test/runTest.ts` の `installVsix`、`vscodeCli` |
| DLL の出どころとライセンス | `windows/qemu/build.sh` の後半、`.github/workflows/qemu-windows.yml` の「Source RPMs」 |
| 全体の流れ（ビルド → VSIX → 5 つの環境で確認 → 下書きのリリース） | `.github/workflows/package.yml` |

---

## 4. 手を動かして確かめる

1. **VSIX に入るものを見る**：`npx vsce ls --no-dependencies`。`.vscodeignore` から `scripts/**` を消して、もう一度見る
2. **zip のモードを見る**：Actions の「Package VSIX」の成果物 `vsix` を落として、Python で
   `python3 -c "import zipfile;[print(oct(i.external_attr>>16),i.filename) for i in zipfile.ZipFile('microgit-5.0.0-linux-x64.vsix').infolist()]"`
3. **配るものをテストする**：Windows で `npm run compile` のあと、PowerShell で `$env:MICROGIT_TEST_VSIX='<VSIX のパス>'; $env:MICROGIT_TEST_EXPECT_BACKEND='kernel'; node out/test/runTest.js`
4. **DLL の出どころを読む**：win32-x64 の VSIX の `extension/resources/kernel/win32-x64/qemu/licenses/packages.tsv` を開いて、GLib のライセンスとソース RPM の名前を見る
5. **Smart App Control の状態を見る**：Windows セキュリティ → アプリとブラウザーの制御 → Smart App Control

---

## 5. もっと知りたいとき

- VS Code の文書「Publishing Extensions」の「Platform-specific extensions」、「Extension Marketplace」（署名の確認）
- GPLv2 の本文の第 3 節（実行形式を配るときの義務）、LGPL-2.1 の第 6 節、FSF の「GPL に関するよくある質問」
- QEMU の文書「Security」（仮想化の使い方と、そうでない使い方）
- Microsoft の「Smart App Control Frequently Asked Questions」
- 「zip external file attributes unix mode」で検索する
