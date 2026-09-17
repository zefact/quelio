//! 結果の並べ方 (AIへ返す形)。
//!
//! JSONの表は読みやすい代わりに、同じ中身でも文字数が何倍にもなる。
//! AIの入力には限りがあるので、Markdownの表やCSVも選べるようにする。
//!
//! 画面とは関係のない文字の組み立てなので、ここに分けて試せるようにしてある

use serde::Deserialize;

use crate::export::CsvCell;

/// 返し方
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RowFormat {
    /// 行を配列で返す (既定)
    #[default]
    Json,
    /// Markdownの表で返す
    Markdown,
    /// CSVで返す
    Csv,
}

/// NULL を表す文字。
///
/// 空文字と区別できるようにする。
/// 「空欄」で返すと、AIが「空文字が入っている」と読んでしまう
pub const NULL_TEXT: &str = "NULL";

/// Markdownの表のセルに入れられる形にする。
///
/// `|` は表の区切りなので逃がし、改行は `<br>` にする
/// (生の改行を入れると、そこで表が終わってしまう)
fn md_cell(value: Option<&str>) -> String {
    match value {
        Some(v) => md_escape(v),
        None => NULL_TEXT.to_string(),
    }
}

/// 表のセルに入れられる文字にする (スキーマのMarkdownでも使う)。
///
/// 逃がすのは区切りの `|` だけ。`\` まで倍にすると、
/// Windowsのパスが `C:\\tmp` のように見えてしまう
pub(super) fn md_escape(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace("\r\n", "<br>")
        .replace(['\r', '\n'], "<br>")
}

/// Markdownの表にする
pub fn to_markdown(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    // 列が1つも無ければ表にならない (見出しの区切りだけが残る)
    if columns.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str("| ");
    out.push_str(
        &columns
            .iter()
            .map(|c| md_cell(Some(c)))
            .collect::<Vec<_>>()
            .join(" | "),
    );
    out.push_str(" |\n|");
    for _ in columns {
        out.push_str(" --- |");
    }
    for row in rows {
        out.push_str("\n| ");
        out.push_str(
            &row.iter()
                .map(|c| md_cell(c.as_deref()))
                .collect::<Vec<_>>()
                .join(" | "),
        );
        out.push_str(" |");
    }
    out
}

/// CSVにする。
///
/// 組み立ては画面のCSV出力と同じものを使う
/// (引用符・改行の扱いと、表計算ソフトで数式と読まれないための細工が揃う)
pub fn to_csv(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    if columns.is_empty() {
        return String::new();
    }
    let mut out = Vec::new();
    let head: Vec<Option<CsvCell>> = columns
        .iter()
        .map(|c| Some(CsvCell::text(c.clone())))
        .collect();
    let _ = crate::export::write_csv_row(&mut out, &head);
    for row in rows {
        let cells: Vec<Option<CsvCell>> = row
            .iter()
            .map(|c| c.as_ref().map(|v| CsvCell::text(v.clone())))
            .collect();
        let _ = crate::export::write_csv_row(&mut out, &cells);
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<String> {
        vec!["id".to_string(), "name".to_string()]
    }

    #[test]
    fn 見出しと行を表にする() {
        let rows = vec![vec![Some("1".to_string()), Some("山田".to_string())]];
        let got = to_markdown(&cols(), &rows);
        assert_eq!(got, "| id | name |\n| --- | --- |\n| 1 | 山田 |");
    }

    #[test]
    fn nullと空文字を区別する() {
        // 空欄で返すと「空文字が入っている」と読まれてしまう
        let rows = vec![vec![None, Some(String::new())]];
        let got = to_markdown(&cols(), &rows);
        assert!(got.contains("| NULL |  |"), "{got}");
    }

    #[test]
    fn 区切りの記号は逃がす() {
        let rows = vec![vec![Some("a|b".to_string()), Some("c".to_string())]];
        let got = to_markdown(&cols(), &rows);
        // 逃がさないと、ここで列が増えてしまう
        assert_eq!(got.lines().last().expect("行がある"), "| a\\|b | c |");
    }

    #[test]
    fn 改行はbrにする() {
        for nl in ["a\nb", "a\r\nb", "a\rb"] {
            let rows = vec![vec![Some(nl.to_string()), None]];
            let got = to_markdown(&cols(), &rows);
            assert!(got.contains("a<br>b"), "{nl}: {got}");
            // 表が途中で終わらないこと (見出し2行 + データ1行)
            assert_eq!(got.lines().count(), 3, "{nl}: {got}");
        }
    }

    #[test]
    fn 列が無ければ何も書かない() {
        // 列の無い結果 (更新系など) で、区切りだけの壊れた表を出さない
        assert_eq!(to_markdown(&[], &[]), "");
        assert_eq!(to_csv(&[], &[]), "");
    }

    #[test]
    fn バックスラッシュはそのまま出す() {
        let rows = vec![vec![Some("C:\\tmp".to_string()), None]];
        let got = to_markdown(&cols(), &rows);
        assert!(got.contains("C:\\tmp"), "{got}");
        assert!(!got.contains("\\\\"), "{got}");
    }

    #[test]
    fn 行が無くても見出しは出す() {
        let got = to_markdown(&cols(), &[]);
        assert_eq!(got, "| id | name |\n| --- | --- |");
    }

    #[test]
    fn csvは見出しと行を書く() {
        let rows = vec![vec![Some("1".to_string()), Some("山田".to_string())]];
        let got = to_csv(&cols(), &rows);
        let lines: Vec<&str> = got.lines().collect();
        // 文字列は常にクォートで囲まれる (画面のCSV出力と同じ作り)
        assert_eq!(lines[0], "\"id\",\"name\"");
        assert_eq!(lines[1], "\"1\",\"山田\"");
    }

    #[test]
    fn csvはカンマと引用符を崩さない() {
        let rows = vec![vec![Some("a,b".to_string()), Some("\"c\"".to_string())]];
        let got = to_csv(&cols(), &rows);
        let line = got.lines().nth(1).expect("行がある");
        // 読み直せる形になっていること
        assert!(line.contains("\"a,b\""), "{line}");
        assert!(line.contains("\"\"c\"\""), "{line}");
    }

    #[test]
    fn csvでもnullと空文字を区別する() {
        let rows = vec![vec![None, Some(String::new())]];
        let got = to_csv(&cols(), &rows);
        // NULLは空欄、空文字はクォートだけ
        assert_eq!(got.lines().nth(1).expect("行がある"), ",\"\"");
    }

    #[test]
    fn 返し方の既定はjson() {
        assert_eq!(RowFormat::default(), RowFormat::Json);
        // AIから来る文字列を読めること
        for (text, want) in [
            ("\"json\"", RowFormat::Json),
            ("\"markdown\"", RowFormat::Markdown),
            ("\"csv\"", RowFormat::Csv),
        ] {
            let got: RowFormat = serde_json::from_str(text).expect("読めること");
            assert_eq!(got, want, "{text}");
        }
    }
}
