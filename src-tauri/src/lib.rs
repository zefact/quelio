mod app_settings;
mod backup;
mod catalog;
mod commands;
mod crypto;
mod csv_import;
mod dbadmin;
mod kv_bulk;
mod search;
mod csv_job;
mod db;
mod ddl;
mod ddl_table;
mod dialect;
mod dml;
mod er_store;
mod export;
mod filename;
mod json_store;
mod known_hosts;
mod kv;
mod models;
mod query;
mod query_log;
mod saved_sql;
mod sessions;
mod sql_history;
mod sql_params;
mod ssh_tunnel;
mod storage;
mod tools;
mod uploads;
mod workspace;

/// 「Quelioについて」メニューのID (押されたらフロントへ通知する)
#[cfg(target_os = "macos")]
const ABOUT_MENU_ID: &str = "about";

/// macOS用の日本語メニューバーを構築する
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    // OS標準のAboutパネルではなく、アプリ内の「Quelioについて」を出す
    // (アイコン・説明・リリース日・サイトのリンクまで同じ見た目で見せるため)
    let about = MenuItem::with_id(app, ABOUT_MENU_ID, "Quelioについて", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Quelio",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("サービス"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Quelioを隠す"))?,
            &PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?,
            &PredefinedMenuItem::show_all(app, Some("すべてを表示"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quelioを終了"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("取り消す"))?,
            &PredefinedMenuItem::redo(app, Some("やり直す"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("カット"))?,
            &PredefinedMenuItem::copy(app, Some("コピー"))?,
            &PredefinedMenuItem::paste(app, Some("ペースト"))?,
            &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "表示",
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some("フルスクリーンにする"),
        )?],
    )?;

    let window = Submenu::with_items(
        app,
        "ウインドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("しまう"))?,
            &PredefinedMenuItem::maximize(app, Some("拡大/縮小"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("ウインドウを閉じる"))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|_app| {
            // SSHホスト鍵 (TOFU) の保存先を設定ディレクトリに初期化
            {
                use tauri::Manager;
                if let Ok(dir) = _app.path().app_config_dir() {
                    known_hosts::init(dir.join("known_hosts.json"));
                }
            }
            // 前回の取り込みが中断して残った一時ファイルを片付ける
            {
                use tauri::Manager;
                if let Ok(dir) = _app.path().app_cache_dir() {
                    uploads::cleanup_old(&dir.join("uploads"));
                }
            }
            // メニューバーを日本語化 (macOSのみ)
            #[cfg(target_os = "macos")]
            {
                use tauri::{Emitter, Manager};
                let menu = build_menu(_app.handle())?;
                _app.set_menu(menu)?;
                _app.on_menu_event(|app, event| {
                    if event.id() == ABOUT_MENU_ID {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.emit("show-about", ());
                        }
                    }
                });
            }
            // コンソール画面へ「SQLを記録した」と知らせるためのハンドルを渡す
            {
                use tauri::Manager;
                _app.state::<query_log::QueryLog>()
                    .set_app(_app.handle().clone());
            }
            // キープアライブ: 120秒ごとに全セッションへpingを送り、
            // サーバーやファイアウォールのアイドル切断を防ぐ
            {
                use tauri::Manager;
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                        let sessions = handle.state::<sessions::Sessions>();
                        let qlog = handle.state::<query_log::QueryLog>();
                        sessions::keepalive_all(&sessions, &qlog).await;
                    }
                });
            }
            Ok(())
        })
        .manage(sessions::Sessions::default())
        .manage(sessions::CancelRegistry::default())
        .manage(query_log::QueryLog::default())
        .manage(tools::Jobs::default())
        .manage(csv_job::CsvJobs::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::create_folder,
            commands::delete_folder,
            commands::update_layout,
            commands::test_connection,
            commands::system_databases,
            commands::list_charsets,
            commands::preview_create_database,
            commands::preview_create_schema,
            commands::check_config_files,
            commands::quarantine_config_file,
            commands::connect_session,
            commands::list_tables,
            commands::table_detail,
            commands::run_query,
            commands::preview_sql,
            commands::cancel_query,
            commands::cancel_schema_load,
            commands::kv_scan,
            commands::kv_key_detail,
            commands::kv_exec,
            commands::check_kv_destructive,
            commands::kv_apply,
            commands::export_schema_csv,
            commands::export_query_csv,
            commands::export_plan_csv,
            commands::list_collations,
            commands::schema_columns,
            commands::list_column_types,
            commands::create_table,
            commands::preview_create_table,
            commands::rename_table,
            commands::drop_table,
            commands::set_table_comment,
            commands::preview_column_ddl,
            commands::apply_column_ddl,
            commands::apply_index_ddl,
            commands::apply_foreign_key_ddl,
            commands::apply_row_change,
            commands::fetch_cell,
            commands::count_table_rows,
            commands::list_routines,
            commands::search_objects,
            commands::search_values,
            commands::kv_count_keys,
            commands::kv_delete_keys,
            commands::kv_search,
            commands::create_database,
            commands::drop_database,
            commands::list_schemas,
            commands::change_schema,
            commands::list_processes,
            commands::preview_csv,
            commands::import_csv,
            commands::kill_process,
            commands::table_ddl,
            commands::reveal_path,
            commands::csv_export_status,
            commands::cancel_csv_export,
            commands::export_connections,
            commands::import_connections,
            commands::export_er_diagrams,
            commands::import_er_diagrams,
            commands::default_ssh_key_dir,
            commands::save_capture,
            commands::get_app_settings,
            commands::save_app_settings,
            commands::get_sql_history,
            commands::add_sql_history,
            commands::get_sql_params,
            commands::save_sql_params,
            commands::get_saved_sql,
            commands::upsert_saved_sql,
            commands::delete_saved_sql,
            commands::get_tool_settings,
            commands::save_tool_settings,
            commands::detect_tools,
            commands::start_export,
            commands::start_import,
            commands::job_status,
            commands::cancel_job,
            commands::create_temp_upload,
            commands::append_temp_upload,
            commands::list_sessions,
            commands::schema_snapshot,
            commands::open_diff,
            commands::open_schema,
            commands::open_er,
            commands::schema_with_foreign_keys,
            commands::get_workspace,
            commands::save_workspace,
            commands::get_er_diagram,
            commands::save_er_diagram,
            commands::list_er_diagrams,
            commands::delete_er_diagram,
            commands::disconnect_session,
            commands::check_dangerous_sql,
            commands::get_query_log,
            commands::clear_query_log,
            commands::export_query_log,
            commands::open_console,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
