//! 共有フォルダの履歴フォルダへの Publish(利用者が押したときだけ)と、Fetch(自動。設計メモ §4.1)。
//!
//! 共有フォルダ F の中の形(設計メモ §3):
//! ```text
//! F/.microgit-history/
//!   team.json                      チーム ID と形式の版(目印。§3.1)
//!   members/<deviceId>.json        その端末の表示名(画面で「佐藤さんの版」と出すため)
//!   chunks/<先頭2桁>/<hash>        内容アドレス型の不変チャンク(zstd 圧縮。名前は圧縮前の SHA-256)
//!   log/<deviceId>/<連番>-<id>.json  その端末だけが書く、追記専用の版の記録
//! ```
//! 不変条件(設計メモ §5): 各端末は自分の `log/<deviceId>/` と `members/<deviceId>.json` 以外を書き換えない。
//! チャンクは書いた後に変更しない。記録が参照するチャンクは、記録より先に存在する(Publish が保証し、Fetch が確かめる)。
use crate::engine::Engine;
use crate::model::{is_record_file_name, Record};
use crate::store::{ensure_dir, ChunkStore};
use crate::util::write_atomic;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 履歴フォルダの名前。全員が同じ相対パスを使う(設計メモ §3.1)。先頭ドットの名前が Drive で同期されるかは未検証(§6 の検証 1)
pub const HISTORY_DIR: &str = ".microgit-history";
pub const SHARED_FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamMarker {
    pub team_id: String,
    pub format: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub device_id: String,
    pub display_name: String,
}

pub fn history_root(shared: &Path) -> PathBuf {
    shared.join(HISTORY_DIR)
}

pub fn read_marker(shared: &Path) -> Result<Option<TeamMarker>> {
    let p = history_root(shared).join("team.json");
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(serde_json::from_str(&s).context("team.json の形式が正しくない")?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 目印を確かめる。無ければ作る(最初に Publish する人)。チーム ID か形式の版が違えば、書き込まずに失敗する
pub fn check_or_create_marker(shared: &Path, team_id: &str) -> Result<()> {
    match read_marker(shared)? {
        Some(m) if m.team_id != team_id => bail!(
            "このフォルダの履歴は、別のチームのものです。設定した共有フォルダが正しいか確かめてください(チーム ID が一致しません)"
        ),
        Some(m) if m.format != SHARED_FORMAT => bail!("このフォルダの履歴は、このアプリと形式の版が違います(形式 {})。アプリを更新してください", m.format),
        Some(_) => Ok(()),
        None => {
            let m = TeamMarker { team_id: team_id.into(), format: SHARED_FORMAT };
            write_atomic(&history_root(shared).join("team.json"), serde_json::to_string_pretty(&m)?.as_bytes())?;
            Ok(())
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct PublishSummary {
    pub records: usize,
    pub chunks: usize,
}

/// 自分の、まだ出していない版を共有フォルダへ出す。
/// 手順(設計メモ §3): ①無いチャンクを書く ②全部あることを確かめる ③記録を一時名で書いて改名する。
pub fn publish(e: &Engine) -> Result<PublishSummary> {
    let shared = e.shared();
    if !shared.is_dir() {
        bail!("共有フォルダ {} が見つかりません", shared.display());
    }
    check_or_create_marker(shared, &e.cfg.team_id)?;
    let root = history_root(shared);
    let member = Member { device_id: e.cfg.device_id.clone(), display_name: e.cfg.display_name.clone() };
    write_atomic(&root.join("members").join(format!("{}.json", e.cfg.device_id)), serde_json::to_string_pretty(&member)?.as_bytes())?;
    // 出す前に、ZIP の文書を分けた形にしておく(出した記録は書き換えないため)
    e.convert_pending()?;
    let (recs, _) = e.my_unpublished();
    let remote = ChunkStore::new(root.join("chunks"));
    let logdir = root.join("log").join(&e.cfg.device_id);
    ensure_dir(&logdir)?;
    let mut sum = PublishSummary::default();
    for r in &recs {
        for id in r.chunk_ids() {
            if !remote.has(&id) {
                let raw = e.local.read_raw(&id)?;
                write_atomic(&remote.path_of(&id), &raw)?;
                sum.chunks += 1;
            }
        }
        for id in r.chunk_ids() {
            if !remote.has(&id) {
                bail!("共有フォルダにチャンクを書けませんでした。空き容量と、フォルダへの書き込みの権限を確かめてください");
            }
        }
        write_atomic(&logdir.join(r.file_name()), serde_json::to_string_pretty(r)?.as_bytes())?;
        e.mark_published(r.seq)?;
        sum.records += 1;
    }
    Ok(sum)
}

#[derive(Debug, Default, PartialEq)]
pub struct FetchSummary {
    pub imported: usize,
    /// 参照先のチャンクがまだ届いていない記録(次の自動実行で取り直す)
    pub pending: usize,
    /// 壊れている、または形式が違うので取り込まなかった記録
    pub rejected: usize,
}

/// 他の端末が出した版を、ローカルの履歴ストアへ取り込む。文書そのものには触れない(設計メモ §4.1)
pub fn fetch(e: &Engine) -> Result<FetchSummary> {
    let root = history_root(e.shared());
    let mut sum = FetchSummary::default();
    let Some(m) = read_marker(e.shared())? else { return Ok(sum) };
    if m.team_id != e.cfg.team_id || m.format != SHARED_FORMAT {
        return Err(anyhow!("履歴フォルダのチーム ID か形式の版が一致しないため、取り込みません"));
    }
    let remote = ChunkStore::new(root.join("chunks"));
    let logs = root.join("log");
    let Ok(devs) = fs::read_dir(&logs) else { return Ok(sum) };
    for dev in devs.flatten() {
        let dev_id = dev.file_name().to_string_lossy().to_string();
        if dev_id == e.cfg.device_id || !dev.path().is_dir() {
            continue;
        }
        let mut files: Vec<_> = fs::read_dir(dev.path())?.flatten().collect();
        files.sort_by_key(|f| f.file_name());
        for f in files {
            let name = f.file_name().to_string_lossy().to_string();
            // 一時名(.tmp-…)や Drive の競合コピー(… (1).json)は、この形に合わないので読まない
            if !is_record_file_name(&name) {
                continue;
            }
            let id = &name[9..73];
            if e.has_record(id) {
                continue;
            }
            let r: Record = match fs::read_to_string(f.path()).ok().and_then(|s| serde_json::from_str(&s).ok()) {
                Some(r) => r,
                None => {
                    // 書きかけが同期の途中で見えている可能性もある。次の回に読み直す
                    sum.pending += 1;
                    continue;
                }
            };
            if r.id != id || r.compute_id() != r.id || r.device != dev_id || r.format != crate::model::RECORD_FORMAT {
                sum.rejected += 1;
                continue;
            }
            if r.path.split('/').any(|s| s.is_empty() || s == "." || s == "..") || r.path.contains('\\') {
                sum.rejected += 1; // 共有フォルダの外を指す記録は取り込まない
                continue;
            }
            let ids = r.chunk_ids();
            if ids.iter().any(|c| !remote.has(c) && !e.local.has(c)) {
                sum.pending += 1;
                continue;
            }
            let mut ok = true;
            for c in &ids {
                if e.local.has(c) {
                    continue;
                }
                match remote.read_raw(c).and_then(|raw| e.local.put_raw_verified(c, &raw)) {
                    Ok(()) => {}
                    Err(_) => {
                        ok = false; // 同期の途中か、壊れている。捨てて、次の回にやり直す
                        break;
                    }
                }
            }
            if !ok {
                sum.pending += 1;
                continue;
            }
            // 中身が本当に組み立て直せるかを、取り込む前に確かめる
            if e.materialize(&r).is_err() {
                sum.rejected += 1;
                continue;
            }
            e.import(r)?;
            sum.imported += 1;
        }
    }
    Ok(sum)
}

/// 端末 ID → 表示名(画面で使う)
pub fn members(shared: &Path) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Ok(rd) = fs::read_dir(history_root(shared).join("members")) {
        for f in rd.flatten() {
            if let Some(x) = fs::read_to_string(f.path()).ok().and_then(|s| serde_json::from_str::<Member>(&s).ok()) {
                m.insert(x.device_id, x.display_name);
            }
        }
    }
    m
}
