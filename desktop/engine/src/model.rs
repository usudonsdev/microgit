//! 版の記録の形式(段階 1、形式の番号 1)。
//!
//! 1 つの記録は、1 つのファイルの 1 つの版である(実装メモ §1: フォルダの木ではなく、ファイルごと)。
//! 記録の `id` は、中身の持ち方(全体か、ZIP を分けた形か)に依らない値から決める。そのため、Publish する前なら、
//! 裏で ZIP を分けた形に置き換えても `id` は変わらない。Publish した後は、記録を書き換えない(設計メモ §5)。
use serde::{Deserialize, Serialize};

pub const RECORD_FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// 利用者の保存(監視が拾ったもの)
    Save,
    /// 過去の版を同じファイルに重ねたもの(設計メモ §7.1)
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    /// ファイル全体を内容で分割したチャンクの並び
    Whole { chunks: Vec<String> },
    /// ZIP の文書を、骨組み・部品の中身・preflate の補正データに分けたもの(preflate メモ §5)
    Zip {
        preflate: String,
        format: u32,
        skeleton: Vec<String>,
        offsets: Vec<u64>,
        parts: Vec<ZipPart>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZipPart {
    pub name: String,
    /// "preflate" | "stored" | "raw"
    pub mode: String,
    pub data: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub corrections: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub format: u32,
    pub id: String,
    pub device: String,
    pub author: String,
    pub seq: u64,
    /// 共有フォルダからの相対パス(区切りは `/`)
    pub path: String,
    /// RFC 3339(UTC)
    pub time: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_from: Option<String>,
    /// この端末が記録したときに知っていた、同じファイルの最新の版。分岐の見分けに使う(設計メモ §7.3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub size: u64,
    /// ファイル全体の SHA-256。戻すときに必ず照らす(preflate メモ §4 の 6)
    pub sha256: String,
    pub content: Content,
}

impl Record {
    /// `id` を決める値。中身の持ち方は含めない
    pub fn compute_id(&self) -> String {
        let key = serde_json::json!({
            "format": self.format, "device": self.device, "seq": self.seq, "path": self.path,
            "time": self.time, "kind": self.kind, "restored_from": self.restored_from,
            "parent": self.parent, "size": self.size, "sha256": self.sha256,
        });
        crate::util::sha256_hex(key.to_string().as_bytes())
    }

    pub fn chunk_ids(&self) -> Vec<String> {
        match &self.content {
            Content::Whole { chunks } => chunks.clone(),
            Content::Zip { skeleton, parts, .. } => {
                let mut v = skeleton.clone();
                for p in parts {
                    v.extend(p.data.iter().cloned());
                    v.extend(p.corrections.iter().cloned());
                }
                v
            }
        }
    }

    /// 記録のファイル名: `<連番 8 桁>-<id>.json`。Fetch はこの形の名前だけを読む(一時名や競合コピーは無視)
    pub fn file_name(&self) -> String {
        format!("{:08}-{}.json", self.seq, self.id)
    }
}

/// 記録のファイル名として正しいか(`00000012-<64 桁>.json`)
pub fn is_record_file_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 8 + 1 + 64 + 5
        && b[..8].iter().all(|c| c.is_ascii_digit())
        && b[8] == b'-'
        && b[9..73].iter().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && name.ends_with(".json")
}
