//! 内容アドレス型のチャンク置き場。ローカルの履歴ストアと、共有フォルダの履歴フォルダの両方で同じ形を使う。
//!
//! チャンクの名前は、**圧縮する前の中身**の SHA-256。ファイルの中身は zstd で圧縮したもの。
//! 読むときは、展開してハッシュを照らす。合わないチャンクは壊れているとみなす(設計メモ §4 の表)。
use crate::util::{sha256_hex, write_atomic};
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub const AVG_CHUNK: usize = 8192; // 計測メモ §3.3: 8 KB 前後がよい

#[derive(Clone, Debug)]
pub struct ChunkStore {
    pub root: PathBuf,
}

impl ChunkStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn path_of(&self, id: &str) -> PathBuf {
        self.root.join(&id[..2]).join(id)
    }

    pub fn has(&self, id: &str) -> bool {
        self.path_of(id).is_file()
    }

    /// 圧縮したままのバイト列(共有フォルダへの写しに使う)
    pub fn read_raw(&self, id: &str) -> Result<Vec<u8>> {
        fs::read(self.path_of(id)).with_context(|| format!("チャンク {id} が読めない"))
    }

    pub fn get(&self, id: &str) -> Result<Vec<u8>> {
        let raw = self.read_raw(id)?;
        decode_verify(id, &raw)
    }

    pub fn put(&self, data: &[u8]) -> Result<String> {
        let id = sha256_hex(data);
        if !self.has(&id) {
            let z = zstd::encode_all(data, 3)?;
            write_atomic(&self.path_of(&id), &z)?;
        }
        Ok(id)
    }

    /// 他の置き場から、圧縮したままのチャンクを、中身を確かめてから入れる
    pub fn put_raw_verified(&self, id: &str, raw: &[u8]) -> Result<()> {
        decode_verify(id, raw)?;
        if !self.has(id) {
            write_atomic(&self.path_of(id), raw)?;
        }
        Ok(())
    }

    /// 内容で分割して入れる。空のデータは、チャンク 0 個
    pub fn put_chunked(&self, data: &[u8]) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for c in fastcdc::v2020::FastCDC::new(data, AVG_CHUNK / 4, AVG_CHUNK, AVG_CHUNK * 8) {
            ids.push(self.put(&data[c.offset..c.offset + c.length])?);
        }
        Ok(ids)
    }

    pub fn get_concat(&self, ids: &[String]) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        for id in ids {
            out.extend_from_slice(&self.get(id)?);
        }
        Ok(out)
    }
}

pub fn decode_verify(id: &str, raw: &[u8]) -> Result<Vec<u8>> {
    let d = zstd::decode_all(raw).map_err(|e| anyhow!("チャンク {id} を展開できない: {e}"))?;
    if sha256_hex(&d) != id {
        return Err(anyhow!("チャンク {id} の中身がハッシュと合わない"));
    }
    Ok(d)
}

pub fn ensure_dir(p: &Path) -> Result<()> {
    fs::create_dir_all(p).with_context(|| format!("フォルダ {} を作れない", p.display()))
}
