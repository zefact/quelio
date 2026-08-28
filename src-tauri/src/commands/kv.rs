//! Valkey (KVモード) の操作

use super::*;

/// Valkey: キー一覧をSCANで1ページぶん取得する
#[tauri::command]
pub async fn kv_scan(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    pattern: String,
    cursor: String,
) -> Result<crate::kv::KvScanResult, String> {
    sessions::kv_scan(&state, &qlog, &session_id, &database, &pattern, &cursor).await
}

/// Valkey: キーの詳細 (型・TTL・値プレビュー) を返す
#[tauri::command]
pub async fn kv_key_detail(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    key: String,
) -> Result<crate::kv::KvKeyDetail, String> {
    sessions::kv_key_detail(&state, &qlog, &session_id, &database, &key).await
}

/// Valkey: キーの値を変更する (追加・削除・改名・TTL変更・新規作成)
#[tauri::command]
pub async fn kv_apply(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    change: crate::kv::KvChange,
) -> Result<(), String> {
    sessions::kv_apply(&state, &qlog, &session_id, &database, change).await
}

/// Valkey: コマンド (複数行) を逐次実行する
#[tauri::command]
pub async fn kv_exec(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    commands: Vec<String>,
    confirmed: bool,
) -> Result<crate::kv::KvRunOutput, String> {
    sessions::kv_exec(&state, &qlog, &session_id, &database, commands, confirmed).await
}

/// 実行前に確認したいValkeyコマンド (FLUSHALL・CONFIG SET等) を1つ返す。
/// 実際の実行はせず、画面の確認ダイアログ用に使う
#[tauri::command]
pub fn check_kv_destructive(commands: Vec<String>) -> Result<Vec<String>, String> {
    Ok(crate::kv::find_destructive(&commands))
}

/// Valkey: パターンに一致するキーを数える (消す前の確認用)
#[tauri::command]
pub async fn kv_count_keys(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: String,
    pattern: String,
    job_id: String,
) -> Result<crate::kv_bulk::KvCountResult, String> {
    let job = jobs.start(&job_id, &session_id);
    let res = sessions::kv_count_keys(
        &state,
        &qlog,
        &session_id,
        &database,
        &pattern,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);
    res
}

/// Valkey: パターンに一致するキーをまとめて消す
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kv_delete_keys(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: String,
    pattern: String,
    confirmed_all: bool,
    job_id: String,
) -> Result<crate::kv_bulk::KvDeleteResult, String> {
    let job = jobs.start(&job_id, &session_id);
    let res = sessions::kv_delete_keys(
        &state,
        &qlog,
        &session_id,
        &database,
        &pattern,
        confirmed_all,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);
    res
}

/// Valkey: 値の中から文字列を探す
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kv_search(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: String,
    pattern: String,
    options: crate::kv_bulk::KvSearchOptions,
    job_id: String,
) -> Result<crate::kv_bulk::KvSearchResult, String> {
    let job = jobs.start(&job_id, &session_id);
    let res = sessions::kv_search(
        &state,
        &qlog,
        &session_id,
        &database,
        &pattern,
        options,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);
    res
}
