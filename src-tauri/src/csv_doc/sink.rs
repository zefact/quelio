//! SQLの結果を、CSVを介さずそのまま表にする書き出し先。
//!
//! 「結果をCSVエディタで開く」は、以前は
//! CSVの文字列を組み立てて一時ファイルへ書き、それを読み直して解析していた。
//! 同じ中身を2度作ることになるうえ、25MBの読み書きが挟まる。
//!
//! ここは受け取った行をそのまま溜めるだけにして、その往復をなくす
//! (DBのデータが一時フォルダに落ちなくなる、という利点もある)

use std::sync::{Arc, Mutex};

use crate::export::CsvCell;
use crate::export_rows::RowSink;

/// 受け取った表 (見出しと行)
#[derive(Default)]
pub struct Collected {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// 書き終わったときだけ表が入る置き場。
///
/// `RowSink::finish` は自分を消費するので、結果はここへ預けて受け取る
/// (中止したときは `finish` が呼ばれないので、空のまま残る)
pub type Slot = Arc<Mutex<Option<Collected>>>;

/// 行をそのまま溜める書き出し先
pub struct DocSink {
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    slot: Slot,
}

impl DocSink {
    /// 書き出し先と、結果の置き場を作る
    pub fn new() -> (Box<DocSink>, Slot) {
        let slot: Slot = Arc::new(Mutex::new(None));
        let sink = Box::new(DocSink {
            header: Vec::new(),
            rows: Vec::new(),
            slot: slot.clone(),
        });
        (sink, slot)
    }
}

impl RowSink for DocSink {
    fn header(&mut self, names: &[String]) -> Result<(), String> {
        self.header = names.to_vec();
        Ok(())
    }

    fn row(&mut self, cells: &[Option<CsvCell>]) -> Result<(), String> {
        // NULLは空欄にする (CSVを経由していたときと同じ扱い)
        self.rows.push(
            cells
                .iter()
                .map(|c| match c {
                    Some(c) => c.text.clone(),
                    None => String::new(),
                })
                .collect(),
        );
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), String> {
        let mut slot = self
            .slot
            .lock()
            .map_err(|_| "表を受け取れません".to_string())?;
        *slot = Some(Collected {
            header: self.header,
            rows: self.rows,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(text: &str) -> Option<CsvCell> {
        Some(CsvCell::text(text.to_string()))
    }

    #[test]
    fn 見出しと行をそのまま受け取る() {
        let (mut sink, slot) = DocSink::new();
        sink.header(&["a".to_string(), "b".to_string()]).unwrap();
        sink.row(&[cell("1"), cell("あ")]).unwrap();
        sink.row(&[cell("2"), None]).unwrap();
        sink.finish().unwrap();

        let got = slot.lock().unwrap().take().unwrap();
        assert_eq!(got.header, vec!["a", "b"]);
        assert_eq!(
            got.rows,
            vec![
                vec!["1".to_string(), "あ".to_string()],
                vec!["2".to_string(), String::new()],
            ]
        );
    }

    #[test]
    fn 引用符や改行を含む値もそのまま入る() {
        let (mut sink, slot) = DocSink::new();
        sink.header(&["x".to_string()]).unwrap();
        sink.row(&[cell("引用符\"と,改行\nを含む")]).unwrap();
        // CSVでは印を付けていた値も、表の中では元のまま持つ
        sink.row(&[cell("=1+1")]).unwrap();
        sink.finish().unwrap();

        let got = slot.lock().unwrap().take().unwrap();
        assert_eq!(got.rows[0][0], "引用符\"と,改行\nを含む");
        assert_eq!(got.rows[1][0], "=1+1");
    }

    #[test]
    fn 締めるまでは何も入らない() {
        let (mut sink, slot) = DocSink::new();
        sink.header(&["x".to_string()]).unwrap();
        sink.row(&[cell("1")]).unwrap();
        // 中止したときは finish が呼ばれない = 途中まで書いた表は渡らない
        assert!(slot.lock().unwrap().is_none());
    }
}
