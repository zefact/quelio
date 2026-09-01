//! 取り込みと書き出し、および検索。
//! CSV/TSVの取り込み・SQLダンプ・外部ツールの検出

use super::*;

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
        crate::outfile::write(&path, content).map_err(|e| format!("CSVを書き込めません: {e}"))?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

/// 選択中DBのテーブル定義書をExcelで書き出し、パスを返す。
///
/// connection は表紙に出す接続の表示名。
/// tables は出力するテーブル名 (指定しなければDB全体)
#[tauri::command]
pub async fn export_schema_xlsx(
    app: AppHandle,
    state: State<'_, Sessions>,
    qlog: State<'_, QueryLog>,
    session_id: String,
    database: String,
    connection: String,
    tables: Option<Vec<String>>,
) -> Result<String, String> {
    let delim = crate::app_settings::load(&app)?.comment_delimiter;
    let mut items = sessions::schema_snapshot(&state, &qlog, &session_id, &database).await?;
    if let Some(pick) = tables {
        let want: std::collections::HashSet<String> = pick.into_iter().collect();
        items.retain(|e| want.contains(&e.table.name));
    }
    if items.is_empty() {
        return Err("出力するテーブルがありません".into());
    }
    let now = chrono::Local::now();
    let meta = crate::export_xlsx::DocMeta {
        connection,
        database: database.clone(),
        generated_at: now.format("%Y-%m-%d %H:%M").to_string(),
    };
    let bytes = crate::export_xlsx::build(&items, &meta, &delim)?;

    // 設定の「保存先フォルダ」に従う (未設定ならOSのダウンロードフォルダ)
    let dir = crate::app_settings::download_dir(&app)?;
    let stem = crate::filename::safe_stem(&database);
    let path = dir.join(format!("{stem}_定義書_{}.xlsx", now.format("%Y%m%d_%H%M%S")));
    crate::outfile::write(&path, bytes).map_err(|e| format!("Excelを書き込めません: {e}"))?;
    Ok(path.to_string_lossy().to_string())
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
