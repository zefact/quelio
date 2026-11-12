//! SQLに書かれたパスワードを、記録に残す前に伏せる。
//!
//! `CREATE USER … IDENTIFIED BY 'ひみつ'` のような文をそのまま記録すると、
//! SQLコンソールと履歴に平文が残ってしまう。
//! ここを通してから記録することで、どの経路から実行されても漏れないようにする
//! (画面のユーザー管理からでも、利用者がSQLエディタへ手で打った場合でも)。
//!
//! 伏せるのは「パスワードを書く場所」だけで、SQL全体は読める形のまま残す。
//! 何をした文なのかは記録から分かってほしいため

/// 伏せた後に出す文字列
const HIDDEN: &str = "'********'";

/**
 * この語の後ろに続く文字列リテラルがパスワード。
 *
 * `BY` だけで見るのは、`IDENTIFIED BY 'pw'` と
 * `IDENTIFIED WITH 方式 BY 'pw'` の両方を1つで拾うため。
 * `AS` は `IDENTIFIED WITH 方式 AS 'ハッシュ'` の形。
 * 相手にする文はユーザーを作る・変えるものだけなので、
 * ここで `BY` や `AS` を広く見ても他の文には当たらない
 */
const AFTER: &[&str] = &["BY", "PASSWORD", "AS"];

/// 文の先頭の空白とコメント (`--` / `#` / `/* */`) を読み飛ばす
fn skip_leading_comments(mut s: &str) -> &str {
    loop {
        s = s.trim_start();
        if let Some(rest) = s.strip_prefix("--").or_else(|| s.strip_prefix('#')) {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            return s;
        }
    }
}

/**
 * パスワードを伏せる対象の文かどうか。
 *
 * ふつうの検索や更新まで書き換えてしまわないよう、
 * ユーザーを作る・変える種類の文だけを相手にする
 */
fn targets(sql: &str) -> bool {
    let head: String = skip_leading_comments(sql)
        .chars()
        .take(40)
        .collect::<String>()
        .to_ascii_uppercase();
    // 語の間の空白の数に左右されないよう詰めてから見る
    let head = head.split_whitespace().collect::<Vec<_>>().join(" ");
    const HEADS: &[&str] = &[
        "CREATE USER",
        "CREATE ROLE",
        "CREATE OR REPLACE USER",
        "CREATE OR REPLACE ROLE",
        "ALTER USER",
        "ALTER ROLE",
        "SET PASSWORD",
        "GRANT ",
    ];
    HEADS.iter().any(|h| head.starts_with(h))
}

/**
 * 記録に残す形に直す。
 *
 * `;` で並べた複数の文もそのまま渡してよい (SQLの履歴は入力をまとめて残す)。
 * 文ごとに見て、対象の文のパスワードだけを伏せる。
 * 対象の文が無ければ、そのまま返す
 */
pub fn mask(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    for stmt in statements(sql) {
        if targets(stmt) {
            out.push_str(&mask_one(stmt));
        } else {
            out.push_str(stmt);
        }
    }
    out
}

/// 文字列リテラル・引用符・コメントの外にある `;` の直後で区切る。
/// 区切った断片をつなげると元の文字列に戻る
fn statements(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut parts = Vec::new();
    let mut from = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => i = quoted_end(bytes, i),
            b'$' => i = dollar_end(bytes, i).unwrap_or(i + 1),
            b'-' if bytes.get(i + 1) == Some(&b'-') => i = line_end(bytes, i),
            b'#' => i = line_end(bytes, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = block_end(bytes, i),
            b';' => {
                i += 1;
                parts.push(&sql[from..i]);
                from = i;
            }
            _ => i += 1,
        }
    }
    if from < sql.len() {
        parts.push(&sql[from..]);
    }
    parts
}

/// 1つの文のパスワードを伏せる
fn mask_one(sql: &str) -> String {
    let upper = sql.to_ascii_uppercase();
    // `SET PASSWORD … = 'pw'` は等号の後ろがパスワードになる
    let after_equal = skip_leading_comments(&upper).starts_with("SET PASSWORD");
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;

    while i < bytes.len() {
        // 文字列リテラル ('…' / MySQLの "…" / PostgreSQLの $$…$$) の始まり
        let end = match bytes[i] {
            b'\'' | b'"' => Some(quoted_end(bytes, i)),
            b'$' => dollar_end(bytes, i),
            _ => None,
        };
        if let Some(end) = end {
            // PostgreSQLの E'…' は前置きの E の前を見る (E は残してよい)
            let lit = if bytes[i] == b'\'' && e_prefixed(bytes, i) {
                i - 1
            } else {
                i
            };
            if is_password_here(&upper, lit, after_equal) {
                out.push_str(HIDDEN);
            } else {
                out.push_str(&sql[i..end]);
            }
            i = end;
            continue;
        }
        // コメントの中の引用符を、リテラルの始まりと読み違えない
        let skip = match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => Some(line_end(bytes, i)),
            b'#' => Some(line_end(bytes, i)),
            b'/' if bytes.get(i + 1) == Some(&b'*') => Some(block_end(bytes, i)),
            b'`' => Some(quoted_end(bytes, i)),
            _ => None,
        };
        if let Some(end) = skip {
            out.push_str(&sql[i..end]);
            i = end;
            continue;
        }
        // 文字の途中で切らないよう、1文字ぶんずつ運ぶ
        let ch = sql[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `at` から始まる引用符 (' / " / `) の、終わりの次の位置
fn quoted_end(bytes: &[u8], at: usize) -> usize {
    let quote = bytes[at];
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            // 逃がされた引用符 ('' と \') は終わりではない
            b if b == quote && bytes.get(i + 1) == Some(&quote) => i += 2,
            b'\\' if quote != b'`' => i += 2,
            b if b == quote => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// `at` からPostgreSQLのドル引用符 (`$$…$$` / `$tag$…$tag$`) が始まるなら、終わりの次の位置
fn dollar_end(bytes: &[u8], at: usize) -> Option<usize> {
    // `a$b` のような名前の途中や、`$1` の位置パラメータは引用符ではない
    if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
        return None;
    }
    let mut j = at + 1;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
        j += 1;
    }
    if bytes.get(j) != Some(&b'$') || bytes.get(at + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let tag = &bytes[at..=j];
    let body = j + 1;
    let close = bytes[body..].windows(tag.len()).position(|w| w == tag)?;
    Some(body + close + tag.len())
}

/// 行コメントの終わり (改行の次)
fn line_end(bytes: &[u8], at: usize) -> usize {
    bytes[at..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |p| at + p + 1)
}

/// ブロックコメントの終わり (`*/` の次)
fn block_end(bytes: &[u8], at: usize) -> usize {
    bytes[at + 2..]
        .windows(2)
        .position(|w| w == b"*/")
        .map_or(bytes.len(), |p| at + 2 + p + 2)
}

/// `at` の `'` が `E'…'` の前置き付きか (直前が E で、その前が名前の一部でない)
fn e_prefixed(bytes: &[u8], at: usize) -> bool {
    at > 0
        && matches!(bytes[at - 1], b'E' | b'e')
        && (at == 1 || !(bytes[at - 2].is_ascii_alphanumeric() || bytes[at - 2] == b'_'))
}

/**
 * その位置の文字列リテラルがパスワードか。
 *
 * 直前にある語だけを見る。`IDENTIFIED BY PASSWORD 'ハッシュ'` のように
 * 語が重なる書き方もあるので、間の空白と語を読み飛ばしながらさかのぼる。
 * 古い書き方の `PASSWORD('pw')` は、かっこを読み飛ばして見る
 */
fn is_password_here(upper: &str, at: usize, after_equal: bool) -> bool {
    let before = upper[..at].trim_end();
    // SET PASSWORD の等号の後ろは、それだけでパスワード
    if after_equal && before.ends_with('=') {
        return true;
    }
    let before = before.trim_end_matches('(').trim_end();
    AFTER.iter().any(|w| ends_with_word(before, w))
}

/// 末尾が単語として word か (`LOBBY` の末尾の `BY` には反応しない)
fn ends_with_word(s: &str, word: &str) -> bool {
    s.ends_with(word)
        && !s[..s.len() - word.len()]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ユーザー作成のパスワードは伏せる() {
        assert_eq!(
            mask("CREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ'"),
            "CREATE USER 'u'@'%' IDENTIFIED BY '********'"
        );
    }

    #[test]
    fn 名前と接続元はそのまま残す() {
        let out = mask("ALTER USER 'app'@'10.0.0.1' IDENTIFIED BY 'pw'");
        assert!(out.contains("'app'"));
        assert!(out.contains("'10.0.0.1'"));
        assert!(!out.contains("pw"));
    }

    #[test]
    fn ハッシュ指定も伏せる() {
        assert_eq!(
            mask("CREATE USER `u` IDENTIFIED BY PASSWORD '*ABC123'"),
            "CREATE USER `u` IDENTIFIED BY PASSWORD '********'"
        );
    }

    #[test]
    fn postgresqlの書き方も伏せる() {
        assert_eq!(
            mask("CREATE ROLE \"u\" LOGIN PASSWORD 'ひみつ' CONNECTION LIMIT 5"),
            "CREATE ROLE \"u\" LOGIN PASSWORD '********' CONNECTION LIMIT 5"
        );
    }

    #[test]
    fn 等号を挟む書き方も伏せる() {
        assert_eq!(
            mask("SET PASSWORD FOR 'u'@'%' = 'ひみつ'"),
            "SET PASSWORD FOR 'u'@'%' = '********'"
        );
    }

    #[test]
    fn 引用符を含むパスワードでも後ろまで巻き込まない() {
        let out = mask("CREATE USER 'u'@'%' IDENTIFIED BY 'a''b' WITH MAX_USER_CONNECTIONS 3");
        assert_eq!(
            out,
            "CREATE USER 'u'@'%' IDENTIFIED BY '********' WITH MAX_USER_CONNECTIONS 3"
        );
    }

    #[test]
    fn 逃がしたバックスラッシュでも後ろまで巻き込まない() {
        let out = mask(r"CREATE USER 'u'@'%' IDENTIFIED BY 'a\\' WITH MAX_USER_CONNECTIONS 3");
        assert!(out.contains("'********'"));
        assert!(out.ends_with("WITH MAX_USER_CONNECTIONS 3"));
    }

    #[test]
    fn 権限の付与に付くパスワードも伏せる() {
        let out = mask("GRANT SELECT ON `d`.* TO 'u'@'%' IDENTIFIED BY 'ひみつ'");
        assert!(out.contains("'u'"));
        assert!(!out.contains("ひみつ"));
    }

    #[test]
    fn ふつうのSQLは書き換えない() {
        let sql = "SELECT * FROM users WHERE password = 'abc'";
        assert_eq!(mask(sql), sql);
        let sql = "UPDATE t SET password = 'abc' WHERE id = 1";
        assert_eq!(mask(sql), sql);
    }

    #[test]
    fn mysqlのダブルクォートのパスワードも伏せる() {
        assert_eq!(
            mask("CREATE USER 'u'@'%' IDENTIFIED BY \"ひみつ\""),
            "CREATE USER 'u'@'%' IDENTIFIED BY '********'"
        );
    }

    #[test]
    fn postgresqlのe文字列とドル引用符も伏せる() {
        assert_eq!(
            mask("ALTER ROLE u PASSWORD E'ひ\\'みつ'"),
            "ALTER ROLE u PASSWORD E'********'"
        );
        assert_eq!(
            mask("ALTER ROLE u WITH PASSWORD $$ひみつ$$ VALID UNTIL 'infinity'"),
            "ALTER ROLE u WITH PASSWORD '********' VALID UNTIL 'infinity'"
        );
        assert_eq!(
            mask("CREATE ROLE u LOGIN PASSWORD $pw$ひ;みつ$pw$"),
            "CREATE ROLE u LOGIN PASSWORD '********'"
        );
    }

    #[test]
    fn 先頭にコメントがあっても伏せる() {
        for sql in [
            "-- 新しい利用者\nCREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ'",
            "/* 作成 */ CREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ'",
            "# MySQL\nALTER  USER 'u' IDENTIFIED BY 'ひみつ'",
        ] {
            let out = mask(sql);
            assert!(!out.contains("ひみつ"), "{out}");
            assert!(out.contains("'********'"), "{out}");
        }
    }

    #[test]
    fn 認証方式のハッシュ指定と古い書き方も伏せる() {
        let out = mask(
            "CREATE USER 'u'@'%' IDENTIFIED WITH caching_sha2_password AS '$A$005$ひみつ'",
        );
        assert!(!out.contains("ひみつ"), "{out}");
        assert!(out.contains("caching_sha2_password"), "{out}");
        assert_eq!(
            mask("SET PASSWORD = PASSWORD('ひみつ')"),
            "SET PASSWORD = PASSWORD('********')"
        );
        assert_eq!(
            mask("SET PASSWORD FOR 'u'@'%' = PASSWORD('ひみつ')"),
            "SET PASSWORD FOR 'u'@'%' = PASSWORD('********')"
        );
    }

    #[test]
    fn 複数の文が並んでいても対象の文だけ伏せる() {
        let sql = "SELECT 'BY x';\nCREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ';\nSELECT 1";
        assert_eq!(
            mask(sql),
            "SELECT 'BY x';\nCREATE USER 'u'@'%' IDENTIFIED BY '********';\nSELECT 1"
        );
        // 文字列の中の ; では区切らない
        let sql = "SELECT 'a;b'; ALTER USER u IDENTIFIED BY 'ひみつ'";
        assert!(!mask(sql).contains("ひみつ"));
    }

    #[test]
    fn コメントの中の引用符で読み違えない() {
        let out = mask("CREATE USER 'u'@'%' /* it's */ IDENTIFIED BY 'ひみつ'");
        assert!(out.contains("/* it's */"), "{out}");
        assert!(!out.contains("ひみつ"), "{out}");
    }

    #[test]
    fn 単語の一部のbyには反応しない() {
        let sql = "CREATE USER 'lobby'@'%' IDENTIFIED BY 'ひみつ'";
        let out = mask(sql);
        assert!(out.contains("'lobby'"), "{out}");
        assert!(!out.contains("ひみつ"), "{out}");
    }

    #[test]
    fn 伏せた後をもう一度伏せても変わらない() {
        let once = mask("CREATE USER 'u'@'%' IDENTIFIED BY 'ひみつ'");
        assert_eq!(mask(&once), once);
    }

    #[test]
    fn 削除や一覧はそのまま() {
        for sql in [
            "DROP USER 'u'@'%'",
            "SHOW GRANTS FOR CURRENT_USER()",
            "REVOKE SELECT ON `d`.* FROM 'u'@'%'",
        ] {
            assert_eq!(mask(sql), sql);
        }
    }

    #[test]
    fn 日本語が混ざっても崩れない() {
        let out = mask("CREATE USER '担当者'@'%' IDENTIFIED BY 'ひみつ'");
        assert_eq!(out, "CREATE USER '担当者'@'%' IDENTIFIED BY '********'");
    }
}
