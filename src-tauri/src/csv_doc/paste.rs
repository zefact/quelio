//! クリップボードのタブ区切りテキストを、表の形へ読み戻す。
//!
//! 相手は表計算ソフトなので、コピー側 (`copy.rs`) と同じ決まりで読む。
//! - 項目の区切りはタブ、行の区切りは改行 (CRLF / LF / CR)
//! - 項目がダブルクォートで始まっていたら、閉じるまでが1つの項目。
//!   中の `""` はダブルクォート1つ
//!
//! 途中に出てくるダブルクォートは、囲みではなくただの文字として扱う
//! (`a"b` はそのまま `a"b`)

/// タブ区切りのテキストを、行と項目に分ける
pub fn parse_tsv(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    // この項目の1文字目をまだ見ていないか (囲みの始まりを見分けるため)
    let mut fresh = true;
    let mut quoted = false;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if quoted {
            if ch != '"' {
                field.push(ch);
            } else if chars.peek() == Some(&'"') {
                // 囲みの中の `""` は、ダブルクォート1つ
                chars.next();
                field.push('"');
            } else {
                quoted = false;
            }
            continue;
        }
        match ch {
            '"' if fresh => {
                quoted = true;
                fresh = false;
            }
            '\t' => {
                row.push(std::mem::take(&mut field));
                fresh = true;
            }
            '\n' | '\r' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                fresh = true;
            }
            _ => {
                field.push(ch);
                fresh = false;
            }
        }
    }
    // 末尾が改行なら、そこで行は閉じているので空の行を足さない
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 読んだ結果が想いどおりかを見る
    fn eq(text: &str, want: &[&[&str]]) {
        let want: Vec<Vec<String>> = want
            .iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect();
        assert_eq!(parse_tsv(text), want, "入力: {text:?}");
    }

    #[test]
    fn タブと改行で表に戻す() {
        eq("a\tb\nc\td", &[&["a", "b"], &["c", "d"]]);
    }

    #[test]
    fn 空の文字からは何も作らない() {
        assert!(parse_tsv("").is_empty());
    }

    #[test]
    fn 末尾の改行で空の行を作らない() {
        eq("a\nb\n", &[&["a"], &["b"]]);
    }

    #[test]
    fn 改行がCRLFでも読める() {
        eq("a\tb\r\nc\td", &[&["a", "b"], &["c", "d"]]);
    }

    #[test]
    fn 改行がCRだけでも読める() {
        eq("a\rb", &[&["a"], &["b"]]);
    }

    #[test]
    fn 末尾のタブは空の項目として残す() {
        eq("a\t", &[&["a", ""]]);
    }

    #[test]
    fn 囲みの中のタブは項目を分けない() {
        eq("\"a\tb\"\tc", &[&["a\tb", "c"]]);
    }

    #[test]
    fn 囲みの中の改行は行を分けない() {
        eq("\"a\nb\"\tc", &[&["a\nb", "c"]]);
    }

    #[test]
    fn 囲みの中の二重のダブルクォートは1つに戻す() {
        eq("\"a\"\"b\"", &[&["a\"b"]]);
    }

    #[test]
    fn 途中のダブルクォートは文字のまま残す() {
        eq("a\"b", &[&["a\"b"]]);
    }

    #[test]
    fn 空の項目が並んでいても数が合う() {
        eq("\t\t", &[&["", "", ""]]);
    }

    #[test]
    fn 行ごとに項目の数が違っていてもそのまま返す() {
        eq("a\tb\nc", &[&["a", "b"], &["c"]]);
    }

    #[test]
    fn コピーした形をそのまま読み戻せる() {
        // copy.rs が作る形と行き来できることを見ておく
        let rows = [["a\tb", "c\nd", "e\"f"], ["", "1", "2"]];
        let text = crate::csv_doc::copy::to_tsv(rows);
        eq(&text, &[&rows[0], &rows[1]]);
    }
}
