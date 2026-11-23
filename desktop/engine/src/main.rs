// verEve デスクトップ(非エンジニア版、段階 1)。
//
//   vereve-desk run [--background]     常駐する(監視・自動の取り込み・画面)。2 つ目は起動しない
//   vereve-desk show <ファイル>        そのファイルの過去のバージョンの画面を開く(右クリックの項目から呼ぶ)
//   vereve-desk open                   ホームの画面を開く
//   vereve-desk setup <フォルダ> <名前>  画面を使わずに設定する
//   vereve-desk publish                チームに共有する(画面のボタンと同じ)
//   vereve-desk install / uninstall    Windows: 利用者単位で入れる・外す(管理者権限は要らない)
//
// 画面はブラウザで開く。環境変数 VEREVE_DESK_NO_BROWSER=1 なら、開かずに URL を表示する(試験用)。
#![cfg_attr(windows, windows_subsystem = "windows")]

use engine::config;
use engine::ui::{self, App, Runtime};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod win;

fn main() {
    win::attach_console();
    let args: Vec<String> = std::env::args().collect();
    let r = match args.get(1).map(|s| s.as_str()) {
        Some("run") => run(),
        Some("show") => match args.get(2) {
            Some(p) => show(Some(PathBuf::from(p))),
            None => Err(anyhow::anyhow!("ファイルを指定してください")),
        },
        Some("open") | None => show(None),
        Some("setup") => setup(args.get(2), args.get(3)),
        Some("publish") => publish(),
        Some("install") => win::install(),
        Some("uninstall") => win::uninstall(),
        Some(x) => Err(anyhow::anyhow!("知らない指示です: {x}")),
    };
    if let Err(e) = r {
        win::report_error(&format!("{e:#}"));
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let dir = config::data_dir();
    std::fs::create_dir_all(&dir)?;
    if alive(&dir).is_some() {
        return Ok(()); // もう動いている
    }
    // 2 つ同時に起動されても、片方だけが動くように、ロック用のポートを使わずに runtime.json の作成で決める
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("画面のための待ち受けを始められない: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let token = engine::util::random_hex(16);
    let app = Arc::new(App { dir: dir.clone(), token: token.clone(), port, engine: Default::default(), status: Default::default() });
    if let Some(cfg) = config::load(&dir)? {
        app.start_engine(cfg)?;
    }
    let rt = Runtime { port, token, pid: std::process::id() };
    engine::util::write_atomic(&ui::runtime_path(&dir), serde_json::to_string(&rt)?.as_bytes())?;
    ui::serve(app, server);
    Ok(())
}

/// 動いている常駐のプロセスの、待ち受けの番号と合言葉。動いていなければ None
fn alive(dir: &std::path::Path) -> Option<Runtime> {
    let s = std::fs::read_to_string(ui::runtime_path(dir)).ok()?;
    let rt: Runtime = serde_json::from_str(&s).ok()?;
    let body = http_get(rt.port, &format!("/ping?t={}", rt.token))?;
    (body == "ok").then_some(rt)
}

fn http_get(port: u16, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    let (head, body) = buf.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then(|| body.to_string())
}

fn ensure_running() -> anyhow::Result<Runtime> {
    let dir = config::data_dir();
    if let Some(rt) = alive(&dir) {
        return Ok(rt);
    }
    let exe = std::env::current_exe()?;
    win::spawn_detached(&exe, &["run", "--background"])?;
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(200));
        if let Some(rt) = alive(&dir) {
            return Ok(rt);
        }
    }
    anyhow::bail!("verEve を起動できませんでした")
}

fn show(file: Option<PathBuf>) -> anyhow::Result<()> {
    let rt = ensure_running()?;
    let enc = |s: &str| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = match file {
        Some(p) => {
            let p = std::fs::canonicalize(&p).unwrap_or(p);
            let p = win::strip_verbatim(&p);
            format!("http://127.0.0.1:{}/file?t={}&path={}", rt.port, rt.token, enc(&p.display().to_string()))
        }
        None => format!("http://127.0.0.1:{}/?t={}", rt.port, rt.token),
    };
    if std::env::var_os("VEREVE_DESK_NO_BROWSER").is_some() {
        println!("{url}");
        return Ok(());
    }
    win::open_browser(&url)
}

fn setup(folder: Option<&String>, name: Option<&String>) -> anyhow::Result<()> {
    let (Some(f), Some(n)) = (folder, name) else { anyhow::bail!("使い方: vereve-desk setup <共有フォルダ> <あなたの名前>") };
    let dir = config::data_dir();
    std::fs::create_dir_all(&dir)?;
    let c = ui::make_config(&dir, f, n).map_err(|m| anyhow::anyhow!(m))?;
    config::save(&dir, &c)?;
    println!("設定しました: {}", c.shared_folder.display());
    Ok(())
}

fn publish() -> anyhow::Result<()> {
    let dir = config::data_dir();
    let Some(c) = config::load(&dir)? else { anyhow::bail!("まだ設定されていません") };
    let e = engine::engine::Engine::open(c, &dir)?;
    let s = engine::share::publish(&e)?;
    println!("{} 件の版を、チームに共有しました", s.records);
    Ok(())
}
