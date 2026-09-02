//! テーブル定義書のExcel (.xlsx) 出力。
//!
//! 日本の現場で使われる定義書の形 (表紙 / テーブル一覧 / テーブルごとのシート) に
//! 合わせて組み立てる。そのまま納品物にできる見た目にすることを狙っているので、
//! 罫線・配色・印刷の設定までここで決めきる

use std::collections::HashSet;

use rust_xlsxwriter::{
    Color, Format, FormatAlign, FormatBorder, FormatUnderline, Url, Workbook, Worksheet,
};

use crate::export::{full_name, info_get, parse_comment, split_type};
use crate::models::SchemaEntry;

/// 表紙に載せる情報
pub struct DocMeta {
    /// 接続の表示名
    pub connection: String,
    pub database: String,
    /// 出力日時 (画面の時刻をそのまま使う)
    pub generated_at: String,
}

// ---------- 配色と書体 ----------

/// 帯と見出しの地の色 (濃いスレート)
const INK: Color = Color::RGB(0x1E2833);
/// 濃い地の上に置く文字色
const ON_INK: Color = Color::RGB(0xFFFFFF);
/// 差し色 (見出しの下線・記号)。青緑にして事務的になりすぎないようにする
const ACCENT: Color = Color::RGB(0x2E9E8F);
/// 主キーの記号の色 (鍵のイメージで金色寄せ)
const GOLD: Color = Color::RGB(0xC08A17);
/// 罫線の色 (黒より薄くして表を軽く見せる)
const RULE: Color = Color::RGB(0xDCE1E8);
/// 1行おきの地の色
const STRIPE: Color = Color::RGB(0xF6F8FA);
/// 見出しラベルの地の色
const LABEL_BG: Color = Color::RGB(0xEDF1F5);
/// リンクの文字色
const LINK: Color = Color::RGB(0x1F6FB2);
/// 補足など、控えめに出す文字色
const MUTED: Color = Color::RGB(0x7A8595);
/// 本文の文字色 (真っ黒より少し弱めて読みやすくする)
const TEXT: Color = Color::RGB(0x2B3440);

/// 本文の書体 (WindowsとmacOSの両方に入っているものを先に置く)
const FONT: &str = "Yu Gothic";
/// 物理名 (テーブル名・カラム名) に使う等幅
const FONT_MONO: &str = "Consolas";

/// Excelのシート名に使えない文字と長さの上限に合わせて整える。
///
/// 同じ名前になってしまう場合は末尾に連番を付けて分ける
pub fn sheet_name(base: &str, used: &mut HashSet<String>) -> String {
    // 使えない文字はアンダースコアに寄せる
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            c => c,
        })
        .collect();
    // 先頭・末尾のシングルクォートはExcelが受け付けない
    let cleaned = cleaned.trim_matches('\'');
    let cleaned = if cleaned.is_empty() { "sheet" } else { cleaned };
    let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let mut name = cut(cleaned, 31);
    let mut n = 2;
    while used.contains(&name) {
        let suffix = format!("~{n}");
        name = format!("{}{}", cut(cleaned, 31 - suffix.chars().count()), suffix);
        n += 1;
    }
    used.insert(name.clone());
    name
}

/// 画面に要るおおよその文字幅 (全角は2文字ぶんとして数える)。
///
/// ライブラリの自動調整は文字数で測るため、日本語の列が狭くなってしまう
pub fn display_width(text: &str) -> f64 {
    text.chars()
        .map(|c| {
            let n = c as u32;
            let wide = matches!(n,
                0x1100..=0x115F
                    | 0x2E80..=0xA4CF
                    | 0xAC00..=0xD7A3
                    | 0xF900..=0xFAFF
                    | 0xFE30..=0xFE6F
                    | 0xFF00..=0xFF60
                    | 0xFFE0..=0xFFE6
                    | 0x20000..=0x3FFFD);
            if wide {
                2.0
            } else {
                1.0
            }
        })
        .sum()
}

/**
 * 型を「基本型 / 桁 / 小数」に分ける。
 *
 * 日本の定義書は桁と小数点以下を別の列に書くのが普通なので、
 * `decimal(12,2)` を `decimal` `12` `2` に割る。
 * `enum('a','b')` のように数でない指定は割らずに型へ残す
 * (無理に桁の欄へ入れると読めなくなる)
 */
pub fn type_parts(col_type: &str) -> (String, String, String) {
    let (base, inside) = split_type(col_type);
    if inside.is_empty() {
        return (base, String::new(), String::new());
    }
    let numeric = |v: &str| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    let mut it = inside.split(',').map(|v| v.trim());
    let len = it.next().unwrap_or("");
    let scale = it.next().unwrap_or("");
    // 3つ以上に割れるもの・数でないものは、型の一部として残す
    if it.next().is_some() || !numeric(len) || (!scale.is_empty() && !numeric(scale)) {
        return (col_type.to_string(), String::new(), String::new());
    }
    (base, len.to_string(), scale.to_string())
}

/// ユニーク制約の掛かっている列の名前 (複合ユニークは構成する列すべて)
fn unique_column_names(d: &crate::models::TableDetail) -> HashSet<String> {
    let mut out = HashSet::new();
    for ix in &d.indexes {
        if !ix.unique {
            continue;
        }
        for c in ix.columns.split(',') {
            let name = c.trim().trim_matches(['`', '"']);
            if !name.is_empty() {
                out.insert(name.to_string());
            }
        }
    }
    out
}

/// 外部キーに使われている列の名前
fn fk_column_names(d: &crate::models::TableDetail) -> HashSet<String> {
    d.foreign_keys
        .iter()
        .flat_map(|fk| fk.columns.iter().cloned())
        .collect()
}

/// 自動採番の列か (DBによって書き方が違う)
pub fn is_auto_number(extra: &str, default: &str, col_type: &str) -> bool {
    let e = extra.to_lowercase();
    e.contains("auto_increment")
        || e.contains("identity")
        || col_type.to_lowercase().contains("serial")
        || default.to_lowercase().starts_with("nextval(")
}

/// 列幅の下限 (見出しだけの列がつぶれないように)
const MIN_WIDTH: f64 = 6.0;
/// 列幅の上限 (長い備考で横に伸びすぎないように)
const MAX_WIDTH: f64 = 44.0;

/// 書いた内容から列幅を決めるための入れ物。
///
/// 1枚のシートに列数の違う表を縦に並べるので、
/// 表ごとに幅を指定すると後の表で上書きされてしまう。
/// 全部書いてから、列ごとの最大値でまとめて決める
#[derive(Default)]
struct Widths(Vec<f64>);

impl Widths {
    /// この列にこの文字を置いた、と覚える
    fn see(&mut self, col: usize, text: &str) {
        let want = (display_width(text) + 2.5).clamp(MIN_WIDTH, MAX_WIDTH);
        if self.0.len() <= col {
            self.0.resize(col + 1, MIN_WIDTH);
        }
        if self.0[col] < want {
            self.0[col] = want;
        }
    }

    /// 折り返して読ませる列など、幅を決め打ちにする
    fn fix(&mut self, col: usize, width: f64) {
        if self.0.len() <= col {
            self.0.resize(col + 1, MIN_WIDTH);
        }
        self.0[col] = width;
    }

    /// いま決まっている幅 (折り返しの行数を見積もるのに使う)
    fn width(&self, col: usize) -> f64 {
        self.0.get(col).copied().unwrap_or(MIN_WIDTH)
    }

    fn apply(&self, sheet: &mut Worksheet) -> Result<(), String> {
        for (i, w) in self.0.iter().enumerate() {
            sheet
                .set_column_width(i as u16, *w)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// 表の本文に使う書式。1行おきに地の色を変えるので2つずつ持つ
struct Body {
    plain: [Format; 2],
    center: [Format; 2],
    mono: [Format; 2],
    wrap: [Format; 2],
    key: [Format; 2],
    mark: [Format; 2],
}

impl Body {
    fn new() -> Self {
        /*
         * 縦線は薄く、横線だけを見せる。
         * 全部を同じ濃さで囲うと方眼紙のようになって古く見えるので、
         * 上下の罫線で行を数えられるようにして、左右は極力目立たせない
         */
        let base = || {
            Format::new()
                .set_font_name(FONT)
                .set_font_size(10)
                .set_font_color(TEXT)
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
                .set_indent(1)
        };
        let pair = |f: Format| [f.clone(), f.set_background_color(STRIPE)];
        let centered = || base().set_align(FormatAlign::Center).set_indent(0);
        Self {
            plain: pair(base()),
            center: pair(centered()),
            mono: pair(base().set_font_name(FONT_MONO)),
            wrap: pair(base().set_text_wrap()),
            key: pair(centered().set_font_color(GOLD).set_bold()),
            mark: pair(centered().set_font_color(ACCENT).set_bold()),
        }
    }
}

/// 列の見せ方
#[derive(Clone, Copy, PartialEq)]
enum Cell {
    /// そのまま左寄せ
    Text,
    /// 中央寄せ (記号・短い値)
    Center,
    /// 等幅 (テーブル名・カラム名など、そのまま使う名前)
    Mono,
    /// 折り返す (備考・補足)
    Wrap,
    /// 主キーの印 (金色)
    Key,
    /// その他の印 (差し色)
    Mark,
}

/// 書式の一式 (使い回すのでまとめて作る)
struct Styles {
    /// 表紙の題字
    cover_title: Format,
    /// 表紙の副題 (データベース名)
    cover_sub: Format,
    /// 差し色の細い帯 (題字の上下に敷く)
    accent_bar: Format,
    /// シート上部の帯に置くテーブル名
    band_title: Format,
    /// 帯の右端に置く戻りリンク
    band_link: Format,
    /// 帯の下に置く論理名の行
    band_sub: Format,
    /// 「文書情報」などの小見出し (下に差し色の線を引く)
    section: Format,
    /// 項目名 (左の枠)
    label: Format,
    /// 項目の中身 (右の枠)
    value: Format,
    /// 表の見出し行
    head: Format,
    body: Body,
    link: Format,
    none: Format,
}

impl Styles {
    fn new() -> Self {
        let text = || {
            Format::new()
                .set_font_name(FONT)
                .set_font_size(10)
                .set_font_color(TEXT)
        };
        let boxed = || {
            text()
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
                .set_indent(1)
        };
        Self {
            cover_title: Format::new()
                .set_font_name(FONT)
                .set_font_size(24)
                .set_bold()
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(2),
            cover_sub: Format::new()
                .set_font_name(FONT_MONO)
                .set_font_size(11)
                .set_font_color(Color::RGB(0xA9B6C4))
                .set_background_color(INK)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(2),
            accent_bar: Format::new().set_background_color(ACCENT),
            band_title: Format::new()
                .set_font_name(FONT_MONO)
                .set_font_size(15)
                .set_bold()
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(1),
            band_link: text()
                .set_font_color(LINK)
                .set_underline(FormatUnderline::Single)
                .set_background_color(LABEL_BG)
                .set_align(FormatAlign::Right)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(1),
            band_sub: text()
                .set_font_size(10)
                .set_background_color(LABEL_BG)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(1),
            section: text()
                .set_bold()
                .set_font_size(11)
                .set_font_color(INK)
                .set_align(FormatAlign::Bottom)
                .set_border_bottom(FormatBorder::Medium)
                .set_border_bottom_color(ACCENT),
            label: boxed().set_bold().set_background_color(LABEL_BG),
            value: boxed(),
            head: text()
                .set_bold()
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::Center)
                .set_align(FormatAlign::VerticalCenter)
                .set_text_wrap()
                .set_border(FormatBorder::Thin)
                .set_border_color(INK)
                .set_border_bottom(FormatBorder::Medium)
                .set_border_bottom_color(ACCENT),
            body: Body::new(),
            link: text()
                .set_font_color(LINK)
                .set_underline(FormatUnderline::Single)
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
                .set_indent(1),
            none: text().set_font_color(MUTED).set_indent(1),
        }
    }

    /// 本文の書式を選ぶ (1行おきに地の色を変える)
    fn cell(&self, kind: Cell, striped: bool) -> &Format {
        let i = usize::from(striped);
        match kind {
            Cell::Text => &self.body.plain[i],
            Cell::Center => &self.body.center[i],
            Cell::Mono => &self.body.mono[i],
            Cell::Wrap => &self.body.wrap[i],
            Cell::Key => &self.body.key[i],
            Cell::Mark => &self.body.mark[i],
        }
    }
}

/// 1行ぶんの高さ (本文)
const ROW_HEIGHT: f64 = 19.0;
/// 折り返して2行目以降が増えるぶんの高さ
const LINE_HEIGHT: f64 = 14.0;

/**
 * 折り返す文字を入れた行の高さを見積もる。
 *
 * Excelの自動調整は結合セルや明示した高さと相性が悪く、
 * 備考が1行に潰れて読めなくなる。列幅から行数を割り出して自分で決める
 */
fn wrapped_height(text: &str, width: f64) -> f64 {
    if text.is_empty() {
        return ROW_HEIGHT;
    }
    // 左右の余白ぶんを引いた、実際に文字が乗る幅
    let usable = (width - 2.0).max(4.0);
    let lines = (display_width(text) / usable).ceil().max(1.0);
    ROW_HEIGHT + (lines - 1.0) * LINE_HEIGHT
}

/// 表の1列の決め方 (見出しと見せ方)
struct Col(&'static str, Cell);

/// 見出し行を書く。
///
/// start は書き始める列。1枚のシートに列数の違う表を縦に並べるので、
/// 幅の意味が合う位置まで右へずらして書く
fn write_head(
    sheet: &mut Worksheet,
    row: u32,
    start: u16,
    cols: &[Col],
    s: &Styles,
    w: &mut Widths,
) -> Result<(), String> {
    sheet.set_row_height(row, 22).map_err(|e| e.to_string())?;
    for (i, Col(label, _)) in cols.iter().enumerate() {
        let col = start + i as u16;
        sheet
            .write_string_with_format(row, col, *label, &s.head)
            .map_err(|e| e.to_string())?;
        w.see(col as usize, label);
    }
    Ok(())
}

/// 本文の1行を書く
#[allow(clippy::too_many_arguments)]
fn write_row(
    sheet: &mut Worksheet,
    row: u32,
    start: u16,
    cols: &[Col],
    values: &[&str],
    striped: bool,
    s: &Styles,
    w: &mut Widths,
) -> Result<(), String> {
    let mut height = ROW_HEIGHT;
    for (i, (Col(_, kind), text)) in cols.iter().zip(values).enumerate() {
        let col = start + i as u16;
        sheet
            .write_string_with_format(row, col, *text, s.cell(*kind, striped))
            .map_err(|e| e.to_string())?;
        // 折り返す列は中身で幅を決めない (縦に伸ばして読ませる)
        if *kind == Cell::Wrap {
            height = height.max(wrapped_height(text, w.width(col as usize)));
        } else {
            w.see(col as usize, text);
        }
    }
    sheet
        .set_row_height(row, height)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 幅を共有するシートに、下の方へ置く小さい表を書く。
 *
 * 列幅はシート全体で1つなので、カラム表の細い列に
 * 「インデックス名」のような長い見出しを置くと、カラム表まで太くなる。
 * そこで、論理的な1列を「カラム表の何列ぶんか」で表して結合する
 * (結合したセルは、個々の列の幅を広げない)
 */
struct Span(u16, u16, &'static str, Cell);

/// カラム一覧の右端の列 (下の表はここまでで折り返す)
const LAST_COL: u16 = 12;

/// 結合したセルに書く (1列ぶんなら結合しない)
fn write_span(
    sheet: &mut Worksheet,
    row: u32,
    from: u16,
    to: u16,
    text: &str,
    fmt: &Format,
) -> Result<(), String> {
    if from == to {
        sheet
            .write_string_with_format(row, from, text, fmt)
            .map_err(|e| e.to_string())?;
    } else {
        sheet
            .merge_range(row, from, row, to, text, fmt)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 結合ありの見出し行
fn write_span_head(
    sheet: &mut Worksheet,
    row: u32,
    spans: &[Span],
    s: &Styles,
) -> Result<(), String> {
    sheet.set_row_height(row, 22).map_err(|e| e.to_string())?;
    for Span(from, to, label, _) in spans {
        write_span(sheet, row, *from, *to, label, &s.head)?;
    }
    Ok(())
}

/// 結合ありの本文1行
fn write_span_row(
    sheet: &mut Worksheet,
    row: u32,
    spans: &[Span],
    values: &[&str],
    striped: bool,
    s: &Styles,
) -> Result<(), String> {
    for (Span(from, to, _, kind), text) in spans.iter().zip(values) {
        write_span(sheet, row, *from, *to, text, s.cell(*kind, striped))?;
    }
    Ok(())
}

/// 表のあとに置く「(なし)」
fn write_none(sheet: &mut Worksheet, row: u32, s: &Styles) -> Result<(), String> {
    sheet
        .write_string_with_format(row, 0, "(なし)", &s.none)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 小見出し。表の幅いっぱいに差し色の下線を引いて、区切りを見せる
fn write_section(
    sheet: &mut Worksheet,
    row: u32,
    from: u16,
    to: u16,
    label: &str,
    s: &Styles,
) -> Result<(), String> {
    sheet.set_row_height(row, 26).map_err(|e| e.to_string())?;
    write_span(sheet, row, from, to, label, &s.section)
}

/// ラベルと中身を左右2組ずつ並べる場所の決め方
struct Grid {
    label_l: (u16, u16),
    value_l: (u16, u16),
    label_r: (u16, u16),
    value_r: (u16, u16),
}

/**
 * 項目を2列組で並べる。
 *
 * 1項目1行で縦に積むと間延びして読みにくいので、左右に振り分ける。
 * 奇数個で余ったときは、最後の中身を右端まで伸ばして枠を揃える
 */
fn write_info_grid(
    sheet: &mut Worksheet,
    mut row: u32,
    g: &Grid,
    items: &[(String, String)],
    s: &Styles,
) -> Result<u32, String> {
    for pair in items.chunks(2) {
        sheet.set_row_height(row, 22).map_err(|e| e.to_string())?;
        write_span(sheet, row, g.label_l.0, g.label_l.1, &pair[0].0, &s.label)?;
        match pair.get(1) {
            Some(right) => {
                write_span(sheet, row, g.value_l.0, g.value_l.1, &pair[0].1, &s.value)?;
                write_span(sheet, row, g.label_r.0, g.label_r.1, &right.0, &s.label)?;
                write_span(sheet, row, g.value_r.0, g.value_r.1, &right.1, &s.value)?;
            }
            None => write_span(sheet, row, g.value_l.0, g.value_r.1, &pair[0].1, &s.value)?,
        }
        row += 1;
    }
    Ok(row)
}

/// 項目1つを1行まるごと使って書く (概要のように長いもの)
fn write_info_wide(
    sheet: &mut Worksheet,
    row: u32,
    g: &Grid,
    label: &str,
    value: &str,
    s: &Styles,
) -> Result<(), String> {
    sheet.set_row_height(row, 22).map_err(|e| e.to_string())?;
    write_span(sheet, row, g.label_l.0, g.label_l.1, label, &s.label)?;
    write_span(sheet, row, g.value_l.0, g.value_r.1, value, &s.value)
}

/// 印刷の設定 (納品物としてそのまま刷れるように)
fn setup_print(sheet: &mut Worksheet, meta: &DocMeta, repeat_row: Option<u32>) {
    sheet.set_landscape();
    sheet.set_print_fit_to_pages(1, 0);
    sheet.set_header(format!("&L{} テーブル定義書&R&A", meta.database));
    sheet.set_footer("&C&P / &N");
    if let Some(r) = repeat_row {
        let _ = sheet.set_repeat_rows(r, r);
    }
}

/// シート名から内部リンクの指定を作る (名前の中の ' は二重にして逃がす)
fn internal_link(name: &str) -> String {
    format!("internal:'{}'!A1", name.replace('\'', "''"))
}

/// 定義書を組み立てて、.xlsx のバイト列を返す
pub fn build(
    items: &[SchemaEntry],
    meta: &DocMeta,
    comment_delimiter: &str,
) -> Result<Vec<u8>, String> {
    let s = Styles::new();
    let mut book = Workbook::new();
    // シート名は先に全部決める (一覧からリンクを張るため)
    let mut used = HashSet::new();
    used.insert("表紙".to_string());
    used.insert("テーブル一覧".to_string());
    let names: Vec<String> = items
        .iter()
        .map(|e| sheet_name(&full_name(&e.table), &mut used))
        .collect();

    cover(&mut book, meta, items.len(), &s)?;
    table_list(&mut book, items, &names, meta, comment_delimiter, &s)?;
    for (e, name) in items.iter().zip(&names) {
        table_sheet(&mut book, e, name, meta, comment_delimiter, &s)?;
    }

    book.save_to_buffer().map_err(|e| e.to_string())
}

/// 表紙の改訂履歴に、あらかじめ用意しておく空欄の数
const HISTORY_ROWS: u32 = 6;

/// 種別を日本語にする (DBによって "BASE TABLE" などまちまちなので)
fn table_kind(table_type: &str) -> &'static str {
    if table_type.to_uppercase().contains("VIEW") {
        "ビュー"
    } else {
        "テーブル"
    }
}

/// 表紙のレイアウト (ラベル14 + 中身36 を左右に2組)
const COVER_GRID: Grid = Grid {
    label_l: (1, 1),
    value_l: (2, 3),
    label_r: (4, 4),
    value_r: (5, 6),
};

/// 表紙 (題字の帯 + 文書情報 + 改訂履歴)
fn cover(book: &mut Workbook, meta: &DocMeta, tables: usize, s: &Styles) -> Result<(), String> {
    let sheet = book.add_worksheet();
    sheet.set_name("表紙").map_err(|e| e.to_string())?;
    // 行に少し余白を持たせる (折り返す行は自動で伸びる)
    sheet.set_default_row_height(19);
    sheet.set_screen_gridlines(false);
    sheet.set_tab_color(INK);
    // 左端は余白にして、紙面の端に文字が貼り付かないようにする
    for (col, width) in [
        (0u16, 2.5),
        (1, 14.0),
        (2, 18.0),
        (3, 18.0),
        (4, 14.0),
        (5, 18.0),
        (6, 18.0),
    ] {
        sheet
            .set_column_width(col, width)
            .map_err(|e| e.to_string())?;
    }

    /*
     * 題字の帯。
     *
     * 濃い地を大きく敷いて、その下に差し色の細い線を引く。
     * 表紙で色を使うのはここだけにして、あとは白と罫線で見せる
     */
    sheet.set_row_height(1, 52).map_err(|e| e.to_string())?;
    sheet.set_row_height(2, 24).map_err(|e| e.to_string())?;
    sheet.set_row_height(3, 4).map_err(|e| e.to_string())?;
    write_span(sheet, 1, 1, 6, "テーブル定義書", &s.cover_title)?;
    write_span(sheet, 2, 1, 6, &meta.database, &s.cover_sub)?;
    write_span(sheet, 3, 1, 6, "", &s.accent_bar)?;

    // 文書情報 (空欄は枠だけ作って、手で書き足せるようにする)
    let count = format!("{tables} テーブル");
    let items: Vec<(String, String)> = [
        ("システム名", ""),
        ("サブシステム名", ""),
        ("データベース", meta.database.as_str()),
        ("接続先", meta.connection.as_str()),
        ("対象テーブル", count.as_str()),
        ("作成日", meta.generated_at.as_str()),
        ("作成者", ""),
        ("版数", ""),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    let mut r = 5;
    write_section(sheet, r, 1, 6, "文書情報", s)?;
    r += 1;
    r = write_info_grid(sheet, r, &COVER_GRID, &items, s)?;

    // 改訂履歴 (1行目だけ埋め、あとは書き足せるよう枠を用意する)
    r += 1;
    write_section(sheet, r, 1, 6, "改訂履歴", s)?;
    r += 1;
    let spans = [
        Span(1, 1, "版", Cell::Center),
        Span(2, 2, "日付", Cell::Center),
        Span(3, 5, "改訂内容", Cell::Text),
        Span(6, 6, "担当", Cell::Center),
    ];
    write_span_head(sheet, r, &spans, s)?;
    r += 1;
    write_span_row(
        sheet,
        r,
        &spans,
        &[
            "",
            meta.generated_at.as_str(),
            "新規作成 (Quelio で出力)",
            "",
        ],
        false,
        s,
    )?;
    for i in 0..HISTORY_ROWS {
        r += 1;
        write_span_row(sheet, r, &spans, &["", "", "", ""], i % 2 == 0, s)?;
    }

    // 幅は列ごとに決め打ちにしてある (空欄が多く、中身から決められないため)
    sheet.set_landscape();
    Ok(())
}

/// テーブル一覧で、見出し行を置く位置 (上に帯があるぶん下げる)
const HEAD_ROW: u32 = 4;

/// テーブル一覧 (各シートへのリンク付き)
fn table_list(
    book: &mut Workbook,
    items: &[SchemaEntry],
    names: &[String],
    meta: &DocMeta,
    delim: &str,
    s: &Styles,
) -> Result<(), String> {
    let sheet = book.add_worksheet();
    sheet.set_name("テーブル一覧").map_err(|e| e.to_string())?;
    // 行に少し余白を持たせる (折り返す行は自動で伸びる)
    sheet.set_default_row_height(19);
    sheet.set_screen_gridlines(false);
    sheet.set_tab_color(INK);
    setup_print(sheet, meta, Some(HEAD_ROW));

    // 表紙と同じ帯を頭に置いて、ページのつながりを見せる
    sheet.set_row_height(0, 30).map_err(|e| e.to_string())?;
    sheet.set_row_height(1, 21).map_err(|e| e.to_string())?;
    sheet.set_row_height(2, 4).map_err(|e| e.to_string())?;
    write_span(sheet, 0, 0, 5, "テーブル一覧", &s.band_title)?;
    let sub = format!("{}  ／  {} テーブル", meta.database, items.len());
    write_span(sheet, 1, 0, 5, &sub, &s.band_sub)?;
    write_span(sheet, 2, 0, 5, "", &s.accent_bar)?;

    let cols = [
        Col("No", Cell::Center),
        Col("テーブル名", Cell::Mono),
        Col("論理名", Cell::Text),
        Col("種別", Cell::Center),
        Col("カラム数", Cell::Center),
        Col("備考", Cell::Wrap),
    ];
    let mut w = Widths::default();
    // 備考は折り返して読ませるので、先に幅を決めておく
    w.fix(5, 30.0);
    write_head(sheet, HEAD_ROW, 0, &cols, s, &mut w)?;

    for (i, (e, name)) in items.iter().zip(names).enumerate() {
        let r = HEAD_ROW + 1 + i as u32;
        let striped = i % 2 == 1;
        let comment = info_get(&e.detail.info, "コメント");
        let (logical, note) = parse_comment(&comment, delim);
        let no = (i + 1).to_string();
        let count = e.detail.columns.len().to_string();
        write_row(
            sheet,
            r,
            0,
            &cols,
            &[
                no.as_str(),
                full_name(&e.table).as_str(),
                logical.as_str(),
                table_kind(&e.table.table_type),
                count.as_str(),
                note.as_str(),
            ],
            striped,
            s,
            &mut w,
        )?;
        // テーブル名はシートへのリンクにする (シート名は丸めることがあるので表示は元の名前)
        let link = Url::new(internal_link(name)).set_text(full_name(&e.table));
        let mut fmt = s.link.clone();
        if striped {
            fmt = fmt.set_background_color(STRIPE);
        }
        sheet
            .write_url_with_format(r, 1, link, &fmt)
            .map_err(|x| x.to_string())?;
    }

    if !items.is_empty() {
        sheet
            .autofilter(
                HEAD_ROW,
                0,
                HEAD_ROW + items.len() as u32,
                cols.len() as u16 - 1,
            )
            .map_err(|e| e.to_string())?;
    }
    sheet
        .set_freeze_panes(HEAD_ROW + 1, 0)
        .map_err(|e| e.to_string())?;
    w.apply(sheet)?;
    Ok(())
}

/// テーブルのシートで、テーブル情報を左右2組に振り分ける場所
const SHEET_GRID: Grid = Grid {
    label_l: (0, 3),
    value_l: (4, 6),
    label_r: (7, 9),
    value_r: (10, LAST_COL),
};

/// テーブル1つぶんのシート (見出し + カラム + インデックス + 外部キー)
fn table_sheet(
    book: &mut Workbook,
    e: &SchemaEntry,
    name: &str,
    meta: &DocMeta,
    delim: &str,
    s: &Styles,
) -> Result<(), String> {
    let sheet = book.add_worksheet();
    sheet.set_name(name).map_err(|x| x.to_string())?;
    // 行に少し余白を持たせる (折り返す行は自動で伸びる)
    sheet.set_default_row_height(19);
    sheet.set_screen_gridlines(false);
    setup_print(sheet, meta, None);
    let mut w = Widths::default();
    // 折り返す列は中身で測れないので、先に読みやすい幅を決め打ちする
    w.fix(LAST_COL as usize, 34.0);
    let d = &e.detail;
    let comment = info_get(&d.info, "コメント");
    let (logical, note) = parse_comment(&comment, delim);

    let kind = table_kind(&e.table.table_type);

    /*
     * シートの頭の帯。
     *
     * 表紙と同じ濃い地に物理名を大きく置き、下に論理名の行を敷く。
     * 何のテーブルのページかが、開いた瞬間に分かるようにする
     */
    sheet.set_row_height(0, 30).map_err(|x| x.to_string())?;
    sheet.set_row_height(1, 21).map_err(|x| x.to_string())?;
    sheet.set_row_height(2, 4).map_err(|x| x.to_string())?;
    write_span(
        sheet,
        0,
        0,
        LAST_COL,
        full_name(&e.table).as_str(),
        &s.band_title,
    )?;
    let sub = if logical.is_empty() {
        kind.to_string()
    } else {
        format!("{logical}  ／  {kind}")
    };
    write_span(sheet, 1, 0, LAST_COL - 3, &sub, &s.band_sub)?;
    // 戻りリンクは薄い地の右端へ (濃い地の上だと文字色が沈む)
    write_span(sheet, 1, LAST_COL - 2, LAST_COL, "", &s.band_link)?;
    let back = Url::new("internal:'テーブル一覧'!A1").set_text("← テーブル一覧へ");
    sheet
        .write_url_with_format(1, LAST_COL - 2, back, &s.band_link)
        .map_err(|x| x.to_string())?;
    write_span(sheet, 2, 0, LAST_COL, "", &s.accent_bar)?;

    /*
     * テーブル情報。
     *
     * 決まった項目のあとに、接続先から取れた情報 (エンジン・文字コード・
     * 行数など) を並べる。DBによって取れるものが違うため。
     * 縦に積むと間延びするので2列組にし、概要だけ1行まるごと使う
     */
    let mut r = 4;
    write_section(sheet, r, 0, LAST_COL, "テーブル情報", s)?;
    r += 1;
    let mut info: Vec<(String, String)> = vec![
        ("論理名".to_string(), logical.clone()),
        ("物理名".to_string(), e.table.name.clone()),
        (
            "スキーマ".to_string(),
            e.table.schema.clone().unwrap_or_default(),
        ),
        ("種別".to_string(), kind.to_string()),
    ];
    for (label, value) in &d.info {
        if label != "コメント" {
            info.push((label.clone(), value.clone()));
        }
    }
    r = write_info_grid(sheet, r, &SHEET_GRID, &info, s)?;
    if !note.is_empty() {
        write_info_wide(sheet, r, &SHEET_GRID, "概要", &note, s)?;
        r += 1;
    }

    /*
     * カラム一覧。
     *
     * 日本の定義書でよく使われる並びにする。
     * 主キー・ユニーク・外部キーは、まとめて1列に書くより
     * 別々の列で●を付けたほうが一目で読める
     */
    let cols = [
        Col("No", Cell::Center),
        Col("PK", Cell::Key),
        Col("UQ", Cell::Mark),
        Col("FK", Cell::Mark),
        Col("論理名", Cell::Text),
        Col("物理名", Cell::Mono),
        Col("データ型", Cell::Mono),
        Col("桁", Cell::Center),
        Col("小数", Cell::Center),
        Col("必須", Cell::Mark),
        Col("既定値", Cell::Mono),
        Col("自動採番", Cell::Mark),
        Col("備考", Cell::Wrap),
    ];
    r += 1;
    write_section(sheet, r, 0, LAST_COL, "カラム", s)?;
    r += 1;
    write_head(sheet, r, 0, &cols, s, &mut w)?;
    let head_row = r;
    // ユニーク・外部キーは、インデックスと制約の側から引く
    let unique_cols = unique_column_names(d);
    let fk_cols = fk_column_names(d);
    for (i, c) in d.columns.iter().enumerate() {
        r += 1;
        let (base, len, scale) = type_parts(&c.col_type);
        let (col_logical, col_note) = parse_comment(c.comment.as_deref().unwrap_or(""), delim);
        let default = match &c.default {
            None => String::new(),
            Some(v) if v.is_empty() => "''".to_string(),
            Some(v) => v.clone(),
        };
        let auto = is_auto_number(
            c.extra.as_deref().unwrap_or(""),
            c.default.as_deref().unwrap_or(""),
            &c.col_type,
        );
        let no = (i + 1).to_string();
        let mark = |on: bool| if on { "●" } else { "" };
        write_row(
            sheet,
            r,
            0,
            &cols,
            &[
                no.as_str(),
                mark(c.key.as_deref() == Some("PRI")),
                mark(unique_cols.contains(&c.name)),
                mark(fk_cols.contains(&c.name)),
                col_logical.as_str(),
                c.name.as_str(),
                base.as_str(),
                len.as_str(),
                scale.as_str(),
                mark(!c.nullable),
                default.as_str(),
                mark(auto),
                col_note.as_str(),
            ],
            i % 2 == 1,
            s,
            &mut w,
        )?;
    }
    // カラムの見出しは、画面でも紙でも常に見えるようにする
    sheet
        .set_freeze_panes(head_row + 1, 0)
        .map_err(|x| x.to_string())?;
    let _ = sheet.set_repeat_rows(head_row, head_row);

    // インデックス
    r += 2;
    write_section(sheet, r, 0, LAST_COL, "インデックス", s)?;
    r += 1;
    if d.indexes.is_empty() {
        write_none(sheet, r, s)?;
    } else {
        let spans = [
            Span(0, 0, "No", Cell::Center),
            Span(1, 3, "インデックス名", Cell::Mono),
            Span(4, 4, "UQ", Cell::Mark),
            Span(5, 8, "対象カラム", Cell::Mono),
            Span(9, 10, "種類", Cell::Center),
            Span(11, LAST_COL, "備考", Cell::Text),
        ];
        write_span_head(sheet, r, &spans, s)?;
        for (i, ix) in d.indexes.iter().enumerate() {
            r += 1;
            let no = (i + 1).to_string();
            write_span_row(
                sheet,
                r,
                &spans,
                &[
                    no.as_str(),
                    ix.name.as_str(),
                    if ix.unique { "●" } else { "" },
                    ix.columns.as_str(),
                    ix.index_type.as_deref().unwrap_or(""),
                    "",
                ],
                i % 2 == 1,
                s,
            )?;
        }
    }

    // 外部キー
    r += 2;
    write_section(sheet, r, 0, LAST_COL, "外部キー", s)?;
    r += 1;
    if d.foreign_keys.is_empty() {
        write_none(sheet, r, s)?;
    } else {
        let spans = [
            Span(0, 0, "No", Cell::Center),
            Span(1, 4, "制約名", Cell::Mono),
            Span(5, 5, "カラム", Cell::Mono),
            Span(6, 7, "参照先", Cell::Mono),
            Span(8, 10, "参照カラム", Cell::Mono),
            Span(11, 11, "ON DELETE", Cell::Center),
            Span(12, LAST_COL, "ON UPDATE", Cell::Center),
        ];
        // 見出しが折り返さないだけの幅は要る (結合していない列なので)
        w.see(11, "ON DELETE");
        write_span_head(sheet, r, &spans, s)?;
        for (i, fk) in d.foreign_keys.iter().enumerate() {
            r += 1;
            let ref_table = if fk.ref_schema.is_empty() {
                fk.ref_table.clone()
            } else {
                format!("{}.{}", fk.ref_schema, fk.ref_table)
            };
            let cols_text = fk.columns.join(", ");
            let ref_cols = fk.ref_columns.join(", ");
            let no = (i + 1).to_string();
            write_span_row(
                sheet,
                r,
                &spans,
                &[
                    no.as_str(),
                    fk.name.as_str(),
                    cols_text.as_str(),
                    ref_table.as_str(),
                    ref_cols.as_str(),
                    fk.on_delete.as_str(),
                    fk.on_update.as_str(),
                ],
                i % 2 == 1,
                s,
            )?;
        }
    }

    w.apply(sheet)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn シート名は使えない文字を置き換える() {
        let mut used = HashSet::new();
        assert_eq!(sheet_name("public.m_users", &mut used), "public.m_users");
        let mut used = HashSet::new();
        assert_eq!(sheet_name("a/b:c*d?e[f]g", &mut used), "a_b_c_d_e_f_g");
    }

    #[test]
    fn シート名は31文字までにする() {
        let mut used = HashSet::new();
        let long = "a".repeat(40);
        assert_eq!(sheet_name(&long, &mut used).chars().count(), 31);
    }

    #[test]
    fn 同じ名前になったら連番で分ける() {
        let mut used = HashSet::new();
        assert_eq!(sheet_name("users", &mut used), "users");
        assert_eq!(sheet_name("users", &mut used), "users~2");
        assert_eq!(sheet_name("users", &mut used), "users~3");
    }

    #[test]
    fn 長い名前が重なっても31文字を超えない() {
        let mut used = HashSet::new();
        let long = "b".repeat(40);
        let first = sheet_name(&long, &mut used);
        let second = sheet_name(&long, &mut used);
        assert_ne!(first, second);
        assert!(second.chars().count() <= 31, "{second}");
        assert!(second.ends_with("~2"));
    }

    #[test]
    fn 日本語のテーブル名も数え方を間違えない() {
        let mut used = HashSet::new();
        let long = "注文明細".repeat(10);
        assert_eq!(sheet_name(&long, &mut used).chars().count(), 31);
    }

    #[test]
    fn 空の名前でも壊れない() {
        let mut used = HashSet::new();
        assert_eq!(sheet_name("", &mut used), "sheet");
        assert_eq!(sheet_name("'''", &mut used), "sheet~2");
    }

    #[test]
    fn 全角は2文字ぶんとして数える() {
        assert_eq!(display_width("abc"), 3.0);
        assert_eq!(display_width("ユーザー"), 8.0);
        assert_eq!(display_width("注文ID"), 6.0);
        assert_eq!(display_width(""), 0.0);
    }

    #[test]
    fn 列幅は中身の一番広いものに合わせる() {
        let mut w = Widths::default();
        w.see(0, "No");
        w.see(0, "1");
        w.see(1, "論理名");
        w.see(1, "メールアドレス");
        assert_eq!(w.0[0], MIN_WIDTH);
        assert_eq!(w.0[1], 16.5);
    }

    #[test]
    fn 列幅は上限と下限で止める() {
        let mut w = Widths::default();
        w.see(0, &"あ".repeat(100));
        w.see(1, "");
        assert_eq!(w.0[0], MAX_WIDTH);
        assert_eq!(w.0[1], MIN_WIDTH);
    }

    #[test]
    fn 内部リンクはシート名のクォートを逃がす() {
        assert_eq!(internal_link("m_users"), "internal:'m_users'!A1");
        assert_eq!(internal_link("a'b"), "internal:'a''b'!A1");
    }
}
