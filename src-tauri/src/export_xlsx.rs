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

/// 見出しの地の色 (濃紺)
const INK: Color = Color::RGB(0x2F3A56);
/// 見出しの文字色
const ON_INK: Color = Color::RGB(0xFFFFFF);
/// 罫線の色 (黒より薄くして表を軽く見せる)
const RULE: Color = Color::RGB(0xC9CEDA);
/// 1行おきの地の色
const STRIPE: Color = Color::RGB(0xF4F6FA);
/// 見出しラベルの地の色
const LABEL_BG: Color = Color::RGB(0xE8ECF4);
/// リンクの文字色
const LINK: Color = Color::RGB(0x2A5DB0);
/// 補足など、控えめに出す文字色
const MUTED: Color = Color::RGB(0x7B8394);

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
}

impl Body {
    fn new() -> Self {
        let base = || {
            Format::new()
                .set_font_name(FONT)
                .set_font_size(10)
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
        };
        let pair = |f: Format| [f.clone(), f.set_background_color(STRIPE)];
        Self {
            plain: pair(base()),
            center: pair(base().set_align(FormatAlign::Center)),
            mono: pair(base().set_font_name(FONT_MONO)),
            wrap: pair(base().set_text_wrap()),
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
}

/// 書式の一式 (使い回すのでまとめて作る)
struct Styles {
    cover_title: Format,
    cover_sub: Format,
    cover_label: Format,
    cover_value: Format,
    section: Format,
    head: Format,
    body: Body,
    link: Format,
    /// 表の外に置くリンク (枠を付けない)
    link_plain: Format,
    meta_label: Format,
    meta_value: Format,
    none: Format,
}

impl Styles {
    fn new() -> Self {
        let text = || Format::new().set_font_name(FONT).set_font_size(10);
        Self {
            cover_title: Format::new()
                .set_font_name(FONT)
                .set_font_size(22)
                .set_bold()
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(1),
            cover_sub: Format::new()
                .set_font_name(FONT)
                .set_font_size(11)
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::VerticalCenter)
                .set_indent(1),
            cover_label: text()
                .set_bold()
                .set_background_color(LABEL_BG)
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
                .set_indent(1),
            cover_value: text()
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE)
                .set_indent(1),
            section: text().set_bold().set_font_size(11).set_font_color(INK),
            head: text()
                .set_bold()
                .set_font_color(ON_INK)
                .set_background_color(INK)
                .set_align(FormatAlign::Center)
                .set_align(FormatAlign::VerticalCenter)
                .set_text_wrap()
                .set_border(FormatBorder::Thin)
                .set_border_color(INK),
            body: Body::new(),
            link: text()
                .set_font_color(LINK)
                .set_underline(FormatUnderline::Single)
                .set_align(FormatAlign::VerticalCenter)
                .set_border(FormatBorder::Thin)
                .set_border_color(RULE),
            link_plain: text()
                .set_font_color(LINK)
                .set_underline(FormatUnderline::Single)
                .set_align(FormatAlign::VerticalCenter),
            meta_label: text()
                .set_bold()
                .set_font_color(MUTED)
                .set_align(FormatAlign::VerticalCenter),
            meta_value: text()
                .set_font_name(FONT_MONO)
                .set_font_size(11)
                .set_bold()
                .set_align(FormatAlign::VerticalCenter),
            none: text().set_font_color(MUTED),
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
        }
    }
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
    for (i, (Col(_, kind), text)) in cols.iter().zip(values).enumerate() {
        let col = start + i as u16;
        sheet
            .write_string_with_format(row, col, *text, s.cell(*kind, striped))
            .map_err(|e| e.to_string())?;
        // 折り返す列は中身で幅を決めない (縦に伸ばして読ませる)
        if *kind != Cell::Wrap {
            w.see(col as usize, text);
        }
    }
    Ok(())
}

/// 表のあとに置く「(なし)」
fn write_none(sheet: &mut Worksheet, row: u32, s: &Styles) -> Result<(), String> {
    sheet
        .write_string_with_format(row, 1, "(なし)", &s.none)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// セクションの見出し
fn write_section(
    sheet: &mut Worksheet,
    row: u32,
    label: &str,
    s: &Styles,
) -> Result<(), String> {
    sheet.set_row_height(row, 24).map_err(|e| e.to_string())?;
    sheet
        .write_string_with_format(row, 0, label, &s.section)
        .map_err(|e| e.to_string())?;
    Ok(())
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

/// 表紙
fn cover(book: &mut Workbook, meta: &DocMeta, tables: usize, s: &Styles) -> Result<(), String> {
    let sheet = book.add_worksheet();
    sheet.set_name("表紙").map_err(|e| e.to_string())?;
    sheet.set_screen_gridlines(false);
    sheet.set_tab_color(INK);
    sheet.set_column_width(0, 3.0).map_err(|e| e.to_string())?;
    sheet.set_column_width(1, 20.0).map_err(|e| e.to_string())?;
    sheet.set_column_width(2, 56.0).map_err(|e| e.to_string())?;

    // 上部の帯 (タイトル)
    sheet.set_row_height(1, 46).map_err(|e| e.to_string())?;
    sheet.set_row_height(2, 24).map_err(|e| e.to_string())?;
    sheet
        .merge_range(1, 0, 1, 2, "テーブル定義書", &s.cover_title)
        .map_err(|e| e.to_string())?;
    sheet
        .merge_range(2, 0, 2, 2, &meta.database, &s.cover_sub)
        .map_err(|e| e.to_string())?;

    let count = tables.to_string();
    let rows = [
        ("データベース", meta.database.as_str()),
        ("接続", meta.connection.as_str()),
        ("テーブル数", count.as_str()),
        ("出力日時", meta.generated_at.as_str()),
    ];
    for (i, (label, value)) in rows.iter().enumerate() {
        let r = 5 + i as u32;
        sheet.set_row_height(r, 22).map_err(|e| e.to_string())?;
        sheet
            .write_string_with_format(r, 1, *label, &s.cover_label)
            .map_err(|e| e.to_string())?;
        sheet
            .write_string_with_format(r, 2, *value, &s.cover_value)
            .map_err(|e| e.to_string())?;
    }
    sheet
        .write_string_with_format(10, 1, "Quelio が出力しました", &s.none)
        .map_err(|e| e.to_string())?;
    sheet.set_landscape();
    Ok(())
}

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
    sheet.set_screen_gridlines(false);
    sheet.set_tab_color(INK);
    setup_print(sheet, meta, Some(0));

    let cols = [
        Col("No", Cell::Center),
        Col("テーブル名", Cell::Mono),
        Col("論理名", Cell::Text),
        Col("種別", Cell::Center),
        Col("カラム数", Cell::Center),
        Col("備考", Cell::Wrap),
    ];
    let mut w = Widths::default();
    write_head(sheet, 0, 0, &cols, s, &mut w)?;

    for (i, (e, name)) in items.iter().zip(names).enumerate() {
        let r = 1 + i as u32;
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
                e.table.table_type.as_str(),
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
            .autofilter(0, 0, items.len() as u32, cols.len() as u16 - 1)
            .map_err(|e| e.to_string())?;
    }
    sheet.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
    // 備考は折り返して読ませる
    w.fix(5, 30.0);
    w.apply(sheet)?;
    Ok(())
}

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
    sheet.set_screen_gridlines(false);
    setup_print(sheet, meta, None);
    let mut w = Widths::default();
    let d = &e.detail;
    let comment = info_get(&d.info, "コメント");
    let (logical, note) = parse_comment(&comment, delim);

    // 見出し (テーブル名を大きく、その下に論理名と備考)
    sheet.set_row_height(0, 26).map_err(|x| x.to_string())?;
    sheet
        .write_string_with_format(0, 0, full_name(&e.table).as_str(), &s.meta_value)
        .map_err(|x| x.to_string())?;
    let head_line = if note.is_empty() {
        logical.clone()
    } else {
        format!("{logical}   {note}")
    };
    sheet
        .write_string_with_format(1, 0, head_line.as_str(), &s.meta_label)
        .map_err(|x| x.to_string())?;
    let back = Url::new("internal:'テーブル一覧'!A1").set_text("← テーブル一覧へ");
    sheet
        .write_url_with_format(0, 8, back, &s.link_plain)
        .map_err(|x| x.to_string())?;

    // カラム
    let cols = [
        Col("No", Cell::Center),
        Col("論理名", Cell::Text),
        Col("カラム名", Cell::Mono),
        Col("型", Cell::Mono),
        Col("サイズ", Cell::Center),
        Col("NOT NULL", Cell::Center),
        Col("キー", Cell::Center),
        Col("デフォルト", Cell::Mono),
        Col("属性", Cell::Text),
        Col("補足", Cell::Wrap),
    ];
    let mut r = 3;
    write_section(sheet, r, "カラム", s)?;
    r += 1;
    write_head(sheet, r, 0, &cols, s, &mut w)?;
    let head_row = r;
    for (i, c) in d.columns.iter().enumerate() {
        r += 1;
        let (base, size) = split_type(&c.col_type);
        let (col_logical, col_note) = parse_comment(c.comment.as_deref().unwrap_or(""), delim);
        let default = match &c.default {
            None => String::new(),
            Some(v) if v.is_empty() => "''".to_string(),
            Some(v) => v.clone(),
        };
        let no = (i + 1).to_string();
        write_row(
            sheet,
            r,
            0,
            &cols,
            &[
                no.as_str(),
                col_logical.as_str(),
                c.name.as_str(),
                base.as_str(),
                size.as_str(),
                if c.nullable { "" } else { "●" },
                c.key.as_deref().unwrap_or(""),
                default.as_str(),
                c.extra.as_deref().unwrap_or(""),
                col_note.as_str(),
            ],
            i % 2 == 1,
            s,
            &mut w,
        )?;
    }
    // カラムの見出しまでは常に見えるようにする
    sheet
        .set_freeze_panes(head_row + 1, 0)
        .map_err(|x| x.to_string())?;

    // インデックス
    r += 2;
    write_section(sheet, r, "インデックス", s)?;
    r += 1;
    if d.indexes.is_empty() {
        write_none(sheet, r, s)?;
    } else {
        let cols = [
            Col("インデックス名", Cell::Mono),
            Col("ユニーク", Cell::Center),
            Col("カラム", Cell::Mono),
            Col("種類", Cell::Center),
        ];
        write_head(sheet, r, 1, &cols, s, &mut w)?;
        for (i, ix) in d.indexes.iter().enumerate() {
            r += 1;
            write_row(
                sheet,
                r,
                1,
                &cols,
                &[
                    ix.name.as_str(),
                    if ix.unique { "●" } else { "" },
                    ix.columns.as_str(),
                    ix.index_type.as_deref().unwrap_or(""),
                ],
                i % 2 == 1,
                s,
                &mut w,
            )?;
        }
    }

    // 外部キー
    r += 2;
    write_section(sheet, r, "外部キー", s)?;
    r += 1;
    if d.foreign_keys.is_empty() {
        write_none(sheet, r, s)?;
    } else {
        let cols = [
            Col("制約名", Cell::Mono),
            Col("カラム", Cell::Mono),
            Col("参照先", Cell::Mono),
            Col("参照カラム", Cell::Mono),
            Col("ON DELETE", Cell::Center),
            Col("ON UPDATE", Cell::Center),
        ];
        write_head(sheet, r, 1, &cols, s, &mut w)?;
        for (i, fk) in d.foreign_keys.iter().enumerate() {
            r += 1;
            let ref_table = if fk.ref_schema.is_empty() {
                fk.ref_table.clone()
            } else {
                format!("{}.{}", fk.ref_schema, fk.ref_table)
            };
            let cols_text = fk.columns.join(", ");
            let ref_cols = fk.ref_columns.join(", ");
            write_row(
                sheet,
                r,
                1,
                &cols,
                &[
                    fk.name.as_str(),
                    cols_text.as_str(),
                    ref_table.as_str(),
                    ref_cols.as_str(),
                    fk.on_delete.as_str(),
                    fk.on_update.as_str(),
                ],
                i % 2 == 1,
                s,
                &mut w,
            )?;
        }
    }

    // 列数の違う表を並べるので、最後に中身から幅を合わせる
    w.fix(9, 40.0);
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
