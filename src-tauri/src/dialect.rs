//! 接続先サーバーの設定から、実際のSQLの書き方 (方言) を決める。
//!
//! 文の区切りや文字列リテラルの読み方は、DBの種類だけでは決まらない。
//! MySQLは `sql_mode` に `NO_BACKSLASH_ESCAPES` があるとバックスラッシュが
//! ただの文字になり、PostgreSQLは `standard_conforming_strings` が `off` だと
//! 逆にバックスラッシュがエスケープになる。
//!
//! ここを取り違えると、`SELECT 'a\'; DROP TABLE t; -- '` のようなSQLを
//! 1文と読んでしまい、読み取り専用の判定も危険なSQLの確認もすり抜ける。
//! そのため接続のたびにサーバーへ実際の設定を聞き、その方言を
//! セッションに持たせて字句解析に使う。

use crate::models::DbType;
use crate::query::Dialect;
use crate::sessions::DbConn;

/// MySQLで、この指定があるとバックスラッシュはエスケープにならない
const NO_BACKSLASH_ESCAPES: &str = "NO_BACKSLASH_ESCAPES";

/// `sql_mode` の値 (カンマ区切り) に NO_BACKSLASH_ESCAPES が含まれるか
pub fn mysql_backslash_escape(sql_mode: &str) -> bool {
    !sql_mode
        .split(',')
        .any(|m| m.trim().eq_ignore_ascii_case(NO_BACKSLASH_ESCAPES))
}

/// `sql_mode` に ANSI_QUOTES が含まれるか。
/// 含まれると `"…"` は文字列ではなく識別子の引用符になる
pub fn mysql_ansi_quotes(sql_mode: &str) -> bool {
    sql_mode.split(',').any(|m| {
        let m = m.trim();
        m.eq_ignore_ascii_case("ANSI_QUOTES") || m.eq_ignore_ascii_case("ANSI")
    })
}

/// `standard_conforming_strings` の値から、バックスラッシュがエスケープになるか。
/// on (標準に従う) ならただの文字、off なら従来どおりエスケープ
pub fn pg_backslash_escape(standard_conforming_strings: &str) -> bool {
    matches!(
        standard_conforming_strings.trim().to_ascii_lowercase().as_str(),
        "off" | "false" | "no" | "0"
    )
}

/// 方言を確かめられなかったときに使う、安全側に倒した方言。
///
/// バックスラッシュをエスケープと見なさない方が文字列が早く閉じるので、
/// 文の切れ目を「見落とす」より「多めに割る」側になる。
/// 見落とすと危険なSQLがそのまま通ってしまうが、多めに割る分には
/// 確認ダイアログが余計に出るか、読み取り専用で断られるだけで済む
pub fn fail_closed(db: DbType) -> Dialect {
    let mut d = Dialect::of(db);
    d.backslash_escape = false;
    d.ansi_quotes = db == DbType::Mysql;
    d
}

/// 方言を聞いた結果。
///
/// 「読み取り専用が効いていない」「危険なSQLの確認が出ない」を追いかけるとき、
/// どの設定をどう読んだのかが分からないと原因にたどり着けない。
/// そのため、投げたSQLと聞けなかった理由も一緒に返す
pub struct Resolved {
    pub dialect: Dialect,
    /// サーバーへ投げたSQL (聞く必要のないDBでは None)
    pub sql: Option<&'static str>,
    /// 聞けなかった理由 (聞けたときは None)
    pub error: Option<String>,
}

impl Resolved {
    /// 聞く必要が無かった場合 (SQLite・Valkey)
    fn as_is(dialect: Dialect) -> Resolved {
        Resolved {
            dialect,
            sql: None,
            error: None,
        }
    }
}

/// MySQL: 文字列の読み方を決める設定
const MYSQL_SQL_MODE: &str = "SELECT @@SESSION.sql_mode";
/// PostgreSQL: バックスラッシュをエスケープとして扱うかの設定
const PG_CONFORMING: &str = "SHOW standard_conforming_strings";

/// 接続からこのセッションの方言を解決する。
/// 問い合わせに失敗した場合は安全側の方言 (`fail_closed`) を使う
pub async fn resolve(db: DbType, conn: &mut DbConn) -> Resolved {
    match conn {
        DbConn::MySql(c) => {
            match sqlx::query_scalar::<_, String>(MYSQL_SQL_MODE)
                .fetch_one(&mut *c)
                .await
            {
                Ok(mode) => Resolved {
                    dialect: Dialect {
                        backslash_escape: mysql_backslash_escape(&mode),
                        ansi_quotes: mysql_ansi_quotes(&mode),
                        ..Dialect::MYSQL
                    },
                    sql: Some(MYSQL_SQL_MODE),
                    error: None,
                },
                Err(e) => Resolved {
                    dialect: fail_closed(db),
                    sql: Some(MYSQL_SQL_MODE),
                    error: Some(crate::db::format_db_error(e)),
                },
            }
        }
        DbConn::Pg(c) => {
            match sqlx::query_scalar::<_, String>(PG_CONFORMING)
                .fetch_one(&mut *c)
                .await
            {
                Ok(v) => Resolved {
                    dialect: Dialect {
                        backslash_escape: pg_backslash_escape(&v),
                        ..Dialect::POSTGRESQL
                    },
                    sql: Some(PG_CONFORMING),
                    error: None,
                },
                Err(e) => Resolved {
                    dialect: fail_closed(db),
                    sql: Some(PG_CONFORMING),
                    error: Some(crate::db::format_db_error(e)),
                },
            }
        }
        // SQLite・Valkeyはサーバー設定で変わる要素が無い
        _ => Resolved::as_is(Dialect::of(db)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_mode() {
        assert!(mysql_backslash_escape(""));
        assert!(mysql_backslash_escape("STRICT_TRANS_TABLES,NO_ZERO_DATE"));
        assert!(!mysql_backslash_escape("NO_BACKSLASH_ESCAPES"));
        assert!(!mysql_backslash_escape(
            "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION"
        ));
        // 空白・大文字小文字のゆらぎを吸収する
        assert!(!mysql_backslash_escape("ANSI_QUOTES, no_backslash_escapes"));
        // 別の指定に部分一致しても反応しない
        assert!(mysql_backslash_escape("XNO_BACKSLASH_ESCAPES"));
    }

    #[test]
    fn ansi_quotes() {
        assert!(!mysql_ansi_quotes("STRICT_TRANS_TABLES"));
        assert!(mysql_ansi_quotes("ANSI_QUOTES"));
        assert!(mysql_ansi_quotes("STRICT_TRANS_TABLES, ansi_quotes"));
        assert!(mysql_ansi_quotes("ANSI"));
        assert!(!mysql_ansi_quotes("NO_ANSI_QUOTES"));
    }

    #[test]
    fn 確かめられないときは安全側に倒す() {
        // 文を見落とすより、多めに割る側にする
        assert!(!fail_closed(DbType::Mysql).backslash_escape);
        assert!(fail_closed(DbType::Mysql).ansi_quotes);
        assert!(!fail_closed(DbType::Postgresql).backslash_escape);
    }

    #[test]
    fn pg_scs() {
        assert!(!pg_backslash_escape("on"));
        assert!(pg_backslash_escape("off"));
        assert!(pg_backslash_escape("OFF"));
        assert!(!pg_backslash_escape("unknown"));
    }
}
