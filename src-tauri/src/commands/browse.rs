//! 一覧と定義の参照 (テーブル・カラム・ルーチン・実行中の接続)

use super::*;

/// 指定データベースのテーブル一覧を返す
#[tauri::command]
pub async fn list_tables(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    sessions::list_tables(&state, &qlog, &session_id, &database).await
}

/// テーブル構造(カラム・インデックス・情報)を返す
#[tauri::command]
pub async fn table_detail(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<TableDetail, String> {
    sessions::table_detail(&state, &qlog, &session_id, &database, schema, &table).await
}

/// SQLエディタの補完に使うテーブル・カラム名の一覧を返す
#[tauri::command]
pub async fn schema_columns(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<catalog::SchemaColumns, String> {
    sessions::schema_columns(&state, &qlog, &session_id, &database).await
}

/// カラムに使える型の一覧を返す (カラム編集の選択肢用)
#[tauri::command]
pub async fn list_column_types(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    sessions::list_column_types(&state, &qlog, &session_id, &database).await
}

/// 使える照合順序の一覧を返す (カラム編集の選択肢用)
#[tauri::command]
pub async fn list_collations(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    sessions::list_collations(&state, &qlog, &session_id, &database).await
}

/// 関数・プロシージャ・トリガの定義を返す
#[tauri::command]
pub async fn list_routines(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<crate::catalog::RoutineInfo>, String> {
    sessions::list_routines(&state, &qlog, &session_id, &database).await
}

/// テーブルの正確な行数を数える (一覧の概算行数との差を確かめる)
#[tauri::command]
pub async fn count_table_rows(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> Result<i64, String> {
    let timeout_secs = crate::app_settings::load(&app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);
    sessions::count_table_rows(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        timeout_secs,
    )
    .await
}

/// 画面で切り詰められたセルの全文を読み直す (主キーで1行に絞る)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_cell(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    column: String,
    key: Vec<crate::dml::Cell>,
) -> Result<sessions::CellValue, String> {
    let timeout_secs = crate::app_settings::load(&app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);
    sessions::fetch_cell(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        &column,
        &key,
        timeout_secs,
    )
    .await
}

/// データを1行だけ追加・更新・削除し、実行したSQLを返す
#[tauri::command]
pub async fn apply_row_change(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    change: crate::dml::RowChange,
) -> Result<String, String> {
    sessions::apply_row_change(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        &change,
    )
    .await
}

/// テーブルの CREATE 文を返す (定義の共有・コピー用)
#[tauri::command]
pub async fn table_ddl(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> Result<String, String> {
    sessions::table_ddl(&state, &qlog, &session_id, database, schema, &table).await
}

/// サーバー側で動いている接続の一覧を返す
#[tauri::command]
pub async fn list_processes(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    // log: コンソールに記録するか (定期取得では記録しない)
    log: bool,
) -> Result<Vec<crate::catalog::ProcessInfo>, String> {
    sessions::list_processes(&state, &qlog, &session_id, &database, log).await
}

/// 他の接続のSQLを中止する / 接続を切る
#[tauri::command]
pub async fn kill_process(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    target: i64,
    action: sessions::ProcessAction,
) -> Result<(), String> {
    sessions::kill_process(&state, &qlog, &session_id, &database, target, action).await
}

/// スキーマの読み込み (専用接続) を中止する
#[tauri::command]
pub async fn cancel_schema_load(
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    session_id: String,
) -> Result<(), String> {
    sessions::cancel_schema_load(&cancel, &qlog, &session_id).await
}

/// 開いているセッションの一覧 (差分ビューア用)
#[tauri::command]
pub async fn list_sessions(state: State<'_, Sessions>) -> Result<Vec<SessionSummary>, String> {
    Ok(sessions::list_sessions(&state).await)
}

/// 指定DBのスキーマスナップショットを返す (差分ビューア用)
#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<SchemaEntry>, String> {
    sessions::schema_snapshot(&state, &qlog, &session_id, &database).await
}

/// ER図がひと呼び出しで受け取る内容
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErSchema {
    entries: Vec<crate::models::SchemaEntry>,
    foreign_keys: Vec<crate::models::FkInfo>,
}

/// ER図用: スキーマと外部キーをまとめて返す (収集用の接続を1本で済ませる)
#[tauri::command]
pub async fn schema_with_foreign_keys(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<ErSchema, String> {
    let (entries, foreign_keys) =
        sessions::schema_with_foreign_keys(&state, &qlog, &session_id, &database).await?;
    Ok(ErSchema {
        entries,
        foreign_keys,
    })
}

/// ピン留めしているテーブルの一覧を返す (接続・DBごと)
#[tauri::command]
pub fn list_pinned_tables(
    app: AppHandle,
    profile_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    crate::pinned::list(&app, &profile_id, &database)
}

/// テーブルのピンを付け外しして、そのあとの一覧を返す
#[tauri::command]
pub fn set_pinned_table(
    app: AppHandle,
    profile_id: String,
    database: String,
    table: String,
    pinned: bool,
) -> Result<Vec<String>, String> {
    crate::pinned::set(&app, &profile_id, &database, &table, pinned)
}
