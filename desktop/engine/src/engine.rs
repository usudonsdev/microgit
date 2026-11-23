//! 履歴エンジン: 保存ごとの記録、ZIP 文書の分割(裏で)、版の一覧、同じファイルに版を重ねる復元。
//!
//! 不変条件(設計メモ §5、§7.1、preflate メモ §4・§5):
//! - 保存ごとの記録は、共有フォルダに書かない(書くのは Publish だけ)。
//! - 記録はまずファイル全体で持つ。ZIP の分割は後で行い、組み立て直しが SHA-256 で一致したときだけ置き換える。
//! - Publish した記録は書き換えない。
//! - 戻すときは、組み立て直した中身を記録の SHA-256 と照らしてから書く。
//! - 同じファイルに版を重ねる前に、いまの中身が履歴にあることを確かめ、無ければ先に記録する。
use crate::config::{store_dir, Config};
use crate::model::{Content, Kind, Record, ZipPart, RECORD_FORMAT};
use crate::ooxml;
use crate::store::{ensure_dir, ChunkStore};
use crate::util::{abs_from_rel, is_ignored_rel, path_key, rel_posix, sha256_hex, write_atomic};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    next_seq: u64,
    /// この連番までの自分の記録は、共有フォルダに出してある
    published_upto: u64,
}

struct Inner {
    state: State,
    /// path_key → その path の記録(時刻の古い順)
    by_path: HashMap<String, Vec<Record>>,
    /// id → (path_key, 何番目)
    ids: HashMap<String, (String, usize)>,
}

pub struct Engine {
    pub cfg: Config,
    pub dir: PathBuf,
    pub local: ChunkStore,
    records_dir: PathBuf,
    state_path: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Debug, PartialEq)]
pub enum RestoreOutcome {
    /// 新しい版として重ねた。いまの中身を先に記録したなら `saved_current` が true
    Stacked { new_id: String, saved_current: bool },
    /// 戻したい版と、いまの中身が同じだった。何もしていない(設計メモ §7.1)
    Unchanged,
}

/// 版の画面に出す 1 行分(設計メモ §7.2・§7.3 の言葉は画面の側で付ける)
#[derive(Debug, Clone, Serialize)]
pub struct VersionView {
    pub id: String,
    pub time: String,
    pub author: String,
    pub mine: bool,
    pub kind: Kind,
    pub restored_from_time: Option<String>,
    pub size: u64,
    pub published: bool,
    /// 他の人が、この前の版を知らずに別に編集した版
    pub diverged: bool,
    pub is_current: bool,
}

impl Engine {
    pub fn open(cfg: Config, dir: &Path) -> Result<Self> {
        let sd = store_dir(dir, &cfg.shared_folder);
        ensure_dir(&sd)?;
        let local = ChunkStore::new(sd.join("chunks"));
        let records_dir = sd.join("records");
        ensure_dir(&records_dir)?;
        let state_path = sd.join("state.json");
        let state: State = match fs::read_to_string(&state_path) {
            Ok(s) => serde_json::from_str(&s).context("state.json の形式が正しくない")?,
            Err(_) => State::default(),
        };
        let e = Engine {
            cfg,
            dir: dir.to_path_buf(),
            local,
            records_dir,
            state_path,
            inner: Mutex::new(Inner { state, by_path: HashMap::new(), ids: HashMap::new() }),
        };
        e.load_records()?;
        Ok(e)
    }

    fn load_records(&self) -> Result<()> {
        let mut all = Vec::new();
        for dev in fs::read_dir(&self.records_dir)? {
            let dev = dev?;
            if !dev.file_type()?.is_dir() {
                continue;
            }
            for f in fs::read_dir(dev.path())? {
                let f = f?;
                let name = f.file_name().to_string_lossy().to_string();
                if !crate::model::is_record_file_name(&name) {
                    continue;
                }
                let s = fs::read_to_string(f.path())?;
                match serde_json::from_str::<Record>(&s) {
                    Ok(r) => all.push(r),
                    Err(e) => eprintln!("記録 {} を読めない: {e}", f.path().display()),
                }
            }
        }
        let mut g = self.inner.lock().unwrap();
        let mut max_seq = 0;
        for r in all {
            if r.device == self.cfg.device_id {
                max_seq = max_seq.max(r.seq);
            }
            insert(&mut g, r);
        }
        if g.state.next_seq <= max_seq {
            g.state.next_seq = max_seq + 1;
        }
        if g.state.next_seq == 0 {
            g.state.next_seq = 1;
        }
        Ok(())
    }

    fn save_state(&self, st: &State) -> Result<()> {
        write_atomic(&self.state_path, serde_json::to_string(st)?.as_bytes())?;
        Ok(())
    }

    fn record_path(&self, r: &Record) -> PathBuf {
        self.records_dir.join(&r.device).join(r.file_name())
    }

    fn write_record(&self, r: &Record) -> Result<()> {
        write_atomic(&self.record_path(r), serde_json::to_string_pretty(r)?.as_bytes())?;
        Ok(())
    }

    pub fn shared(&self) -> &Path {
        &self.cfg.shared_folder
    }

    /// 履歴の対象か: 共有フォルダの中の、無視しないファイル(設計メモ §7.2。アップロード済みかは判定できないので、中にあることで代える)
    pub fn rel_of(&self, abs: &Path) -> Option<String> {
        let root = fs::canonicalize(self.shared()).unwrap_or_else(|_| self.shared().to_path_buf());
        let abs = fs::canonicalize(abs).unwrap_or_else(|_| abs.to_path_buf());
        let rel = rel_posix(&root, &abs)?;
        (!is_ignored_rel(&rel)).then_some(rel)
    }

    pub fn latest(&self, rel: &str) -> Option<Record> {
        let g = self.inner.lock().unwrap();
        g.by_path.get(&path_key(rel)).and_then(|v| v.last().cloned())
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        let g = self.inner.lock().unwrap();
        let (k, i) = g.ids.get(id)?;
        g.by_path.get(k).and_then(|v| v.get(*i)).cloned()
    }

    pub fn has_record(&self, id: &str) -> bool {
        self.inner.lock().unwrap().ids.contains_key(id)
    }

    pub fn all_paths(&self) -> Vec<(String, Record)> {
        let g = self.inner.lock().unwrap();
        let mut v: Vec<_> = g.by_path.values().filter_map(|v| v.last().map(|r| (r.path.clone(), r.clone()))).collect();
        v.sort_by(|a, b| b.1.time.cmp(&a.1.time));
        v
    }

    /// ファイルを読む。Office が書いている途中などで読めないときは、少し待って数回やり直す
    fn read_file(abs: &Path) -> Result<Vec<u8>> {
        let mut last = None;
        for i in 0..5 {
            match fs::read(abs) {
                Ok(b) => return Ok(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e.into()),
                Err(e) => last = Some(e),
            }
            std::thread::sleep(std::time::Duration::from_millis(200 * (i + 1)));
        }
        Err(anyhow!("{} を読めない: {}", abs.display(), last.unwrap()))
    }

    /// 保存を記録する。中身が、そのファイルの最新の版と同じなら記録しない(None)。
    /// 最新の版が他の人のもので、中身が同じなら、Drive が届けた本文なので記録しない(設計メモ §4 の表)。
    pub fn record_file(&self, abs: &Path) -> Result<Option<Record>> {
        let Some(rel) = self.rel_of(abs) else { return Ok(None) };
        if !abs.is_file() {
            return Ok(None);
        }
        let bytes = Self::read_file(abs)?;
        self.record_bytes(&rel, &bytes, Kind::Save, None)
    }

    fn record_bytes(&self, rel: &str, bytes: &[u8], kind: Kind, restored_from: Option<String>) -> Result<Option<Record>> {
        let sha = sha256_hex(bytes);
        let latest = self.latest(rel);
        if kind == Kind::Save {
            if let Some(l) = &latest {
                if l.sha256 == sha {
                    return Ok(None);
                }
            }
        }
        let chunks = self.local.put_chunked(bytes)?;
        let mut g = self.inner.lock().unwrap();
        // ロックを取り直した後で、もう一度だけ確かめる(監視と復元が同時に来たとき)
        if kind == Kind::Save {
            if let Some(l) = g.by_path.get(&path_key(rel)).and_then(|v| v.last()) {
                if l.sha256 == sha {
                    return Ok(None);
                }
            }
        }
        let seq = g.state.next_seq;
        let parent = g.by_path.get(&path_key(rel)).and_then(|v| v.last()).map(|r| r.id.clone());
        let mut r = Record {
            format: RECORD_FORMAT,
            id: String::new(),
            device: self.cfg.device_id.clone(),
            author: self.cfg.display_name.clone(),
            seq,
            path: rel.to_string(),
            time: now_rfc3339(&g, rel),
            kind,
            restored_from,
            parent,
            size: bytes.len() as u64,
            sha256: sha,
            content: Content::Whole { chunks },
        };
        r.id = r.compute_id();
        self.write_record(&r)?;
        g.state.next_seq = seq + 1;
        let st = State { next_seq: g.state.next_seq, published_upto: g.state.published_upto };
        self.save_state(&st)?;
        insert(&mut g, r.clone());
        Ok(Some(r))
    }

    /// 記録から、ファイルの中身を組み立てる。記録の SHA-256 と合わなければ失敗する
    pub fn materialize(&self, r: &Record) -> Result<Vec<u8>> {
        let bytes = match &r.content {
            Content::Whole { chunks } => self.local.get_concat(chunks)?,
            Content::Zip { skeleton, offsets, parts, preflate, format } => {
                if preflate != ooxml::PREFLATE_VERSION || *format != ooxml::FORMAT_VERSION {
                    bail!("この版は、別の版の preflate({preflate}、形式 {format})で記録されていて、この版のアプリでは戻せない");
                }
                let mut ps = Vec::new();
                for p in parts {
                    let data = match p.mode.as_str() {
                        "preflate" => ooxml::PartData::Preflate {
                            plain: self.local.get_concat(&p.data)?,
                            corrections: self.local.get_concat(&p.corrections)?,
                        },
                        "stored" => ooxml::PartData::Stored { plain: self.local.get_concat(&p.data)? },
                        "raw" => ooxml::PartData::Raw { compressed: self.local.get_concat(&p.data)? },
                        m => bail!("部品の種類 {m} を知らない"),
                    };
                    ps.push(ooxml::Part { name: p.name.clone(), data });
                }
                let s = ooxml::Split::Zip { skeleton: self.local.get_concat(skeleton)?, offsets: offsets.clone(), parts: ps };
                ooxml::rebuild(&s).map_err(|e| anyhow!(e))?
            }
        };
        if sha256_hex(&bytes) != r.sha256 {
            bail!("版 {} を組み立て直した中身が、記録したときと一致しない", r.id);
        }
        Ok(bytes)
    }

    /// まだ Publish していない自分の記録のうち、ZIP の文書を分けた形に置き換える(裏の処理。preflate メモ §5)。
    /// 置き換えた数を返す
    pub fn convert_pending(&self) -> Result<usize> {
        let todo: Vec<Record> = {
            let g = self.inner.lock().unwrap();
            g.by_path
                .values()
                .flatten()
                .filter(|r| r.device == self.cfg.device_id && r.seq > g.state.published_upto)
                .filter(|r| matches!(r.content, Content::Whole { .. }))
                .cloned()
                .collect()
        };
        let mut n = 0;
        for r in todo {
            let bytes = self.materialize(&r)?;
            if !bytes.starts_with(b"PK\x03\x04") {
                continue;
            }
            let split = ooxml::split(&bytes);
            let ooxml::Split::Zip { skeleton, offsets, parts } = split else { continue };
            let mut zp = Vec::new();
            for p in parts {
                let (mode, data, corr) = match p.data {
                    ooxml::PartData::Preflate { plain, corrections } => ("preflate", plain, corrections),
                    ooxml::PartData::Stored { plain } => ("stored", plain, Vec::new()),
                    ooxml::PartData::Raw { compressed } => ("raw", compressed, Vec::new()),
                };
                zp.push(ZipPart {
                    name: p.name,
                    mode: mode.into(),
                    data: self.local.put_chunked(&data)?,
                    corrections: if corr.is_empty() { Vec::new() } else { vec![self.local.put(&corr)?] },
                });
            }
            let mut nr = r.clone();
            nr.content = Content::Zip {
                preflate: ooxml::PREFLATE_VERSION.into(),
                format: ooxml::FORMAT_VERSION,
                skeleton: self.local.put_chunked(&skeleton)?,
                offsets,
                parts: zp,
            };
            // 置き換える前に、新しい形から元に戻ることを確かめる
            if self.materialize(&nr).is_err() {
                continue;
            }
            let mut g = self.inner.lock().unwrap();
            if r.seq <= g.state.published_upto {
                continue; // 途中で Publish された。出した記録は書き換えない
            }
            self.write_record(&nr)?;
            replace(&mut g, nr);
            n += 1;
        }
        Ok(n)
    }

    /// 版の一覧(新しい順)
    pub fn versions(&self, rel: &str) -> Vec<VersionView> {
        let g = self.inner.lock().unwrap();
        let Some(v) = g.by_path.get(&path_key(rel)) else { return Vec::new() };
        let times: HashMap<&str, &str> = v.iter().map(|r| (r.id.as_str(), r.time.as_str())).collect();
        let mut out = Vec::new();
        for (i, r) in v.iter().enumerate() {
            let prev = if i > 0 { Some(&v[i - 1]) } else { None };
            let diverged = match prev {
                Some(p) => r.parent.as_deref() != Some(p.id.as_str()) && r.device != p.device,
                None => false,
            };
            out.push(VersionView {
                id: r.id.clone(),
                time: r.time.clone(),
                author: r.author.clone(),
                mine: r.device == self.cfg.device_id,
                kind: r.kind.clone(),
                restored_from_time: r.restored_from.as_deref().and_then(|id| times.get(id).map(|s| s.to_string())),
                size: r.size,
                published: r.device != self.cfg.device_id || r.seq <= g.state.published_upto,
                diverged,
                is_current: i + 1 == v.len(),
            });
        }
        out.reverse();
        out
    }

    pub fn unpublished_count(&self) -> usize {
        let g = self.inner.lock().unwrap();
        g.by_path.values().flatten().filter(|r| r.device == self.cfg.device_id && r.seq > g.state.published_upto).count()
    }

    /// 過去の版を、同じファイルに新しい版として重ねる(設計メモ §7.1)
    pub fn restore(&self, rel: &str, id: &str) -> Result<RestoreOutcome> {
        let target = self.get(id).ok_or_else(|| anyhow!("その版が見つからない"))?;
        if path_key(&target.path) != path_key(rel) {
            bail!("その版は、このファイルのものではない");
        }
        let bytes = self.materialize(&target)?;
        let abs = abs_from_rel(self.shared(), rel);
        let mut saved_current = false;
        if abs.is_file() {
            let cur = Self::read_file(&abs)?;
            if sha256_hex(&cur) == target.sha256 {
                return Ok(RestoreOutcome::Unchanged);
            }
            // いまの中身が履歴に無ければ、先に記録する。記録できなければ置き換えない
            if self.record_bytes(rel, &cur, Kind::Save, None)?.is_some() {
                saved_current = true;
            }
        }
        // そのまま上書きする(一時名からの改名にしない)。Drive for desktop が同じファイルの新しい版として扱う見込みが高いため
        // (設計メモ §6 の検証 7 で確かめる)。開いているアプリが書き込みを拒んだら、置き換えない
        let res = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&abs).and_then(|mut f| {
            f.write_all(&bytes)?;
            f.sync_all()
        });
        if let Err(e) = res {
            if is_sharing_violation(&e) {
                bail!("このファイルは、ほかのアプリ(Word や Excel など)で開かれています。閉じてから、もう一度お試しください");
            }
            return Err(anyhow!("ファイルに書き込めない: {e}"));
        }
        if sha256_hex(&Self::read_file(&abs)?) != target.sha256 {
            bail!("書き込んだ中身を確かめたところ、一致しなかった。ほかのアプリが同時に書き換えた可能性がある");
        }
        let r = self
            .record_bytes(rel, &bytes, Kind::Restore, Some(target.id.clone()))?
            .ok_or_else(|| anyhow!("版を記録できなかった"))?;
        Ok(RestoreOutcome::Stacked { new_id: r.id, saved_current })
    }

    // ---- Publish / Fetch から使う ----

    pub(crate) fn my_unpublished(&self) -> (Vec<Record>, u64) {
        let g = self.inner.lock().unwrap();
        let mut v: Vec<Record> = g
            .by_path
            .values()
            .flatten()
            .filter(|r| r.device == self.cfg.device_id && r.seq > g.state.published_upto)
            .cloned()
            .collect();
        v.sort_by_key(|r| r.seq);
        (v, g.state.published_upto)
    }

    pub(crate) fn mark_published(&self, upto: u64) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        if upto > g.state.published_upto {
            g.state.published_upto = upto;
        }
        let st = State { next_seq: g.state.next_seq, published_upto: g.state.published_upto };
        self.save_state(&st)
    }

    /// 他の端末の記録を取り込む(チャンクは呼び出し側が先に入れておく)
    pub(crate) fn import(&self, r: Record) -> Result<()> {
        if self.has_record(&r.id) {
            return Ok(());
        }
        self.write_record(&r)?;
        let mut g = self.inner.lock().unwrap();
        insert(&mut g, r);
        Ok(())
    }
}

fn insert(g: &mut Inner, r: Record) {
    if g.ids.contains_key(&r.id) {
        return;
    }
    let k = path_key(&r.path);
    let v = g.by_path.entry(k.clone()).or_default();
    v.push(r);
    // 時刻の古い順。同じ時刻なら端末と連番で決める(どの端末でも同じ並びになるように)
    v.sort_by(|a, b| (a.time.as_str(), a.device.as_str(), a.seq).cmp(&(b.time.as_str(), b.device.as_str(), b.seq)));
    reindex(g, &k);
}

fn replace(g: &mut Inner, r: Record) {
    let k = path_key(&r.path);
    if let Some(v) = g.by_path.get_mut(&k) {
        if let Some(x) = v.iter_mut().find(|x| x.id == r.id) {
            *x = r;
        }
    }
}

fn reindex(g: &mut Inner, k: &str) {
    if let Some(v) = g.by_path.get(k) {
        for (i, r) in v.iter().enumerate() {
            g.ids.insert(r.id.clone(), (k.to_string(), i));
        }
    }
}

/// 記録の時刻。同じファイルの最新の版より前にならないようにする(時計のずれで並びが逆にならないように)
fn now_rfc3339(g: &Inner, rel: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    match g.by_path.get(&path_key(rel)).and_then(|v| v.last()) {
        Some(l) if l.time >= now => {
            let t = chrono::DateTime::parse_from_rfc3339(&l.time).map(|t| t.with_timezone(&chrono::Utc)).unwrap_or_else(|_| chrono::Utc::now());
            (t + chrono::Duration::milliseconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }
        _ => now,
    }
}

fn is_sharing_violation(e: &std::io::Error) -> bool {
    // Windows: ERROR_SHARING_VIOLATION(32)、ERROR_LOCK_VIOLATION(33)
    matches!(e.raw_os_error(), Some(32) | Some(33)) && cfg!(windows) || e.kind() == std::io::ErrorKind::PermissionDenied
}
