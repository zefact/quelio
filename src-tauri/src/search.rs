//! DB横断の検索。
//!
//! 2種類ある:
//! - オブジェクト名の検索 … テーブル名・カラム名・コメントをカタログから探す (軽い)
//! - 値の検索 … 文字列型の列を片っ端から LIKE で探す (重い。中止できるようにしてある)

use serde::{Deserialize, Serialize};
use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::sqlite::SqliteConnection;
use sqlx::Row;
use tokio::time::{timeout, Duration};

use crate::catalog::LogCtx;
use crate::csv_job::CsvJob;
use crate::db::format_db_error;
use crate::models::DbType;

/// 1つの問い合わせを待つ上限
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// 値検索全体の締め切り (1テーブルずつ止められるが、待たせすぎない)
const TOTAL_DEADLINE: Duration = Duration::from_secs(300);

/// 1つのSQLに入れる列数の上限 (SQLiteは式が深すぎると読めなくなる)
const MAX_COLS_PER_QUERY: usize = 400;

/// オブジェクト名の検索で返す最大件数
const OBJECT_LIMIT: i64 = 2000;

/// 値の検索で返す最大件数
const VALUE_HIT_LIMIT: usize = 500;

/// 1テーブルから拾う行数
const SAMPLE_ROWS: i64 = 20;

/// 見に行くテーブル数の上限
const MAX_TABLES: usize = 2000;

/// 見つけた値のプレビューの長さ (文字数)
const PREVIEW_CHARS: usize = 120;

/// DBから読み出す値の長さの上限 (文字数)。
/// TEXTやJSONの列をそのまま持ってくると、1テーブルで何百MBにもなりうる
const READ_CHARS: usize = 1000;

/// 読み取れなかったテーブルを覚えておく数
const MAX_SKIPPED: usize = 20;

/// LIKEのエスケープ文字。
/// バックスラッシュはDBや設定で扱いが変わるので、紛れの無い記号を使う
const LIKE_ESCAPE: char = '!';

/// 探す文字列を LIKE のパターン (`%...%`) にする
pub fn like_pattern(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len() + 2);
    out.push('%');
    for c in needle.chars() {
        if c == LIKE_ESCAPE || c == '%' || c == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// 使うLIKEの書き方。
///
/// PostgreSQLのLIKEは大文字小文字を区別するのでILIKEに替える。
/// MySQLは照合順序しだいなので、区別したいときは LIKE BINARY にする
fn like_op(db: DbType, ignore_case: bool) -> &'static str {
    match (db, ignore_case) {
        (DbType::Postgresql, true) => "ILIKE",
        (DbType::Mysql, false) => "LIKE BINARY",
        _ => "LIKE",
    }
}

/// SQLiteのLIKEはASCIIの大文字小文字を区別しない。
/// 「区別する」を選んだときは instr で見る (こちらはバイト単位で厳密)
fn sqlite_exact(db: DbType, ignore_case: bool) -> bool {
    db == DbType::Sqlite && !ignore_case
}

/// SQLへ渡す値。LIKEならパターン、instrなら探す文字列そのもの
pub fn bind_value(db: DbType, ignore_case: bool, needle: &str) -> String {
    if sqlite_exact(db, ignore_case) {
        needle.to_string()
    } else {
        like_pattern(needle)
    }
}

/// 値を探す対象にする型か (文字列として読める型だけを相手にする)
pub fn is_text_type(db: DbType, data_type: &str) -> bool {
    let t = data_type.trim().to_lowercase();
    // SQLiteは型を書かない列があり、そこには何でも入る
    if t.is_empty() {
        return db == DbType::Sqlite;
    }
    ["char", "text", "clob", "json", "enum", "set(", "xml", "name", "uuid"]
        .iter()
        .any(|k| t.contains(k))
}

/// 文字列として読むためのキャスト
fn as_text(db: DbType, col_sql: &str) -> String {
    match db {
        DbType::Postgresql => format!("{col_sql}::text"),
        DbType::Mysql => format!("CAST({col_sql} AS CHAR)"),
        _ => format!("CAST({col_sql} AS TEXT)"),
    }
}

/// 読み出す用に先頭だけ切る。
/// 当たりの判定はDB側の条件 (切っていない値) で行うので、ここは表示のためだけ
fn head_of(db: DbType, text_sql: &str) -> String {
    match db {
        DbType::Postgresql => format!("left({text_sql}, {READ_CHARS})"),
        DbType::Mysql => format!("LEFT({text_sql}, {READ_CHARS})"),
        _ => format!("substr({text_sql}, 1, {READ_CHARS})"),
    }
}

/// 見つかったオブジェクト
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHit {
    /// データベース名 (SQLiteは空)
    pub database: String,
    /// PostgreSQLのスキーマ (他は空)
    pub schema: String,
    pub table: String,
    /// カラム名 (テーブル自体が一致したときは空)
    pub column: String,
    pub data_type: String,
    pub comment: String,
}

/// 見つかった値
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueHit {
    pub schema: String,
    pub table: String,
    pub column: String,
    /// 見つかった値の先頭
    pub value: String,
    /*
     * DB側の照合順序のほうが広くて当たった行 (全角と半角を同じとみなす等)。
     * どの列で当たったのかまでは分からないので、そうと分かるようにする
     */
    pub approximate: bool,
}

/// 値検索の結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSearchResult {
    pub hits: Vec<ValueHit>,
    /// 見に行ったテーブル数
    pub scanned: usize,
    pub cancelled: bool,
    /// 上限に達して打ち切った
    pub truncated: bool,
    /// 読めなかったテーブル (権限が無いなど)
    pub skipped: Vec<String>,
}

/// 名前検索の結果
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSearchResult {
    pub hits: Vec<ObjectHit>,
    /// 上限に達して打ち切った
    pub truncated: bool,
}

/// 値検索の条件
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSearchOptions {
    pub needle: String,
    /// 大文字小文字を区別しない
    pub ignore_case: bool,
}

/// 値を探す対象の列
#[derive(Debug, Clone)]
pub struct SearchColumn {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub data_type: String,
}

/// 同じテーブルの列をまとめる (取得順にテーブルが並んでいる前提)
pub fn group_by_table(cols: Vec<SearchColumn>) -> Vec<(String, String, Vec<SearchColumn>)> {
    let mut out: Vec<(String, String, Vec<SearchColumn>)> = Vec::new();
    for c in cols {
        match out.last_mut() {
            Some((sc, tb, list)) if *sc == c.schema && *tb == c.table => list.push(c),
            _ => out.push((c.schema.clone(), c.table.clone(), vec![c])),
        }
    }
    out
}

/// 1テーブルぶんの検索SQLを組み立てる。
///
/// 「どの列に入っているか」を見たいので、一致した行の該当列だけを読み出す。
/// 件数は数えず、先頭の数行で止める (全表スキャンを短く切り上げるため)
pub fn value_query(
    db: DbType,
    table_sql: &str,
    columns: &[String],
    ignore_case: bool,
) -> String {
    let op = like_op(db, ignore_case);
    let exact = sqlite_exact(db, ignore_case);
    let mut selects = Vec::with_capacity(columns.len());
    let mut wheres = Vec::with_capacity(columns.len());
    for (i, c) in columns.iter().enumerate() {
        let quoted = crate::ddl::quote(db, c);
        let text = as_text(db, &quoted);
        selects.push(format!("{} AS c{i}", head_of(db, &text)));
        let ph = if db == DbType::Postgresql {
            format!("${}", i + 1)
        } else {
            "?".to_string()
        };
        wheres.push(if exact {
            format!("instr({text}, {ph}) > 0")
        } else {
            format!("{text} {op} {ph} ESCAPE '{LIKE_ESCAPE}'")
        });
    }
    format!(
        "SELECT {} FROM {} WHERE {} LIMIT {}",
        selects.join(", "),
        table_sql,
        wheres.join(" OR "),
        SAMPLE_ROWS
    )
}

/// 表示用に先頭だけ切り出す (文字の途中で切らない)
fn preview(text: &str) -> String {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

// ---------- オブジェクト名の検索 ----------

/// MySQL: つながっているサーバーの全データベースから探す
/// 名前検索の対象データベースを決める。
///
/// 探す範囲は画面で選んでいるデータベースの中だけにするので、
/// 選んでいなければ「何を探すか」が決まらない。
/// 黙って全体を探すと、画面に出ている範囲と食い違う
pub fn search_scope(database: Option<&str>) -> Result<&str, String> {
    match database.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Ok(d),
        None => Err("データベースを選んでから検索してください".to_string()),
    }
}

pub async fn mysql_objects(
    conn: &mut MySqlConnection,
    database: &str,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, String> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_COMMENT, '') AS CMT \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? \
           AND (TABLE_NAME LIKE ? ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(TABLE_COMMENT, '') LIKE ? ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone()))
            .bind(database)
            .bind(&pattern)
        .bind(&pattern)
        .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: r.try_get("TABLE_SCHEMA").unwrap_or_default(),
            schema: String::new(),
            table: r.try_get("TABLE_NAME").unwrap_or_default(),
            column: String::new(),
            data_type: r.try_get("TABLE_TYPE").unwrap_or_default(),
            comment: r.try_get("CMT").unwrap_or_default(),
        });
    }

    let cols_sql = format!(
        "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, \
                COALESCE(COLUMN_COMMENT, '') AS CMT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? \
           AND (COLUMN_NAME LIKE ? ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(COLUMN_COMMENT, '') LIKE ? ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone()))
            .bind(database)
            .bind(&pattern)
        .bind(&pattern)
        .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: r.try_get("TABLE_SCHEMA").unwrap_or_default(),
            schema: String::new(),
            table: r.try_get("TABLE_NAME").unwrap_or_default(),
            column: r.try_get("COLUMN_NAME").unwrap_or_default(),
            data_type: r.try_get("COLUMN_TYPE").unwrap_or_default(),
            comment: r.try_get("CMT").unwrap_or_default(),
        });
    }
    Ok(out)
}

/// 名前検索で返す最大件数
pub const OBJECT_TOTAL_LIMIT: usize = OBJECT_LIMIT as usize;

/// PostgreSQL: つないでいるデータベースの全スキーマから探す
pub async fn pg_objects(
    conn: &mut PgConnection,
    database: &str,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, String> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT n.nspname AS schema, c.relname AS tbl, c.relkind AS kind, \
                COALESCE(obj_description(c.oid, 'pg_class'), '') AS cmt \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition \
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
           AND (c.relname ILIKE $1 ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(obj_description(c.oid, 'pg_class'), '') ILIKE $1 ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY n.nspname, c.relname LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone())).bind(&pattern).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        let kind: Option<i8> = r.try_get("kind").unwrap_or_default();
        out.push(ObjectHit {
            database: database.to_string(),
            schema: r.try_get("schema").unwrap_or_default(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: String::new(),
            data_type: pg_kind_label(kind).to_string(),
            comment: r.try_get("cmt").unwrap_or_default(),
        });
    }

    let cols_sql = format!(
        "SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, \
                format_type(a.atttypid, a.atttypmod) AS typ, \
                COALESCE(col_description(c.oid, a.attnum), '') AS cmt \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition \
           AND a.attnum > 0 AND NOT a.attisdropped \
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
           AND (a.attname ILIKE $1 ESCAPE '{LIKE_ESCAPE}' \
                OR COALESCE(col_description(c.oid, a.attnum), '') ILIKE $1 ESCAPE '{LIKE_ESCAPE}') \
         ORDER BY n.nspname, c.relname, a.attnum LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone())).bind(&pattern).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: database.to_string(),
            schema: r.try_get("schema").unwrap_or_default(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
            comment: r.try_get("cmt").unwrap_or_default(),
        });
    }
    Ok(out)
}

/// relkind を読みやすい名前にする
fn pg_kind_label(kind: Option<i8>) -> &'static str {
    match kind.map(|c| c as u8 as char) {
        Some('v') => "VIEW",
        Some('m') => "MATERIALIZED VIEW",
        Some('f') => "FOREIGN TABLE",
        Some('p') => "PARTITIONED TABLE",
        _ => "TABLE",
    }
}

/// SQLite: ファイルの中から探す
pub async fn sqlite_objects(
    conn: &mut SqliteConnection,
    needle: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<ObjectHit>, String> {
    let pattern = like_pattern(needle);
    let mut out = Vec::new();

    let tables_sql = format!(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
           AND name LIKE ? ESCAPE '{LIKE_ESCAPE}' \
         ORDER BY name LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &tables_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(tables_sql.clone())).bind(&pattern).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: String::new(),
            schema: String::new(),
            table: r.try_get("name").unwrap_or_default(),
            column: String::new(),
            data_type: r
                .try_get::<String, _>("type")
                .unwrap_or_default()
                .to_uppercase(),
            comment: String::new(),
        });
    }

    let cols_sql = format!(
        "SELECT m.name AS tbl, p.name AS col, p.\"type\" AS typ \
         FROM sqlite_master m JOIN pragma_table_info(m.name) p \
         WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' \
           AND p.name LIKE ? ESCAPE '{LIKE_ESCAPE}' \
         ORDER BY m.name, p.cid LIMIT {OBJECT_LIMIT}"
    );
    ctx.qlog.add(ctx.connection, ctx.database, &cols_sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sqlx::AssertSqlSafe(cols_sql.clone())).bind(&pattern).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    for r in &rows {
        out.push(ObjectHit {
            database: String::new(),
            schema: String::new(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
            comment: String::new(),
        });
    }
    Ok(out)
}

// ---------- 値の検索 ----------

/// 値を探す対象の列を集める (MySQL)
pub async fn mysql_value_columns(
    conn: &mut MySqlConnection,
    database: &str,
    ctx: &LogCtx<'_>,
) -> Result<Vec<SearchColumn>, String> {
    // ビューは実体が無く、重い定義だと検索が長引くのでテーブルだけにする
    let sql = "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE \
               FROM information_schema.COLUMNS c \
               JOIN information_schema.TABLES t \
                 ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
               WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' \
               ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";
    ctx.qlog.add(ctx.connection, ctx.database, sql);
    let rows = timeout(
        SEARCH_TIMEOUT,
        sqlx::query(sql).bind(database).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| "検索がタイムアウトしました".to_string())?
    .map_err(format_db_error)?;
    /*
     * データベース名で修飾しておく。
     * 接続の既定スキーマは USE で変わりうるので、名前だけだと別のDBを読みかねない
     */
    Ok(rows
        .iter()
        .map(|r| SearchColumn {
            schema: database.to_string(),
            table: r.try_get("TABLE_NAME").unwrap_or_default(),
            column: r.try_get("COLUMN_NAME").unwrap_or_default(),
            data_type: r.try_get("COLUMN_TYPE").unwrap_or_default(),
        })
        .collect())
}

/// 値を探す対象の列を集める (PostgreSQL)
pub async fn pg_value_columns(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<SearchColumn>, String> {
    let sql = "SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col, \
                    format_type(a.atttypid, a.atttypmod) AS typ \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition \
               AND a.attnum > 0 AND NOT a.attisdropped \
               AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
             ORDER BY n.nspname, c.relname, a.attnum";
    ctx.qlog.add(ctx.connection, ctx.database, sql);
    let rows = timeout(SEARCH_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "検索がタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| SearchColumn {
            schema: r.try_get("schema").unwrap_or_default(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
        })
        .collect())
}

/// 値を探す対象の列を集める (SQLite)
pub async fn sqlite_value_columns(
    conn: &mut SqliteConnection,
    ctx: &LogCtx<'_>,
) -> Result<Vec<SearchColumn>, String> {
    let sql = "SELECT m.name AS tbl, p.name AS col, p.\"type\" AS typ \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid";
    ctx.qlog.add(ctx.connection, ctx.database, sql);
    let rows = timeout(SEARCH_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| "検索がタイムアウトしました".to_string())?
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| SearchColumn {
            schema: String::new(),
            table: r.try_get("tbl").unwrap_or_default(),
            column: r.try_get("col").unwrap_or_default(),
            data_type: r.try_get("typ").unwrap_or_default(),
        })
        .collect())
}

/// 1テーブルぶんの読み出し結果 (列の並びは検索SQLと同じ)
pub type TableRows = Vec<Vec<Option<String>>>;

/// 検索の進み具合 (テーブルを1つ見るたびに更新する)
struct Progress {
    hits: Vec<ValueHit>,
    skipped: Vec<String>,
    /// 上限に達して skipped に載せられなかった件数
    omitted: usize,
    scanned: usize,
    /// 全体の締め切りを見るための開始時刻
    started: std::time::Instant,
}

impl Progress {
    fn new() -> Self {
        Self {
            hits: Vec::new(),
            skipped: Vec::new(),
            omitted: 0,
            scanned: 0,
            started: std::time::Instant::now(),
        }
    }

    /// 締め切りを過ぎたか (1テーブルずつしか止められないので、全体にも上限を置く)
    fn over_deadline(&self) -> bool {
        self.started.elapsed() >= TOTAL_DEADLINE
    }
}

/// 読み出した行から当たりを拾う。上限に達したらtrueを返す
fn collect_hits(
    p: &mut Progress,
    schema: &str,
    table: &str,
    names: &[String],
    rows: TableRows,
    opts: &ValueSearchOptions,
) -> bool {
    for row in rows {
        /*
         * どの列に入っていたかを見せたいので、まずこちらでも照らし合わせる。
         * ただしDB側の照合順序のほうが広いことがある (全角半角を同じとみなす等)。
         * その場合はどの列とも言えないので、値の入っている先頭の列で1件出す
         * (行を落としてしまうと「当たったのに0件」になってしまう)
         */
        let mut matched = false;
        for (i, name) in names.iter().enumerate() {
            let Some(Some(v)) = row.get(i) else { continue };
            if !contains(v, &opts.needle, opts.ignore_case) {
                continue;
            }
            matched = true;
            if push_hit(p, schema, table, name, v, false) {
                return true;
            }
        }
        if !matched {
            if let Some((i, v)) = row
                .iter()
                .enumerate()
                .find_map(|(i, v)| v.as_ref().map(|v| (i, v)))
            {
                let name = names.get(i).cloned().unwrap_or_default();
                if push_hit(p, schema, table, &name, v, true) {
                    return true;
                }
            }
        }
    }
    false
}

/// 当たりを1件積む。上限に達したらtrueを返す
fn push_hit(
    p: &mut Progress,
    schema: &str,
    table: &str,
    column: &str,
    value: &str,
    approximate: bool,
) -> bool {
    p.hits.push(ValueHit {
        schema: schema.to_string(),
        table: table.to_string(),
        column: column.to_string(),
        value: preview(value),
        approximate,
    });
    p.hits.len() >= VALUE_HIT_LIMIT
}

/// 読めなかったテーブルを覚えておく (権限が無い等)
fn note_skipped(p: &mut Progress, schema: &str, table: &str, err: &str) {
    if p.skipped.len() >= MAX_SKIPPED {
        // 黙って捨てると「見ていないもの」が無かったことになるので数える
        p.omitted += 1;
        return;
    }
    let label = if schema.is_empty() {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    };
    p.skipped.push(format!("{label}: {err}"));
}

/// 1テーブル分の実行計画
struct TablePlan {
    /// 実際に探す列
    names: Vec<String>,
    sql: String,
    /// 列が多すぎて見送った数 (0なら全部見ている)
    dropped: usize,
}

/// このテーブルで探す列と、実行するSQL (探す列が無ければNone)
fn plan_table(
    db: DbType,
    schema: &str,
    table: &str,
    cols: &[SearchColumn],
    opts: &ValueSearchOptions,
) -> Option<TablePlan> {
    let mut names: Vec<String> = cols
        .iter()
        .filter(|c| is_text_type(db, &c.data_type))
        .map(|c| c.column.clone())
        .collect();
    if names.is_empty() {
        return None;
    }
    // 列が多すぎると式が深くなりすぎて読めなくなる (SQLiteは1000段まで)。
    // 見送った分は黙って落とさず、画面に出して分かるようにする
    let dropped = names.len().saturating_sub(MAX_COLS_PER_QUERY);
    names.truncate(MAX_COLS_PER_QUERY);
    let schema_opt = (!schema.is_empty()).then_some(schema);
    let table_sql = crate::ddl::quote_table(db, schema_opt, table);
    let sql = value_query(db, &table_sql, &names, opts.ignore_case);
    Some(TablePlan {
        names,
        sql,
        dropped,
    })
}

/// 列を見送ったテーブルを控える (「見つからない」と「見ていない」を区別できるように)
fn note_dropped_columns(p: &mut Progress, schema: &str, table: &str, plan: &TablePlan) {
    if plan.dropped == 0 {
        return;
    }
    let kept = plan.names.len();
    let dropped = plan.dropped;
    note_skipped(
        p,
        schema,
        table,
        &format!("列が多いため先頭{kept}列だけを見ました (残り{dropped}列は未確認)"),
    );
}

/// 結果をまとめる
fn finish(p: Progress, cancelled: bool, truncated: bool) -> ValueSearchResult {
    let mut skipped = p.skipped;
    // 上限で載せきれなかったぶんは、件数だけでも伝える
    if p.omitted > 0 {
        skipped.push(format!("ほか{}件は表示していません", p.omitted));
    }
    ValueSearchResult {
        hits: p.hits,
        scanned: p.scanned,
        cancelled,
        truncated,
        skipped,
    }
}

/// 1行ぶんを文字列の並びにする
fn row_to_texts<R: Row>(row: &R, width: usize) -> Vec<Option<String>>
where
    for<'a> Option<String>: sqlx::Decode<'a, R::Database> + sqlx::Type<R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    (0..width)
        .map(|i| row.try_get::<Option<String>, _>(i).unwrap_or(None))
        .collect()
}

/// 中止されたか
fn cancelled(job: Option<&CsvJob>) -> bool {
    job.is_some_and(|j| j.is_cancelled())
}

/// MySQL: 値を探す
pub async fn mysql_values(
    conn: &mut MySqlConnection,
    tables: Vec<(String, String, Vec<SearchColumn>)>,
    opts: &ValueSearchOptions,
    job: Option<&CsvJob>,
    ctx: &LogCtx<'_>,
) -> ValueSearchResult {
    let pattern = bind_value(DbType::Mysql, opts.ignore_case, &opts.needle);
    let mut p = Progress::new();
    for (schema, table, cols) in tables {
        if cancelled(job) {
            return finish(p, true, false);
        }
        let Some(plan) = plan_table(DbType::Mysql, &schema, &table, &cols, opts) else {
            continue;
        };
        note_dropped_columns(&mut p, &schema, &table, &plan);
        let TablePlan { names, sql, .. } = plan;
        p.scanned += 1;
        if let Some(j) = job {
            j.set_rows(p.scanned);
        }
        // 1テーブルごとに残すと履歴が埋まるので、最初の1本だけ形を残す
        if p.scanned == 1 {
            ctx.qlog.add(ctx.connection, ctx.database, &sql);
        }
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for _ in &names {
            q = q.bind(&pattern);
        }
        match timeout(SEARCH_TIMEOUT, q.fetch_all(&mut *conn)).await {
            Ok(Ok(rows)) => {
                let texts = rows
                    .iter()
                    .map(|r| row_to_texts(r, names.len()))
                    .collect();
                if collect_hits(&mut p, &schema, &table, &names, texts, opts) {
                    return finish(p, false, true);
                }
            }
            // 「中止」を押すとサーバー側からも止めに行くので、そのエラーが先に返る
            Ok(Err(_)) if cancelled(job) => return finish(p, true, false),
            Ok(Err(e)) => note_skipped(&mut p, &schema, &table, &format_db_error(e)),
            Err(_) => note_skipped(&mut p, &schema, &table, "タイムアウトしました"),
        }
        if p.scanned >= MAX_TABLES || p.over_deadline() {
            return finish(p, false, true);
        }
    }
    finish(p, false, false)
}

/// PostgreSQL: 値を探す
pub async fn pg_values(
    conn: &mut PgConnection,
    tables: Vec<(String, String, Vec<SearchColumn>)>,
    opts: &ValueSearchOptions,
    job: Option<&CsvJob>,
    ctx: &LogCtx<'_>,
) -> ValueSearchResult {
    let pattern = bind_value(DbType::Postgresql, opts.ignore_case, &opts.needle);
    let mut p = Progress::new();
    for (schema, table, cols) in tables {
        if cancelled(job) {
            return finish(p, true, false);
        }
        let Some(plan) = plan_table(DbType::Postgresql, &schema, &table, &cols, opts)
        else {
            continue;
        };
        note_dropped_columns(&mut p, &schema, &table, &plan);
        let TablePlan { names, sql, .. } = plan;
        p.scanned += 1;
        if let Some(j) = job {
            j.set_rows(p.scanned);
        }
        // 1テーブルごとに残すと履歴が埋まるので、最初の1本だけ形を残す
        if p.scanned == 1 {
            ctx.qlog.add(ctx.connection, ctx.database, &sql);
        }
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for _ in &names {
            q = q.bind(&pattern);
        }
        match timeout(SEARCH_TIMEOUT, q.fetch_all(&mut *conn)).await {
            Ok(Ok(rows)) => {
                let texts = rows
                    .iter()
                    .map(|r| row_to_texts(r, names.len()))
                    .collect();
                if collect_hits(&mut p, &schema, &table, &names, texts, opts) {
                    return finish(p, false, true);
                }
            }
            // 「中止」を押すとサーバー側からも止めに行くので、そのエラーが先に返る
            Ok(Err(_)) if cancelled(job) => return finish(p, true, false),
            Ok(Err(e)) => note_skipped(&mut p, &schema, &table, &format_db_error(e)),
            Err(_) => note_skipped(&mut p, &schema, &table, "タイムアウトしました"),
        }
        if p.scanned >= MAX_TABLES || p.over_deadline() {
            return finish(p, false, true);
        }
    }
    finish(p, false, false)
}

/// SQLite: 値を探す
pub async fn sqlite_values(
    conn: &mut SqliteConnection,
    tables: Vec<(String, String, Vec<SearchColumn>)>,
    opts: &ValueSearchOptions,
    job: Option<&CsvJob>,
    ctx: &LogCtx<'_>,
) -> ValueSearchResult {
    let pattern = bind_value(DbType::Sqlite, opts.ignore_case, &opts.needle);
    let mut p = Progress::new();
    for (schema, table, cols) in tables {
        if cancelled(job) {
            return finish(p, true, false);
        }
        let Some(plan) = plan_table(DbType::Sqlite, &schema, &table, &cols, opts) else {
            continue;
        };
        note_dropped_columns(&mut p, &schema, &table, &plan);
        let TablePlan { names, sql, .. } = plan;
        p.scanned += 1;
        if let Some(j) = job {
            j.set_rows(p.scanned);
        }
        // 1テーブルごとに残すと履歴が埋まるので、最初の1本だけ形を残す
        if p.scanned == 1 {
            ctx.qlog.add(ctx.connection, ctx.database, &sql);
        }
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for _ in &names {
            q = q.bind(&pattern);
        }
        match timeout(SEARCH_TIMEOUT, q.fetch_all(&mut *conn)).await {
            Ok(Ok(rows)) => {
                let texts = rows
                    .iter()
                    .map(|r| row_to_texts(r, names.len()))
                    .collect();
                if collect_hits(&mut p, &schema, &table, &names, texts, opts) {
                    return finish(p, false, true);
                }
            }
            // 「中止」を押すとサーバー側からも止めに行くので、そのエラーが先に返る
            Ok(Err(_)) if cancelled(job) => return finish(p, true, false),
            Ok(Err(e)) => note_skipped(&mut p, &schema, &table, &format_db_error(e)),
            Err(_) => note_skipped(&mut p, &schema, &table, "タイムアウトしました"),
        }
        if p.scanned >= MAX_TABLES || p.over_deadline() {
            return finish(p, false, true);
        }
    }
    finish(p, false, false)
}

/// 当たったかどうかを画面と同じ見方で確かめる
fn contains(value: &str, needle: &str, ignore_case: bool) -> bool {
    if ignore_case {
        value.to_lowercase().contains(&needle.to_lowercase())
    } else {
        value.contains(needle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn データベースを選んでいなければ探さない() {
        /*
         * 探す範囲は画面で選んでいるデータベースの中だけ。
         * 選んでいないときに黙って全体を探すと、
         * 画面に出ている範囲と食い違って「今どこを見ているのか」が分からなくなる
         */
        assert_eq!(search_scope(Some("shop")), Ok("shop"));

        for empty in [None, Some(""), Some("   ")] {
            let err = search_scope(empty).expect_err("選んでいなければエラー");
            assert!(err.contains("データベースを選んで"), "{err}");
        }
    }

    #[test]
    fn likeのパターンに直す() {
        assert_eq!(like_pattern("abc"), "%abc%");
        // ワイルドカードは打ち消す
        assert_eq!(like_pattern("a%b"), "%a!%b%");
        assert_eq!(like_pattern("a_b"), "%a!_b%");
        // エスケープ文字そのものも打ち消す
        assert_eq!(like_pattern("a!b"), "%a!!b%");
    }

    #[test]
    fn 大文字小文字の扱いはdbで変わる() {
        assert_eq!(like_op(DbType::Postgresql, true), "ILIKE");
        assert_eq!(like_op(DbType::Postgresql, false), "LIKE");
        assert_eq!(like_op(DbType::Mysql, true), "LIKE");
        assert_eq!(like_op(DbType::Mysql, false), "LIKE BINARY");
        assert_eq!(like_op(DbType::Sqlite, true), "LIKE");
    }

    #[test]
    fn 文字列として読める型を見分ける() {
        assert!(is_text_type(DbType::Mysql, "varchar(255)"));
        assert!(is_text_type(DbType::Mysql, "longtext"));
        assert!(is_text_type(DbType::Mysql, "enum('a','b')"));
        assert!(is_text_type(DbType::Postgresql, "character varying"));
        assert!(is_text_type(DbType::Postgresql, "jsonb"));
        assert!(!is_text_type(DbType::Mysql, "int(11)"));
        assert!(!is_text_type(DbType::Postgresql, "timestamp with time zone"));
        // SQLiteは型を書かない列があり、そこには何でも入る
        assert!(is_text_type(DbType::Sqlite, ""));
        assert!(!is_text_type(DbType::Mysql, ""));
    }

    #[test]
    fn sqliteで区別するときはinstrを使う() {
        // SQLiteのLIKEはASCIIの大小を区別しないので、区別したいときは instr で見る
        let sql = value_query(DbType::Sqlite, "\"t\"", &["a".to_string()], false);
        assert!(sql.contains("instr(CAST(\"a\" AS TEXT), ?) > 0"), "{sql}");
        // 読み出す値は先頭だけにする (巨大なTEXTをそのまま持ってこない)
        assert!(sql.contains("substr(CAST(\"a\" AS TEXT), 1, 1000) AS c0"), "{sql}");
        // 渡す値もパターンではなく探す文字列そのものになる
        assert_eq!(bind_value(DbType::Sqlite, false, "a%b"), "a%b");
        assert_eq!(bind_value(DbType::Sqlite, true, "a%b"), "%a!%b%");
        assert_eq!(bind_value(DbType::Mysql, false, "a%b"), "%a!%b%");
    }

    #[test]
    fn mysqlの検索sqlを組み立てる() {
        let sql = value_query(
            DbType::Mysql,
            "`t`",
            &["a".to_string(), "b".to_string()],
            true,
        );
        assert_eq!(
            sql,
            "SELECT LEFT(CAST(`a` AS CHAR), 1000) AS c0, \
             LEFT(CAST(`b` AS CHAR), 1000) AS c1 FROM `t` \
             WHERE CAST(`a` AS CHAR) LIKE ? ESCAPE '!' \
             OR CAST(`b` AS CHAR) LIKE ? ESCAPE '!' LIMIT 20"
        );
    }

    #[test]
    fn postgresqlは番号付きのプレースホルダを使う() {
        let sql = value_query(
            DbType::Postgresql,
            "\"s\".\"t\"",
            &["a".to_string(), "b".to_string()],
            true,
        );
        assert!(sql.contains("\"a\"::text ILIKE $1 ESCAPE '!'"));
        assert!(sql.contains("\"b\"::text ILIKE $2 ESCAPE '!'"));
    }

    #[test]
    fn 列名はクォートする() {
        let sql = value_query(DbType::Mysql, "`t`", &["a`b".to_string()], true);
        assert!(sql.contains("`a``b`"), "{sql}");
    }

    #[test]
    fn 列が多いテーブルは見送った分を控える() {
        let col = |c: &str| SearchColumn {
            schema: String::new(),
            table: "wide".to_string(),
            column: c.to_string(),
            data_type: "text".to_string(),
        };
        let opts = ValueSearchOptions {
            needle: "x".into(),
            ignore_case: false,
        };
        let cols: Vec<SearchColumn> =
            (0..MAX_COLS_PER_QUERY + 5).map(|i| col(&format!("c{i}"))).collect();
        let plan = plan_table(DbType::Sqlite, "", "wide", &cols, &opts).unwrap();
        assert_eq!(plan.names.len(), MAX_COLS_PER_QUERY);
        assert_eq!(plan.dropped, 5);

        // 「見つからない」と「見ていない」を区別できるよう画面に出す
        let mut p = Progress::new();
        note_dropped_columns(&mut p, "", "wide", &plan);
        assert_eq!(p.skipped.len(), 1);
        assert!(p.skipped[0].contains("残り5列は未確認"), "{:?}", p.skipped);

        // 収まっているテーブルには何も出さない
        let few: Vec<SearchColumn> = (0..3).map(|i| col(&format!("c{i}"))).collect();
        let plan = plan_table(DbType::Sqlite, "", "wide", &few, &opts).unwrap();
        assert_eq!(plan.dropped, 0);
        let mut p = Progress::new();
        note_dropped_columns(&mut p, "", "wide", &plan);
        assert!(p.skipped.is_empty());
    }

    #[test]
    fn 載せきれなかった件数も伝える() {
        let mut p = Progress::new();
        for i in 0..MAX_SKIPPED + 3 {
            note_skipped(&mut p, "", &format!("t{i}"), "読めません");
        }
        assert_eq!(p.skipped.len(), MAX_SKIPPED);
        assert_eq!(p.omitted, 3);
        let out = finish(p, false, false);
        // 黙って消えず、件数だけでも残る
        assert_eq!(out.skipped.len(), MAX_SKIPPED + 1);
        assert!(out.skipped.last().unwrap().contains("ほか3件"));
    }

    #[test]
    fn テーブルごとにまとめる() {
        let col = |s: &str, t: &str, c: &str| SearchColumn {
            schema: s.to_string(),
            table: t.to_string(),
            column: c.to_string(),
            data_type: "text".to_string(),
        };
        let grouped = group_by_table(vec![
            col("", "a", "x"),
            col("", "a", "y"),
            col("", "b", "z"),
        ]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].2.len(), 2);
        assert_eq!(grouped[1].1, "b");
        // スキーマが違えば別のテーブル
        let grouped = group_by_table(vec![col("s1", "a", "x"), col("s2", "a", "x")]);
        assert_eq!(grouped.len(), 2);
    }

    #[test]
    fn 見つけた値は先頭だけ出す() {
        let long = "あ".repeat(200);
        assert!(preview(&long).ends_with('…'));
        assert_eq!(preview("短い"), "短い");
    }

    #[test]
    fn 当たりの見方を画面と揃える() {
        assert!(contains("ABCdef", "abc", true));
        assert!(!contains("ABCdef", "abc", false));
        assert!(contains("ABCdef", "ABC", false));
    }
}
