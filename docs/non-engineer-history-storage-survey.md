# 非エンジニア版: 履歴を「本体と別ファイルにしない」方式の関連研究調査

調査日 2026-10-18。`docs/non-engineer-oss-plan.md` §11(Persistent signals)の続き。同文書は `origin/docs/release-5.1.0` にあり、このブランチには無い。

## 0. 依頼と要件

- ユーザーが管理するファイルが、本体とバージョン管理の二つになることを避けたい。
- 履歴は、ファイルのメタデータとして、またはソフトの中で管理したい。
- Google Drive で別端末との送受信にも対応したい。
- 対象は Word、表計算、画像、PDF など、普通のアプリが保存する不透明なバイト列のファイルである。内部状態には触れず、観測できるのは保存後のファイル全体だけである。

## 1. 調査の信頼度(最初に読むこと)

- 調査は 4 本の並列エージェント(論文・Signal / 埋め込み方式 / Google Drive / CRDT・バイト列)で行った。
- **一次資料の本文は 1 件も読めていない。** WebFetch は名前解決に失敗し、curl はプロキシが 403 で拒否した。到達できたのは github.com 系のみだった。
- 以下の記述は、検索結果の要約と要旨に基づく。数値と書誌は、本文での再確認が済むまで暫定である。
- 【事実】は検索結果の要約に書かれていた内容、【推測】は調査者の判断、【未確認】は確認できなかったことを指す。
- 次に本文を読むには、ネットワーク許可(drops.dagstuhl.de、prg.is.titech.ac.jp、arxiv.org、developers.google.com、support.google.com、sqlite.org)を足した環境が要る。

## 2. 結論(暫定)

1. **Persistent signals は「本体と履歴を一つにする」目的に使えると、確認できた範囲では明言されていない。** 系統全体が、履歴を外部の時系列 DB に置く設計である(§3)。`non-engineer-oss-plan.md` §11.4 の「ライブの正本には採用しない」は、今回の調査で覆らない。補強もされない。PDF 本文は依然として未読である。
2. **CRDT・ローカルファースト系は、不透明なファイルには適用できない。** 編集操作の列か、構造化されたデータモデルが前提になる(§5)。
3. **バイト列を扱う系(内容定義チャンク分割、delta 圧縮、Git パック、restic/borg)は、形式を知らなくても使える。** ただし docx/xlsx/pptx は ZIP 圧縮、PDF や画像も圧縮済みが多く、小さな編集で多くのバイトが変わりうる。効果の測定は見つからず、実ファイルでの検証が要る(§5)。
4. **メタデータ(xattr、NTFS 代替データストリーム)だけに履歴を載せる設計は避ける。** メール添付、ZIP、FAT、iCloud で落ちる。Google Drive for desktop での扱いも公式には未確認である(§4)。
5. **Google Drive の revisions に履歴を任せる方式は、保存ごとのマイクロ履歴には向かない。** 約 30 日で消え、100 個を超えると早く消え、keepForever は 200 個までである(§6)。
6. **本体への埋め込みは、実績と失敗事例の両方がある。** PDF 増分更新は、黒塗りが復元される事故を起こした。旧 Word の高速保存は、削除済みの文字を残した。埋め込むなら、利用者に見えて、制御できる必要がある(§4)。
7. **「ファイルが二つになる」問題は、置き場の種類を変えなくても、既定パスの隠蔽で和らげられる。** これは `non-engineer-oss-plan.md` §7.2 と §11.3 の結論と同じである。ただし持ち出しと別端末への送受信では、履歴ファイルが正本であることは変わらない。要件の核は、この点にある。

## 3. Persistent signals 系統

| 書誌 | 読んだ範囲 | 要点 |
|---|---|---|
| Kamina, Aotani, Masuhara「Signal Classes」ECOOP 2021, LIPIcs 194, 17:1–17:30, DOI 10.4230/LIPIcs.ECOOP.2021.17 | 本文は未読。検索要約と要旨のみ | signal class は同期とライフサイクルの単位。実装は時系列 DB に基づくランタイム。形式化で glitch freedom と型健全性を主張する。DB の実体、永続化、時刻回復、スキーマ進化の詳細は【未確認】 |
| Aotani「Persistent Signals: Reactive State That Outlives the Program」TC39 TG5 ワークショップ、2026-09-28 | 要旨ページ(github.com/tc39/tg5 workshops/2026/116.md) | 時系列 DB を言語ランタイムの一部にする。DB の実体は書かれていない。当日資料は見つからなかった |
| Kamina, Aotani, Masuhara「Managing Persistent Signals using Signal Classes」REBLS 2020 | 検索要約のみ | ECOOP 2021 の前身 |
| Persistent time-varying values(SignalJ)Onward! 2019 | 検索要約のみ。正確な題名と DOI は【未確認】 | Java 拡張。TimescaleDB(PostgreSQL 系)を使うと要約が述べる |
| Hidaka, Kamina「Realizing Persistent Signals in JavaScript」REBLS 2023, DOI 10.1145/3623506.3623576 | 検索要約のみ | 履歴は外部の時系列 DB に保持される(日本語報告 ipsj.ixsq.nii.ac.jp/records/217291 の要約) |
| Kamina ら「Distributed Persistent Signals」REBLS 2022, DOI 10.1145/3563837.3568341 | 検索要約のみ。著者の記載は【未確認】 | 分散基盤。同期の詳細は不明 |
| 「Consistent Distributed Reactive Programming with Retroactive Computation」arXiv:2502.20534(2025) | 検索要約のみ。著者は【未確認】 | id ごとの時系列 DB とディレクトリサービスを使う |

- 【推測】履歴の実体は、アプリのデータとは別の DB(サーバ型の可能性が高い)である。本体ファイルやそのメタデータに埋め込む設計は、確認できた範囲に無い。
- ECOOP 2021 の本文に「埋め込み DB」や「DB を使わない」という記述があれば、結論が変わりうる。
- 時間変化値、bitemporal DB、event sourcing の文献は、調べられていない。

## 4. ファイル内埋め込みとメタデータ

| 方式 | 履歴が生き残る条件 | 落ちる条件・失敗事例 |
|---|---|---|
| PDF 増分更新 | 増分追記のまま渡す | Save As で再生成される。Office の PDF 書き出しは増分を使わないことが多い。黒塗り復元事故(Stevens 2008)。追記でファイルが増える |
| 旧 Word 高速保存 | 機能が有効な間 | Word 2007 で廃止。削除済み文字が残る漏洩があった |
| OOXML 変更履歴(w:ins / w:del) | 承諾・拒否されるまで | ドキュメント検査で消える。変更履歴を ON にした間の編集だけ |
| OOXML customXml 部品 | 【未確認】。Office、LibreOffice、Google Docs 変換が再保存で保持するか不明 | Document Inspector の削除対象 |
| XMP の xmpMM:History | 編集アプリが保持して追記する | 書き出しやメタデータ除去で消える。記録であり、復元用の差分ではない |
| NTFS ADS | NTFS 上のコピー | FAT、メール、HTTP で落ちる |
| macOS xattr | 同一ボリューム、Finder のコピー | iCloud Drive は 2026-05 の報告でほぼ全て落とす(Eclectic Light)。Google Drive と OneDrive は 2018 年の調査で非対応(古い)。Dropbox は一部対応 |
| Office のクラウド版履歴 | OneDrive/SharePoint に保存したとき | ファイル本体の外にある。ローカル専用のファイルには無い |
| SQLite 文書形式、Fossil、Automerge | アプリがその形式を握る | Word など既存アプリには適用できない |

- 学術の周辺: Mimram, Di Giusto「A Categorical Theory of Patches」(ENTCS 298, 2013, arXiv 1311.3903)は Pijul の理論的基礎とされる(Pijul フォーラムでの言及)。W3C PROV は来歴の交換モデルで、文書への埋め込み方法は範囲外である。
- 【未確認】Swierstra & Löh「The semantics of version control」(Onward! 2014)は調査者の記憶にあるだけで、検索では出ていない。

## 5. CRDT とバイト列のスナップショット

CRDT・ローカルファースト:

- Kleppmann ら「Local-first software」Onward! 2019, DOI 10.1145/3359591.3359737。所有・オフライン・複数端末の理想は、要件と一致する。前提として、アプリのデータモデルが CRDT になっている必要がある。
- Automerge は、履歴込みの 1 ファイル形式である。圧縮すると履歴を失い、共通の祖先を持たない写しとは同期できない。
- Eg-walker(Gentle, Kleppmann, EuroSys 2025, arXiv 2409.14252)は、テキスト向けのイベントグラフで、メモリと読み込みが改善されたと主張する。
- Loro の shallow snapshot と Yjs の GC は、いずれも古い履歴を切り捨てて肥大を抑える。切り捨てた時点より古い端末とは合流できない。
- 不透明なファイルでは、観測できる更新が「保存後のファイル全体」だけで、操作の列が無い。ファイル全体を 1 つの値と見なすと、バージョン列になるだけでマージはできない。2 台が同じファイルを別々に編集したときの扱いは、文献では決まらない。製品判断である。

バイト列を扱う系:

- LBFS(SOSP 2001)は、内容定義チャンク分割の原点とされる。FastCDC(USENIX ATC 2016)は Gear ハッシュで CPU 負荷を下げる。
- restic は 512 KiB 未満のファイルを分割せず、チャンクは 512 KiB〜8 MiB である。事務書類は小さいので、既定値では何も節約されない。パラメータを小さくする必要がある【推測】。
- Git パックは、OFS_DELTA と REF_DELTA の連鎖で履歴を 1 ファイルに持つ。復元はデルタ連鎖をたどる。
- Perkeep は、不変の blob と、再構築できる索引を分ける。
- 内容アドレス型で不変のチャンクは、ファイルの和集合で合流できて競合しない。競合が起きるのは、変更される単一の索引ファイルまたは単一のコンテナである【推測】。

## 6. Google Drive(すべて公式ページ本文は未取得、要約ベース)

| 項目 | 内容 |
|---|---|
| revisions(Google 形式以外) | 最新を除き、keepForever でなければ約 30 日で purge される。既に 100 個あるファイルに新しくアップロードすると、早く消えることがある |
| keepForever | 最大 200 個。容量に算入される |
| Google 形式 | revisions が統合されることがあり、全変更は取れない |
| appProperties | アプリ専用で OAuth が必要。上限は 100 個、キーと値の合計 124 バイトという数値があるが、v2 由来の第三者リファレンスで v3 は【未確認】。履歴本体は入らず、目印にとどまる |
| drive.appdata / appDataFolder | 作成アプリだけが読める。ユーザーが手動で削除できる。アンインストールで消える。容量上限は【未確認】 |
| drive.file | 非機微スコープ。アプリが作ったファイルと、ユーザーが開いたファイルだけ |
| スコープ審査 | drive と drive.readonly は制限付き。drive.file と drive.appdata は非機微 |
| changes フィード | getStartPageToken と changes.list で別端末の更新を検知できる |
| Drive for desktop | 競合時に別コピーを作ることがある(二次出典)。オンライン専用のプレースホルダがある。xattr と ADS が同期されるかは【未確認】 |
| 【未確認】 | md5Checksum、If-Match による楽観ロック、changes の保持期間、クォータの数値、非機微スコープの審査要否 |

履歴を別端末へ送る 3 方式の落ちる条件【推測】:

- (a) 本体の revisions に任せる: 約 30 日または 100 個で消える。
- (b) appDataFolder に履歴を置く: 手動削除とアンインストールで消える。同時書き込みの制御は自前になる。
- (c) 本体に埋め込む: 競合コピーで履歴が分岐し、肥大し、他のアプリが履歴部分を壊すおそれがある。「ファイルは一つ」の要件には最も合う。

## 7. 設計への示唆(暫定、実装前に要検証)

要件の核は、「管理するファイルを一つにする」ことと「Drive で別端末へ送る」ことの両立である。調査から見える候補は 2 つである。

- **案 X: 履歴を別の Drive ファイル(appDataFolder など)に置き、本体と一対一で結ぶ。** 内容アドレス型の不変チャンクにすると、端末間の競合が起きにくい。利用者は本体だけを管理するが、履歴ファイルは正本として残る。`non-engineer-oss-plan.md` §11 の結論と整合する。持ち出しでは、本体だけを渡すと履歴が付かない。
- **案 Y: 本体ファイル内に履歴を埋め込む(形式ごと)。** docx/xlsx は customXml 部品、PDF は増分追記、画像は XMP が候補になる。「二つにならない」要件には最も合う。ただし形式ごとに実装が要る。再保存で部品が消える、肥大する、漏洩する、という失敗事例がある。

どちらも未検証の前提を含むので、実装に進む前に、次の実測を行う。

1. docx/xlsx に customXml で小さな履歴を入れ、Word、Excel、LibreOffice、Google Drive(アップロードとダウンロード)、メール添付、ZIP を通して、生存を確認する。
2. 実際の docx/xlsx/pdf の連続保存で、チャンク分割と delta の節約率を測る(ZIP を展開してから分割する場合も含む)。
3. Drive for desktop で、ファイルの再書き込み、競合コピー、xattr の扱いを実機で確認する。
4. 公式ページの本文を読んで、§6 の未確認の項目を埋める。ECOOP 2021 の PDF 本文を読んで、DB の実体を確認する。

## 8. 未確認の文献

Signal Classes 本文、Onward! 2019 の正確な書誌、arXiv 2502.20534 の著者、Swierstra & Löh、Darcs/Camp の理論、Xia ら「A Comprehensive Study of the Past, Present, and Future of Data Deduplication」(Proc. IEEE 2016、記憶のみ)、Yjs の公式文書、restic と borg の prune の仕組み、時間変化値・bitemporal DB・event sourcing の文献。
