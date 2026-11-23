#![cfg_attr(not(windows), allow(dead_code))]
//! OS ごとの部分: ブラウザを開く、裏で起動する、Windows の右クリックの項目と自動起動の登録。
//!
//! 右クリックの項目(設計メモ §7.2): 従来のメニュー `HKCU\Software\Classes\*\shell\verEve.history` に足す。
//! 管理者権限は要らない。`AppliesTo` で共有フォルダの中のファイルにだけ出す。Windows 11 では「その他のオプションを表示」の
//! 奥に出る(最初の短いメニューに出すにはパッケージの身元が要る。段階 1 では行わない。実装メモ §1)。
use std::path::{Path, PathBuf};

pub const MENU_KEY: &str = r"HKCU\Software\Classes\*\shell\verEve.history";
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const MENU_TEXT: &str = "過去のバージョンを確認";

/// `\\?\C:\…` を `C:\…` に戻す(canonicalize の結果を、画面や登録に使うため)
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

/// `AppliesTo` の条件: 共有フォルダの中のパス(前方一致)。値の書き方は Windows の検索の構文(AQS)。【実機で未確認】
pub fn applies_to(shared: &Path) -> String {
    let mut s = strip_verbatim(shared).display().to_string();
    if !s.ends_with('\\') {
        s.push('\\');
    }
    format!("System.ItemPathDisplay:~<\"{}\"", s.replace('"', ""))
}

pub fn open_browser(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    r.map(|_| ()).map_err(|e| anyhow::anyhow!("ブラウザを開けませんでした: {e}。次の URL を開いてください: {url}"))
}

pub fn spawn_detached(exe: &Path, args: &[&str]) -> anyhow::Result<()> {
    let mut c = std::process::Command::new(exe);
    c.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    c.spawn()?;
    Ok(())
}

#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn AttachConsole(pid: u32) -> i32;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, typ: u32) -> i32;
    }
}

/// Windows では画面を持たない exe にしてあるので、コマンドプロンプトから起動されたときだけ、その窓に出力をつなぐ
pub fn attach_console() {
    #[cfg(windows)]
    unsafe {
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        sys::AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

pub fn report_error(msg: &str) {
    eprintln!("verEve: {msg}");
    #[cfg(windows)]
    {
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (t, c) = (w(msg), w("verEve"));
        unsafe {
            sys::MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), 0x10);
        }
    }
}

#[cfg(windows)]
fn reg(args: &[&str]) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;
    let st = std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).status()?;
    anyhow::ensure!(st.success(), "登録情報を書き換えられませんでした(reg {})", args.first().unwrap_or(&""));
    Ok(())
}

/// 利用者単位で入れる: exe を利用者の領域へ写し、右クリックの項目と、ログオン時の自動起動を登録する
pub fn install() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let dir = engine::config::data_dir();
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin)?;
        let me = std::env::current_exe()?;
        let target = bin.join("vereve-desk.exe");
        if me != target {
            std::fs::copy(&me, &target)?;
        }
        let exe = target.display().to_string();
        let cmd = format!("\"{exe}\" show \"%1\"");
        reg(&["add", MENU_KEY, "/ve", "/d", MENU_TEXT, "/f"])?;
        reg(&["add", MENU_KEY, "/v", "MUIVerb", "/d", MENU_TEXT, "/f"])?;
        reg(&["add", MENU_KEY, "/v", "Icon", "/d", &exe, "/f"])?;
        if let Some(c) = engine::config::load(&dir)? {
            reg(&["add", MENU_KEY, "/v", "AppliesTo", "/d", &applies_to(&c.shared_folder), "/f"])?;
        }
        reg(&["add", &format!(r"{MENU_KEY}\command"), "/ve", "/d", &cmd, "/f"])?;
        reg(&["add", RUN_KEY, "/v", "verEveDesk", "/d", &format!("\"{exe}\" run --background"), "/f"])?;
        spawn_detached(&target, &["open"])?;
        println!("入れました: {exe}");
        Ok(())
    }
    #[cfg(not(windows))]
    anyhow::bail!("install は Windows 用です。ほかの OS では `vereve-desk run` を自動起動に登録してください")
}

pub fn uninstall() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let _ = reg(&["delete", MENU_KEY, "/f"]);
        let _ = reg(&["delete", RUN_KEY, "/v", "verEveDesk", "/f"]);
        println!("右クリックの項目と自動起動を外しました。履歴は {} に残っています", engine::config::data_dir().display());
        Ok(())
    }
    #[cfg(not(windows))]
    anyhow::bail!("uninstall は Windows 用です")
}
