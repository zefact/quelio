//! 定義の変更 (テーブル・カラム・インデックス・外部キー) と、
//! データベース / スキーマそのものの操作

use super::*;

/// 入力どおりのテーブルを作成し、実行したSQLを返す
#[tauri::command]
pub async fn create_table(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    table: ddl_table::NewTable,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let types = column_types(&state, &qlog, &session_id, database.as_deref()).await;
    let statements = ddl_table::build(db_type, &table, &types)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// 実行せずに、テーブルを作るSQLを返す (確認ダイアログに出す)
#[tauri::command]
pub async fn preview_create_table(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    table: ddl_table::NewTable,
) -> Result<String, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let types = column_types(&state, &qlog, &session_id, database.as_deref()).await;
    let statements = ddl_table::build(db_type, &table, &types)?;
    Ok(statements.join(";\n") + ";")
}

/// テーブル名を変更し、実行したSQLを返す
#[tauri::command]
pub async fn rename_table(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    new_name: String,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let statements =
        ddl::build_rename_table(db_type, schema.as_deref(), &table, &new_name)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// テーブルを削除し、実行したSQLを返す
#[tauri::command]
pub async fn drop_table(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    table_type: String,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let statements =
        ddl::build_drop_table(db_type, schema.as_deref(), &table, &table_type)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// テーブルのコメント (日本語名) を設定し、実行したSQLを返す
#[tauri::command]
pub async fn set_table_comment(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    comment: String,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let statements =
        ddl::build_set_table_comment(db_type, schema.as_deref(), &table, &comment)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// インデックスの追加・変更・削除を実行し、実行したSQLを返す
#[tauri::command]
pub async fn apply_index_ddl(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    change: ddl::IndexChange,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let statements = ddl::build_index(db_type, schema.as_deref(), &table, &change)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// 外部キーの追加・削除を実行し、実行したSQLを返す
#[tauri::command]
pub async fn apply_foreign_key_ddl(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    change: ddl::ForeignKeyChange,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let statements =
        ddl::build_foreign_key(db_type, schema.as_deref(), &table, &change)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// カラム変更のSQLを組み立てて返す (実行はしない。画面のプレビュー用)
#[tauri::command]
pub async fn preview_column_ddl(
    state: State<'_, Sessions>,
    session_id: String,
    schema: Option<String>,
    table: String,
    change: ddl::ColumnChange,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    // プレビューは削除の確認だけに使うので、型チェックは不要
    ddl::build(db_type, schema.as_deref(), &table, &change, &[])
}

/// 型チェック用の一覧を取る (取れなければ空を返し、チェックを省く)
async fn column_types(
    state: &State<'_, Sessions>,
    qlog: &State<'_, QueryLog>,
    session_id: &str,
    database: Option<&str>,
) -> Vec<String> {
    sessions::list_column_types(state, qlog, session_id, database.unwrap_or(""))
        .await
        .unwrap_or_default()
}

/// カラム変更のSQLを組み立てて実行する (成功したら実行したSQLを返す)
#[tauri::command]
pub async fn apply_column_ddl(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    change: ddl::ColumnChange,
) -> Result<Vec<String>, String> {
    let db_type = sessions::session_db_type(&state, &session_id).await?;
    let types = column_types(&state, &qlog, &session_id, database.as_deref()).await;
    let statements = ddl::build(db_type, schema.as_deref(), &table, &change, &types)?;
    sessions::exec_ddl(&state, &qlog, &session_id, database, &statements).await?;
    Ok(statements)
}

/// データベースを作る (作成後の一覧を返す)
#[tauri::command]
pub async fn create_database(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    name: String,
    encoding: Option<String>,
    collation: Option<String>,
) -> Result<Vec<String>, String> {
    sessions::create_database(&state, &qlog, &session_id, &name, encoding, collation).await
}

/// データベースを消す (削除後の一覧を返す)
#[tauri::command]
pub async fn drop_database(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    name: String,
) -> Result<Vec<String>, String> {
    sessions::drop_database(&state, &qlog, &session_id, &name).await
}

/// スキーマの一覧を返す (PostgreSQLのみ)
#[tauri::command]
pub async fn list_schemas(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    sessions::list_schemas(&state, &qlog, &session_id, &database).await
}

/// スキーマを作る / 消す (処理後の一覧を返す)
#[tauri::command]
pub async fn change_schema(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    name: String,
    drop: bool,
    cascade: bool,
) -> Result<Vec<String>, String> {
    sessions::change_schema(&state, &qlog, &session_id, &database, &name, drop, cascade)
        .await
}

/// 文字コード・照合順序の一覧 (データベース作成の選択肢に使う)
#[tauri::command]
pub async fn list_charsets(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
) -> Result<Vec<crate::catalog::CharsetInfo>, String> {
    sessions::list_charsets(&state, &qlog, &session_id).await
}

/// 実行せずに、データベースを作るSQLを返す (確認ダイアログに出す)。
/// 名前や指定が不正ならここでエラーになるので、実行前に気づける
#[tauri::command]
pub fn preview_create_database(
    db_type: crate::models::DbType,
    name: String,
    encoding: Option<String>,
    collation: Option<String>,
) -> Result<String, String> {
    crate::dbadmin::create_database_sql(
        db_type,
        &name,
        encoding.as_deref(),
        collation.as_deref(),
    )
}

/// 実行せずに、スキーマを作るSQLを返す (確認ダイアログに出す)
#[tauri::command]
pub fn preview_create_schema(
    db_type: crate::models::DbType,
    name: String,
) -> Result<String, String> {
    crate::dbadmin::create_schema_sql(db_type, &name)
}

/// 消してはいけないデータベースの名前を返す (画面で削除ボタンを出さないため)
#[tauri::command]
pub fn system_databases(db_type: crate::models::DbType) -> Vec<String> {
    crate::dbadmin::system_databases(db_type)
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}
