//! D&Dで受け取ったファイルの一時置き場。
//!
//! 中身は本番DBのダンプSQLになり得るため、
//! 共有の /tmp ではなくアプリ専用のフォルダに権限を絞って置き、
//! 取り込みが終わったら消す

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 取り込みが中断した等で残ったファイルを消すまでの時間。
/// 中身は本番のダンプになり得るので、置きっぱなしにしない
const KEEP: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// 一時ファイルを置くフォルダ (アプリのキャッシュ配下)
pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("キャッシュフォルダを取得できません: {e}"))?;
    let dir = base.join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("一時フォルダを作成できません: {e}"))?;
    restrict(&dir, 0o700);
    Ok(dir)
}

/// 所有者だけが読み書きできるようにする (Unixのみ)。
///
/// Windowsにはファイル単位のモードが無く、置き場所の
/// `%LOCALAPPDATA%` が既定でそのユーザーだけのフォルダになる。
/// (他のユーザーから読まれない前提はOS側のACLに委ねている)
#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

/// 所有者だけが読める空ファイルを作る。
///
/// 作ってから権限を変えると、その一瞬だけ既定の権限 (0644) の窓ができる。
/// 作成時に権限を指定して、その窓を無くす
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// 空の一時ファイルを作ってパスを返す
pub fn create(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = dir(app)?;
    // 前回の取り込みが中断していた場合の残骸をここで片付ける
    cleanup_old(&dir);
    // 元のファイル名はユーザーが決めるものなので、そのまま使わない
    let safe = crate::filename::safe_file_name(file_name);
    let path = dir.join(format!("{}_{safe}", uuid::Uuid::new_v4()));
    create_private(&path).map_err(|e| format!("一時ファイルを作成できません: {e}"))?;
    Ok(path)
}

/// 一時フォルダの直下にあるファイルか。
/// `..` を含むパスに騙されないよう、実体のパスに直してから確かめる
pub fn is_inside(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(d), Ok(p)) => p.parent() == Some(d.as_path()),
        _ => false,
    }
}

/// 古い一時ファイルを消す
pub fn cleanup_old(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let too_old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > KEEP);
        if too_old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
