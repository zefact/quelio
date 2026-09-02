//! SQLの結果を Excel (.xlsx) の1シートに書き出す。
//!
//! 定義書 (`export_xlsx`) と違い、こちらは行数が事前に読めない。
//! 何百万行でもメモリが膨らまないよう、ライブラリの「一定メモリ」モードで
//! 1行ずつファイルへ流しながら書く。
//!
//! 見た目は定義書と揃え、そのまま配れる形にする
//! (見出しに色、絞り込み、見出し行の固定、列幅の自動調整)

use std::path::{Path, PathBuf};

use rust_xlsxwriter::{
    Color, ExcelDateTime, Format, FormatAlign, FormatBorder, Workbook, Worksheet,
};

use crate::export::CsvCell;
use crate::export_rows::RowSink;

/// Excelの1シートに入る行数の上限 (見出し行を含む)
pub const SHEET_MAX_ROWS: u32 = 1_048_576;

/// 見出しの地の色 (定義書と同じ)
const INK: Color = Color::RGB(0x1E2833);
/// 見出しの下に引く差し色
const ACCENT: Color = Color::RGB(0x2E9E8F);
/// 本文の文字色
const TEXT: Color = Color::RGB(0x2B3440);

const FONT: &str = "Yu Gothic";

/// 列幅の下限・上限 (見出しだけの列がつぶれず、長い値で横に伸びすぎない幅)
const MIN_WIDTH: f64 = 8.0;
const MAX_WIDTH: f64 = 60.0;

/// 列幅を測るのは先頭の何行までにするか。
///
/// 何百万行を全部測ると、書き出しそのものより時間がかかる。
/// 画面に出るのは先頭のほうなので、そこまでで決めれば実用上は足りる
const WIDTH_SAMPLE_ROWS: u32 = 200;

/// 桁を落とさずにExcelの数値として書ける整数の範囲。
///
/// Excelの数値は倍精度浮動小数点なので、これを超えるIDを数値として書くと
/// 末尾が丸められて別の値になる。文字列のまま置いたほうが安全
const SAFE_INT: i64 = 9_007_199_254_740_991;

/// 書式の一式
struct Styles {
    head: Format,
    text: Format,
    number: Format,
    date: Format,
    datetime: Format,
    time: Format,
}

impl Styles {
    fn new() -> Self {
        let base = || {
            Format::new()
                .set_font_name(FONT)
                .set_font_size(10)
                .set_font_color(TEXT)
        };
        Self {
            head: base()
                .set_bold()
                .set_font_color(Color::RGB(0xFFFFFF))
                .set_background_color(INK)
                .set_align(FormatAlign::Center)
                .set_align(FormatAlign::VerticalCenter)
                .set_border_bottom(FormatBorder::Medium)
                .set_border_bottom_color(ACCENT),
            text: base(),
            number: base(),
            date: base().set_num_format("yyyy-mm-dd"),
            datetime: base().set_num_format("yyyy-mm-dd hh:mm:ss"),
            time: base().set_num_format("hh:mm:ss"),
        }
    }
}

/// セルに入れる値の見分け
enum Value<'a> {
    /// 数値としてExcelに入れる
    Number(f64),
    /// 日付・日時・時刻としてExcelに入れる
    Time(ExcelDateTime, &'a Format),
    /// そのまま文字列として置く
    Text,
}

/**
 * `YYYY-MM-DD` などの決まった形かどうかを、桁と区切りだけで確かめる。
 *
 * 「日付らしきもの」を広く拾うと、伝票番号のような文字列まで日付に化ける。
 * 形がぴたりと合うものだけを日付として扱う
 */
fn matches_shape(s: &str, shape: &str) -> bool {
    if s.len() != shape.len() {
        return false;
    }
    s.bytes().zip(shape.bytes()).all(|(c, k)| match k {
        b'9' => c.is_ascii_digit(),
        _ => c == k,
    })
}

/// 文字列が日付・日時・時刻なら、Excelの値に直す
fn as_time<'a>(text: &str, s: &'a Styles) -> Option<(ExcelDateTime, &'a Format)> {
    // 小数秒 (`.123456`) は付いていても良いので、先に切り離して形を見る
    let (head, has_frac) = match text.split_once('.') {
        Some((h, frac)) if !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit()) => {
            (h, true)
        }
        Some(_) => return None,
        None => (text, false),
    };
    let fmt = if matches_shape(head, "9999-99-99") {
        // 日付に小数秒は付かない
        if has_frac {
            return None;
        }
        &s.date
    } else if matches_shape(head, "9999-99-99 99:99:99") {
        &s.datetime
    } else if matches_shape(head, "99:99:99") {
        &s.time
    } else {
        return None;
    };
    // 1900年より前など、Excelで表せない日付はここで弾かれる (文字列のまま置く)
    ExcelDateTime::parse_from_str(text).ok().map(|v| (v, fmt))
}

/// セルの値をどう置くか決める
fn classify<'a>(cell: &CsvCell, s: &'a Styles) -> Value<'a> {
    if cell.numeric {
        // 整数は桁が落ちない範囲だけ数値にする (大きなIDを丸めない)
        if let Ok(n) = cell.text.parse::<i64>() {
            return if n.abs() <= SAFE_INT {
                Value::Number(n as f64)
            } else {
                Value::Text
            };
        }
        if let Ok(n) = cell.text.parse::<f64>() {
            if n.is_finite() {
                return Value::Number(n);
            }
        }
        return Value::Text;
    }
    match as_time(&cell.text, s) {
        Some((v, fmt)) => Value::Time(v, fmt),
        None => Value::Text,
    }
}

/// おおよその文字幅 (全角は2文字ぶん)
fn width_of(text: &str) -> f64 {
    crate::export_xlsx::display_width(text)
}

/// Excelの1シートに結果を書き出す
pub struct SheetSink {
    book: Workbook,
    sheet: Worksheet,
    styles: Styles,
    path: PathBuf,
    /// 次に書く行 (0行目は見出し)
    row: u32,
    /// 列ごとの幅 (先頭の数行から決める)
    widths: Vec<f64>,
}

impl SheetSink {
    /// 保存先とシート名を決めて用意する
    pub fn new(path: &Path, sheet_name: &str) -> Result<Self, String> {
        let mut book = Workbook::new();
        let mut sheet = book.new_worksheet_with_constant_memory();
        sheet.set_name(sheet_name).map_err(|e| e.to_string())?;
        sheet.set_screen_gridlines(false);
        Ok(Self {
            book,
            sheet,
            styles: Styles::new(),
            path: path.to_path_buf(),
            row: 0,
            widths: Vec::new(),
        })
    }

    /// この列にこの文字を置いた、と覚える (先頭の数行だけ)
    fn see(&mut self, col: usize, text: &str) {
        if self.widths.len() <= col {
            self.widths.resize(col + 1, MIN_WIDTH);
        }
        let want = (width_of(text) + 2.5).clamp(MIN_WIDTH, MAX_WIDTH);
        if self.widths[col] < want {
            self.widths[col] = want;
        }
    }

    /// 上限に達していないか確かめる
    fn check_room(&self) -> Result<(), String> {
        if self.row >= SHEET_MAX_ROWS {
            return Err(format!(
                "Excelの1シートに入る上限 ({}行) を超えました。CSVで出力してください",
                crate::csv_import::fmt_count((SHEET_MAX_ROWS - 1) as usize)
            ));
        }
        Ok(())
    }
}

impl RowSink for SheetSink {
    fn header(&mut self, names: &[String]) -> Result<(), String> {
        self.sheet
            .set_row_height(self.row, 22)
            .map_err(|e| e.to_string())?;
        for (i, name) in names.iter().enumerate() {
            self.sheet
                .write_string_with_format(self.row, i as u16, name, &self.styles.head)
                .map_err(|e| e.to_string())?;
            self.see(i, name);
        }
        // 見出しはいつも見えるようにし、そのまま絞り込みできるようにする
        let _ = self.sheet.set_freeze_panes(self.row + 1, 0);
        self.row += 1;
        Ok(())
    }

    fn row(&mut self, cells: &[Option<CsvCell>]) -> Result<(), String> {
        self.check_room()?;
        let r = self.row;
        let measure = r <= WIDTH_SAMPLE_ROWS;
        for (i, cell) in cells.iter().enumerate() {
            // NULLは何も書かない (空文字と見分けが付くように)
            let Some(cell) = cell else { continue };
            let col = i as u16;
            match classify(cell, &self.styles) {
                Value::Number(n) => self
                    .sheet
                    .write_number_with_format(r, col, n, &self.styles.number)
                    .map_err(|e| e.to_string())?,
                Value::Time(v, fmt) => self
                    .sheet
                    .write_with_format(r, col, &v, fmt)
                    .map_err(|e| e.to_string())?,
                Value::Text => self
                    .sheet
                    .write_string_with_format(r, col, &cell.text, &self.styles.text)
                    .map_err(|e| e.to_string())?,
            };
            if measure {
                self.see(i, &cell.text);
            }
        }
        self.row += 1;
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), String> {
        let Self {
            mut book,
            mut sheet,
            path,
            row,
            widths,
            ..
        } = *self;
        for (i, w) in widths.iter().enumerate() {
            sheet
                .set_column_width(i as u16, *w)
                .map_err(|e| e.to_string())?;
        }
        // 見出しだけで終わった場合に、空の範囲へ絞り込みを付けない
        if row > 1 && !widths.is_empty() {
            let last = widths.len() as u16 - 1;
            sheet
                .autofilter(0, 0, row - 1, last)
                .map_err(|e| e.to_string())?;
        }
        book.push_worksheet(sheet);
        // 中身はDBのデータなので、所有者だけが読める権限で作る
        let file = crate::outfile::create(&path)
            .map_err(|e| format!("Excelを作成できません: {e}"))?;
        book.save_to_writer(file)
            .map_err(|e| format!("Excelを書き込めません: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styles() -> Styles {
        Styles::new()
    }

    #[test]
    fn 形が合う文字だけを日付として扱う() {
        let s = styles();
        assert!(as_time("2026-09-02", &s).is_some());
        assert!(as_time("2026-09-02 10:20:30", &s).is_some());
        assert!(as_time("2026-09-02 10:20:30.123", &s).is_some());
        assert!(as_time("10:20:30", &s).is_some());
    }

    #[test]
    fn 日付に見えるだけの文字は文字列のまま() {
        let s = styles();
        // 伝票番号やコード
        assert!(as_time("2026-09-2", &s).is_none());
        assert!(as_time("20260902", &s).is_none());
        assert!(as_time("2026-09-02X", &s).is_none());
        assert!(as_time("A026-09-02", &s).is_none());
        // 日付に小数秒は付かない
        assert!(as_time("2026-09-02.5", &s).is_none());
        assert!(as_time("", &s).is_none());
    }

    #[test]
    fn 表せない日付は文字列のまま() {
        let s = styles();
        assert!(as_time("1000-01-01", &s).is_none());
        assert!(as_time("0000-00-00", &s).is_none());
    }

    #[test]
    fn 桁が落ちる整数は数値にしない() {
        let s = styles();
        let big = CsvCell {
            text: "9007199254740993".to_string(),
            numeric: true,
            clip: None,
        };
        assert!(matches!(classify(&big, &s), Value::Text));
        let ok = CsvCell {
            text: "1234567890".to_string(),
            numeric: true,
            clip: None,
        };
        assert!(matches!(classify(&ok, &s), Value::Number(_)));
    }

    #[test]
    fn 数値でない列は日付だけを見る() {
        let s = styles();
        // 前ゼロのコードは数値フラグが立たないので、文字列のまま残る
        let code = CsvCell::text("00123".to_string());
        assert!(matches!(classify(&code, &s), Value::Text));
        let d = CsvCell::text("2026-09-02".to_string());
        assert!(matches!(classify(&d, &s), Value::Time(_, _)));
    }
}
