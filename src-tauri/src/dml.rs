//! データ編集 (INSERT / UPDATE / DELETE) のSQL生成。
//!
//! 値はSQLに埋め込まず必ずプレースホルダで渡す。
//! PostgreSQLだけは文字列のまま渡すと型が合わないため、
//! DBから取得したカラム型でキャストを付ける

use std::collections::HashMap;

use serde::Deserialize;

use crate::models::DbType;

/// 1カラム分の値 (NULLはNone)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub column: String,
    pub value: Option<String>,
}

/// 1行に対する変更内容
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowChange {
    /// 値の更新 (keyで行を特定し、setの内容へ書き換える)
    Update { key: Vec<Cell>, set: Vec<Cell> },
    /// 行の追加
    Insert { values: Vec<Cell> },
    /// 行の削除
    Delete { key: Vec<Cell> },
}

impl RowChange {
    /// 行を特定するキー (追加のときは無い)
    pub fn key(&self) -> Option<&[Cell]> {
        match self {
            RowChange::Update { key, .. } | RowChange::Delete { key } => Some(key),
            RowChange::Insert { .. } => None,
        }
    }
}

/// 識別子をDB種別に応じてクォートする
fn quote(db: DbType, ident: &str) -> String {
    if db == DbType::Mysql {
        format!("`{}`", ident.replace('`', "``"))
    } else {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }
}

/// スキーマ付きのテーブル名 (SQLiteはスキーマの概念が無いので名前だけ)
fn quote_table(db: DbType, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) if db != DbType::Sqlite => {
            format!("{}.{}", quote(db, s), quote(db, table))
        }
        _ => quote(db, table),
    }
}

/// キャストに使える型名か (DBから取った値のはずだが、念のため字種を絞る)
fn safe_type(t: &str) -> bool {
    !t.is_empty()
        && t.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, ' ' | '_' | '(' | ')' | ',' | '[' | ']' | '.')
        })
}

/// プレースホルダを作りながら値を集める
struct Binder<'a> {
    db: DbType,
    /// PostgreSQLのキャスト用 (カラム名 → 型)
    types: &'a HashMap<String, String>,
    params: Vec<Option<String>>,
}

impl<'a> Binder<'a> {
    fn new(db: DbType, types: &'a HashMap<String, String>) -> Self {
        Self {
            db,
            types,
            params: Vec::new(),
        }
    }

    /// 値をパラメータに積み、SQLに書くプレースホルダを返す
    fn push(&mut self, column: &str, value: Option<String>) -> String {
        self.params.push(value);
        if self.db != DbType::Postgresql {
            return "?".to_string();
        }
        let n = self.params.len();
        // PostgreSQLは文字列のまま渡すと型が合わないのでキャストする
        match self.types.get(column) {
            Some(t) if safe_type(t) => format!("CAST(${n} AS {t})"),
            _ => format!("${n}"),
        }
    }
}

/// 変更内容から (SQL, 渡す値) を組み立てる
pub fn build(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    change: &RowChange,
    types: &HashMap<String, String>,
) -> Result<(String, Vec<Option<String>>), String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let t = quote_table(db, schema, table.trim());
    let mut b = Binder::new(db, types);

    let sql = match change {
        RowChange::Update { key, set } => {
            if set.is_empty() {
                return Err("変更点がありません".into());
            }
            let assigns = set
                .iter()
                .map(|c| {
                    let ph = b.push(&c.column, c.value.clone());
                    format!("{} = {ph}", quote(db, &c.column))
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("UPDATE {t} SET {assigns} WHERE {}", where_key(db, &mut b, key)?)
        }
        RowChange::Insert { values } => {
            if values.is_empty() {
                return Err("入力された値がありません".into());
            }
            let cols = values
                .iter()
                .map(|c| quote(db, &c.column))
                .collect::<Vec<_>>()
                .join(", ");
            let phs = values
                .iter()
                .map(|c| b.push(&c.column, c.value.clone()))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {t} ({cols}) VALUES ({phs})")
        }
        RowChange::Delete { key } => {
            format!("DELETE FROM {t} WHERE {}", where_key(db, &mut b, key)?)
        }
    };
    Ok((sql, b.params))
}

/// テーブル全体の行数を数えるSELECTを組み立てる。
/// 一覧に出している概算行数ではなく、正確な件数が要るときに使う
pub fn build_table_count(
    db: DbType,
    schema: Option<&str>,
    table: &str,
) -> Result<String, String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let t = quote_table(db, schema, table.trim());
    // MySQLのCOUNT(*)はBIGINT UNSIGNEDで、そのままでは符号付き整数として読めない
    let count = if db == DbType::Mysql {
        "CAST(COUNT(*) AS SIGNED)"
    } else {
        "COUNT(*)"
    };
    Ok(format!("SELECT {count} FROM {t}"))
}

/// キーに当たる行数を数えるSELECTを組み立てる。
/// 変更を実行する前に「ちょうど1行か」を確かめるために使う
pub fn build_key_count(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    key: &[Cell],
    types: &HashMap<String, String>,
) -> Result<(String, Vec<Option<String>>), String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    let t = quote_table(db, schema, table.trim());
    let mut b = Binder::new(db, types);
    // MySQLのCOUNT(*)はBIGINT UNSIGNEDで、そのままでは符号付き整数として読めない
    let count = if db == DbType::Mysql {
        "CAST(COUNT(*) AS SIGNED)"
    } else {
        "COUNT(*)"
    };
    let sql = format!("SELECT {count} FROM {t} WHERE {}", where_key(db, &mut b, key)?);
    Ok((sql, b.params))
}

/// 1セルだけを読み直すSELECTを組み立てる (画面で切り詰めた長い値の全文取得用)。
/// 主キーで1行に絞り、値はすべてプレースホルダで渡す
pub fn build_cell_select(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    column: &str,
    key: &[Cell],
    types: &HashMap<String, String>,
) -> Result<(String, Vec<Option<String>>), String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    if column.trim().is_empty() {
        return Err("カラムが指定されていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    // 主キーの値が欠けていると WHERE が IS NULL になり、別の行に当たりうる
    if key.iter().any(|c| c.value.is_none()) {
        return Err("主キーの値が取得できないため、この行を特定できません".into());
    }
    let t = quote_table(db, schema, table.trim());
    let mut b = Binder::new(db, types);
    let sql = format!(
        "SELECT {} FROM {t} WHERE {} LIMIT 1",
        quote(db, column),
        where_key(db, &mut b, key)?
    );
    Ok((sql, b.params))
}

/// 行を特定するWHERE句 (主キーの値で絞る)
fn where_key(db: DbType, b: &mut Binder, key: &[Cell]) -> Result<String, String> {
    if key.is_empty() {
        return Err("主キーが無いため、行を特定できません".into());
    }
    Ok(key
        .iter()
        .map(|c| {
            let col = quote(db, &c.column);
            match &c.value {
                // 主キーは通常NULLにならないが、念のため
                None => format!("{col} IS NULL"),
                Some(v) => {
                    let ph = b.push(&c.column, Some(v.clone()));
                    format!("{col} = {ph}")
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" AND "))
}
