use super::*;

/// テストデータの作り方の案を返す (列ごとの推測)
#[tauri::command]
pub async fn plan_test_data(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> Result<Vec<sessions::ColumnPlan>, String> {
    let delim = crate::app_settings::load(&app)?.comment_delimiter;
    sessions::plan_test_data(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        &delim,
    )
    .await
}

/// テストデータを作ってテーブルへ入れる。
///
/// 進捗の取得・中止はCSVと同じ仕組み (`csv_export_status` / `cancel_csv_export`) を使う
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_test_data(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    rows: usize,
    null_rate: u8,
    columns: Vec<sessions::GenColumn>,
    job_id: String,
) -> Result<sessions::GenResult, String> {
    let delim = crate::app_settings::load(&app)?.comment_delimiter;
    let job = jobs.start(&job_id, &session_id);
    let res = sessions::generate_test_data(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        rows,
        null_rate,
        &columns,
        &delim,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);
    res
}
