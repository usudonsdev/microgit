//! 画面: 常駐するエンジンが 127.0.0.1 で開く小さなウェブページ(実装メモ §1)。
//!
//! 言葉は設計メモ §7.3 の表に従う。Git の言葉(コミット、ブランチ、マージ、push など)を画面に出さない。
//! 安全: 127.0.0.1 だけで待ち受け、起動ごとの合言葉(t=…)が無い要求と、Host が 127.0.0.1 でない要求は断る。
//! 書き換える操作は POST だけで受ける。
use crate::config::{self, Config};
use crate::engine::{Engine, RestoreOutcome, VersionView};
use crate::model::Kind;
use crate::service::{self, Status};
use crate::share;
use crate::util::{abs_from_rel, write_atomic};
use anyhow::Result;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Response, Server};

pub struct App {
    pub dir: PathBuf,
    pub token: String,
    pub port: u16,
    pub engine: Mutex<Option<Arc<Engine>>>,
    pub status: Arc<Status>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Runtime {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

pub fn runtime_path(dir: &Path) -> PathBuf {
    dir.join("runtime.json")
}

type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn html(body: String) -> Resp {
    Response::from_data(body.into_bytes())
        .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(Header::from_bytes("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'").unwrap())
        .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap())
}

fn redirect(to: &str) -> Resp {
    Response::from_data(Vec::new()).with_status_code(303).with_header(Header::from_bytes("Location", to).unwrap())
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn parse_qs(s: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for kv in s.split('&') {
        if kv.is_empty() {
            continue;
        }
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        let dec = |x: &str| percent_decode_str(&x.replace('+', " ")).decode_utf8_lossy().to_string();
        m.insert(dec(k), dec(v));
    }
    m
}

/// 版の時刻を、画面向けの地方時で出す(例: 「11/20 15:30」)
pub fn local_time(rfc: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(rfc) {
        Ok(t) => t.with_timezone(&chrono::Local).format("%Y/%m/%d %H:%M:%S").to_string(),
        Err(_) => rfc.to_string(),
    }
}

fn short_time(rfc: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(rfc) {
        Ok(t) => t.with_timezone(&chrono::Local).format("%m/%d %H:%M:%S").to_string(),
        Err(_) => rfc.to_string(),
    }
}

fn size_text(n: u64) -> String {
    if n >= 1 << 20 {
        format!("{:.1} MB", n as f64 / (1u64 << 20) as f64)
    } else if n >= 1024 {
        format!("{} KB", n / 1024)
    } else {
        format!("{n} バイト")
    }
}

const CSS: &str = r#"
body{font-family:"Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans CJK JP",sans-serif;margin:0;background:#f6f7f9;color:#1d232b}
header{background:#fff;border-bottom:1px solid #dde1e6;padding:14px 24px;display:flex;align-items:center;gap:16px}
header a{color:inherit;text-decoration:none;font-weight:700;font-size:18px}
main{max-width:920px;margin:24px auto;padding:0 24px}
h1{font-size:20px;margin:0 0 4px} .sub{color:#5b6470;font-size:13px;margin:0 0 20px;word-break:break-all}
.card{background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:18px 20px;margin-bottom:16px}
.notice{background:#fff8e6;border-color:#f0d48a} .err{background:#fdeeee;border-color:#ee9a9a} .ok{background:#ecf8ef;border-color:#9ad3a8}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #eceef1;vertical-align:middle;font-size:14px}
th{color:#5b6470;font-weight:600;font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef1f5;color:#3d4652;margin-right:4px}
.tag.cur{background:#1f6feb;color:#fff} .tag.other{background:#efe7fb;color:#5a3d99} .tag.warn{background:#fff1d6;color:#8a5a00}
button,.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid #c6ccd4;background:#fff;color:#1d232b;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
form.inline{display:inline;margin:0}
input[type=text]{font:inherit;padding:7px 9px;border:1px solid #c6ccd4;border-radius:6px;width:100%;box-sizing:border-box}
label{display:block;font-size:13px;color:#3d4652;margin:12px 0 4px}
.muted{color:#5b6470;font-size:13px}
ul.checks{list-style:none;padding:0;margin:0} ul.checks li{padding:4px 0;font-size:14px}
"#;

fn page(app: &App, title: &str, body: &str) -> Resp {
    html(format!(
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{} - verEve</title><style>{CSS}</style></head><body><header><a href=\"/?t={}\">verEve</a><span class=\"muted\">ファイルの過去のバージョン</span></header><main>{body}</main></body></html>",
        esc(title),
        app.token
    ))
}

impl App {
    pub fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.lock().unwrap().clone()
    }

    fn t(&self) -> String {
        format!("t={}", self.token)
    }

    pub fn start_engine(self: &Arc<Self>, cfg: Config) -> Result<()> {
        let e = Arc::new(Engine::open(cfg, &self.dir)?);
        *self.engine.lock().unwrap() = Some(e.clone());
        let st = self.status.clone();
        std::thread::spawn(move || {
            if let Err(err) = service::run_loop(e, st.clone()) {
                *st.last_error.lock().unwrap() = Some(format!("監視を始められませんでした: {err:#}"));
            }
        });
        Ok(())
    }
}

pub fn serve(app: Arc<App>, server: Server) {
    for mut req in server.incoming_requests() {
        let app = app.clone();
        // 1 つずつ処理する(利用者 1 人の画面なので十分。処理の重なりを避ける)
        let url = req.url().to_string();
        let (path, qs) = url.split_once('?').unwrap_or((&url, ""));
        let mut q = parse_qs(qs);
        let host_ok = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Host"))
            .map(|h| {
                let v = h.value.as_str();
                v == format!("127.0.0.1:{}", app.port) || v == format!("localhost:{}", app.port)
            })
            .unwrap_or(false);
        if *req.method() == Method::Post {
            let mut body = String::new();
            let _ = req.as_reader().take(1 << 20).read_to_string(&mut body);
            q.extend(parse_qs(&body));
        }
        let token_ok = q.get("t").map(|t| t == &app.token).unwrap_or(false);
        let resp = if !host_ok || !token_ok {
            Response::from_string("この画面は、verEve のアプリから開いてください。").with_status_code(403)
        } else {
            match (req.method(), path) {
                (Method::Get, "/ping") => Response::from_string("ok"),
                (Method::Get, "/") => home(&app),
                (Method::Get, "/setup") => setup_page(&app, None),
                (Method::Post, "/setup") => setup_post(&app, &q),
                (Method::Get, "/file") => file_page(&app, &q),
                (Method::Post, "/restore") => restore_post(&app, &q),
                (Method::Get, "/download") => download(&app, &q),
                (Method::Post, "/publish") => publish_post(&app),
                _ => Response::from_string("見つかりません").with_status_code(404),
            }
        };
        let _ = req.respond(resp);
    }
}

fn home(app: &Arc<App>) -> Resp {
    let Some(e) = app.engine() else { return redirect(&format!("/setup?{}", app.t())) };
    let st = &app.status;
    let mut b = String::new();
    b.push_str(&format!("<h1>共有フォルダ</h1><p class=\"sub\">{}</p>", esc(&e.shared().display().to_string())));
    if let Some(err) = st.last_error.lock().unwrap().clone() {
        b.push_str(&format!("<div class=\"card err\">うまくいかなかったことがあります: {}</div>", esc(&err)));
    }
    pending_notice(app, &mut b);
    let n = e.unpublished_count();
    b.push_str("<div class=\"card\">");
    if n == 0 {
        b.push_str("<p>あなたの版は、すべてチームに共有しています。</p>");
    } else {
        b.push_str(&format!(
            "<p>まだチームに共有していない、あなたの版が <b>{n} 件</b>あります。共有すると、このフォルダを使っているチームの人が、あなたの版を見られるようになります。</p><form method=\"post\" action=\"/publish\"><input type=\"hidden\" name=\"t\" value=\"{}\"><button class=\"primary\">チームに共有する</button></form>",
            app.token
        ));
    }
    b.push_str("</div>");
    let files = e.all_paths();
    b.push_str("<div class=\"card\"><h1>最近変わったファイル</h1><p class=\"muted\">ファイルを右クリックして「過去のバージョンを確認」を選んでも、この画面が開きます。</p><table><tr><th>ファイル</th><th>最後の版</th><th>だれ</th></tr>");
    for (rel, r) in files.iter().take(50) {
        let abs = abs_from_rel(e.shared(), rel);
        b.push_str(&format!(
            "<tr><td><a href=\"/file?{}&path={}\">{}</a></td><td>{}</td><td>{}</td></tr>",
            app.t(),
            enc(&abs.display().to_string()),
            esc(rel),
            esc(&local_time(&r.time)),
            esc(&who(&e, &r.device, &r.author))
        ));
    }
    if files.is_empty() {
        b.push_str("<tr><td colspan=\"3\" class=\"muted\">まだ版はありません。共有フォルダの中のファイルを保存すると、ここに出ます。</td></tr>");
    }
    b.push_str("</table></div>");
    page(app, "ホーム", &b)
}

fn pending_notice(app: &App, b: &mut String) {
    let since = app.status.pending_since_unix.load(Ordering::Relaxed);
    if app.status.pending.load(Ordering::Relaxed) > 0 && since > 0 && service::now_unix().saturating_sub(since) >= 60 {
        b.push_str("<div class=\"card notice\">まだ Google ドライブから届いていない版があります。しばらくしてからもう一度お試しください。</div>");
    }
}

fn who(e: &Engine, device: &str, author: &str) -> String {
    if device == e.cfg.device_id {
        "あなた".into()
    } else {
        format!("{}さん", author)
    }
}

fn setup_page(app: &App, msg: Option<&str>) -> Resp {
    let checks = setup_checks();
    let cur = config::load(&app.dir).ok().flatten();
    let mut b = String::from("<h1>はじめに</h1><p class=\"sub\">チームで使っている Google ドライブの共有フォルダを選びます。このフォルダの中のファイルは、保存するたびに過去のバージョンが残ります。</p>");
    if let Some(m) = msg {
        b.push_str(&format!("<div class=\"card err\">{}</div>", esc(m)));
    }
    b.push_str("<div class=\"card\"><h1>このパソコンの確認</h1><ul class=\"checks\">");
    for (ok, text) in checks {
        b.push_str(&format!("<li>{} {}</li>", if ok { "✅" } else { "⚠️" }, esc(&text)));
    }
    b.push_str("</ul><p class=\"muted\">Google ドライブを使えるようにする手順は、Google の公式ヘルプ「パソコン版 Google ドライブ」をご覧ください。チームで共有しないなら、今は飛ばしてかまいません。</p></div>");
    b.push_str(&format!(
        "<div class=\"card\"><form method=\"post\" action=\"/setup\"><input type=\"hidden\" name=\"t\" value=\"{}\"><label>共有フォルダの場所(エクスプローラーでフォルダを開き、上のアドレス欄の文字をコピーして貼り付けます)</label><input type=\"text\" name=\"folder\" value=\"{}\" placeholder=\"例: G:\\共有ドライブ\\営業部\\資料\"><label>あなたの名前(チームの人に「○○さんの版」と表示されます)</label><input type=\"text\" name=\"name\" value=\"{}\" placeholder=\"例: 佐藤\"><p><button class=\"primary\">このフォルダで始める</button></p></form></div>",
        app.token,
        esc(&cur.as_ref().map(|c| c.shared_folder.display().to_string()).unwrap_or_default()),
        esc(&cur.as_ref().map(|c| c.display_name.clone()).unwrap_or_default())
    ));
    page(app, "はじめに", &b)
}

/// 導入時の確認(設計メモ §9.2)。見つけ方は推測を含む(§9.5 の未決)ので、結果は警告に留め、止めない
pub fn setup_checks() -> Vec<(bool, String)> {
    let mut v = Vec::new();
    let drivefs = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Google").join("DriveFS"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support/Google/DriveFS"))
    } else {
        None
    };
    match drivefs {
        Some(p) if p.is_dir() => v.push((true, "パソコン版 Google ドライブが入っているようです。".into())),
        Some(_) => v.push((false, "パソコン版 Google ドライブが見つかりませんでした。チームで共有するには必要です。".into())),
        None => v.push((false, "このパソコンでは、Google ドライブの有無を確かめられません。".into())),
    }
    v
}

/// 選んだフォルダを確かめて、設定を作る(設計メモ §9.2 の確認 3・5、§3.1 の目印)
pub fn make_config(dir: &Path, folder: &str, name: &str) -> std::result::Result<Config, String> {
    let folder = folder.trim().trim_matches('"');
    let name = name.trim();
    if folder.is_empty() {
        return Err("共有フォルダの場所を入れてください。".into());
    }
    if name.is_empty() {
        return Err("あなたの名前を入れてください。".into());
    }
    let p = PathBuf::from(folder);
    if !p.is_dir() {
        return Err(format!("フォルダ「{folder}」が見つかりませんでした。場所を確かめてください。"));
    }
    // 書き込みの権限: 試しに一時ファイルを書いて消す
    let probe = p.join(format!(".tmp-vereve-probe-{}", crate::util::random_hex(4)));
    if write_atomic(&probe, b"x").is_err() {
        return Err("このフォルダに書き込めませんでした。フォルダの管理者に「編集者」の権限を頼んでください。".into());
    }
    let _ = std::fs::remove_file(&probe);
    let old = config::load(dir).ok().flatten();
    let device_id = old.as_ref().map(|c| c.device_id.clone()).unwrap_or_else(config::new_device_id);
    let mut team_generated = false;
    let team_id = match share::read_marker(&p) {
        Ok(Some(m)) if m.format == share::SHARED_FORMAT => m.team_id,
        Ok(Some(m)) => return Err(format!("このフォルダの履歴は、このアプリと形式の版が違います(形式 {})。アプリを更新してください。", m.format)),
        Ok(None) => {
            // 目印をすぐ作る。後から設定する人は、このチーム ID に加わる(設計メモ §3.1)
            let id = config::new_team_id();
            team_generated = true;
            share::check_or_create_marker(&p, &id).map_err(|e| format!("履歴フォルダを作れませんでした: {e:#}"))?;
            id
        }
        Err(_) => return Err("このフォルダの履歴の目印(team.json)を読めませんでした。".into()),
    };
    Ok(Config { shared_folder: p, display_name: name.into(), device_id, team_id, team_generated })
}

fn setup_post(app: &Arc<App>, q: &HashMap<String, String>) -> Resp {
    if app.engine().is_some() {
        return setup_page(app, Some("共有フォルダを変えるには、アプリを終了してから設定し直してください(段階 1 では、動いている間は変えられません)。"));
    }
    match make_config(&app.dir, q.get("folder").map(|s| s.as_str()).unwrap_or(""), q.get("name").map(|s| s.as_str()).unwrap_or("")) {
        Ok(c) => {
            if let Err(e) = config::save(&app.dir, &c).and_then(|_| app.start_engine(c)) {
                return setup_page(app, Some(&format!("始められませんでした: {e:#}")));
            }
            redirect(&format!("/?{}", app.t()))
        }
        Err(m) => setup_page(app, Some(&m)),
    }
}

fn file_page(app: &Arc<App>, q: &HashMap<String, String>) -> Resp {
    let Some(e) = app.engine() else { return redirect(&format!("/setup?{}", app.t())) };
    let abs = PathBuf::from(q.get("path").cloned().unwrap_or_default());
    let Some(rel) = e.rel_of(&abs) else {
        return page(app, "対象外", "<div class=\"card notice\">このファイルは、verEve の共有フォルダの外にあるか、履歴を取らない種類のファイルです。</div>");
    };
    // 版の画面を開いたときにも、チームの版を取り込む(設計メモ §4.1)。保存したばかりの変更もここで拾う
    let _ = e.record_file(&abs);
    service::run_fetch(&e, &app.status);
    let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
    let vs = e.versions(&rel);
    let mut b = format!("<h1>{}</h1><p class=\"sub\">{}</p>", esc(&name), esc(&abs.display().to_string()));
    if let Some(m) = q.get("msg") {
        let cls = if q.get("ok").is_some() { "ok" } else { "err" };
        b.push_str(&format!("<div class=\"card {cls}\">{}</div>", esc(m)));
    }
    pending_notice(app, &mut b);
    b.push_str("<div class=\"card\"><table><tr><th>日時</th><th>だれ</th><th>内容</th><th>大きさ</th><th></th></tr>");
    if vs.is_empty() {
        b.push_str("<tr><td colspan=\"5\" class=\"muted\">まだ版はありません。ファイルを保存すると、ここに版が増えていきます。</td></tr>");
    }
    for v in &vs {
        b.push_str(&version_row(app, &e, &abs, v));
    }
    b.push_str("</table><p class=\"muted\">「この版に戻す」を押しても、いまの内容は消えません。ひとつ前の版として残り、いつでも戻せます。</p></div>");
    page(app, &name, &b)
}

fn version_row(app: &App, e: &Engine, abs: &Path, v: &VersionView) -> String {
    let mut tags = String::new();
    if v.is_current {
        tags.push_str("<span class=\"tag cur\">いまの内容</span>");
    }
    let what = match (&v.kind, &v.restored_from_time) {
        (Kind::Restore, Some(t)) => format!("{} の版に戻しました", short_time(t)),
        (Kind::Restore, None) => "過去の版に戻しました".into(),
        (Kind::Save, _) => "保存".into(),
    };
    if !v.mine {
        tags.push_str("<span class=\"tag other\">チームの人の版</span>");
    }
    if v.diverged {
        tags.push_str(&format!("<span class=\"tag warn\">{}さんが別に編集した版です</span>", esc(&v.author)));
    }
    if v.mine && !v.published {
        tags.push_str("<span class=\"tag\">まだチームに共有していません</span>");
    }
    let path_enc = enc(&abs.display().to_string());
    let restore = if v.is_current {
        String::new()
    } else {
        format!(
            "<form class=\"inline\" method=\"post\" action=\"/restore\"><input type=\"hidden\" name=\"t\" value=\"{}\"><input type=\"hidden\" name=\"path\" value=\"{}\"><input type=\"hidden\" name=\"id\" value=\"{}\"><button>この版に戻す</button></form> ",
            app.token,
            esc(&abs.display().to_string()),
            esc(&v.id)
        )
    };
    format!(
        "<tr><td>{}</td><td>{}</td><td>{}<br>{}</td><td>{}</td><td>{}<a class=\"btn\" download href=\"/download?{}&path={}&id={}\">この版を書き出す</a></td></tr>",
        esc(&local_time(&v.time)),
        esc(&who(e, if v.mine { &e.cfg.device_id } else { "" }, &v.author)),
        esc(&what),
        tags,
        esc(&size_text(v.size)),
        restore,
        app.t(),
        path_enc,
        enc(&v.id)
    )
}

fn restore_post(app: &Arc<App>, q: &HashMap<String, String>) -> Resp {
    let Some(e) = app.engine() else { return redirect(&format!("/setup?{}", app.t())) };
    let abs = PathBuf::from(q.get("path").cloned().unwrap_or_default());
    let back = |msg: &str, ok: bool| redirect(&format!("/file?{}&path={}&msg={}{}", app.t(), enc(&abs.display().to_string()), enc(msg), if ok { "&ok=1" } else { "" }));
    let Some(rel) = e.rel_of(&abs) else { return back("このファイルは対象外です。", false) };
    let id = q.get("id").cloned().unwrap_or_default();
    let time = e.get(&id).map(|r| short_time(&r.time)).unwrap_or_default();
    match e.restore(&rel, &id) {
        Ok(RestoreOutcome::Stacked { .. }) => back(&format!("{time} の版に戻しました。戻す前の内容は、ひとつ前の版として残っています。"), true),
        Ok(RestoreOutcome::Unchanged) => back("いまの内容が、その版と同じなので、何もしませんでした。", true),
        Err(err) => back(&format!("戻せませんでした: {err:#}"), false),
    }
}

fn download(app: &Arc<App>, q: &HashMap<String, String>) -> Resp {
    let Some(e) = app.engine() else { return redirect(&format!("/setup?{}", app.t())) };
    let id = q.get("id").cloned().unwrap_or_default();
    let Some(r) = e.get(&id) else { return Response::from_string("その版が見つかりません").with_status_code(404) };
    match e.materialize(&r) {
        Ok(bytes) => {
            let name = r.path.rsplit('/').next().unwrap_or("file");
            let (stem, ext) = match name.rfind('.') {
                Some(i) if i > 0 => (&name[..i], &name[i..]),
                _ => (name, ""),
            };
            let t = chrono::DateTime::parse_from_rfc3339(&r.time).map(|t| t.with_timezone(&chrono::Local).format("%Y%m%d-%H%M").to_string()).unwrap_or_default();
            let fname = format!("{stem}_{t}の版{ext}");
            Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", "application/octet-stream").unwrap())
                .with_header(content_disposition(ext, &fname))
        }
        Err(err) => Response::from_string(format!("この版を組み立て直せませんでした: {err:#}")).with_status_code(500),
    }
}

/// ダウンロードの名前。ASCII だけの予備の名前には、英数字の拡張子だけを使う(日本語や `"`・改行が入ると、
/// ヘッダーを作れずに落ちるか、ヘッダーを書き換えられるため。レビュー #2)
fn content_disposition(ext: &str, fname: &str) -> Header {
    let safe_ext: String = ext.chars().skip(1).filter(|c| c.is_ascii_alphanumeric()).take(10).collect();
    let fallback = if safe_ext.is_empty() { "version".to_string() } else { format!("version.{safe_ext}") };
    let v = format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", enc(fname));
    Header::from_bytes("Content-Disposition", v).unwrap_or_else(|_| Header::from_bytes("Content-Disposition", "attachment").unwrap())
}

fn publish_post(app: &Arc<App>) -> Resp {
    let Some(e) = app.engine() else { return redirect(&format!("/setup?{}", app.t())) };
    let mut b = String::new();
    match share::publish(&e) {
        Ok(s) => b.push_str(&format!("<div class=\"card ok\">{} 件の版を、チームに共有しました。Google ドライブの同期が終わると、チームの人に見えるようになります。</div>", s.records)),
        Err(err) => b.push_str(&format!("<div class=\"card err\">共有できませんでした: {}</div>", esc(&format!("{err:#}")))),
    }
    b.push_str(&format!("<p><a class=\"btn\" href=\"/?{}\">ホームに戻る</a></p>", app.t()));
    page(app, "チームに共有する", &b)
}
