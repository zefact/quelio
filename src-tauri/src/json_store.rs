//! アプリ設定フォルダのJSONを、壊れにくい形で読み書きするための共通処理。
//!
//! - 読み取りは「ファイルが無い」と「壊れている」を区別する。
//!   壊れているときにエラーを返すことで、空の内容で上書きしてしまうのを防ぐ
//! - 書き込みは 一時ファイル → fsync → rename のアトミック置換。
//!   途中で電源が落ちても、元のファイルか新しいファイルのどちらかが必ず残る

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager};

/// アプリ設定フォルダの中のパスを返す (フォルダが無ければ作る)
pub fn config_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    Ok(dir.join(name))
}

/// JSONを読み込む。ファイルが無ければ `None`、壊れていれば `Err`。
/// `what` はエラーメッセージに出す名前 (例: "ER図")
pub fn read<T: DeserializeOwned>(path: &Path, what: &str) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("{what}を読み込めません: {e}"))?;
    // 中身が空 (書き込み途中で落ちた旧形式など) は「無い」とみなす
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{what}の形式が不正です ({}): {e}", path.display()))
}

/// 設定フォルダのファイル1件の状態 (設定画面に出す)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    /// ファイル名 (退避のときにこれで指定する)
    pub name: String,
    /// 画面に出す名前
    pub label: String,
    /// 実際のパス (利用者が自分で開けるように出す)
    pub path: String,
    /// ファイルがあるか
    pub exists: bool,
    /// 読めない理由 (読めるなら None)
    pub error: Option<String>,
}

/// 設定フォルダに置くファイルの一覧 (ファイル名, 画面に出す名前)。
///
/// 壊れたときに画面から気づけるよう、ここに集める
pub const CONFIG_FILES: &[(&str, &str)] = &[
    ("connections.json", "接続先"),
    ("app_settings.json", "アプリ設定"),
    ("tools.json", "外部ツールの設定"),
    ("workspace.json", "前回の書きかけSQL"),
    ("er_diagrams.json", "ER図"),
    ("saved_sql.json", "お気に入りのSQL"),
    ("sql_history.json", "SQLの実行履歴"),
    ("sql_params.json", "SQLパラメータの保存値"),
];

/// 設定ファイルが読める形かどうかを1件ずつ確かめる。
///
/// 壊れていると「読めません」というエラーだけが出て、
/// 画面からは直しようがなかった (どのファイルかも分からない)
pub fn check_all(app: &AppHandle) -> Result<Vec<ConfigFile>, String> {
    let mut out = Vec::new();
    for (name, label) in CONFIG_FILES {
        let path = config_path(app, name)?;
        let exists = path.exists();
        // 中身の形までは見ない (JSONとして読めるかだけ確かめる)
        let error = if exists {
            read::<serde_json::Value>(&path, label).err()
        } else {
            None
        };
        out.push(ConfigFile {
            name: (*name).to_string(),
            label: (*label).to_string(),
            path: path.display().to_string(),
            exists,
            error,
        });
    }
    Ok(out)
}

/// 壊れた設定ファイルを退避して、作り直せるようにする。
///
/// 消さずに `名前.broken-日時` へ改名するので、後から中身を救い出せる。
/// **読める状態のファイルは退避しない** (この機能が「設定を消すボタン」に
/// なってしまわないように、必ず読めないことを確かめてから動かす)
pub fn quarantine(app: &AppHandle, name: &str, stamp: &str) -> Result<String, String> {
    let Some((_, label)) = CONFIG_FILES.iter().find(|(n, _)| *n == name) else {
        return Err(format!("{name} は設定ファイルではありません"));
    };
    let path = config_path(app, name)?;
    if !path.exists() {
        return Err(format!("{label}のファイルはありません"));
    }
    if read::<serde_json::Value>(&path, label).is_ok() {
        return Err(format!("{label}のファイルは壊れていません"));
    }
    let moved = path.with_file_name(format!("{name}.broken-{stamp}"));
    fs::rename(&path, &moved).map_err(|e| format!("{label}のファイルを移動できません: {e}"))?;
    Ok(moved.display().to_string())
}

/// 所有者だけが読み書きできるファイルを作る (パスワードなどを含むため)。
/// 作成時からパーミッションを絞るので、一瞬でも他人に読める時間を作らない
#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // 既に別のパーミッションで存在していた場合のために、開いた後にも掛け直す
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<fs::File> {
    fs::File::create(path)
}

/// 同じフォルダに一時ファイルを作って書き切ってから、rename で置き換える
pub fn write(path: &Path, text: &str, what: &str) -> Result<(), String> {
    let tmp = tmp_path(path);
    let err = |e: std::io::Error| format!("{what}を書き込めません: {e}");

    // 書き込み中に落ちても元のファイルは無傷。fsyncまで済ませてから置き換える
    let result = (|| -> std::io::Result<()> {
        let mut f = create_private(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    // 置き換えたことをフォルダにも反映させる (unixのみ)
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// 直前の内容を `.bak` に残してから書き換える (接続先など、失うと痛いもの用)。
/// `.bak` も所有者だけが読める形で作る (中身は同じ秘匿情報のため)
pub fn write_with_backup(path: &Path, text: &str, what: &str) -> Result<(), String> {
    // バックアップの失敗では保存自体を止めない
    if let Ok(prev) = fs::read(path) {
        let bak = with_suffix(path, "bak");
        if let Ok(mut f) = create_private(&bak) {
            let _ = f.write_all(&prev);
        }
    }
    write(path, text, what)
}

/// 一時ファイルの通し番号 (同じファイルへの同時書き込みでぶつからないように)
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 一時ファイルのパス (同じフォルダに置かないとrenameがアトミックにならない)
fn tmp_path(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    with_suffix(path, &format!("{}-{seq}.tmp", std::process::id()))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "store.json".to_string());
    path.with_file_name(format!("{name}.{suffix}"))
}
