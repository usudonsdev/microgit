# MicroGit：Linuxカーネル機能ポータブル化 初期設計

ステータス：初期要件確定（内部設計・実装フェーズへ移行）

> **第 2 版（2026-09-26、#9）：** Phase 0〜2 の実装で決めたことを、§4.1・§4.3・§5・§6・§8・§9 に「第 2 版」と印を付けて書き足した。初版の本文は消していない。要件側の反映は要件定義書の第 2 版、決定の理由は docs/adr/、仕組みの説明は docs/kernel-backend.md から辿れる。

## 1. コンセプト

**Linuxカーネルの機能としてのOverlayFSを、Linux以外のホストにも提供する部品**を作る。

汎用のLinux環境（WSL2、Docker Desktop、Lima、Apple Containerization など）を提供するのではなく、**特定のカーネル機能だけを、アプリに埋め込める部品として**提供する点を差分とする。

### ロードマップ上の位置づけ

| 段階 | 形態 |
|---|---|
| 初期 | MicroGit の内部機能として VS Code Marketplace で提供 |
| 最終 | AI を用いて、任意のアプリに必要なカーネル機能を部品として詰め込める仕組み |

MicroGit は「カーネル機能の部品化」の最初の適用例と位置づける。

## 2. 背景と先行研究

### 関連分野
- **Container debloating**：Cimplifier、SlimToolkit、Confine、BAFFS。いずれも Linux カーネルを前提とし、ユーザーランドのみを削減する。動的解析によるカバレッジ不足（通らなかった経路の欠落）が既知の課題。
- **microVM／軽量ランタイム**：Firecracker（KVM 前提）、libkrun、Apple Containerization、gVisor、Kata Containers。
- **カーネル特化**：Lupine Linux、ユニカーネル。

### 本設計の差分
1. 提供範囲を**単一のカーネル機能**に絞り、ゲストを極限まで削る
2. 汎用 VM ではなく、**アプリのライブラリとして同梱・配布**できる
3. Windows を含む**全ホストで同一の挙動**を保証する

## 3. 初期要件

### 機能要件
- FR-1：全対応ホストで Linux OverlayFS と同一のセマンティクスを提供する
- FR-2：MicroGit のマイクロコミット（レイヤーの積み重ね・スナップショット・差分取得・分岐）を OverlayFS 上で実現する
- FR-3：ゲストの書き込みは upper layer に閉じ、ホスト側の検証を経てから実ファイル・履歴に反映する
- FR-4：連続セーブに追従する

### 非機能要件
- NFR-1（対応環境）：VS Code が動作する全環境。動作要件も VS Code 同等
- NFR-2（性能）：最終目標は連続セーブに対してメモリ転送と等速
- NFR-3（サイズ）：同梱カーネル＋ゲストユーザーランドで一桁 MB を目標
- NFR-4（通信）：ネットワークを使用しない。ゲストカーネルからネットワークスタックを除外する
- NFR-5（互換）：既存の Node.js 仮想 OverlayFS 実装をフォールバックとして維持する

## 4. アーキテクチャ

```
┌──────────────────── Host ────────────────────┐
│ VS Code 拡張（MicroGit）                       │
│  ├─ Backend Selector                          │
│  │   ├─ Linux  : ネイティブ OverlayFS（VMなし）  │
│  │   ├─ macOS  : Hypervisor/Virtualization.fw │
│  │   ├─ Windows: Hyper-V 系 API（要検証）       │
│  │   └─ Fallback: Node.js 仮想 OverlayFS       │
│  └─ Boundary Guard（TCB：検証・反映）           │
└───────────────┬──────────────────────────────┘
                │ 細い境界（少数の単純な操作のみ）
┌───────────────┴────────── Guest（最小VM）──────┐
│ 最小 Linux カーネル（virtio のみ / NET 無効 /    │
│                     overlayfs 有効）            │
│ 最小 init ＋ agent（Go/Rust 静的バイナリ）       │
│ lower: スナップショット層 / upper: 未確定の変更   │
└────────────────────────────────────────────────┘
```

**第 2 版：実装した構成**

```
┌──────────────────── Host ─────────────────────────────┐
│ VS Code 拡張（MicroGit）                                │
│  ├─ 正本：shadow の Git（ADR-0001）                      │
│  ├─ Backend Selector（src/kernel/backendSelector.ts）    │
│  │   ├─ Linux  : unshare -Urm ＋ agent（VM なし）        │
│  │   ├─ Windows: 同梱の QEMU（WHPX → TCG）＋ 名前付きパイプ │
│  │   ├─ macOS  : microgit-vm（Virtualization.framework） │
│  │   │           ※Apple silicon 実機確認済み（#17）       │
│  │   └─ Fallback: Node.js 版（層は Git から作るキャッシュ） │
│  ├─ Layer Feeder：Git の差分を commit 命令にして送る       │
│  └─ Boundary Guard：一覧と中身を検証してから反映            │
└───────────────┬───────────────────────────────────────┘
                │ JSON 1 行 1 件の命令（プロトコル v1）
                │ virtio-console の名前付きポート "microgit"
┌───────────────┴────────── Guest ──────────────────────┐
│ Linux 6.18.53（allnoconfig ＋ 断片、CONFIG_NET 無効）      │
│ /init ＝ agent（Go の静的バイナリ、PID 1）                 │
│ 層は tmpfs、1 保存 1 層、深さ 32 で写しの層（ADR-0003）      │
└────────────────────────────────────────────────────────┘
```

### 4.1 ホスト別バックエンド
- **Linux**：カーネル 5.11 以降はユーザー名前空間内で非特権 OverlayFS マウントが可能なため、VM を使わずネイティブ実行する
- **macOS**：OS 標準のハイパーバイザ API で最小 VM を起動する
- **Windows**：OS 標準のハイパーバイザ API を使う方針。VMM とファイル共有の実現方法は未確定（§8）
- **フォールバック**：いずれも使えない環境では現行の Node.js 実装で動作する

**第 2 版：**

| ホスト | 実装 | 状態 | 説明 |
|---|---|---|---|
| Linux | `unshare -Urm` の中で agent を動かす。層はカーネル 6.6 以降なら `$XDG_RUNTIME_DIR` の tmpfs | 実装・確認済み（WSL2、GitHub Actions） | docs/kernel-backend.md、ADR-0008 |
| Windows x64 | 同梱の QEMU 11.1.1（装置を絞った自前ビルド）。`-accel whpx,kernel-irqchip=off -accel tcg` で、WHPX が使えなければ TCG。ファイル共有は使わず、中身は命令で送る | 実装・確認済み（手元の Windows 11、GitHub の windows-latest） | docs/windows-backend.md、ADR-0006 |
| macOS（Apple silicon） | Swift の小さなヘルパー `microgit-vm`（Virtualization.framework） | 実機確認済み。大容量は小さいフレームに分割 | #17、docs/guest-phase1.md |
| Windows on Arm、Intel Mac | 対象外 | — | Node.js 版で動く |
| 使えない環境 | Node.js 版。起動と小さな層を 1 枚作る試し（probe）に失敗したら、利用者の操作なしに切り替える | 実装・確認済み（Ubuntu 24.04 の既定で 5 ms） | FR-5 |

### 4.2 ゲスト
- カーネル：virtio デバイスのみ、ネットワーク無効、OverlayFS 有効の専用構成
- ユーザーランド：最小 init と agent のみ。シェル等は含めない
- agent：静的バイナリ（Go または Rust）。OverlayFS 操作と境界プロトコルのみを実装

### 4.3 境界インターフェース
操作を少数に絞り、ホスト側で検証しやすくする。初期候補：

| 操作 | 内容 |
|---|---|
| `commit` | 現在の upper を新しいスナップショット層として確定 |
| `branch` | 既存の層を共有したまま新しい upper を作成（CoW） |
| `diff` | 2 つの層間の差分を取得 |
| `view` | 任意の層構成でのマージ済みビューを取得 |
| `apply` | ホストで検証済みの差分を実ファイルへ反映（ホスト側で実行） |

※ 既存 MicroGit の内部モデルに合わせて調整する

**第 2 版：確定した命令（プロトコル v1、docs/agent-protocol.md）**

初期候補の 5 つの操作は、次のように落ち着いた。

| 初期候補 | 実装 | 理由 |
|---|---|---|
| `commit` | `commit`（`layer`、`parent`、`ops`）。親までの層を lowerdir に積み、空の upper に書き込み・削除・名前の変更を当てて凍結する | 「今の upper を確定」ではなく「親と変更を渡して新しい層を作る」形にした。正本は Git なので、ホストが変更を知っている（ADR-0001・ADR-0004） |
| `branch` | 無い | 同じ親を持つ層を 2 つ作れば枝分かれになる。層は凍結されていて、upper を共有しない |
| `diff` | 無い（試験用の `inspect` が層そのものの中身を返す） | 差分はホストの Git が知っている（`git diff-tree`）。ゲストに聞く必要が無い |
| `view` | `view`（一覧）＋ `read` / `readMany`（中身） | 一覧と中身を分けて、Boundary Guard が一覧を先に全部検証できるようにした |
| `apply` | ホストの `syncWorkspaceFromGuest` | 初期設計どおりホスト側。ゲストの命令ではない |
| — | `hello`、`reset`、`stats`、`poweroff` | 版の確認（起動の合図）、キャッシュを捨てる、使用量、停止 |

mount のオプションは `userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off` に固定した（ADR-0005）。

## 5. セキュリティモデル
- **ゲストは信頼しない**。ゲスト内には検査機構を置かず、小さく正しく動くことに専念させる
- **検査はすべてホスト側の Boundary Guard に集約**（TCB）
  - 共有範囲をワークスペースに限定
  - シンボリックリンクはホスト側で解決し、範囲外を拒否
  - ゲストからの要求の形式・サイズを検証
- ゲストの書き込みは upper に閉じるため、ゲストが侵害・誤動作しても「反映しない」ことで実ファイルと履歴を保護できる
- ネットワークを持たないため、ゲストカーネルの更新要件は緩和される。代わりに**境界の設計**と**イメージの署名・配布経路の完全性**に責任を集中させる
- ユーザーの OS やセキュリティソフトの存在は前提にしない

**第 2 版：**
- Boundary Guard は src/boundaryGuard.ts。一覧の検証（パスの形、Windows・macOS で表せない名前、大文字小文字の衝突、`.git`、ファイルとディレクトリの取り違え）→ 中身をすべて受け取って大きさとハッシュを確かめる → 消す → 書く、の順で、途中でゲストが落ちてもワークスペースに半端な状態を残さない（docs/boundary-guard.md、ADR-0009）
- Linux の VM なしの経路ではゲストの隔離が無いので、脅威モデルを分けた（要件定義書 §7.4、ADR-0008）
- イメージの署名（SR-4）は、同梱配布では Marketplace の VSIX の署名検証に頼る（補足 S-11）

## 6. フェーズ計画

| Phase | 内容 | 完了条件 |
|---|---|---|
| 0 | Linux ネイティブ OverlayFS で境界インターフェースを実装し、現行 Node.js 実装と比較 | 同一テストの通過と性能比較 |
| 1 | 最小カーネル＋agent を作成し、macOS バックエンドで起動 | 起動時間・サイズ・スループットの計測 |
| 2 | Windows バックエンドの実現方式を確定・実装 | 3 OS で同一テスト通過 |
| 3 | MicroGit の内部機能として Marketplace で公開（フォールバック付き） | 公開 |
| 4 | 機能単位の部品として汎用化し、AI による組み込みを検討 | — |

**第 2 版：進み具合（2026-09-26）** 要件定義書 §10 の表を参照。Phase 0 の最初の成果物は、本物のカーネルの挙動を記録したゴールデンテストにした（補足 S-13、docs/overlayfs-golden-test.md）。Phase 1 は macOS より先に、Linux と Windows でゲストを動かした（利用者の判断：「いったん mac は後で対応するとして、windows だけ進めます」）。

### 計測指標
- イメージサイズ（カーネル／ユーザーランド別）
- コールドブート時間
- セーブからコミット確定までのレイテンシ
- スループット（メモリコピーをベースラインとした比率）
- 正しさ（同一テストスイートの 3 OS 通過率）

## 7. 最終形：AI による機能の組み込み（構想）
アプリの要求から必要なカーネル機能を特定し、最小カーネル構成と agent の境界インターフェースを生成してアプリに同梱する。debloating の既知課題（カバレッジ不足による欠落）に対し、「機能単位で必要なものを宣言的に組み立てる」方向で回避することを狙う。

## 8. 未解決事項
- **Windows の VMM とファイル共有方式**：OS 標準 API 上で何を自前実装し、何を既存 VMM に頼るか
- **upperdir の配置**：ゲストローカルか共有 FS 上か。OverlayFS は upper に置けるファイルシステムに制約があるため要検証
- **制御チャネル**：ネットワーク無効構成で使える経路（virtio-console 等）の選定
- **ホスト–ゲスト間のデータ転送コスト**：性能目標に対する支配的要因になる見込み
- **同梱カーネルのライセンス対応**：Linux カーネル（GPLv2）のバイナリ配布に伴うソースコード提供義務
- **同梱カーネルの更新ポリシー**

**第 2 版：状況（2026-09-26）**

| 事項 | 状況 |
|---|---|
| Windows の VMM とファイル共有方式 | **決定**：VMM は同梱の QEMU（自前実装しない）。ファイル共有は使わず、層の中身は命令で送る（docs/windows-backend.md） |
| upperdir の配置 | **決定**：ゲストの tmpfs。キャッシュなので VM が止まれば消えてよい（ADR-0001）。Linux の VM なしは tmpfs か一時ディレクトリ（カーネル 6.6 未満の tmpfs は user xattr を持てない） |
| 制御チャネル | **決定**：virtio-console の名前付きポート。ホストの口は、Linux は標準入出力、Windows は名前付きパイプ（stdio は遅く壊れた、ADR-0006）、macOS は Virtualization.framework のコンソール |
| ホスト–ゲスト間のデータ転送コスト | **計測済み**：名前付きパイプに替えた後は支配的ではない。保存 1 回の時間の大半は Git のプロセスの起動（ADR-0004）。過去に戻る操作は Windows で 1,425.8 → 169.7 ms（要件定義書 NFR-2） |
| 同梱カーネルのライセンス対応 | #19：ソースの tarball（sha256 固定）、設定の断片、ビルド手順をリポジトリに置き、配布物にソースの入手先を書く。QEMU も同じ |
| 同梱カーネルの更新ポリシー | #19（O-6） |

## 9. ADR 候補
- ADR：汎用 Linux VM ではなく、機能単位の部品として提供する
- ADR：Linux ホストでは VM を使わずネイティブ実行する
- ADR：ゲストは信頼せず、検査はホスト側に集約する
- ADR：ゲストはネットワークを持たない
- ADR：ゲストの agent は静的バイナリで実装する

**第 2 版：** 5 つの候補は ADR-0007〜0011 として記録した。実装の途中で決めたことは ADR-0001〜0006。

| 候補 | ADR |
|---|---|
| 汎用 Linux VM ではなく、機能単位の部品として提供する | [ADR-0007](./adr/0007-feature-component-not-general-vm.md) |
| Linux ホストでは VM を使わずネイティブ実行する | [ADR-0008](./adr/0008-linux-native.md) |
| ゲストは信頼せず、検査はホスト側に集約する | [ADR-0009](./adr/0009-untrusted-guest.md) |
| ゲストはネットワークを持たない | [ADR-0010](./adr/0010-no-network.md) |
| ゲストの agent は静的バイナリで実装する | [ADR-0011](./adr/0011-static-go-agent.md) |
