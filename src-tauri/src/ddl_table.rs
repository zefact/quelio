//! 新しいテーブルを作るCREATE TABLE文の組み立て。
//!
//! カラム変更 (ddl.rs) とは入力の形も書き方も違うので、別のモジュールにする。
//! 組み立てたSQLは画面で確認してから実行する

use std::collections::HashSet;

use serde::Deserialize;

use crate::ddl::{
    literal, mysql_column_def, pg_collate, quote, quote_table, some_trimmed, validate,
    validate_collation, validate_table_name, validate_type, ColumnSpec,
};
use crate::models::DbType;

/// これから作るテーブルの内容 (画面の入力そのもの)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTable {
    /// スキーマ (PostgreSQLのみ。空なら検索パス任せ)
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default)]
    pub columns: Vec<ColumnSpec>,
    /// 主キーにするカラム名 (並べた順のまま複合キーにする)
    #[serde(default)]
    pub primary_key: Vec<String>,
    /// 既定の文字コード (MySQLのみ)
    #[serde(default)]
    pub charset: Option<String>,
    /// 既定の照合順序 (MySQLのみ)
    #[serde(default)]
    pub collation: Option<String>,
    /// テーブルコメント (MySQL / PostgreSQLのみ)
    #[serde(default)]
    pub comment: Option<String>,
}

/// このカラムを自動採番にするか (画面のチェックはEXTRAとして送られてくる)
fn auto_increment(spec: &ColumnSpec) -> bool {
    some_trimmed(&spec.extra)
        .map(|e| e.to_uppercase().contains("AUTO_INCREMENT"))
        .unwrap_or(false)
}

/// 主キーに入っているカラムか
fn in_primary_key(t: &NewTable, name: &str) -> bool {
    t.primary_key
        .iter()
        .any(|k| k.trim().eq_ignore_ascii_case(name.trim()))
}

/// 主キーの指定 ("PRIMARY KEY (`a`, `b`)")
fn primary_key_line(db: DbType, t: &NewTable) -> String {
    let cols: Vec<String> = t
        .primary_key
        .iter()
        .map(|k| quote(db, k.trim()))
        .collect();
    format!("PRIMARY KEY ({})", cols.join(", "))
}

/// カラム定義を並べたCREATE TABLEの本体
fn create_table_sql(head: &str, lines: &[String]) -> String {
    format!("CREATE TABLE {} (\n  {}\n)", head, lines.join(",\n  "))
}

/// 入力内容を確かめてからCREATE TABLE文を組み立てる。
///
/// `types` はそのサーバーで使える型名 (空ならチェックしない)
pub fn build(db: DbType, t: &NewTable, types: &[String]) -> Result<Vec<String>, String> {
    if db == DbType::Valkey {
        return Err("Valkey接続ではテーブルを作成できません".into());
    }
    validate_table_name(&t.name)?;
    if let Some(s) = schema_of(t) {
        validate_table_name(&s).map_err(|_| format!("スキーマ名が正しくありません: {s}"))?;
    }
    if t.columns.is_empty() {
        return Err("カラムを1つ以上入れてください".into());
    }

    let mut seen = HashSet::new();
    for c in &t.columns {
        validate(db, c, true)?;
        validate_type(db, &c.col_type, types)?;
        if !seen.insert(c.name.trim().to_lowercase()) {
            return Err(format!("カラム名が重複しています: {}", c.name.trim()));
        }
    }
    for k in &t.primary_key {
        if !t
            .columns
            .iter()
            .any(|c| c.name.trim().eq_ignore_ascii_case(k.trim()))
        {
            return Err(format!("主キーに指定したカラムがありません: {}", k.trim()));
        }
    }
    // 自動採番は主キーにしないと通らない (MySQLはキーが要る、SQLiteは主キー限定)。
    // DBのエラーは分かりにくいので、ここで理由を出す
    if db != DbType::Postgresql {
        for c in &t.columns {
            if auto_increment(c) && !in_primary_key(t, &c.name) {
                return Err(format!(
                    "自動採番のカラムは主キーにしてください: {}",
                    c.name.trim()
                ));
            }
        }
    }

    match db {
        DbType::Mysql => mysql(t),
        DbType::Postgresql => Ok(postgres(t)),
        DbType::Sqlite => Ok(sqlite(t)),
        DbType::Valkey => unreachable!("先頭で弾いている"),
    }
}

/// スキーマ名 (空文字は指定なしとみなす)
fn schema_of(t: &NewTable) -> Option<String> {
    some_trimmed(&t.schema)
}

fn mysql(t: &NewTable) -> Result<Vec<String>, String> {
    let db = DbType::Mysql;
    // 文字コードと照合順序はクォートせずそのまま書くので、名前の形を確かめる
    let charset = some_trimmed(&t.charset);
    let collation = some_trimmed(&t.collation);
    for name in [&charset, &collation].into_iter().flatten() {
        validate_collation(name)?;
    }

    let mut lines: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            // 位置指定 (AFTER) は新規作成では使わないので落とす
            let spec = ColumnSpec {
                after: None,
                ..c.clone()
            };
            mysql_column_def(&spec)
        })
        .collect();
    if !t.primary_key.is_empty() {
        lines.push(primary_key_line(db, t));
    }

    let mut sql = create_table_sql(&quote_table(db, None, t.name.trim()), &lines);
    if let Some(cs) = charset {
        sql.push_str(&format!(" DEFAULT CHARSET = {cs}"));
    }
    if let Some(co) = collation {
        sql.push_str(&format!(" COLLATE = {co}"));
    }
    if let Some(c) = some_trimmed(&t.comment) {
        sql.push_str(&format!(" COMMENT = {}", literal(&c)));
    }
    Ok(vec![sql])
}

/// PostgreSQLで自動採番にするときの型。
/// 画面のチェックを serial 系に読み替える (整数型以外はそのまま)
fn pg_type(spec: &ColumnSpec) -> String {
    let raw = spec.col_type.trim();
    if !auto_increment(spec) {
        return raw.to_string();
    }
    match raw.to_lowercase().as_str() {
        "integer" | "int" | "int4" => "serial".to_string(),
        "bigint" | "int8" => "bigserial".to_string(),
        "smallint" | "int2" => "smallserial".to_string(),
        _ => raw.to_string(),
    }
}

fn postgres(t: &NewTable) -> Vec<String> {
    let db = DbType::Postgresql;
    let table = quote_table(db, schema_of(t).as_deref(), t.name.trim());

    let mut lines: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let mut s = format!("{} {}", quote(db, c.name.trim()), pg_type(c));
            s.push_str(&pg_collate(c));
            // NULL可は書かない (既定がNULL可のため)
            if !c.nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(d) = some_trimmed(&c.default) {
                s.push_str(&format!(" DEFAULT {d}"));
            }
            s
        })
        .collect();
    if !t.primary_key.is_empty() {
        lines.push(primary_key_line(db, t));
    }

    // コメントは別の文になる
    let mut out = vec![create_table_sql(&table, &lines)];
    if let Some(c) = some_trimmed(&t.comment) {
        out.push(format!("COMMENT ON TABLE {table} IS {}", literal(&c)));
    }
    for col in &t.columns {
        if let Some(c) = some_trimmed(&col.comment) {
            out.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                quote(db, col.name.trim()),
                literal(&c)
            ));
        }
    }
    out
}

/// SQLiteで `INTEGER PRIMARY KEY AUTOINCREMENT` と書けるか。
/// この書き方はカラム定義の中にしか置けず、
/// 単独の主キーで整数型のときだけ使える
fn sqlite_inline_rowid(t: &NewTable, spec: &ColumnSpec) -> bool {
    auto_increment(spec)
        && t.primary_key.len() == 1
        && in_primary_key(t, &spec.name)
        && spec.col_type.trim().eq_ignore_ascii_case("integer")
}

fn sqlite(t: &NewTable) -> Vec<String> {
    let db = DbType::Sqlite;
    let inline = t.columns.iter().any(|c| sqlite_inline_rowid(t, c));

    let mut lines: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let mut s = format!("{} {}", quote(db, c.name.trim()), c.col_type.trim());
            if sqlite_inline_rowid(t, c) {
                s.push_str(" PRIMARY KEY AUTOINCREMENT");
                return s;
            }
            if !c.nullable {
                s.push_str(" NOT NULL");
            }
            if let Some(d) = some_trimmed(&c.default) {
                s.push_str(&format!(" DEFAULT {d}"));
            }
            s
        })
        .collect();
    // カラム定義の中に書いた場合は、表の最後に主キーを書かない (二重指定になる)
    if !t.primary_key.is_empty() && !inline {
        lines.push(primary_key_line(db, t));
    }
    // SQLiteはスキーマもコメントも持たないので、テーブル名だけを使う
    vec![create_table_sql(&quote(db, t.name.trim()), &lines)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, col_type: &str) -> ColumnSpec {
        ColumnSpec {
            name: name.to_string(),
            col_type: col_type.to_string(),
            ..Default::default()
        }
    }

    fn table(columns: Vec<ColumnSpec>) -> NewTable {
        NewTable {
            name: "users".to_string(),
            columns,
            primary_key: vec!["id".to_string()],
            ..Default::default()
        }
    }

    #[test]
    fn mysqlは文字コードと自動採番を書く() {
        let mut t = table(vec![
            ColumnSpec {
                extra: Some("auto_increment".to_string()),
                ..col("id", "int")
            },
            ColumnSpec {
                nullable: true,
                comment: Some("氏名".to_string()),
                ..col("name", "varchar(100)")
            },
        ]);
        t.charset = Some("utf8mb4".to_string());
        t.collation = Some("utf8mb4_0900_ai_ci".to_string());
        t.comment = Some("利用者".to_string());
        let sql = build(DbType::Mysql, &t, &[]).unwrap();
        assert_eq!(sql.len(), 1);
        assert!(sql[0].contains("`id` int NOT NULL AUTO_INCREMENT"), "{}", sql[0]);
        assert!(sql[0].contains("`name` varchar(100) NULL COMMENT '氏名'"), "{}", sql[0]);
        assert!(sql[0].contains("PRIMARY KEY (`id`)"), "{}", sql[0]);
        assert!(sql[0].contains("DEFAULT CHARSET = utf8mb4"), "{}", sql[0]);
        assert!(sql[0].contains("COLLATE = utf8mb4_0900_ai_ci"), "{}", sql[0]);
        assert!(sql[0].ends_with("COMMENT = '利用者'"), "{}", sql[0]);
    }

    #[test]
    fn postgresqlはコメントを別の文にする() {
        let mut t = table(vec![
            ColumnSpec {
                extra: Some("auto_increment".to_string()),
                ..col("id", "integer")
            },
            ColumnSpec {
                comment: Some("氏名".to_string()),
                ..col("name", "text")
            },
        ]);
        t.schema = Some("app".to_string());
        t.comment = Some("利用者".to_string());
        let sql = build(DbType::Postgresql, &t, &[]).unwrap();
        // 自動採番は serial に読み替える
        assert!(sql[0].contains("\"id\" serial NOT NULL"), "{}", sql[0]);
        assert!(sql[0].starts_with("CREATE TABLE \"app\".\"users\""), "{}", sql[0]);
        assert_eq!(sql[1], "COMMENT ON TABLE \"app\".\"users\" IS '利用者'");
        assert_eq!(
            sql[2],
            "COMMENT ON COLUMN \"app\".\"users\".\"name\" IS '氏名'"
        );
    }

    #[test]
    fn sqliteは主キーをカラムの中に書く() {
        let t = table(vec![
            ColumnSpec {
                extra: Some("auto_increment".to_string()),
                ..col("id", "integer")
            },
            col("name", "text"),
        ]);
        let sql = build(DbType::Sqlite, &t, &[]).unwrap();
        assert!(
            sql[0].contains("\"id\" integer PRIMARY KEY AUTOINCREMENT"),
            "{}",
            sql[0]
        );
        // 二重に主キーを書かない
        assert!(!sql[0].contains("PRIMARY KEY (\"id\")"), "{}", sql[0]);
    }

    #[test]
    fn sqliteの複合主キーは表の最後に書く() {
        let mut t = table(vec![col("a", "integer"), col("b", "integer")]);
        t.primary_key = vec!["a".to_string(), "b".to_string()];
        let sql = build(DbType::Sqlite, &t, &[]).unwrap();
        assert!(sql[0].contains("PRIMARY KEY (\"a\", \"b\")"), "{}", sql[0]);
    }

    #[test]
    fn 同じ名前のカラムは作れない() {
        let t = table(vec![col("id", "int"), col("ID", "int")]);
        let err = build(DbType::Mysql, &t, &[]).unwrap_err();
        assert!(err.contains("重複"), "{err}");
    }

    #[test]
    fn 主キーに無いカラムは指定できない() {
        let mut t = table(vec![col("id", "int")]);
        t.primary_key = vec!["missing".to_string()];
        let err = build(DbType::Mysql, &t, &[]).unwrap_err();
        assert!(err.contains("主キー"), "{err}");
    }

    #[test]
    fn 自動採番は主キーでないと通さない() {
        let mut t = table(vec![
            col("id", "int"),
            ColumnSpec {
                extra: Some("auto_increment".to_string()),
                ..col("no", "int")
            },
        ]);
        t.primary_key = vec!["id".to_string()];
        let err = build(DbType::Mysql, &t, &[]).unwrap_err();
        assert!(err.contains("自動採番"), "{err}");
    }

    #[test]
    fn カラムが無いと作れない() {
        let t = table(vec![]);
        assert!(build(DbType::Mysql, &t, &[]).is_err());
    }

    #[test]
    fn デフォルト値に定義を書き足せない() {
        let t = table(vec![ColumnSpec {
            default: Some("0, ADD COLUMN evil int".to_string()),
            ..col("id", "int")
        }]);
        assert!(build(DbType::Mysql, &t, &[]).is_err());
    }

    #[test]
    fn 使えない型は弾く() {
        let t = table(vec![col("id", "nosuchtype")]);
        let types = vec!["int".to_string(), "varchar".to_string()];
        assert!(build(DbType::Mysql, &t, &types).is_err());
        // 一覧が空のときはチェックしない (取れないサーバーで作れなくならないように)
        assert!(build(DbType::Mysql, &t, &[]).is_ok());
    }

    #[test]
    fn valkeyでは作れない() {
        let t = table(vec![col("id", "int")]);
        assert!(build(DbType::Valkey, &t, &[]).is_err());
    }
}
