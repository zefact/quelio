//! スキーマ情報のCSV生成

use crate::models::{SchemaEntry, TableInfo};

/// CSVフィールドのエスケープ
fn esc(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSVへ書き出す1項目
pub struct CsvCell {
    pub text: String,
    /// trueならダブルクォートで囲まない (数値型)
    pub numeric: bool,
}

impl CsvCell {
    /// 文字列・日時など、クォートで囲む値
    pub fn text(text: String) -> Self {
        Self {
            text,
            numeric: false,
        }
    }
}

/// データ出力用のCSV1行。
/// 文字列・日時などは値に改行やカンマ・引用符が含まれても壊れないよう
/// 常にダブルクォートで囲み、数値はそのまま出す。
/// NULL (None) は空欄 (クォートなし) にして空文字と区別する
pub fn csv_row_cells(fields: &[Option<CsvCell>]) -> String {
    let mut line = fields
        .iter()
        .map(|f| match f {
            Some(c) if c.numeric => c.text.clone(),
            Some(c) => format!("\"{}\"", c.text.replace('"', "\"\"")),
            None => String::new(),
        })
        .collect::<Vec<_>>()
        .join(",");
    line.push('\n');
    line
}

fn row(fields: &[String]) -> String {
    let mut line = fields
        .iter()
        .map(|f| esc(f))
        .collect::<Vec<_>>()
        .join(",");
    line.push('\n');
    line
}

/// スキーマ付きのテーブル名 (MySQLはテーブル名のみ)
fn full_name(t: &TableInfo) -> String {
    match &t.schema {
        Some(s) => format!("{s}.{}", t.name),
        None => t.name.clone(),
    }
}

/// テーブル情報 (ラベル,値) からラベル指定で値を取り出す
fn info_get(info: &[(String, String)], label: &str) -> String {
    info.iter()
        .find(|(l, _)| l == label)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// "varchar(100)" → ("varchar", "100") に分離
fn split_type(t: &str) -> (String, String) {
    if let (Some(open), Some(close)) = (t.find('('), t.rfind(')')) {
        if open < close {
            let base = format!("{}{}", &t[..open], &t[close + 1..])
                .trim()
                .to_string();
            return (base, t[open + 1..close].to_string());
        }
    }
    (t.to_string(), String::new())
}

/// 開き括弧に対応する閉じ括弧 (対応が無ければNone)
fn closing_for(delim: &str) -> Option<&'static str> {
    match delim {
        "（" => Some("）"),
        "(" => Some(")"),
        "【" => Some("】"),
        "[" => Some("]"),
        "「" => Some("」"),
        "{" => Some("}"),
        "<" => Some(">"),
        _ => None,
    }
}

/// カラムコメントを 論理名＋補足 に分解する (区切り文字は設定で変更可)。
/// 例: 区切り"（" のとき "会社CD（YYMMXX）" → ("会社CD", "YYMMXX")
fn parse_comment(comment: &str, delim: &str) -> (String, String) {
    if delim.is_empty() {
        return (comment.to_string(), String::new());
    }
    match comment.split_once(delim) {
        Some((name, rest)) => {
            let note = match closing_for(delim) {
                Some(close) => rest.strip_suffix(close).unwrap_or(rest),
                None => rest,
            };
            (name.trim().to_string(), note.trim().to_string())
        }
        None => (comment.to_string(), String::new()),
    }
}

/// UTF-8 BOM (Excelで文字化けさせないため)
const BOM: &str = "\u{FEFF}";

pub fn tables_csv(items: &[SchemaEntry]) -> String {
    let mut out = String::from(BOM);
    out += "テーブル名,種別,概算行数,エンジン,サイズ,照合順序,作成,更新,コメント\n";
    for e in items {
        let (t, d) = (&e.table, &e.detail);
        out += &row(&[
            full_name(t),
            t.table_type.clone(),
            t.row_estimate.map(|n| n.to_string()).unwrap_or_default(),
            info_get(&d.info, "エンジン"),
            info_get(&d.info, "サイズ"),
            info_get(&d.info, "照合順序"),
            info_get(&d.info, "作成"),
            info_get(&d.info, "更新"),
            info_get(&d.info, "コメント"),
        ]);
    }
    out
}

/// カラム一覧CSV (定義書フォーマット)
pub fn columns_csv(items: &[SchemaEntry], comment_delimiter: &str) -> String {
    let mut out = String::from(BOM);
    out += "テーブル名,テーブルコメント,No,論理名,カラム名,型,サイズ,NOT NULL,キー,デフォルト,属性,照合順序,補足\n";
    for e in items {
        let (t, d) = (&e.table, &e.detail);
        let table_comment = info_get(&d.info, "コメント");
        for (i, c) in d.columns.iter().enumerate() {
            let (base, size) = split_type(&c.col_type);
            let (logical_name, note) =
                parse_comment(c.comment.as_deref().unwrap_or(""), comment_delimiter);
            out += &row(&[
                full_name(t),
                table_comment.clone(),
                (i + 1).to_string(),
                logical_name,
                c.name.clone(),
                base,
                size,
                if c.nullable { "" } else { "○" }.to_string(),
                c.key.clone().unwrap_or_default(),
                match &c.default {
                    None => String::new(),
                    Some(v) if v.is_empty() => "''".to_string(),
                    Some(v) => v.clone(),
                },
                c.extra.clone().unwrap_or_default(),
                c.collation.clone().unwrap_or_default(),
                note,
            ]);
        }
    }
    out
}

/// インデックス一覧CSV (カラムごとに1行、SEQ順)
pub fn indexes_csv(items: &[SchemaEntry]) -> String {
    let mut out = String::from(BOM);
    out += "テーブル名,No,インデックス名,カラム名,ユニーク\n";
    for e in items {
        let (t, d) = (&e.table, &e.detail);
        for ix in &d.indexes {
            for (seq, column) in ix.columns.split(',').map(str::trim).enumerate() {
                out += &row(&[
                    full_name(t),
                    (seq + 1).to_string(),
                    ix.name.clone(),
                    column.to_string(),
                    if ix.unique { "◯" } else { "" }.to_string(),
                ]);
            }
        }
    }
    out
}
