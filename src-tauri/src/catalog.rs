//! データベース・テーブル一覧を取得するカタログクエリ。
//!
//! ここには3つのDBで共通のもの (ログの持ち回り・引く範囲の指定・
//! 行のまとめ方・戻り値の型) だけを置き、
//! 実際の問い合わせは mysql / pg / sqlite へ分けている。
//! 呼ぶ側から見た名前は今までどおり `catalog::〇〇`

use serde::Serialize;
use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use std::collections::HashMap;

use crate::apperr::AppError;
use crate::db::db_error;
use crate::models::{
    ColumnInfo, FkInfo, ForeignKeyInfo, IndexInfo, TableDetail, TableInfo,
};
use crate::query_log::QueryLog;

/// MySQL のカタログ
mod mysql;
pub use mysql::*;

/// PostgreSQL のカタログ
mod pg;
pub use pg::*;

/// SQLite のカタログ
mod sqlite;
pub use sqlite::*;

const QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// スキーマ全体をまとめて取るクエリのタイムアウト (テーブル数が多いぶん長め)
const SCHEMA_TIMEOUT: Duration = Duration::from_secs(120);

/// クエリログ用のコンテキスト(接続名・DB名)
pub struct LogCtx<'a> {
    pub qlog: &'a QueryLog,
    pub connection: &'a str,
    pub database: &'a str,
}

impl LogCtx<'_> {
    fn log(&self, sql: &str) {
        self.qlog.add(self.connection, self.database, sql);
    }
}

/// 空文字列をNoneにする
fn opt(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// カタログを引く範囲。
///
/// 「1テーブルぶん」と「まとめて全部」でSQLはほとんど同じで、違うのは
/// 「テーブル名の列を選ぶか (行の振り分けに要る)」
/// 「WHERE で1テーブルに絞るか」
/// 「並び順の先頭にテーブル名を置くか」の3点だけ。
///
/// 同じSQLを2本持つと、片方だけ直して
/// 詳細画面と差分ビューアの内容がずれるため、ここで組み立てる
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// 1テーブルだけ
    One,
    /// スキーマ (データベース) 全体
    All,
}

/// ログ表示用に、プレースホルダを実際の値に置き換える
fn fill_binds(sql: &str, binds: &[&str], pg: bool) -> String {
    let mut out = sql.to_string();
    for (i, b) in binds.iter().enumerate() {
        let quoted = format!("'{b}'");
        out = if pg {
            out.replace(&format!("${}", i + 1), &quoted)
        } else {
            out.replacen('?', &quoted, 1)
        };
    }
    out
}

/// ログ表示用: PostgreSQLの `$1` `$2` プレースホルダを実値に置換
fn bind2_pg(sql: &str, a: &str, b: &str) -> String {
    sql.replace("$1", &format!("'{a}'"))
        .replace("$2", &format!("'{b}'"))
}

/// バイト数を人間可読な文字列にする
fn format_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// 文字コード1件と、そこで使える照合順序
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharsetInfo {
    pub name: String,
    /// 読みやすい説明 (PostgreSQLでは空)
    pub description: String,
    /// 何も選ばなかったときに使われる照合順序 (PostgreSQLでは空)
    pub default_collation: String,
    /// この文字コードで使える照合順序 (PostgreSQLでは空)
    pub collations: Vec<String>,
}

/// SQLエディタの補完に出すカラム (名前・型・コメント)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub name: String,
    /// 表示用の型名 (取れない場合は空)
    pub data_type: String,
    /// カラムコメント (日本語名の取り出しに使う。SQLiteは常に空)
    pub comment: String,
}

/// SQLエディタの補完に出すテーブル
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    /// テーブルコメント (日本語名の取り出しに使う。SQLiteは常に空)
    pub comment: String,
    pub columns: Vec<SchemaColumn>,
}

/// SQLエディタの補完に使うテーブル・カラムの一覧。
/// 定義の全取得は重いので、必要な列だけを1クエリで集める
pub type SchemaColumns = Vec<SchemaTable>;

/// 取得した (テーブル名, テーブルコメント, カラム) の並びをテーブルごとにまとめる
fn group_columns(rows: Vec<(String, String, SchemaColumn)>) -> SchemaColumns {
    let mut out: SchemaColumns = Vec::new();
    for (table, comment, column) in rows {
        match out.last_mut() {
            Some(t) if t.name == table => t.columns.push(column),
            _ => out.push(SchemaTable {
                name: table,
                comment,
                columns: vec![column],
            }),
        }
    }
    out
}

/// ビュー以外の定義物 (関数・プロシージャ・トリガ) 1件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    /// 種別 ("関数" / "プロシージャ" / "トリガ")
    pub kind: String,
    /// スキーマ (MySQL/SQLiteは空)
    pub schema: String,
    pub name: String,
    /// 引数や対象テーブルなど、名前だけでは分からない補足
    pub detail: String,
    /// CREATE文 (取得できないときは空)
    pub definition: String,
}

/// 定義を読めなかったときに本文の代わりに出す説明
const NO_DEFINITION: &str = "-- 定義を取得できませんでした (権限が足りない可能性があります)";

/// サーバー側の接続1本ぶんの情報
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// 接続ID (MySQL) / プロセスID (PostgreSQL)。中止・切断に使う
    pub id: i64,
    pub user: String,
    /// 接続元 (host:port など)
    pub host: String,
    /// 接続先のデータベース名
    pub database: String,
    /// 状態 (Sleep / Query / active / idle in transaction など)
    pub state: String,
    /// その状態になってからの秒数 (取れなければ0)
    pub seconds: i64,
    /// 実行中のSQL (空なら何も走っていない)
    pub query: String,
    /// この画面自身の接続か (自分を切らないよう目印にする)
    pub is_self: bool,
}

/// テスト
#[cfg(test)]
mod tests;
