//! SQLダンプの書き出し先を決める。
//!
//! 指定が無ければ、設定の「保存先フォルダ」に `DB名_日時.sql` で置く。
//! 画面で保存先やファイル名を変えたときは、そのパスに書く。
//!
//! 書いている途中は隣の `.partial` に書き、終わってから本来の名前に置き換える。
//! 同じ名前の古いバックアップへ上書きするとき、途中で失敗・中止しても
//! 古いほうを壊さないようにするため

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::models::DbType;
use crate::tools::Endpoint;

/// ファイル名に使うDB名 (安全な形に直したもの)
pub fn base_name(ep: &Endpoint, database: &str) -> String {
    // SQLiteのDB名はいつも "main" なので、DBファイルの名前から付ける
    let base = if ep.db_type == DbType::Sqlite {
        Path::new(&ep.sqlite_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "sqlite".to_string())
    } else {
        database.to_string()
    };
    // DB名はユーザーが決めるものなので、そのままファイル名にしない
    crate::filename::safe_stem(&base)
}

/// 既定のファイル名 (`DB名_20261116_142233.sql`)
pub fn default_name(ep: &Endpoint, database: &str) -> String {
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    format!("{}_{ts}.sql", base_name(ep, database))
}

/// 書き出し先 (画面で指定が無ければ既定の場所)
pub fn resolve(
    app: &AppHandle,
    ep: &Endpoint,
    database: &str,
    out_path: Option<&str>,
) -> Result<PathBuf, String> {
    match out_path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => check(Path::new(p)),
        None => Ok(crate::app_settings::download_dir(app)?.join(default_name(ep, database))),
    }
}

/// 画面で指定された書き出し先を確かめる (拡張子が無ければ .sql を付ける)
pub fn check(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("保存先はフォルダから指定してください".into());
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.trim().is_empty())
        .ok_or("ファイル名を入れてください")?;
    if name.contains(['/', '\\']) {
        return Err("ファイル名に / や \\ は使えません".into());
    }
    let dir = path.parent().ok_or("保存先のフォルダが分かりません")?;
    if !dir.is_dir() {
        return Err(format!("保存先のフォルダがありません: {}", dir.display()));
    }
    if path.is_dir() {
        return Err(format!("同じ名前のフォルダがあります: {}", path.display()));
    }
    let mut out = path.to_path_buf();
    if out.extension().is_none() {
        out.set_extension("sql");
    }
    Ok(out)
}

/// 書いている途中のファイル (同じフォルダに置き、終わったら名前を変えるだけで済ませる)
pub fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    path.with_file_name(name)
}

/// 書き終えたファイルを本来の名前にする (同じ名前があれば置き換える)
pub fn commit(path: &Path) -> Result<(), String> {
    std::fs::rename(partial_path(path), path)
        .map_err(|e| format!("書き出したファイルの名前を変えられません ({}): {e}", path.display()))
}

/// 途中で終わったファイルを消す
pub fn discard(path: &Path) {
    let _ = std::fs::remove_file(partial_path(path));
}
