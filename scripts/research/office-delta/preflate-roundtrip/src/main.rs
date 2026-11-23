use preflate_rs::*;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let raw = std::fs::read(&a[1]).unwrap();
    let plain = std::fs::read(&a[2]).unwrap();
    let (r, _) = preflate_whole_deflate_stream(&raw, &PreflateConfig::default()).unwrap();
    std::fs::write(&a[3], &r.corrections).unwrap();
    // 復元: 展開した中身と補正データだけから作り直す
    let corr = std::fs::read(&a[3]).unwrap();
    let re = recreate_whole_deflate_stream(&plain, &corr).unwrap();
    std::fs::write(&a[4], &re).unwrap();
}
