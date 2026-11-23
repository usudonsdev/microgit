// 試作の確認用: ファイルを分けて、部品ごとの内訳と、組み立て直しが一致するかを出す
use vereve_ooxml_split::*;
fn main() {
    for path in std::env::args().skip(1) {
        let b = std::fs::read(&path).expect("read");
        let t = std::time::Instant::now();
        let s = split(&b);
        let ms_split = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let r = rebuild(&s).expect("rebuild");
        let ms_rebuild = t.elapsed().as_millis();
        let ok = sha256(&r) == sha256(&b);
        match &s {
            Split::Whole { .. } => println!("{path}: 全体をそのまま持つ 一致={ok}"),
            Split::Zip { skeleton, parts, .. } => {
                let (mut pf, mut st, mut rw, mut corr) = (0, 0, 0, 0usize);
                for p in parts { match &p.data {
                    PartData::Preflate { corrections, .. } => { pf += 1; corr += corrections.len(); }
                    PartData::Stored { .. } => st += 1,
                    PartData::Raw { .. } => rw += 1 } }
                println!("{path}: {} B / 部品 {} (preflate {pf}, 無圧縮 {st}, そのまま {rw}) / 補正 {corr} B / 骨組み {} B / 分ける {ms_split} ms / 戻す {ms_rebuild} ms / 一致={ok}",
                    b.len(), parts.len(), skeleton.len());
            }
        }
    }
}
