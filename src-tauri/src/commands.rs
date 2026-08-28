use tauri::{AppHandle, Manager, State};

use crate::models::{
    ConnectInfo, ConnectionProfile, ConnectionStore, CsvExportResult, FolderInfo, LayoutEntry,
    RunOutput, SchemaEntry, SessionSummary, TableDetail, TableInfo, TestResult,
};
use crate::catalog;
use crate::csv_job::CsvJobs;
use crate::ddl;
use crate::ddl_table;
use crate::query;
use crate::query_log::{QueryLog, QueryLogEntry};
use crate::sessions::{self, CancelRegistry, Sessions};
use crate::tools::{self, JobStatus, Jobs, StartedJob, ToolSettings, ToolStatus};
use crate::{db, storage};

/// 実行前に確認したいSQL (DROP・TRUNCATE・WHERE無しのUPDATE/DELETE等) を抜き出す。
/// 実際の実行はせず、画面の確認ダイアログ用に一覧を返すだけ。
///
/// 文の区切り方はサーバーの設定で変わるため、そのセッションが実際に
/// 使っている方言で判定する。セッションが見つからない場合は
/// DBの種類から見た既定の方言で判定する
#[tauri::command]
pub async fn check_dangerous_sql(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    session_id: String,
    sql: String,
    db_type: crate::models::DbType,
) -> Result<Vec<query::DangerousStatement>, String> {
    let d = sessions::session_dialect(&sessions, &session_id)
        .await
        // セッションが見つからない・実行中で読めない場合は、
        // 危険なSQLを見落とさない側 (文を多めに割る側) に倒す
        .unwrap_or_else(|| crate::dialect::fail_closed(db_type));
    let mut found = query::dangerous_statements(d, &sql);
    /*
     * 定義の変更 (ALTER / RENAME) の確認は設定で外せる。
     * 設定が読めないときは確認する側に倒す
     */
    let confirm_alter = crate::app_settings::load(&app)
        .map(|s| s.confirm_alter)
        .unwrap_or(true);
    if !confirm_alter {
        found.retain(|s| !s.definition_change);
    }
    Ok(found)
}

/// 保存済みの接続先一式(フォルダ+接続)を返す
#[tauri::command]
pub fn list_connections(app: AppHandle) -> Result<ConnectionStore, String> {
    storage::load(&app)
}

/// 接続プロファイルを保存(idが空なら新規採番)して保存後のものを返す
#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    mut profile: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    let mut store = storage::load(&app)?;

    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
        store.connections.push(profile.clone());
    } else if let Some(slot) = store.connections.iter_mut().find(|c| c.id == profile.id) {
        *slot = profile.clone();
    } else {
        store.connections.push(profile.clone());
    }

    storage::save(&app, &store)?;
    Ok(profile)
}

/// 接続プロファイルを削除
#[tauri::command]
pub fn delete_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.connections.retain(|c| c.id != id);
    storage::save(&app, &store)
}

/// フォルダを作成して返す
#[tauri::command]
pub fn create_folder(app: AppHandle, name: String) -> Result<FolderInfo, String> {
    let mut store = storage::load(&app)?;
    let folder = FolderInfo {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        collapsed: false,
        color: None,
    };
    store.folders.push(folder.clone());
    storage::save(&app, &store)?;
    Ok(folder)
}

/// フォルダを削除する (中の接続はルート直下に移動)
#[tauri::command]
pub fn delete_folder(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.folders.retain(|f| f.id != id);
    for c in store.connections.iter_mut() {
        if c.folder_id.as_deref() == Some(id.as_str()) {
            c.folder_id = None;
        }
    }
    storage::save(&app, &store)
}

/// フォルダ一覧(名前・並び・折りたたみ)と接続の並び/所属を一括保存する
#[tauri::command]
pub fn update_layout(
    app: AppHandle,
    folders: Vec<FolderInfo>,
    order: Vec<LayoutEntry>,
    root_order: Option<Vec<String>>,
) -> Result<(), String> {
    let mut store = storage::load(&app)?;
    store.folders = folders;
    // ルート階層の表示順 (フォルダと接続の混在順)。未指定なら従来の順を維持する
    if let Some(root_order) = root_order {
        store.root_order = root_order;
    }

    // orderで指定された順に並べ替え、所属フォルダを反映する。
    // orderに含まれない接続は末尾に残す。
    let mut remaining = std::mem::take(&mut store.connections);
    let mut ordered = Vec::with_capacity(remaining.len());
    for entry in &order {
        if let Some(pos) = remaining.iter().position(|c| c.id == entry.id) {
            let mut conn = remaining.remove(pos);
            conn.folder_id = entry.folder_id.clone();
            ordered.push(conn);
        }
    }
    ordered.extend(remaining);
    store.connections = ordered;

    storage::save(&app, &store)
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

/// 設定フォルダのファイルが読める形かを1件ずつ確かめる
#[tauri::command]
pub fn check_config_files(
    app: AppHandle,
) -> Result<Vec<crate::json_store::ConfigFile>, String> {
    crate::json_store::check_all(&app)
}

/// 壊れた設定ファイルを退避して作り直せるようにし、退避先のパスを返す。
/// 読める状態のファイルは退避しない (誤って設定を消せないように)
#[tauri::command]
pub fn quarantine_config_file(app: AppHandle, name: String) -> Result<String, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    crate::json_store::quarantine(&app, &name, &stamp)
}

/// 接続テスト(未保存のプロファイルでも実行可能)
#[tauri::command]
pub async fn test_connection(
    qlog: State<'_, QueryLog>,
    profile: ConnectionProfile,
) -> Result<TestResult, String> {
    /*
     * 鍵が読めずパスワードを復号できないのも「テストの失敗」の一種。
     * ここだけ Err で返していたため、画面では他の失敗が「接続失敗」、
     * これだけ「エラー」と別の見え方になっていた
     */
    if profile.password_locked {
        return Ok(TestResult {
            success: false,
            message: sessions::LOCKED_SECRET_MSG.to_string(),
            server_version: None,
            elapsed_ms: 0,
        });
    }
    Ok(db::run_test(profile, &qlog).await)
}

/// 接続を確立し、データベース一覧を返す (session_idはタブ単位の任意キー)
#[tauri::command]
pub async fn connect_session(
    state: State<'_, Sessions>,
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    profile: ConnectionProfile,
) -> Result<ConnectInfo, String> {
    sessions::connect(&state, &cancel, &qlog, &jobs, session_id, profile).await
}

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

/// 実行中のクエリをキャンセルする (別接続からKILL/pg_cancel_backend)
#[tauri::command]
pub async fn cancel_query(
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    session_id: String,
) -> Result<(), String> {
    sessions::cancel_query(&cancel, &qlog, &session_id).await
}

/// CSVファイルを先頭だけ読んで見せる
#[tauri::command]
pub async fn preview_csv(
    path: String,
    options: crate::csv_import::CsvOptions,
) -> Result<crate::csv_import::CsvPreview, String> {
    // ファイルの読み取りは待たされることがあるので、画面を止めないよう別スレッドで行う
    tauri::async_runtime::spawn_blocking(move || {
        crate::csv_import::preview(std::path::Path::new(&path), &options)
    })
    .await
    .map_err(|e| format!("読み取りに失敗しました: {e}"))?
}

/// CSVをテーブルへ取り込む
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    path: String,
    options: crate::csv_import::CsvOptions,
    mapping: Vec<(usize, String)>,
    mode: crate::csv_import::ImportMode,
    empty_as_null: bool,
    job_id: String,
) -> Result<crate::csv_import::ImportResult, String> {
    let p = std::path::PathBuf::from(&path);
    let job = jobs.start(&job_id, &session_id);
    let res = sessions::import_csv(
        &state,
        &qlog,
        &session_id,
        database,
        schema,
        &table,
        &p,
        &options,
        &mapping,
        mode,
        empty_as_null,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);
    /*
     * D&Dで預かったファイルは、取り込みが終わったら残さない。
     * ユーザーがファイル選択で指した元のファイルは消してはいけないので、
     * 一時フォルダの中にあるものだけを消す。
     *
     * 失敗・中止のときは残す。設定を直してやり直せるようにするため
     * (残ったものは uploads::cleanup_old が後で片付ける)
     */
    if matches!(&res, Ok(r) if !r.cancelled && r.rows > 0) && is_temp_upload(&app, &p) {
        let _ = std::fs::remove_file(&p);
    }
    res
}

/// アプリがD&Dで預かった一時ファイルか
fn is_temp_upload(app: &AppHandle, path: &std::path::Path) -> bool {
    crate::uploads::dir(app).is_ok_and(|dir| crate::uploads::is_inside(&dir, path))
}

/// テーブル名・カラム名・コメントから探す
#[tauri::command]
pub async fn search_objects(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    keyword: String,
) -> Result<crate::search::ObjectSearchResult, String> {
    sessions::search_objects(&state, &qlog, &session_id, database, &keyword).await
}

/// 値の中から文字列を探す
#[tauri::command]
pub async fn search_values(
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: Option<String>,
    options: crate::search::ValueSearchOptions,
    job_id: String,
) -> Result<crate::search::ValueSearchResult, String> {
    let job = jobs.start(&job_id, &session_id);
    let res =
        sessions::search_values(&state, &qlog, &session_id, database, options, Some(&job))
            .await;
    jobs.finish(&job_id, &job);
    res
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

// ---------- データの編集 (DML) ----------

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

// ---------- テーブル定義の変更 (DDL) ----------

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

/// 画面に出ている実行計画をCSVへ書き出す。
///
/// 通常のCSV出力は「同じSQLをもう一度流して全行を書き出す」作りだが、
/// 実行計画では次の理由でそれができない:
/// - 画面が持っているのは `EXPLAIN …` の結果で、元のSQLを流し直すと
///   計画ではなくデータが出てしまう
/// - ANALYZE は対象のSQLを実際に実行するため、流し直すと
///   もう一度実行することになり、実測時間も画面と違う値になる
///
/// そこで、画面が持っている行をそのまま書き出す。
/// 実行計画は多くても数百行なので、streamにする必要は無い
#[tauri::command]
pub fn export_plan_csv(
    app: AppHandle,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<crate::models::CsvExportResult, String> {
    if rows.is_empty() {
        return Err("書き出す実行計画がありません".to_string());
    }
    let text = crate::export::plan_csv(&columns, &rows);

    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = crate::filename::unique_path(&dir, &format!("quelio_plan_{ts}"), "csv")?;
    std::fs::write(&path, text).map_err(|e| format!("CSVを書き込めません: {e}"))?;
    Ok(crate::models::CsvExportResult {
        path: path.to_string_lossy().to_string(),
        rows: rows.len(),
        cancelled: false,
    })
}

/// SQL実行結果 (1文ぶん) を全件CSVへ書き出し、保存先と行数を返す。
/// 画面のページング (1000行) とは無関係に対象SQLの全行を出力する。
/// job_idを指定すると、別コマンドから進捗取得・キャンセルができる
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_query_csv(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: Option<String>,
    sql: String,
    order_by: Option<String>,
    order_dir: Option<String>,
    job_id: String,
) -> Result<CsvExportResult, String> {
    // 先にジョブを登録する。保存先を決める間にキャンセルを押されても取りこぼさない
    let job = jobs.start(&job_id, &session_id);
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    // DB名はユーザーが決めるものなので、そのままファイル名にしない
    let base = crate::filename::safe_stem(
        &database.clone().unwrap_or_else(|| "query".to_string()),
    );
    let path = dir.join(format!("{base}_query_{ts}.csv"));

    let res = sessions::export_query_csv(
        &state,
        &qlog,
        &session_id,
        database,
        &sql,
        order_by,
        order_dir,
        &path,
        Some(&job),
    )
    .await;
    jobs.finish(&job_id, &job);

    match res {
        // キャンセル時は中途半端なファイルを残さない
        Ok((rows, true)) => {
            let _ = std::fs::remove_file(&path);
            Ok(CsvExportResult {
                path: String::new(),
                rows,
                cancelled: true,
            })
        }
        Ok((rows, false)) => Ok(CsvExportResult {
            path: path.to_string_lossy().to_string(),
            rows,
            cancelled: false,
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

/// 時間のかかる処理の進捗 (件数と局面) を返す。開始前・終了済みならnull。
/// CSVの出力・取り込み、値検索、Valkeyの一括処理で共通に使う
#[tauri::command]
pub fn csv_export_status(
    jobs: State<'_, CsvJobs>,
    job_id: String,
) -> Option<crate::csv_job::JobProgress> {
    jobs.progress(&job_id)
}

/// 時間のかかる処理の中止を要求する (対象は csv_export_status と同じ)。
///
/// 印を立てるだけでは、処理が切れ目に来るまで止まらない
/// (値検索は1テーブルで最大20秒、CSV出力は1行目が返るまで)。
/// 走っている1本はサーバー側からも止めに行く
#[tauri::command]
pub async fn cancel_csv_export(
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    job_id: String,
) -> Result<(), String> {
    // 連打しても、サーバーへ送るのは最初の1回だけ (毎回接続を1本張るため)
    if !jobs.cancel(&job_id) {
        return Ok(());
    }
    let Some(session_id) = jobs.running_session_of(&job_id) else {
        return Ok(());
    };
    /*
     * Valkeyの中止は CLIENT KILL で接続ごと落とすことになり、
     * 「中止しました」ではなく接続エラーとして見えてしまう。
     * Valkeyはコマンドの切れ目ごとに印を見ているので、印だけで十分
     */
    if sessions::cancel_target_db(&cancel, &session_id) == Some(crate::models::DbType::Valkey) {
        return Ok(());
    }
    // 止められなくても印は立っているので、失敗しても構わない
    let _ = sessions::cancel_query(&cancel, &qlog, &session_id).await;
    Ok(())
}

/// 選択中DBのスキーマ情報をCSV3ファイルでDownloadsに書き出し、パスを返す
#[tauri::command]
pub async fn export_schema_csv(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let delim = crate::app_settings::load(&app)?.comment_delimiter;
    let (tables, columns, indexes) =
        sessions::export_schema(&state, &qlog, &session_id, &database, &delim).await?;

    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    // DB名はユーザーが決めるものなので、そのままファイル名にしない
    let stem = crate::filename::safe_stem(&database);

    let mut paths = Vec::new();
    for (kind, content) in [
        ("tables", tables),
        ("columns", columns),
        ("indexes", indexes),
    ] {
        let path = dir.join(format!("{stem}_{kind}_{ts}.csv"));
        std::fs::write(&path, content).map_err(|e| format!("CSVを書き込めません: {e}"))?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

/// 保存したファイルの場所をOSのファイラで開く (フォルダを開いて選択状態にする)
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("フォルダを開けません: {e}"))
}

// ---------- SQLパラメータ ----------

/// 保存済みのSQLパラメータ値を返す (パラメータ名 → 直近の値と埋め込み方)。
/// scopeは接続プロファイルID (接続ごとに分けて保持する)
#[tauri::command]
pub fn get_sql_params(
    app: AppHandle,
    scope: String,
) -> Result<std::collections::HashMap<String, crate::sql_params::ParamSaved>, String> {
    crate::sql_params::load(&app, &scope)
}

/// SQLパラメータ値を保存する (同じ接続の同名は上書き)
#[tauri::command]
pub fn save_sql_params(
    app: AppHandle,
    scope: String,
    entries: std::collections::HashMap<String, crate::sql_params::ParamSaved>,
) -> Result<(), String> {
    crate::sql_params::merge(&app, &scope, entries)
}

// ---------- 設定 > エクスポート/インポート ----------

/// 接続一覧をJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_connections(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_connections(&app, &path)
}

/// JSONファイルから接続一覧を取り込む
#[tauri::command]
pub fn import_connections(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_connections(&app, &path)
}

/// 全ER図をJSONファイルへ書き出す (件数を返す)
#[tauri::command]
pub fn export_er_diagrams(app: AppHandle, path: String) -> Result<usize, String> {
    crate::backup::export_er_diagrams(&app, &path)
}

/// JSONファイルからER図を取り込む
#[tauri::command]
pub fn import_er_diagrams(
    app: AppHandle,
    path: String,
) -> Result<crate::backup::ImportResult, String> {
    crate::backup::import_er_diagrams(&app, &path)
}

/// SSH秘密鍵の参照ダイアログの初期フォルダを返す
/// (~/.ssh があればそこ、無ければホームディレクトリ)
#[tauri::command]
pub fn default_ssh_key_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("ホームディレクトリを取得できません: {e}"))?;
    let ssh = home.join(".ssh");
    let dir = if ssh.is_dir() { ssh } else { home };
    Ok(dir.to_string_lossy().to_string())
}

/// 実行結果キャプチャ(PNG)をDownloadsに保存し、パスを返す
#[tauri::command]
pub async fn save_capture(
    app: AppHandle,
    file_name: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("画像データを解読できません: {e}"))?;
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    // パス区切り等を除去した安全なファイル名にする (拡張子は残す)
    let path = dir.join(crate::filename::safe_file_name(&file_name));
    std::fs::write(&path, bytes).map_err(|e| format!("画像を書き込めません: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// アプリ全般の設定を返す
#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> Result<crate::app_settings::AppSettings, String> {
    crate::app_settings::load(&app)
}

/// SQL実行履歴を返す (新しい順・最大100件)
#[tauri::command]
pub fn get_sql_history(app: AppHandle) -> Result<Vec<crate::sql_history::HistoryEntry>, String> {
    crate::sql_history::load(&app)
}

/// SQL実行履歴に追加する (同一SQLは先頭へ移動)
#[tauri::command]
pub fn add_sql_history(app: AppHandle, sql: String) -> Result<(), String> {
    crate::sql_history::add(&app, sql)
}

/// 保存SQLの一覧を返す
#[tauri::command]
pub fn get_saved_sql(app: AppHandle) -> Result<Vec<crate::saved_sql::SavedSql>, String> {
    crate::saved_sql::load(&app)
}

/// 保存SQLを追加/更新して全件を返す (idが未指定なら新規)
#[tauri::command]
pub fn upsert_saved_sql(
    app: AppHandle,
    id: Option<String>,
    name: String,
    folder: String,
    sql: String,
) -> Result<Vec<crate::saved_sql::SavedSql>, String> {
    crate::saved_sql::upsert(&app, id, name, folder, sql)
}

/// 保存SQLを削除して全件を返す
#[tauri::command]
pub fn delete_saved_sql(
    app: AppHandle,
    id: String,
) -> Result<Vec<crate::saved_sql::SavedSql>, String> {
    crate::saved_sql::delete(&app, &id)
}

/// アプリ全般の設定を保存する
#[tauri::command]
pub fn save_app_settings(
    app: AppHandle,
    settings: crate::app_settings::AppSettings,
) -> Result<(), String> {
    crate::app_settings::save(&app, &settings)
}

// ---------- 外部ツール (エクスポート/インポート) ----------

/// D&Dされたファイルの受け皿となる一時ファイルを作成してパスを返す
#[tauri::command]
pub fn create_temp_upload(app: AppHandle, file_name: String) -> Result<String, String> {
    Ok(crate::uploads::create(&app, &file_name)?
        .to_string_lossy()
        .to_string())
}

/// 一時ファイルへチャンクを追記する (D&Dファイルの転送用)
#[tauri::command]
pub fn append_temp_upload(
    app: AppHandle,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::Engine as _;
    use std::io::Write;
    let dir = crate::uploads::dir(&app)?;
    let p = std::path::PathBuf::from(&path);
    // `..` を含むパスで外へ書き出されないよう、実体のパスで確かめる
    if !crate::uploads::is_inside(&dir, &p) {
        return Err("不正なパスです".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("データを解読できません: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| format!("一時ファイルを開けません: {e}"))?;
    f.write_all(&bytes)
        .map_err(|e| format!("一時ファイルへ書き込めません: {e}"))
}

/// 外部ツールのパス設定を返す
#[tauri::command]
pub fn get_tool_settings(app: AppHandle) -> Result<ToolSettings, String> {
    tools::load_settings(&app)
}

/// 外部ツールのパス設定を保存する
#[tauri::command]
pub fn save_tool_settings(app: AppHandle, settings: ToolSettings) -> Result<(), String> {
    tools::save_settings(&app, &settings)
}

/// 外部ツールの検出状況を返す
#[tauri::command]
pub async fn detect_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tools::detect_tools(&app).await
}

/// 選択テーブルのエクスポートを開始する (mode: full | schema | data)
#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, Jobs>,
    session_id: String,
    database: String,
    tables: Vec<crate::models::ExportTable>,
    mode: String,
) -> Result<StartedJob, String> {
    let ep = sessions::endpoint_info(&state, &qlog, &session_id).await?;
    tools::start_export(&app, &jobs, ep, database, tables, mode).await
}

/// SQLファイルのインポートを開始する
#[tauri::command]
pub async fn start_import(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, Jobs>,
    session_id: String,
    database: String,
    file_path: String,
) -> Result<StartedJob, String> {
    let ep = sessions::endpoint_info(&state, &qlog, &session_id).await?;
    tools::start_import(&app, &jobs, ep, database, file_path).await
}

/// ジョブの進捗を返す
#[tauri::command]
pub async fn job_status(jobs: State<'_, Jobs>, job_id: String) -> Result<JobStatus, String> {
    tools::job_status(&jobs, &job_id).await
}

/// ジョブをキャンセルする
#[tauri::command]
pub async fn cancel_job(jobs: State<'_, Jobs>, job_id: String) -> Result<(), String> {
    tools::cancel_job(&jobs, &job_id).await
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

/// URLクエリ用の簡易パーセントエンコード
fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// スキーマ一覧ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_schema(
    app: AppHandle,
    session_id: String,
    database: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("schema") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = format!(
        "index.html?schema=1&session={}&db={}",
        url_encode(&session_id),
        url_encode(&database)
    );
    let b = tauri::WebviewWindowBuilder::new(&app, "schema", tauri::WebviewUrl::App(url.into()))
        .title("Quelio — スキーマ一覧")
        .inner_size(1250.0, 780.0)
        .min_inner_size(800.0, 400.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("スキーマ一覧を開けません: {e}"))?;
    Ok(())
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

/// ER図がひと呼び出しで受け取る内容
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErSchema {
    entries: Vec<crate::models::SchemaEntry>,
    foreign_keys: Vec<crate::models::FkInfo>,
}

/// ER図ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_er(
    app: AppHandle,
    session_id: String,
    database: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("er") {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = format!(
        "index.html?er=1&session={}&db={}",
        url_encode(&session_id),
        url_encode(&database)
    );
    let b = tauri::WebviewWindowBuilder::new(&app, "er", tauri::WebviewUrl::App(url.into()))
        .title("Quelio — ER図")
        .inner_size(1300.0, 820.0)
        .min_inner_size(800.0, 480.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build().map_err(|e| format!("ER図を開けません: {e}"))?;
    Ok(())
}

/// 前回の作業状態 (タブ・書きかけSQL) を返す (無ければnull)
#[tauri::command]
pub fn get_workspace(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    crate::workspace::load(&app)
}

/// 作業状態を保存する (全上書き)
#[tauri::command]
pub fn save_workspace(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    crate::workspace::save(&app, data)
}

/// 保存済みER図を返す (無ければnull)
#[tauri::command]
pub fn get_er_diagram(
    app: AppHandle,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    crate::er_store::load(&app, &key)
}

/// ER図を保存する (キーごとに上書き)
#[tauri::command]
pub fn save_er_diagram(
    app: AppHandle,
    key: String,
    data: serde_json::Value,
) -> Result<(), String> {
    crate::er_store::save(&app, key, data)
}

/// 保存済みER図のキー一覧を返す
#[tauri::command]
pub fn list_er_diagrams(app: AppHandle) -> Result<Vec<String>, String> {
    crate::er_store::list(&app)
}

/// 保存済みER図を削除する
#[tauri::command]
pub fn delete_er_diagram(app: AppHandle, key: String) -> Result<(), String> {
    crate::er_store::delete(&app, &key)
}

/// スキーマ差分ウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_diff(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("diff") {
        let _ = w.set_focus();
        return Ok(());
    }
    let b = tauri::WebviewWindowBuilder::new(
        &app,
        "diff",
        tauri::WebviewUrl::App("index.html?diff=1".into()),
    )
    .title("Quelio — スキーマ差分")
    .inner_size(1200.0, 760.0)
    .min_inner_size(800.0, 400.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("差分ウィンドウを開けません: {e}"))?;
    Ok(())
}

/// クエリログを返す (after_seqより新しいもの。0で全件)
#[tauri::command]
pub fn get_query_log(
    qlog: State<'_, QueryLog>,
    after_seq: u64,
) -> Result<Vec<QueryLogEntry>, String> {
    Ok(qlog.entries_after(after_seq))
}

/// クエリログをファイルへ書き出す (保存先のパスを返す)
#[tauri::command]
pub fn export_query_log(
    app: AppHandle,
    qlog: State<'_, QueryLog>,
    filter: String,
    format: crate::query_log::LogFormat,
) -> Result<crate::query_log::ExportedLog, String> {
    let (text, rows) = qlog.render(&filter, format);
    if rows == 0 {
        return Err("書き出す記録がありません".to_string());
    }
    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let ext = match format {
        crate::query_log::LogFormat::Csv => "csv",
        crate::query_log::LogFormat::Text => "txt",
    };
    // 同じ秒に2回押しても前のファイルを消さない
    let path = crate::filename::unique_path(&dir, &format!("quelio_sqllog_{ts}"), ext)?;
    std::fs::write(&path, text).map_err(|e| format!("ファイルを書き込めません: {e}"))?;
    Ok(crate::query_log::ExportedLog {
        path: path.to_string_lossy().to_string(),
        rows,
    })
}

/// クエリログを消去する
#[tauri::command]
pub fn clear_query_log(qlog: State<'_, QueryLog>) -> Result<(), String> {
    qlog.clear();
    Ok(())
}

/// コンソールウィンドウを開く(既にあればフォーカス)
#[tauri::command]
pub async fn open_console(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("console") {
        let _ = w.set_focus();
        return Ok(());
    }
    let b = tauri::WebviewWindowBuilder::new(
        &app,
        "console",
        tauri::WebviewUrl::App("index.html?console=1".into()),
    )
    .title("Quelio — コンソール")
    .inner_size(980.0, 520.0)
    .min_inner_size(600.0, 300.0);
    #[cfg(target_os = "macos")]
    let b = b
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0));
    b.build()
        .map_err(|e| format!("コンソールを開けません: {e}"))?;
    Ok(())
}

/// 任意のSQLを実行する
#[tauri::command]
pub async fn run_query(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    sql: String,
    offset: usize,
    order_by: Option<String>,
    order_dir: Option<String>,
    transaction: Option<bool>,
    explain: Option<String>,
    // SQL中の `:name` / `@name` に入れる値。
    // 画面ではなくここで埋め込むので、判定を先に済ませられる
    params: Option<std::collections::HashMap<String, crate::query::ParamValue>>,
) -> Result<RunOutput, String> {
    // SQL実行タイムアウトは設定画面の値を使う (0は無制限)
    let timeout_secs = crate::app_settings::load(&app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);
    sessions::run_query(
        &state,
        &qlog,
        &session_id,
        database,
        &sql,
        offset,
        order_by,
        order_dir,
        transaction.unwrap_or(false),
        explain,
        timeout_secs,
        &params.unwrap_or_default(),
    )
    .await
}

/// 実行せずに、値を入れた後のSQLを返す (パラメータ入力画面のプレビュー用)。
///
/// 実行時と同じ処理を使うので、見えている内容と実際に走る内容がずれない
#[tauri::command]
pub async fn preview_sql(
    state: State<'_, Sessions>,
    session_id: String,
    sql: String,
    db_type: crate::models::DbType,
    params: std::collections::HashMap<String, crate::query::ParamValue>,
) -> Result<String, String> {
    let d = sessions::session_dialect(&state, &session_id)
        .await
        .unwrap_or_else(|| crate::dialect::fail_closed(db_type));
    Ok(query::substitute_params(d, &sql, &params))
}

/// セッションを切断する (DB・SSHとも終了通知を送ってから閉じる)
#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, Sessions>,
    cancel: State<'_, CancelRegistry>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
) -> Result<(), String> {
    sessions::disconnect(&state, &cancel, &qlog, &jobs, &session_id).await;
    Ok(())
}
