//! ZIP 形式の文書(docx/xlsx/pptx)を「骨組み + 部品ごとの中身 + 補正データ」に分け、元のバイト列どおりに組み立て直す試作。
//! 設計: docs/non-engineer-preflate-integration.md(試作 scripts/research/office-delta/ooxml-split から移した)
//!
//! 不変条件: `split` は、分けた結果から `rebuild` したものが元と SHA-256 で一致することを、返す前に必ず確かめる。
//! 一致しなければ、ファイル全体を分けずに持つ(Whole)。履歴に入るものは、常に元へ戻せる。
use preflate_rs::{preflate_whole_deflate_stream, recreate_whole_deflate_stream, PreflateConfig};


/// この形式の版。preflate-rs の版を上げて補正データの意味が変わるときは、ここも上げる
pub const FORMAT_VERSION: u32 = 1;
pub const PREFLATE_VERSION: &str = "0.7.6";

#[derive(Debug, Clone, PartialEq)]
pub enum PartData {
    /// 展開した中身 + 補正データ。中身は内容で分割して重複を省ける
    Preflate { plain: Vec<u8>, corrections: Vec<u8> },
    /// 無圧縮で格納された部品。中身がそのまま
    Stored { plain: Vec<u8> },
    /// preflate で作り直せなかった部品。圧縮データをそのまま持つ(節約は減るが、戻せることを優先)
    Raw { compressed: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Part { pub name: String, pub data: PartData }

#[derive(Debug, Clone, PartialEq)]
pub enum Split {
    /// 骨組み(圧縮データを抜いた残り)と、抜いた位置、部品
    Zip { skeleton: Vec<u8>, offsets: Vec<u64>, parts: Vec<Part> },
    /// ZIP として扱えなかった、または組み立て直しが一致しなかった。ファイル全体をそのまま持つ
    Whole { bytes: Vec<u8> },
}

use crate::util::sha256;

fn u16le(b: &[u8], o: usize) -> Option<u16> { b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]])) }
fn u32le(b: &[u8], o: usize) -> Option<u32> { b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])) }

/// 中央ディレクトリから、(名前, 方式, 圧縮データの開始, 長さ) を読む。ZIP64・暗号化・分割 ZIP は扱わない(None)
fn entries(b: &[u8]) -> Option<Vec<(String, u16, usize, usize)>> {
    let min = b.len().saturating_sub(22 + 65535);
    let eocd = (min..=b.len().checked_sub(22)?).rev().find(|&i| u32le(b, i) == Some(0x0605_4b50))?;
    let n = u16le(b, eocd + 10)? as usize;
    let mut p = u32le(b, eocd + 16)? as usize;
    if u32le(b, eocd + 16)? == 0xFFFF_FFFF { return None; }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if u32le(b, p)? != 0x0201_4b50 { return None; }
        let flags = u16le(b, p + 8)?;
        let method = u16le(b, p + 10)?;
        let csize = u32le(b, p + 20)?;
        let (nl, el, cl) = (u16le(b, p + 28)? as usize, u16le(b, p + 30)? as usize, u16le(b, p + 32)? as usize);
        let lho = u32le(b, p + 42)?;
        if flags & 1 != 0 || csize == 0xFFFF_FFFF || lho == 0xFFFF_FFFF { return None; }
        let name = String::from_utf8_lossy(b.get(p + 46..p + 46 + nl)?).into_owned();
        let l = lho as usize;
        if u32le(b, l)? != 0x0403_4b50 { return None; }
        let start = l + 30 + u16le(b, l + 26)? as usize + u16le(b, l + 28)? as usize;
        b.get(start..start + csize as usize)?;
        out.push((name, method, start, csize as usize));
        p += 46 + nl + el + cl;
    }
    // 圧縮データの範囲が前から順に並び、重ならないこと(骨組みに戻すときの前提)
    let mut sorted = out.clone();
    sorted.sort_by_key(|e| e.2);
    if sorted.windows(2).any(|w| w[0].2 + w[0].3 > w[1].2) { return None; }
    Some(sorted)
}

fn split_part(method: u16, raw: &[u8]) -> PartData {
    match method {
        0 => PartData::Stored { plain: raw.to_vec() },
        8 => {
            // 不正な入力で中が panic しても、その部品だけ Raw に落とす
            let r = std::panic::catch_unwind(|| {
                let (res, plain) = preflate_whole_deflate_stream(raw, &PreflateConfig::default()).ok()?;
                if res.compressed_size != raw.len() { return None; }
                let plain = plain.text().to_vec();
                let re = recreate_whole_deflate_stream(&plain, &res.corrections).ok()?;
                (re == raw).then_some(PartData::Preflate { plain, corrections: res.corrections })
            });
            r.ok().flatten().unwrap_or_else(|| PartData::Raw { compressed: raw.to_vec() })
        }
        _ => PartData::Raw { compressed: raw.to_vec() },
    }
}

pub fn split(b: &[u8]) -> Split {
    let whole = || Split::Whole { bytes: b.to_vec() };
    let Some(es) = entries(b) else { return whole() };
    let mut skeleton = Vec::new();
    let mut offsets = Vec::new();
    let mut parts = Vec::new();
    let mut last = 0;
    for (name, method, start, len) in es {
        skeleton.extend_from_slice(&b[last..start]);
        offsets.push(skeleton.len() as u64);
        parts.push(Part { name, data: split_part(method, &b[start..start + len]) });
        last = start + len;
    }
    skeleton.extend_from_slice(&b[last..]);
    let s = Split::Zip { skeleton, offsets, parts };
    match rebuild(&s) {
        Ok(r) if sha256(&r) == sha256(b) => s,
        _ => whole(),
    }
}

pub fn rebuild(s: &Split) -> Result<Vec<u8>, String> {
    match s {
        Split::Whole { bytes } => Ok(bytes.clone()),
        Split::Zip { skeleton, offsets, parts } => {
            let mut out = Vec::with_capacity(skeleton.len() * 4);
            let mut last = 0usize;
            for (off, p) in offsets.iter().zip(parts) {
                let off = *off as usize;
                out.extend_from_slice(skeleton.get(last..off).ok_or("骨組みの位置が不正")?);
                match &p.data {
                    PartData::Preflate { plain, corrections } => out.extend_from_slice(
                        &recreate_whole_deflate_stream(plain, corrections).map_err(|e| format!("{}: {:?}", p.name, e))?),
                    PartData::Stored { plain } => out.extend_from_slice(plain),
                    PartData::Raw { compressed } => out.extend_from_slice(compressed),
                }
                last = off;
            }
            out.extend_from_slice(skeleton.get(last..).ok_or("骨組みの位置が不正")?);
            Ok(out)
        }
    }
}

