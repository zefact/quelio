//! SQLの結果を1行ずつ受け取って書き出す先。
//!
//! 結果は何百万行にもなりうるので、全行をメモリに溜めてから書くことはしない。
//! 「1行受け取ったらその場で書く」という形をここで決めておき、
//! CSVとExcelの違いは実装 (`CsvSink` / `crate::export_sheet::SheetSink`) に閉じ込める

use crate::export::CsvCell;

/// 書き出す形式 (画面から指定される)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RowFormat {
    Csv,
    Xlsx,
}

impl RowFormat {
    /// 画面から来る文字列を形式に直す (知らない値はCSVとして扱う)
    pub fn parse(s: &str) -> Self {
        match s {
            "xlsx" | "excel" => RowFormat::Xlsx,
            _ => RowFormat::Csv,
        }
    }

    /// 保存するファイルの拡張子
    pub fn extension(self) -> &'static str {
        match self {
            RowFormat::Csv => "csv",
            RowFormat::Xlsx => "xlsx",
        }
    }

    /// エラーメッセージに出す呼び名
    pub fn label(self) -> &'static str {
        match self {
            RowFormat::Csv => "CSV",
            RowFormat::Xlsx => "Excel",
        }
    }
}

/// 結果の書き出し先。
///
/// 1行目が来たときに `header` が呼ばれ、そのあと `row` が行の数だけ呼ばれる。
/// 最後に `finish` で締める (Excelは列幅などをここで決める)。
///
/// `Send` を要求するのは、Tauriのコマンドがスレッドをまたぐ非同期処理のため
pub trait RowSink: Send {
    /// 見出し行 (カラム名)
    fn header(&mut self, names: &[String]) -> Result<(), String>;
    /// 本文の1行 (`None` はNULL)
    fn row(&mut self, cells: &[Option<CsvCell>]) -> Result<(), String>;
    /// 書き終わり。ここで初めてファイルが完成する形式もある
    fn finish(self: Box<Self>) -> Result<(), String>;
}

/// 見出しだけを差し替えて、あとは元の書き出し先へそのまま流す包み。
///
/// 画面で「日本語名」を出しているときに、書き出したファイルの見出しも
/// 画面と同じ名前にするために挟む
pub struct RenameSink {
    inner: Box<dyn RowSink>,
    /// 差し替える見出し
    names: Vec<String>,
}

impl RenameSink {
    pub fn new(inner: Box<dyn RowSink>, names: Vec<String>) -> Self {
        Self { inner, names }
    }
}

impl RowSink for RenameSink {
    fn header(&mut self, names: &[String]) -> Result<(), String> {
        // 列数が合わないときは、名前を取り違えるより元のままのほうが安全
        if self.names.len() == names.len() {
            self.inner.header(&self.names)
        } else {
            self.inner.header(names)
        }
    }

    fn row(&mut self, cells: &[Option<CsvCell>]) -> Result<(), String> {
        self.inner.row(cells)
    }

    fn finish(self: Box<Self>) -> Result<(), String> {
        self.inner.finish()
    }
}

/// CSVとして書き出す
pub struct CsvSink<W: std::io::Write> {
    out: W,
}

impl<W: std::io::Write> CsvSink<W> {
    pub fn new(out: W) -> Self {
        Self { out }
    }
}

impl<W: std::io::Write + Send> RowSink for CsvSink<W> {
    fn header(&mut self, names: &[String]) -> Result<(), String> {
        let cells: Vec<Option<CsvCell>> = names
            .iter()
            .map(|n| Some(CsvCell::text(n.clone())))
            .collect();
        self.row(&cells)
    }

    fn row(&mut self, cells: &[Option<CsvCell>]) -> Result<(), String> {
        // 1行ぶんの文字列を作らず、そのまま流す (行数が多いとここが効く)
        crate::export::write_csv_row(&mut self.out, cells)
            .map_err(|e| format!("CSVを書き込めません: {e}"))
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        std::io::Write::flush(&mut self.out).map_err(|e| format!("CSVを書き込めません: {e}"))
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    /// 受け取った見出しと行を覚えておくだけの書き出し先
    #[derive(Default)]
    struct Recorder {
        header: Vec<String>,
        rows: usize,
        slot: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl RowSink for Recorder {
        fn header(&mut self, names: &[String]) -> Result<(), String> {
            self.header = names.to_vec();
            Ok(())
        }
        fn row(&mut self, _cells: &[Option<CsvCell>]) -> Result<(), String> {
            self.rows += 1;
            Ok(())
        }
        fn finish(self: Box<Self>) -> Result<(), String> {
            *self.slot.lock().map_err(|_| "受け取れません".to_string())? = self.header;
            Ok(())
        }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 包んで書き出し、締めたあとの見出しを返す
    fn run(rename: &[&str], from: &[&str]) -> Vec<String> {
        let slot: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let rec = Box::new(Recorder {
            slot: slot.clone(),
            ..Default::default()
        });
        let mut sink: Box<dyn RowSink> = Box::new(RenameSink::new(rec, names(rename)));
        sink.header(&names(from)).expect("見出しを書けること");
        sink.row(&[Some(CsvCell::text("1".into()))])
            .expect("行を書けること");
        sink.finish().expect("締められること");
        let got = slot.lock().expect("受け取れること").clone();
        got
    }

    #[test]
    fn 見出しを差し替える() {
        assert_eq!(run(&["利用者ID", "名前"], &["user_id", "name"]), names(&["利用者ID", "名前"]));
    }

    #[test]
    fn 列数が合わなければ元の見出しのまま() {
        // 取り違えた名前を書くくらいなら、元のカラム名のほうが役に立つ
        assert_eq!(run(&["利用者ID"], &["user_id", "name"]), names(&["user_id", "name"]));
    }
}
