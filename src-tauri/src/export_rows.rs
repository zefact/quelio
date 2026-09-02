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
        self.out
            .write_all(crate::export::csv_row_cells(cells).as_bytes())
            .map_err(|e| format!("CSVを書き込めません: {e}"))
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        std::io::Write::flush(&mut self.out).map_err(|e| format!("CSVを書き込めません: {e}"))
    }
}
