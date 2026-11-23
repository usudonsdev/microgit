//! 設定と、データの置き場所。
//!
//! ローカルの履歴ストアは、共有フォルダの外(OS の利用者の領域)に置く(設計メモ §2)。
//! 試験や複数の端末の模擬のため、環境変数 `VEREVE_DESK_HOME` で置き場所を変えられる。
use crate::util::{random_hex, sha256_hex, write_atomic};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// 共有フォルダ F(Drive for desktop の中のフォルダ)
    pub shared_folder: PathBuf,
    /// 画面で他の人に見せる名前(例: 「佐藤」)。設計メモ §7.3
    pub display_name: String,
    /// 端末ごとの ID。画面には出さない
    pub device_id: String,
    /// チーム ID。履歴フォルダの目印(team.json)と照らす(設計メモ §3.1)
    pub team_id: String,
}

pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("VEREVE_DESK_HOME") {
        return PathBuf::from(p);
    }
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(p).join("verEve").join("desk");
        }
    }
    if let Some(p) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(p).join("vereve-desk");
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".local").join("share").join("vereve-desk")
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

pub fn load(dir: &Path) -> Result<Option<Config>> {
    let p = config_path(dir);
    if !p.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&p).with_context(|| format!("{} が読めない", p.display()))?;
    Ok(Some(serde_json::from_str(&s).context("設定ファイルの形式が正しくない")?))
}

pub fn save(dir: &Path, c: &Config) -> Result<()> {
    write_atomic(&config_path(dir), serde_json::to_string_pretty(c)?.as_bytes())?;
    Ok(())
}

pub fn new_device_id() -> String {
    random_hex(8)
}

pub fn new_team_id() -> String {
    random_hex(8)
}

/// 共有フォルダのフルパスから、ローカルのストアの名前を決める(設計メモ §3)
pub fn store_dir(dir: &Path, shared: &Path) -> PathBuf {
    let canon = std::fs::canonicalize(shared).unwrap_or_else(|_| shared.to_path_buf());
    let key = canon.to_string_lossy().to_string();
    let key = if cfg!(windows) { key.to_lowercase() } else { key };
    dir.join("stores").join(&sha256_hex(key.as_bytes())[..16])
}
