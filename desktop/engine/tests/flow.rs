//! 履歴エンジンの結合試験。2 台の端末を、別々のデータの置き場と、同じ共有フォルダで模擬する
//! (Drive for desktop の同期の代わりに、同じフォルダを直接読み書きする)。
use engine::config::Config;
use engine::engine::{Engine, RestoreOutcome};
use engine::model::{Content, Kind};
use engine::share::{self, HISTORY_DIR};
use std::fs;
use std::path::{Path, PathBuf};

struct Env {
    _tmp: tempfile::TempDir,
    shared: PathBuf,
    a_dir: PathBuf,
    b_dir: PathBuf,
}

fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let shared = t.path().join("共有フォルダ");
    fs::create_dir_all(&shared).unwrap();
    let a_dir = t.path().join("a");
    let b_dir = t.path().join("b");
    Env { shared, a_dir, b_dir, _tmp: t }
}

fn cfg(shared: &Path, name: &str, dev: &str, team: &str) -> Config {
    Config { shared_folder: shared.to_path_buf(), display_name: name.into(), device_id: dev.into(), team_id: team.into(), team_generated: false }
}

fn cfg_generated(shared: &Path, name: &str, dev: &str, team: &str) -> Config {
    Config { team_generated: true, ..cfg(shared, name, dev, team) }
}

fn write(p: &Path, b: &[u8]) {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).unwrap();
    }
    fs::write(p, b).unwrap();
}

fn fixture(name: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}

#[test]
fn saves_are_recorded_once_per_content() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let f = v.shared.join("資料").join("メモ.txt");
    write(&f, b"one");
    assert!(a.record_file(&f).unwrap().is_some());
    assert!(a.record_file(&f).unwrap().is_none(), "同じ中身は記録しない");
    write(&f, b"two");
    assert!(a.record_file(&f).unwrap().is_some());
    let vs = a.versions("資料/メモ.txt");
    assert_eq!(vs.len(), 2);
    assert!(vs[0].is_current && vs[0].mine && !vs[0].published);
    assert_eq!(a.unpublished_count(), 2);
}

#[test]
fn ignored_files_and_outside_files_are_not_recorded() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    for name in ["~$報告書.docx", ".~lock.a.xlsx#", "a.tmp", "desktop.ini"] {
        let f = v.shared.join(name);
        write(&f, b"x");
        assert!(a.record_file(&f).unwrap().is_none(), "{name} は記録しない");
    }
    let h = v.shared.join(HISTORY_DIR).join("x.txt");
    write(&h, b"x");
    assert!(a.record_file(&h).unwrap().is_none());
    let outside = v.a_dir.join("外.txt");
    write(&outside, b"x");
    assert!(a.record_file(&outside).unwrap().is_none());
}

#[test]
fn restore_stacks_a_new_version_and_keeps_current() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let f = v.shared.join("報告書.txt");
    write(&f, b"v1");
    let r1 = a.record_file(&f).unwrap().unwrap();
    write(&f, b"v2");
    a.record_file(&f).unwrap().unwrap();
    // 監視が拾う前に、利用者がさらに書き換えた(v3 は履歴に無い)
    write(&f, b"v3-not-recorded");
    let out = a.restore("報告書.txt", &r1.id).unwrap();
    let RestoreOutcome::Stacked { saved_current, .. } = out else { panic!("{out:?}") };
    assert!(saved_current, "いまの中身を先に記録する");
    assert_eq!(fs::read(&f).unwrap(), b"v1");
    let vs = a.versions("報告書.txt");
    assert_eq!(vs.len(), 4, "v1, v2, v3, 戻した版");
    assert_eq!(vs[0].kind, Kind::Restore);
    assert!(vs[0].restored_from_time.is_some());
    // 戻した後に監視が同じ中身を拾っても、版を増やさない
    assert!(a.record_file(&f).unwrap().is_none());
    // 同じ版にもう一度戻すと、何もしない
    assert_eq!(a.restore("報告書.txt", &r1.id).unwrap(), RestoreOutcome::Unchanged);
    // v3 にも戻せる(消えていない)
    let v3 = vs.iter().find(|x| x.size == 15).unwrap().id.clone();
    a.restore("報告書.txt", &v3).unwrap();
    assert_eq!(fs::read(&f).unwrap(), b"v3-not-recorded");
}

#[test]
fn restore_rejects_version_of_another_file() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let f1 = v.shared.join("a.txt");
    let f2 = v.shared.join("b.txt");
    write(&f1, b"a");
    write(&f2, b"b");
    let r = a.record_file(&f1).unwrap().unwrap();
    a.record_file(&f2).unwrap();
    assert!(a.restore("b.txt", &r.id).is_err());
    assert_eq!(fs::read(&f2).unwrap(), b"b");
}

#[test]
fn office_files_are_split_in_background_and_restore_byte_exact() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    for name in ["sample.xlsx", "sample.docx"] {
        let bytes = fixture(name);
        let f = v.shared.join(name);
        write(&f, &bytes);
        a.record_file(&f).unwrap().unwrap();
    }
    assert_eq!(a.convert_pending().unwrap(), 2);
    for name in ["sample.xlsx", "sample.docx"] {
        let r = a.latest(name).unwrap();
        assert!(matches!(r.content, Content::Zip { .. }), "{name} は分けた形になる");
        assert_eq!(a.materialize(&r).unwrap(), fixture(name), "{name} は元のバイト列に戻る");
    }
    // 再起動しても読める
    drop(a);
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let r = a.latest("sample.docx").unwrap();
    assert_eq!(a.materialize(&r).unwrap(), fixture("sample.docx"));
}

#[test]
fn publish_and_fetch_between_two_devices() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("見積.xlsx");
    write(&f, &fixture("sample.xlsx"));
    let r = a.record_file(&f).unwrap().unwrap();
    // まだ出していないので、B には見えない
    assert_eq!(share::fetch(&b).unwrap().imported, 0);
    let s = share::publish(&a).unwrap();
    assert_eq!(s.records, 1);
    assert_eq!(a.unpublished_count(), 0);
    let got = share::fetch(&b).unwrap();
    assert_eq!(got.imported, 1);
    let vs = b.versions("見積.xlsx");
    assert_eq!(vs.len(), 1);
    assert!(!vs[0].mine);
    assert_eq!(vs[0].author, "佐藤");
    assert_eq!(b.materialize(&b.get(&r.id).unwrap()).unwrap(), fixture("sample.xlsx"));
    // Drive が本文を B に届けて、B の監視が拾っても、同じ中身なので新しい版を作らない(設計メモ §4 の表)
    assert!(b.record_file(&f).unwrap().is_none());
    // 2 回目の取り込みは何もしない
    assert_eq!(share::fetch(&b).unwrap(), share::FetchSummary::default());
    assert_eq!(share::members(&v.shared).get("aaaa").map(|s| s.as_str()), Some("佐藤"));
}

#[test]
fn fetch_waits_for_chunks_that_have_not_arrived() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, &vec![7u8; 50_000]);
    let r = a.record_file(&f).unwrap().unwrap();
    share::publish(&a).unwrap();
    // 記録だけが先に届いた状態を作る: チャンクを 1 つ隠す
    let chunk = r.chunk_ids()[0].clone();
    let p = v.shared.join(HISTORY_DIR).join("chunks").join(&chunk[..2]).join(&chunk);
    let hidden = p.with_extension("hidden");
    fs::rename(&p, &hidden).unwrap();
    let s = share::fetch(&b).unwrap();
    assert_eq!((s.imported, s.pending), (0, 1), "保留にして取り込まない");
    fs::rename(&hidden, &p).unwrap();
    assert_eq!(share::fetch(&b).unwrap().imported, 1, "届いたら取り込む");
}

#[test]
fn fetch_ignores_temp_and_conflict_copies_and_rejects_corruption() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"hello world");
    let r = a.record_file(&f).unwrap().unwrap();
    share::publish(&a).unwrap();
    let log = v.shared.join(HISTORY_DIR).join("log").join("aaaa");
    let rec = fs::read(log.join(r.file_name())).unwrap();
    write(&log.join(format!(".tmp-123-{}", r.file_name())), &rec);
    write(&log.join(format!("{:08}-{} (1).json", r.seq, r.id)), &rec);
    // 中身を書き換えた偽の記録(id が合わない)
    let mut fake: serde_json::Value = serde_json::from_slice(&rec).unwrap();
    fake["path"] = serde_json::json!("../外.txt");
    let fake_id = "f".repeat(64);
    fake["id"] = serde_json::json!(fake_id);
    write(&log.join(format!("00000099-{fake_id}.json")), serde_json::to_string(&fake).unwrap().as_bytes());
    let s = share::fetch(&b).unwrap();
    assert_eq!(s.imported, 1);
    assert_eq!(s.rejected, 1);
    assert_eq!(b.versions("a.txt").len(), 1);
    // チャンクが壊れていたら、取り込まずに保留にする
    let c = Engine::open(cfg(&v.shared, "高橋", "cccc", "team1"), &v.shared.parent().unwrap().join("c")).unwrap();
    let chunk = r.chunk_ids()[0].clone();
    write(&v.shared.join(HISTORY_DIR).join("chunks").join(&chunk[..2]).join(&chunk), b"broken");
    let s = share::fetch(&c).unwrap();
    assert_eq!((s.imported, s.pending), (0, 1));
}

#[test]
fn other_team_folder_is_refused() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let x = Engine::open(cfg(&v.shared, "他", "xxxx", "team2"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"a");
    a.record_file(&f).unwrap();
    share::publish(&a).unwrap();
    x.record_file(&f).unwrap();
    assert!(share::publish(&x).is_err(), "チーム ID が違うフォルダには書かない");
    assert!(share::fetch(&x).is_err());
    assert!(!v.shared.join(HISTORY_DIR).join("log").join("xxxx").exists());
}

#[test]
fn diverged_edits_are_shown_side_by_side() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"base");
    a.record_file(&f).unwrap();
    share::publish(&a).unwrap();
    share::fetch(&b).unwrap();
    // 2 人が、互いの版を知らずに編集する
    write(&f, b"A edit");
    a.record_file(&f).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    write(&f, b"B edit");
    b.record_file(&f).unwrap();
    share::publish(&a).unwrap();
    share::publish(&b).unwrap();
    share::fetch(&a).unwrap();
    share::fetch(&b).unwrap();
    let va = a.versions("a.txt");
    let vb = b.versions("a.txt");
    assert_eq!(va.len(), 3);
    assert_eq!(va.iter().map(|x| &x.id).collect::<Vec<_>>(), vb.iter().map(|x| &x.id).collect::<Vec<_>>(), "どちらの端末でも同じ並び");
    assert!(va[0].diverged, "後から記録された方に「別に編集した版」の印が付く");
    assert_eq!(va[0].author, "鈴木");
}

#[test]
fn published_records_are_never_rewritten() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let f = v.shared.join("x.xlsx");
    write(&f, &fixture("sample.xlsx"));
    let r = a.record_file(&f).unwrap().unwrap();
    share::publish(&a).unwrap(); // Publish の前に分けた形にする
    let pubd = fs::read(v.shared.join(HISTORY_DIR).join("log").join("aaaa").join(r.file_name())).unwrap();
    assert_eq!(a.convert_pending().unwrap(), 0);
    let rec: engine::model::Record = serde_json::from_slice(&pubd).unwrap();
    assert!(matches!(rec.content, Content::Zip { .. }));
    assert_eq!(rec.id, r.id, "分けても id は変わらない");
}

#[test]
fn reopen_keeps_sequence_and_published_state() {
    let v = env();
    {
        let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
        let f = v.shared.join("a.txt");
        write(&f, b"1");
        a.record_file(&f).unwrap();
        share::publish(&a).unwrap();
        write(&f, b"2");
        a.record_file(&f).unwrap();
    }
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    assert_eq!(a.unpublished_count(), 1);
    let f = v.shared.join("a.txt");
    write(&f, b"3");
    let r = a.record_file(&f).unwrap().unwrap();
    assert_eq!(r.seq, 3);
}

#[test]
fn two_people_who_set_up_before_any_publish_join_one_team() {
    let v = env();
    // 2 人とも、目印が無いときに設定した(別々のチーム ID)。先に出した人のチームに、もう 1 人が加わる
    let a = Engine::open(cfg_generated(&v.shared, "佐藤", "aaaa", "teamA"), &v.a_dir).unwrap();
    let b = Engine::open(cfg_generated(&v.shared, "鈴木", "bbbb", "teamB"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"a");
    a.record_file(&f).unwrap();
    share::publish(&a).unwrap();
    write(&f, b"b");
    b.record_file(&f).unwrap();
    share::publish(&b).unwrap();
    assert_eq!(b.team_id(), "teamA");
    assert_eq!(share::fetch(&a).unwrap().imported, 1);
    assert_eq!(engine::config::load(&v.b_dir).unwrap().unwrap().team_id, "teamA", "設定にも書く");
}

#[test]
fn body_delivered_before_history_does_not_leave_a_duplicate_version() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"from A");
    a.record_file(&f).unwrap();
    // Drive が本文だけを先に B に届け、B の監視が拾った
    let echo = b.record_file(&f).unwrap().unwrap();
    assert_eq!(b.unpublished_count(), 1);
    share::publish(&a).unwrap();
    share::fetch(&b).unwrap();
    let vs = b.versions("a.txt");
    assert_eq!(vs.len(), 1, "写しは消え、佐藤さんの版だけが残る");
    assert_eq!(vs[0].author, "佐藤");
    assert!(b.get(&echo.id).is_none());
    assert_eq!(b.unpublished_count(), 0);
}

#[test]
fn current_version_follows_disk_content_and_unreadable_record_does_not_block_publish() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"x");
    b.record_file(&f).unwrap();
    share::publish(&b).unwrap();
    share::fetch(&a).unwrap();
    write(&f, b"y");
    a.record_file(&f).unwrap();
    // 鈴木さんの版と同じ中身に戻した: 自分の保存として記録し、「いまの内容」はその版になる(レビュー #4)
    write(&f, b"x");
    assert!(a.record_file(&f).unwrap().is_some());
    let vs = a.versions("a.txt");
    assert!(vs[0].is_current);
    assert!(!vs.iter().find(|x| x.size == 1 && x.mine && vs.iter().position(|y| y.id == x.id) == Some(1)).map(|x| x.is_current).unwrap_or(false));
    // y の版は「いまの内容」ではないので、戻せる
    let y = vs.iter().find(|x| x.mine && !x.is_current).unwrap().id.clone();
    a.restore("a.txt", &y).unwrap();
    assert_eq!(fs::read(&f).unwrap(), b"y");
    // 自分のチャンクが 1 つ壊れても、Publish は止まらない(レビュー #5)
    let g = v.shared.join("b.xlsx");
    write(&g, &fixture("sample.xlsx"));
    let r = a.record_file(&g).unwrap().unwrap();
    let st = engine::config::store_dir(&v.a_dir, &v.shared).join("chunks");
    let c = r.chunk_ids()[0].clone();
    fs::write(st.join(&c[..2]).join(&c), b"broken").unwrap();
    assert!(a.convert_pending().is_ok());
}

#[test]
fn records_pointing_into_history_folder_are_rejected() {
    let v = env();
    let a = Engine::open(cfg(&v.shared, "佐藤", "aaaa", "team1"), &v.a_dir).unwrap();
    let b = Engine::open(cfg(&v.shared, "鈴木", "bbbb", "team1"), &v.b_dir).unwrap();
    let f = v.shared.join("a.txt");
    write(&f, b"x");
    a.record_file(&f).unwrap();
    share::publish(&a).unwrap();
    for bad in [".microgit-history/team.json", "C:/x.txt", "a\r\nb.txt"] {
        assert!(!engine::util::is_safe_rel(bad), "{bad:?}");
    }
    assert!(engine::util::is_safe_rel("営業部/見積.xlsx"));
    assert_eq!(share::fetch(&b).unwrap().imported, 1);
}
