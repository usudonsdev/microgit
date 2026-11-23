# Office 文書の差分保存の計測スクリプト

非エンジニア版の履歴ストア(`docs/non-engineer-drive-sharing-design.md` §3)で、Word・Excel のファイルを差分で保存できるかを測るためのスクリプト。結果と解釈は [docs/non-engineer-office-delta-measurement.md](../../../docs/non-engineer-office-delta-measurement.md)。

計測に使った利用者のファイルは、リポジトリに入れない(私的な内容を含みうるため)。手元の xlsx/docx を引数に渡して実行する。

| ファイル | 何をするか |
|---|---|
| `recompress.py` | ZIP の各部品の圧縮データが、zlib(レベル 1〜9、memLevel 8/9)で同じバイト列に再現できるか |
| `recompress2.py` | 同上を、レベル 0〜9・memLevel 1〜9・窓 9〜15・strategy 0〜4 の全組み合わせで調べる(遅い。小さいファイル向け) |
| `measure.py` | 1 か所を編集したときに新しく保存が要るバイト数を、3 つの保存形式(そのまま分割/展開してから分割/部品ごとの圧縮データを分割)で比べる。要 `pip install fastcdc` |
| `preflate-roundtrip/` | Microsoft の preflate-rs で、圧縮データを「展開した中身 + 補正データ」から元のバイト列どおりに作り直せるかを確かめる Rust の小さなツール |

実行例(Python は `-I` を付けて、データのあるディレクトリのファイルを読み込まないようにする):

```bash
python3 -I scripts/research/office-delta/recompress.py path/to/a.xlsx
```

```bash
python3 -I scripts/research/office-delta/measure.py path/to/a.xlsx
```

```bash
cargo build --release --manifest-path scripts/research/office-delta/preflate-roundtrip/Cargo.toml
```

`preflate-roundtrip` の使い方: `preflate-roundtrip <圧縮データ(raw deflate)> <展開した中身> <補正データの出力先> <作り直した圧縮データの出力先>`。部品の切り出しと、ファイル全体の組み立て直しの確認は、計測メモの「再現手順」にある Python の断片で行った。
