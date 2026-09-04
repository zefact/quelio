//! SQLの実行と、その周辺 (確認・パラメータ・履歴・CSV出力)

use super::*;

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
    let prod = is_prod(&sessions, &session_id).await;
    Ok(judge_dangerous(&app, d, &sql, prod))
}

/// SQLを文単位に分けて返す (「カーソルのある文だけ実行」に使う)。
///
/// 区切り方 (引用符・コメント・区切り文字) はサーバーの設定で変わるため、
/// 実行や危険判定と同じ方言で分ける。画面側で分けると食い違う
#[tauri::command]
pub async fn split_sql_statements(
    sessions: State<'_, Sessions>,
    session_id: String,
    sql: String,
    db_type: crate::models::DbType,
) -> Result<Vec<String>, String> {
    let d = sessions::session_dialect(&sessions, &session_id)
        .await
        .unwrap_or_else(|| crate::dialect::fail_closed(db_type));
    Ok(query::split_statements(d, &sql))
}

/// 「本番」に設定された接続か
async fn is_prod(sessions: &State<'_, Sessions>, session_id: &str) -> bool {
    sessions::session_env(sessions, session_id).await.as_deref() == Some("prod")
}

/// 確認が要るSQLを拾う (設定で外した種類は落とす)
/// `prod` は「本番」の接続かどうか (本番では設定に関わらず確認する)
fn judge_dangerous(
    app: &AppHandle,
    d: crate::query::Dialect,
    sql: &str,
    prod: bool,
) -> Vec<query::DangerousStatement> {
    let mut found = query::dangerous_statements(d, sql);
    /*
     * 定義の変更 (ALTER / RENAME) の確認は設定で外せる。
     * ただし本番の接続では外せない (外したことを忘れて流すのが一番怖い)。
     * 設定が読めないときは確認する側に倒す
     */
    let confirm_alter = crate::app_settings::load(app)
        .map(|s| s.confirm_alter)
        .unwrap_or(true);
    if !confirm_alter && !prod {
        found.retain(|s| !s.definition_change);
    }
    found
}

/// パラメータの値を入れた後のSQLが、確認の要る内容になっていないかを見る。
///
/// 「そのまま」「数値」の値はクォートされずに入るので、
/// `UPDATE t SET x = 1 WHERE :cond` に `1=1` を入れると
/// 全件更新に変わる (プレースホルダのままでは WHERE があるので気づけない)。
///
/// 値を入れる前から確認の対象だったものは、実行前に一度確認しているので返さない
#[tauri::command]
pub async fn check_dangerous_filled(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    session_id: String,
    sql: String,
    db_type: crate::models::DbType,
    params: std::collections::HashMap<String, crate::query::ParamValue>,
) -> Result<Vec<query::DangerousStatement>, String> {
    // クォートされる値 (文字列・自動) では判定は変わらない
    let raw_used = params
        .values()
        .any(|v| matches!(v.kind.as_str(), "raw" | "number"));
    if !raw_used {
        return Ok(Vec::new());
    }
    let d = sessions::session_dialect(&sessions, &session_id)
        .await
        .unwrap_or_else(|| crate::dialect::fail_closed(db_type));
    let prod = is_prod(&sessions, &session_id).await;
    // 埋め込む前から対象なら、そちらで確認済み
    if !judge_dangerous(&app, d, &sql, prod).is_empty() {
        return Ok(Vec::new());
    }
    let filled = query::substitute_params(d, &sql, &params);
    Ok(judge_dangerous(&app, d, &filled, prod))
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

/// 書いたSQLが全部で何件返すかを数える (ページングで先頭しか見えていないとき用)
#[tauri::command]
pub async fn count_query_rows(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: Option<String>,
    sql: String,
) -> Result<i64, String> {
    let timeout_secs = crate::app_settings::load(&app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);
    sessions::count_query_rows(&state, &qlog, &session_id, database, &sql, timeout_secs)
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
    // 実行時と同じ検査をここでも行う (実行して初めて弾かれるのを避ける)
    query::check_params(&params)?;
    Ok(query::substitute_params(d, &sql, &params))
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

/// 今のトランザクションの状態を返す ("none" / "open" / "broken" / "busy")。
/// 画面下のステータスバーが、実行や編集のあとに読み直す
#[tauri::command]
pub async fn get_txn_state(
    sessions: State<'_, Sessions>,
    session_id: String,
) -> Result<String, String> {
    sessions::txn_state(&sessions, &session_id).await
}

/// 開いているトランザクションを確定 / 取り消しする。
/// 閉じたあとの状態を返す
#[tauri::command]
pub async fn end_txn(
    sessions: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    commit: bool,
) -> Result<String, String> {
    sessions::end_open_txn(&sessions, &qlog, &session_id, commit).await
}

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

/// 履歴を1件消して、残りを返す
#[tauri::command]
pub fn delete_sql_history(
    app: AppHandle,
    sql: String,
) -> Result<Vec<crate::sql_history::HistoryEntry>, String> {
    crate::sql_history::remove(&app, &sql)
}

/// 履歴をすべて消す
#[tauri::command]
pub fn clear_sql_history(
    app: AppHandle,
) -> Result<Vec<crate::sql_history::HistoryEntry>, String> {
    crate::sql_history::clear(&app)
}

/// お気に入り (フォルダと項目) をまとめて返す
#[tauri::command]
pub fn get_saved_sql(app: AppHandle) -> Result<crate::saved_sql::SavedSqlStore, String> {
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
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::upsert(&app, id, name, folder, sql)
}

/// 保存SQLを削除して全体を返す
#[tauri::command]
pub fn delete_saved_sql(
    app: AppHandle,
    id: String,
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::delete(&app, &id)
}

/// お気に入りのフォルダを作る (空のままでも残る)
#[tauri::command]
pub fn create_saved_folder(
    app: AppHandle,
    path: String,
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::create_folder(&app, &path)
}

/// フォルダの名前を変える (中身のパスも一緒に付け替える)
#[tauri::command]
pub fn rename_saved_folder(
    app: AppHandle,
    path: String,
    name: String,
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::rename_folder(&app, &path, &name)
}

/// フォルダを中身ごと削除する
#[tauri::command]
pub fn delete_saved_folder(
    app: AppHandle,
    path: String,
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::delete_folder(&app, &path)
}

/// フォルダ・項目をドラッグで移す。
///
/// `node` は "f:<フォルダのパス>" か "i:<項目のID>"、
/// `before` は「この要素の直前へ入れる」指定 (未指定なら末尾)
#[tauri::command]
pub fn move_saved_node(
    app: AppHandle,
    node: String,
    parent: String,
    before: Option<String>,
) -> Result<crate::saved_sql::SavedSqlStore, String> {
    crate::saved_sql::move_node(&app, &node, &parent, before)
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
    crate::outfile::write(&path, text).map_err(|e| format!("CSVを書き込めません: {e}"))?;
    Ok(crate::models::CsvExportResult {
        path: path.to_string_lossy().to_string(),
        rows: rows.len(),
        cancelled: false,
    })
}

/// SQL実行結果 (1文ぶん) を全件ファイルへ書き出し、保存先と行数を返す。
/// 画面のページング (1000行) とは無関係に対象SQLの全行を出力する。
/// formatは "csv" か "xlsx"。
/// job_idを指定すると、別コマンドから進捗取得・キャンセルができる
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_query_rows(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    jobs: State<'_, CsvJobs>,
    session_id: String,
    database: Option<String>,
    sql: String,
    order_by: Option<String>,
    order_dir: Option<String>,
    format: String,
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
    let fmt = crate::export_rows::RowFormat::parse(&format);
    let path = dir.join(format!("{base}_query_{ts}.{}", fmt.extension()));

    let res = sessions::export_query_rows(
        &state,
        &qlog,
        &session_id,
        database,
        &sql,
        order_by,
        order_dir,
        &path,
        fmt,
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
