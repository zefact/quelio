//! 出力ファイル (CSV・SQLダンプ・キャプチャ画像など) の作り方。
//!
//! 中身はデータベースの中身そのものなので、設定ファイルと同じく
//! 所有者だけが読める権限で作る。
//! 既定 (umask任せ) では同じ端末の他の利用者からも読めてしまう

use std::fs;
use std::io::Write;
use std::path::Path;

/// 所有者だけが読み書きできるファイルを作る (既にあれば中身を空にする)
#[cfg(unix)]
pub fn create(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // 既に別の権限で存在していた場合のために、開いた後にも掛け直す
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

/// Windowsはフォルダから継承したACLに任せる (モード指定の仕組みが無い)
#[cfg(not(unix))]
pub fn create(path: &Path) -> std::io::Result<fs::File> {
    fs::File::create(path)
}

/// 内容をまとめて書き出す (`std::fs::write` の権限つき版)
pub fn write(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut f = create(path)?;
    f.write_all(contents.as_ref())
}
