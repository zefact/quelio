//! スキーマ情報のCSV生成

use crate::models::{SchemaEntry, TableInfo};

/// 表計算ソフトが数式として読み取ってしまう値か。
///
/// Excel / LibreOffice Calc は `=` `+` `-` `@` で始まるセルを数式として扱う。
/// DBに入っていた文字列がそのまま計算式や外部コマンドの呼び出しになってしまうため、
/// 開いた側で実行されないように印を付ける必要がある (CSVインジェクション)。
/// ただの数値 (-1 / +3.5 / -1.2e5) は数式ではないのでそのまま出す
fn looks_like_formula(s: &str) -> bool {
    // 取り込み時に前後の空白を落とす設定だと、先頭が半角スペースでも数式に戻る
    // (タブ・復帰はそれ自体が対象なので落とさない)
    let s = s.trim_start_matches(' ');
    let Some(first) = s.chars().next() else {
        return false;
    };
    if !matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r') {
        return false;
    }
    // ただの数値ならそのままで安全。
    // ただし inf / NaN は f64 として読めても表計算ソフトでは数値ではない
    match s.parse::<f64>() {
        Ok(n) => !n.is_finite(),
        Err(_) => true,
    }
}

/// 数式として実行されないように先頭へ `'` を足す。
/// 表計算ソフトは取り込み時にこの `'` を「以降は文字列」の印として扱う
/// (CSVをテキストとして開いた場合は `'` がそのまま見える)
fn disarm(s: &str) -> String {
    if looks_like_formula(s) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

/// CSVフィールドのエスケープ
fn esc(s: &str) -> String {
    let s = disarm(s);
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// CSVへ書き出す1項目
pub struct CsvCell {
    pub text: String,
    /// trueならダブルクォートで囲まない (数値型)
    pub numeric: bool,
    /// 画面表示で切り詰めた場合の位置 (CSV出力では切り詰めないので常に None)
    pub clip: Option<crate::query::Clip>,
}

impl CsvCell {
    /// 文字列・日時など、クォートで囲む値
    pub fn text(text: String) -> Self {
        Self {
            text,
            numeric: false,
            clip: None,
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
            // 数式として実行されないように印を付けてから囲む
            Some(c) => format!("\"{}\"", disarm(&c.text).replace('"', "\"\"")),
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
pub fn full_name(t: &TableInfo) -> String {
    match &t.schema {
        Some(s) => format!("{s}.{}", t.name),
        None => t.name.clone(),
    }
}

/// テーブル情報 (ラベル,値) からラベル指定で値を取り出す
pub fn info_get(info: &[(String, String)], label: &str) -> String {
    info.iter()
        .find(|(l, _)| l == label)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// "varchar(100)" → ("varchar", "100") に分離
pub fn split_type(t: &str) -> (String, String) {
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
pub fn parse_comment(comment: &str, delim: &str) -> (String, String) {
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

/// 実行計画をCSVの文字列にする。
///
/// データのCSV出力と同じ組み立て (`csv_row_cells`) を使うので、
/// 計画の文に含まれるカンマ・引用符・改行でも崩れない
pub fn plan_csv(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let head: Vec<Option<CsvCell>> = columns
        .iter()
        .map(|c| Some(CsvCell::text(c.clone())))
        .collect();
    let mut out = csv_row_cells(&head);
    for r in rows {
        let fields: Vec<Option<CsvCell>> =
            r.iter().map(|v| v.clone().map(CsvCell::text)).collect();
        out += &csv_row_cells(&fields);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 実行計画を書き出す() {
        /*
         * 実行計画の文にはカンマも引用符も入る。
         * PostgreSQL 16 が実際に返す形に近い値で確かめる
         */
        let cols = vec!["QUERY PLAN".to_string()];
        let rows = vec![
            vec![Some(
                "Seq Scan on sales  (cost=0.00..1.10 rows=10 width=20)".to_string(),
            )],
            vec![Some("  Filter: (at > '2024-01-01'::date)".to_string())],
            vec![None],
        ];
        let csv = plan_csv(&cols, &rows);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "\"QUERY PLAN\"");
        // カンマを含んでもクォートで囲まれるので列が増えない
        assert_eq!(
            lines[1],
            "\"Seq Scan on sales  (cost=0.00..1.10 rows=10 width=20)\""
        );
        // 値の中の ' はそのまま (CSVでは特別扱いしない)
        assert!(lines[2].contains("'2024-01-01'::date"));
        // NULLは空欄 (空文字と区別する)
        assert_eq!(lines[3], "");
    }

    #[test]
    fn 計画の行も数式として実行されないようにする() {
        // 「-> Hash Join」のように - で始まる行は、表計算ソフトが式と読む
        let csv = plan_csv(
            &["QUERY PLAN".to_string()],
            &[vec![Some("->  Hash Join  (cost=1.00..2.00)".to_string())]],
        );
        assert!(csv.contains("\"'->  Hash Join"), "{csv}");
    }

    #[test]
    fn 数式になる値には印を付ける() {
        for v in [
            "=1+1",
            "@SUM(A1)",
            "=cmd|' /C calc'!A0",
            "+1+1",
            "-2+3+cmd|' /C calc'!A0",
            "\tSUM",
            " =1+1",
            "-inf",
        ] {
            assert!(looks_like_formula(v), "{v}");
            assert_eq!(disarm(v), format!("'{v}"));
        }
    }

    #[test]
    fn ただの数値や文字列はそのまま() {
        for v in ["-1", "+3.5", "-1.2e5", "0", "abc", "", "山田", "a=b"] {
            assert!(!looks_like_formula(v), "{v}");
            assert_eq!(disarm(v), v);
        }
    }

    #[test]
    fn データ行も印を付けてから囲む() {
        let line = csv_row_cells(&[
            Some(CsvCell::text("=1+1".into())),
            Some(CsvCell {
                clip: None,
                text: "-1".into(),
                numeric: true,
            }),
            None,
        ]);
        assert_eq!(line, "\"'=1+1\",-1,\n");
    }
}
