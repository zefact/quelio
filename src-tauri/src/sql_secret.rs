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
 * 相手にする文はユーザーを作る・変えるものだけなので、
 * ここで `BY` を広く見ても他の文には当たらない
 */
const AFTER: &[&str] = &["BY", "PASSWORD"];

/**
 * パスワードを伏せる対象の文かどうか。
 *
 * ふつうの検索や更新まで書き換えてしまわないよう、
 * ユーザーを作る・変える種類の文だけを相手にする
 */
fn targets(sql: &str) -> bool {
    let head: String = sql
        .trim_start()
        .chars()
        .take(40)
        .collect::<String>()
        .to_ascii_uppercase();
    // 先頭の語で見分ける (前に付く空白やコメントは trim 済み)
    const HEADS: &[&str] = &[
        "CREATE USER",
        "CREATE ROLE",
        "CREATE OR REPLACE USER",
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
 * 対象の文でなければ、そのまま返す
 */
pub fn mask(sql: &str) -> String {
    if !targets(sql) {
        return sql.to_string();
    }
    let upper = sql.to_ascii_uppercase();
    // `SET PASSWORD … = 'pw'` は等号の後ろがパスワードになる
    let after_equal = upper.trim_start().starts_with("SET PASSWORD");
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;

    while i < bytes.len() {
        // 文字列リテラルの始まりを見つけたら、そこがパスワードかを見る
        if bytes[i] == b'\'' {
            let end = literal_end(bytes, i);
            if is_password_here(&upper, i, after_equal) {
                out.push_str(HIDDEN);
            } else {
                out.push_str(&sql[i..end]);
            }
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

/// `at` から始まる文字列リテラルの、終わりの次の位置
fn literal_end(bytes: &[u8], at: usize) -> usize {
    let mut i = at + 1;
    while i < bytes.len() {
        match bytes[i] {
            // 逃がされた引用符 ('' と \') は終わりではない
            b'\'' if bytes.get(i + 1) == Some(&b'\'') => i += 2,
            b'\\' => i += 2,
            b'\'' => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/**
 * その位置の文字列リテラルがパスワードか。
 *
 * 直前にある語だけを見る。`IDENTIFIED BY PASSWORD 'ハッシュ'` のように
 * 語が重なる書き方もあるので、間の空白と語を読み飛ばしながらさかのぼる
 */
fn is_password_here(upper: &str, at: usize, after_equal: bool) -> bool {
    let before = upper[..at].trim_end();
    // SET PASSWORD の等号の後ろは、それだけでパスワード
    if after_equal && before.ends_with('=') {
        return true;
    }
    AFTER.iter().any(|w| before.ends_with(w))
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
