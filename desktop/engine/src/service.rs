//! 常駐の処理: 共有フォルダの監視(保存ごとの記録)、自動の Fetch、裏での ZIP の分割。
//!
//! - 監視は、同じファイルの変更が 1.5 秒止まってから記録する(Office は保存の途中で何度も書くため)。
//! - 履歴フォルダの `log/` が変わったら、少し待って Fetch する。念のため 3 分おきにも Fetch する(設計メモ §4.1)。
//! - 起動したときは、共有フォルダの全ファイルを見て、最新の版と中身が違うものを記録する(止まっていた間の変更を拾う)。
//! - ZIP の分割は、保存が 5 秒止まってから行う(保存を遅くしない。preflate メモ §5)。
use crate::engine::Engine;
use crate::share::{self, HISTORY_DIR};
use crate::util::rel_posix;
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub const QUIET: Duration = Duration::from_millis(1500);
pub const FETCH_EVERY: Duration = Duration::from_secs(180);
pub const CONVERT_AFTER: Duration = Duration::from_secs(5);

/// 画面に出す状態
#[derive(Default)]
pub struct Status {
    pub last_fetch_unix: AtomicU64,
    pub pending: AtomicUsize,
    /// 保留が最初に見えた時刻(0 = 保留なし)。長く続くときだけ画面に出す(設計メモ §4.1)
    pub pending_since_unix: AtomicU64,
    pub last_error: Mutex<Option<String>>,
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn run_fetch(e: &Engine, st: &Status) {
    match share::fetch(e) {
        Ok(s) => {
            st.pending.store(s.pending, Ordering::Relaxed);
            if s.pending == 0 {
                st.pending_since_unix.store(0, Ordering::Relaxed);
            } else if st.pending_since_unix.load(Ordering::Relaxed) == 0 {
                st.pending_since_unix.store(now_unix(), Ordering::Relaxed);
            }
            *st.last_error.lock().unwrap() = None;
        }
        Err(err) => *st.last_error.lock().unwrap() = Some(format!("{err:#}")),
    }
    st.last_fetch_unix.store(now_unix(), Ordering::Relaxed);
}

/// 共有フォルダの全ファイルを記録する(起動時)
pub fn scan_all(e: &Engine) -> usize {
    let mut n = 0;
    let mut stack = vec![e.shared().to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for f in rd.flatten() {
            let p = f.path();
            let Ok(ft) = f.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if f.file_name() != HISTORY_DIR {
                    stack.push(p);
                }
            } else if ft.is_file() {
                if let Ok(Some(_)) = e.record_file(&p) {
                    n += 1;
                }
            }
        }
    }
    n
}

/// 監視と自動の Fetch を、呼び出したスレッドで回し続ける
pub fn run_loop(e: Arc<Engine>, st: Arc<Status>) -> anyhow::Result<()> {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })?;
    w.watch(e.shared(), RecursiveMode::Recursive)?;
    // 先にチームの版を取り込んでから、全ファイルを見る。逆だと、Drive が届けた他の人の本文を自分の保存として記録してしまう(レビュー #3)
    run_fetch(&e, &st);
    scan_all(&e);
    let root = std::fs::canonicalize(e.shared()).unwrap_or_else(|_| e.shared().to_path_buf());
    let mut dirty: HashMap<PathBuf, Instant> = HashMap::new();
    let mut log_changed: Option<Instant> = None;
    let mut last_fetch = Instant::now();
    let mut last_save = Instant::now();
    let mut need_convert = true;
    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(p) => {
                if is_under_log(&root, e.shared(), &p) {
                    log_changed = Some(Instant::now());
                } else {
                    dirty.insert(p, Instant::now());
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("監視が止まりました"),
        }
        let now = Instant::now();
        let ready: Vec<PathBuf> = dirty.iter().filter(|(_, t)| now.duration_since(**t) >= QUIET).map(|(p, _)| p.clone()).collect();
        for p in ready {
            dirty.remove(&p);
            match e.record_file(&p) {
                Ok(Some(_)) => {
                    last_save = Instant::now();
                    need_convert = true;
                }
                Ok(None) => {}
                Err(err) => *st.last_error.lock().unwrap() = Some(format!("{}: {err:#}", p.display())),
            }
        }
        if let Some(t) = log_changed {
            if now.duration_since(t) >= Duration::from_secs(2) {
                log_changed = None;
                run_fetch(&e, &st);
                last_fetch = Instant::now();
            }
        }
        if now.duration_since(last_fetch) >= FETCH_EVERY {
            run_fetch(&e, &st);
            last_fetch = Instant::now();
        }
        if need_convert && dirty.is_empty() && now.duration_since(last_save) >= CONVERT_AFTER {
            need_convert = false;
            if let Err(err) = e.convert_pending() {
                *st.last_error.lock().unwrap() = Some(format!("裏での整理に失敗: {err:#}"));
            }
        }
    }
}

fn is_under_log(root: &Path, shared: &Path, p: &Path) -> bool {
    let rel = rel_posix(root, p).or_else(|| rel_posix(shared, p));
    match rel {
        Some(r) => r.starts_with(&format!("{HISTORY_DIR}/log/")),
        None => false,
    }
}
