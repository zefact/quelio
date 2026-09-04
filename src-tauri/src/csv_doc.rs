//! 開いているCSVを保持する。
//!
//! 全行はここ (Rust側) に置き、画面へはページ単位でしか渡さない。
//! 編集も「セルを直す」「行を足す」といった操作として受け取り、
//! 取り消しの履歴もここで持つ。
//!
//! こうしているのは、10万行のCSVを画面側に丸ごと持たせると
//! メモリも描画も持たないため。既存のクエリ結果と同じ考え方

pub mod edit;
pub mod find;
pub mod fixed;
pub mod format;
pub mod io;
pub mod nav;
pub mod sink;
pub mod summary;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use edit::{Edit, Sheet};
use format::{CsvFormat, Newline, Quoting};

/// 取り消しの履歴を持つ上限。
///
/// 際限なく持つと、大きなCSVで列を消すたびに全行の控えが積み上がる
const UNDO_LIMIT: usize = 1000;

/// 画面へ返すファイルの状態
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvInfo {
    pub doc_id: String,
    /// タブに出す名前
    pub name: String,
    /// 保存先 (まだ保存していなければ None)
    pub path: Option<String>,
    pub format: CsvFormat,
    /// 1行目をヘッダとして扱っているか
    pub has_header: bool,
    /// 列名 (ヘッダとして扱っていなければ "1", "2", …)
    pub columns: Vec<String>,
    pub row_count: usize,
    /// 保存していない編集があるか
    pub dirty: bool,
    /// 行によって列数が違っていたか (足りない分は空欄で埋めてある)
    pub ragged: bool,
    /// 文字コードの変換で置き換えが起きたか (文字化けの疑い)
    pub replaced: bool,
    /// 取り消せる操作の名前 (無ければ None)
    pub undo_label: Option<String>,
    /// やり直せる操作の名前 (無ければ None)
    pub redo_label: Option<String>,
}

/// 画面へ返す1ページ
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPage {
    pub offset: usize,
    pub rows: Vec<Vec<String>>,
    /// 全体の行数 (スクロールバーの長さに使う)
    pub total: usize,
}

/// 開いているCSV1つ
pub struct CsvDoc {
    pub path: Option<PathBuf>,
    pub name: String,
    pub format: CsvFormat,
    pub has_header: bool,
    /// 列名 (ヘッダとして扱っていないときは "1", "2", …)
    pub header: Vec<String>,
    /// データ行 (ヘッダは含まない)
    pub rows: Vec<Vec<String>>,
    pub dirty: bool,
    pub ragged: bool,
    pub replaced: bool,
    /// 開いた (保存した) 時点のファイルの更新時刻。外部での書き換えに気づくために持つ
    pub mtime: Option<u64>,
    undo: Vec<Edit>,
    redo: Vec<Edit>,
}

/// ヘッダとして扱わないときの列名 ("1" 始まりの連番)
/// タブに出すファイル名 (取れなければ「CSV」)
fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "CSV".to_string())
}

fn numbered(width: usize) -> Vec<String> {
    (1..=width).map(|i| i.to_string()).collect()
}

impl CsvDoc {
    /// バイト列から作る (ファイル・D&D・貼り付けのどれでも通る入口)
    pub fn from_bytes(
        name: &str,
        bytes: &[u8],
        forced_encoding: Option<&str>,
    ) -> Result<CsvDoc, String> {
        let loaded = io::load(bytes, forced_encoding)?;
        let mut rows = loaded.rows;
        // 1行目をヘッダとして扱う。空のファイルは1列だけの空表にする
        let header = if rows.is_empty() {
            vec!["1".to_string()]
        } else {
            rows.remove(0)
        };
        Ok(CsvDoc {
            path: None,
            name: name.to_string(),
            format: loaded.format,
            has_header: true,
            header,
            rows,
            dirty: false,
            ragged: loaded.ragged,
            replaced: loaded.replaced,
            mtime: None,
            undo: Vec::new(),
            redo: Vec::new(),
        })
    }

    /**
     * バイト列を固定長として読む。
     *
     * 固定長のファイルには見出しの行が無いのが普通なので、
     * 1行目はデータとして扱う (レイアウトに項目名があればそれを列名にする)
     */
    pub fn from_bytes_fixed(
        name: &str,
        bytes: &[u8],
        forced_encoding: Option<&str>,
        unit: fixed::WidthUnit,
        reading: fixed::Reading,
    ) -> Result<CsvDoc, String> {
        let loaded = io::load_fixed(bytes, forced_encoding, unit, reading)?;
        let width = loaded
            .format
            .fixed
            .as_ref()
            .map(|l| l.columns.len())
            .unwrap_or(1)
            .max(1);
        Ok(CsvDoc {
            path: None,
            name: name.to_string(),
            format: loaded.format,
            // 固定長は見出しの行を持たないのが普通
            has_header: false,
            header: numbered(width),
            rows: loaded.rows,
            dirty: false,
            ragged: loaded.ragged,
            replaced: loaded.replaced,
            mtime: None,
            undo: Vec::new(),
            redo: Vec::new(),
        })
    }

    /// ファイルを固定長として開く
    pub fn open_fixed(
        path: &Path,
        forced_encoding: Option<&str>,
        unit: fixed::WidthUnit,
        reading: fixed::Reading,
    ) -> Result<CsvDoc, String> {
        let bytes = io::read_file(path)?;
        let mut doc =
            CsvDoc::from_bytes_fixed(&file_label(path), &bytes, forced_encoding, unit, reading)?;
        doc.path = Some(path.to_path_buf());
        doc.mtime = io::mtime(path);
        Ok(doc)
    }

    /// ファイルを開く
    pub fn open(path: &Path, forced_encoding: Option<&str>) -> Result<CsvDoc, String> {
        let bytes = io::read_file(path)?;
        let mut doc = CsvDoc::from_bytes(&file_label(path), &bytes, forced_encoding)?;
        doc.path = Some(path.to_path_buf());
        doc.mtime = io::mtime(path);
        Ok(doc)
    }

    /// まだ保存していない表を作る (クエリ結果から開く・新規作成)
    pub fn from_rows(name: &str, header: Vec<String>, rows: Vec<Vec<String>>) -> CsvDoc {
        let header = if header.is_empty() {
            vec!["1".to_string()]
        } else {
            header
        };
        let w = header.len();
        let rows = rows
            .into_iter()
            .map(|mut r| {
                r.resize(w, String::new());
                r
            })
            .collect();
        CsvDoc {
            path: None,
            name: name.to_string(),
            format: CsvFormat {
                encoding: "UTF-8".to_string(),
                bom: false,
                newline: if cfg!(windows) {
                    Newline::Crlf
                } else {
                    Newline::Lf
                },
                delimiter: ',',
                quoting: Quoting::Necessary,
                fixed: None,
            },
            has_header: true,
            header,
            rows,
            // 保存しないと残らないので、最初から「未保存」にしておく
            dirty: true,
            ragged: false,
            replaced: false,
            mtime: None,
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    /// 画面に出す列名
    pub fn columns(&self) -> Vec<String> {
        if self.has_header {
            return self.header.clone();
        }
        let mut out = numbered(self.header.len());
        // 固定長は見出しの行を持たないので、レイアウトに付けた項目名を使う
        if let Some(layout) = &self.format.fixed {
            for (at, name) in layout.names().iter().enumerate() {
                if !name.is_empty() {
                    if let Some(slot) = out.get_mut(at) {
                        *slot = name.clone();
                    }
                }
            }
        }
        out
    }

    pub fn info(&self, doc_id: &str) -> CsvInfo {
        CsvInfo {
            doc_id: doc_id.to_string(),
            name: self.name.clone(),
            path: self.path.as_ref().map(|p| p.to_string_lossy().to_string()),
            format: self.format.clone(),
            has_header: self.has_header,
            columns: self.columns(),
            row_count: self.rows.len(),
            dirty: self.dirty,
            ragged: self.ragged,
            replaced: self.replaced,
            undo_label: self.undo.last().map(|e| e.label().to_string()),
            redo_label: self.redo.last().map(|e| e.label().to_string()),
        }
    }

    /// 1ページぶんの行を返す
    pub fn page(&self, offset: usize, limit: usize) -> CsvPage {
        let end = offset.saturating_add(limit).min(self.rows.len());
        let rows = if offset >= self.rows.len() {
            Vec::new()
        } else {
            self.rows[offset..end].to_vec()
        };
        CsvPage {
            offset,
            rows,
            total: self.rows.len(),
        }
    }

    /// 編集操作を組み立てるための入り口 (コマンド層からも使う)
    pub fn sheet(&mut self) -> Sheet<'_> {
        Sheet {
            header: &mut self.header,
            rows: &mut self.rows,
        }
    }

    /// 操作を適用し、取り消せるように控える
    pub fn apply(&mut self, e: Edit) -> Result<(), String> {
        self.sheet().apply(&e)?;
        self.undo.push(e);
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        // 新しく編集したら、やり直しの先は無くなる
        self.redo.clear();
        self.dirty = true;
        Ok(())
    }

    /// 直前の操作を取り消す。戻したものの名前を返す
    pub fn undo(&mut self) -> Result<Option<String>, String> {
        let Some(e) = self.undo.pop() else {
            return Ok(None);
        };
        let back = e.invert();
        if let Err(err) = self.sheet().apply(&back) {
            // 戻せなかったら履歴も戻して、状態を変えないままにする
            self.undo.push(e);
            return Err(err);
        }
        let label = e.label().to_string();
        self.redo.push(e);
        self.dirty = true;
        Ok(Some(label))
    }

    /// 取り消したものをやり直す
    pub fn redo(&mut self) -> Result<Option<String>, String> {
        let Some(e) = self.redo.pop() else {
            return Ok(None);
        };
        if let Err(err) = self.sheet().apply(&e) {
            self.redo.push(e);
            return Err(err);
        }
        let label = e.label().to_string();
        self.undo.push(e);
        self.dirty = true;
        Ok(Some(label))
    }

    /// 1行目をヘッダとして扱うかを切り替える
    pub fn set_has_header(&mut self, on: bool) {
        if self.has_header == on {
            return;
        }
        if on {
            // 先頭の行をヘッダへ持ち上げる
            if self.rows.is_empty() {
                self.has_header = true;
                return;
            }
            self.header = self.rows.remove(0);
        } else {
            // ヘッダを本文へ戻し、列名は連番にする
            let w = self.header.len();
            let head = std::mem::replace(&mut self.header, numbered(w));
            self.rows.insert(0, head);
        }
        self.has_header = on;
        self.dirty = true;
        // 行の位置がずれるので、取り消しの履歴は続けられない
        self.undo.clear();
        self.redo.clear();
    }

    /// 保存するバイト列を組み立てる
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        let mut all: Vec<Vec<String>> = Vec::with_capacity(self.rows.len() + 1);
        if self.has_header {
            all.push(self.header.clone());
        }
        all.extend(self.rows.iter().cloned());
        io::dump(&all, &self.format)
    }

    /// 開いた (前回保存した) あとに、外部でファイルが書き換えられているか
    pub fn changed_outside(&self) -> bool {
        let Some(path) = &self.path else {
            return false;
        };
        match (self.mtime, io::mtime(path)) {
            (Some(a), Some(b)) => a != b,
            // 開いたときに時刻が取れなかった場合は、判定しない
            _ => false,
        }
    }

    /// 保存する。`to` を渡すと別名保存になる
    pub fn save(&mut self, to: Option<&Path>) -> Result<(), String> {
        let path = match to {
            Some(p) => p.to_path_buf(),
            None => self
                .path
                .clone()
                .ok_or_else(|| "保存先が決まっていません".to_string())?,
        };
        let bytes = self.to_bytes()?;
        io::save_atomic(&path, &bytes)?;
        if let Some(name) = path.file_name() {
            self.name = name.to_string_lossy().to_string();
        }
        self.mtime = io::mtime(&path);
        self.path = Some(path);
        self.dirty = false;
        Ok(())
    }
}

/// 直近の比較結果 (画面がページごとに引きに来る)
pub struct StoredDiff {
    pub left_id: String,
    pub right_id: String,
    pub result: crate::csv_diff::DiffResult,
}

/// 開いているCSVをまとめて持つ入れ物 (Tauriの State に入れる)
#[derive(Default)]
pub struct CsvDocuments {
    docs: Mutex<HashMap<String, CsvDoc>>,
    /// doc_id の採番
    next: Mutex<u64>,
    /**
     * 直近の比較結果。
     *
     * 10万行の差分を画面へ丸ごと渡して、ページのたびに送り返させるのは重い。
     * 結果はここに置いておき、画面は見えている範囲だけを取りに来る
     */
    diff: Mutex<Option<StoredDiff>>,
}

impl CsvDocuments {
    /// 新しく開いたドキュメントを預かり、doc_id を返す
    pub fn insert(&self, doc: CsvDoc) -> Result<String, String> {
        let id = {
            let mut n = self.next.lock().map_err(|_| LOCK_ERR)?;
            *n += 1;
            format!("csv{n}")
        };
        self.docs
            .lock()
            .map_err(|_| LOCK_ERR)?
            .insert(id.clone(), doc);
        Ok(id)
    }

    /// 1つ取り出して読む
    pub fn with<T>(&self, id: &str, f: impl FnOnce(&CsvDoc) -> T) -> Result<T, String> {
        let map = self.docs.lock().map_err(|_| LOCK_ERR)?;
        let doc = map.get(id).ok_or_else(|| NOT_FOUND.to_string())?;
        Ok(f(doc))
    }

    /// 1つ取り出して書き換える
    pub fn with_mut<T>(&self, id: &str, f: impl FnOnce(&mut CsvDoc) -> T) -> Result<T, String> {
        let mut map = self.docs.lock().map_err(|_| LOCK_ERR)?;
        let doc = map.get_mut(id).ok_or_else(|| NOT_FOUND.to_string())?;
        Ok(f(doc))
    }

    /// 同じタブの中身を入れ替える (読み方を変えて読み直したとき)
    pub fn replace(&self, id: &str, doc: CsvDoc) -> Result<(), String> {
        let mut map = self.docs.lock().map_err(|_| LOCK_ERR)?;
        if !map.contains_key(id) {
            return Err(NOT_FOUND.to_string());
        }
        map.insert(id.to_string(), doc);
        Ok(())
    }

    /// タブを閉じたときに手放す
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.docs.lock().map_err(|_| LOCK_ERR)?.remove(id);
        Ok(())
    }

    /// 比較結果を預かる
    pub fn set_diff(&self, d: StoredDiff) -> Result<(), String> {
        *self.diff.lock().map_err(|_| LOCK_ERR)? = Some(d);
        Ok(())
    }

    /// 預かっている比較結果を読む
    pub fn with_diff<T>(&self, f: impl FnOnce(&StoredDiff) -> T) -> Result<T, String> {
        let d = self.diff.lock().map_err(|_| LOCK_ERR)?;
        let d = d
            .as_ref()
            .ok_or_else(|| "先に比較を実行してください".to_string())?;
        Ok(f(d))
    }

    /// 保存していないものが残っているか (ウィンドウを閉じる前の確認に使う)
    pub fn dirty_names(&self) -> Result<Vec<String>, String> {
        let map = self.docs.lock().map_err(|_| LOCK_ERR)?;
        Ok(map
            .values()
            .filter(|d| d.dirty)
            .map(|d| d.name.clone())
            .collect())
    }
}

/// 施錠に失敗したときの文言 (別のスレッドが持ったまま落ちた場合)
const LOCK_ERR: &str = "CSVの状態を読み書きできませんでした。開き直してください";
const NOT_FOUND: &str = "そのCSVは開かれていません (閉じた可能性があります)";
