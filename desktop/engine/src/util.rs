//! 小さな共通の道具: ハッシュ、原子的な書き込み、パスの扱い
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn sha256(b: &[u8]) -> [u8; 32] {
    let d = Sha256::digest(b);
    let mut o = [0u8; 32];
    o.copy_from_slice(&d);
    o
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(sha256(b))
}

/// 一時名で書いて fsync し、改名する。読み手は、書きかけの中身を見ない(設計メモ §3 の Publish の手順)。
/// 一時名は `.tmp-` で始め、読み手(Fetch)はその名前を無視する。
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("f");
    let tmp = dir.join(format!(".tmp-{}-{}", random_hex(6), name));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("OS の乱数が使えない");
    hex::encode(b)
}

/// 共有フォルダからの相対パスを、区切りを `/` にした文字列にする。共有フォルダの外なら None
pub fn rel_posix(root: &Path, abs: &Path) -> Option<String> {
    let rc: Vec<_> = root.components().collect();
    let ac: Vec<_> = abs.components().collect();
    if ac.len() <= rc.len() {
        return None;
    }
    let same = |a: &std::path::Component, b: &std::path::Component| {
        let (a, b) = (a.as_os_str().to_string_lossy(), b.as_os_str().to_string_lossy());
        if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b }
    };
    if !rc.iter().zip(&ac).all(|(a, b)| same(a, b)) {
        return None;
    }
    let mut parts = Vec::new();
    for c in &ac[rc.len()..] {
        match c {
            std::path::Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// パスを比べられる形にする: 実在すれば実体のパス、無ければ親フォルダの実体 + 名前(消したファイルも戻せるように)。
/// Windows の `\\?\` の前置きは外す
pub fn norm_path(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).ok().or_else(|| {
        let parent = std::fs::canonicalize(p.parent()?).ok()?;
        Some(parent.join(p.file_name()?))
    });
    strip_verbatim(&c.unwrap_or_else(|| p.to_path_buf()))
}

pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// 他の端末から届いた記録のパスとして安全か(共有フォルダの外や履歴フォルダを指さない。#9)
pub fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\\')
        && !rel.chars().any(|c| c.is_control())
        && rel.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && !s.contains(':'))
        && !is_ignored_rel(rel)
}

pub fn abs_from_rel(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in rel.split('/') {
        p.push(s);
    }
    p
}

/// Windows の大文字・小文字を区別しないファイルシステムで、同じファイルを同じキーにする(設計メモ §7.1 の旧記述と同じ考え方)
pub fn path_key(rel: &str) -> String {
    if cfg!(windows) || cfg!(target_os = "macos") {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// 履歴に取らないファイル: 履歴フォルダ、Office の一時ファイルやロックファイル、隠しの設定ファイル
pub fn is_ignored_rel(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    if first == crate::share::HISTORY_DIR {
        return true;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let lower = name.to_lowercase();
    name.starts_with("~$")
        || name.starts_with(".~lock")
        || name.starts_with(".tmp-")
        || lower.ends_with(".tmp")
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || lower == ".ds_store"
        || lower.ends_with(".gdoc")
        || lower.ends_with(".gsheet")
        || lower.ends_with(".gslides")
}
