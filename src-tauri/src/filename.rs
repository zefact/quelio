//! 保存するファイル名の安全化。
//!
//! データベース名やテーブル名はユーザーが決めるもので、
//! MySQLの識別子には `/` や `.` も入れられる。
//! そのままファイル名へ連結すると、保存先フォルダの外へ書き出せてしまうため、
//! ここで「ファイル名として使える形」に直してから使う

/// ファイル名に使えない (使うと事故になる) 文字
const BAD_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];

/// Windowsが装置名として予約している名前 (拡張子を付けても使えない)
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 長すぎるファイル名にしないための上限 (バイト数)。
/// ファイル名の上限は多くのファイルシステムで255バイトなので、
/// 日付や種別を後ろに足しても収まる長さにしておく
const MAX_BYTES: usize = 100;

/// 名前をファイル名の一部として使える形に直す。
///
/// - 区切り文字・制御文字は `_` にする (フォルダを移動できないように)
/// - 前後の空白と `.` は落とす (Windowsでは末尾の `.` が消えるため)
/// - Windowsの予約名は先頭に `_` を付けて避ける
/// - 空になったら `unnamed` にする
pub fn safe_stem(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if c.is_control() || BAD_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // 前後の空白と . を落とす (".." や "." だけの名前もここで消える)
    let trimmed = replaced.trim_matches(|c: char| c == '.' || c.is_whitespace());
    // 日本語は1文字3バイトなので、文字数ではなくバイト数で切る
    // (文字の途中で切らないよう境界を探す)
    let mut end = MAX_BYTES.min(trimmed.len());
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = trimmed[..end].to_string();
    // 切り詰めた結果、末尾がまた . や空白になることがある
    let cut = out.trim_end_matches(|c: char| c == '.' || c.is_whitespace()).len();
    out.truncate(cut);
    if out.is_empty() {
        return "unnamed".to_string();
    }
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&out)) {
        return format!("_{out}");
    }
    out
}

/// 拡張子を保ったままファイル名を安全にする。
///
/// `safe_stem` をファイル名まるごとに掛けると、切り詰めで拡張子が落ちて
/// 開けないファイルになってしまう
pub fn safe_file_name(name: &str) -> String {
    match name.rsplit_once('.') {
        // 拡張子らしいもの (英数字だけ・短い) のときだけ分けて扱う
        Some((stem, ext))
            if !stem.is_empty()
                && !ext.is_empty()
                && ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            format!("{}.{}", safe_stem(stem), ext.to_ascii_lowercase())
        }
        _ => safe_stem(name),
    }
}

/// pg_dump の `-t` はパターン (ワイルドカード) として解釈されるため、
/// 名前をそのまま渡すと `*` や `?` を含むテーブル名が別の表まで巻き込む。
/// ダブルクォートで囲むと中身は文字どおりに扱われる
fn pg_pattern_part(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// 同じ名前のファイルを上書きしない書き出し先を返す。
///
/// 同じ秒に2回押されても前のファイルを消さないよう、
/// 空いている `名前_2.拡張子` … を探す
pub fn unique_path(
    dir: &std::path::Path,
    stem: &str,
    ext: &str,
) -> Result<std::path::PathBuf, String> {
    let path = dir.join(format!("{stem}.{ext}"));
    if !path.exists() {
        return Ok(path);
    }
    for n in 2..100 {
        let path = dir.join(format!("{stem}_{n}.{ext}"));
        if !path.exists() {
            return Ok(path);
        }
    }
    // 使える名前が見つからないまま上書きしない
    Err("同じ名前のファイルが多すぎます".to_string())
}

/// pg_dump の `-t` に渡す1テーブルぶんのパターン
pub fn pg_table_pattern(schema: Option<&str>, name: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", pg_pattern_part(s), pg_pattern_part(name)),
        None => pg_pattern_part(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同じ名前のファイルを上書きしない() {
        let dir = std::env::temp_dir().join(format!(
            "quelio_unique_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("a.csv"));
        let _ = std::fs::remove_file(dir.join("a_2.csv"));

        // 空いていればそのまま
        let p1 = unique_path(&dir, "a", "csv").unwrap();
        assert_eq!(p1.file_name().unwrap(), "a.csv");

        // 既にあれば連番を足す (前のファイルを消さない)
        std::fs::write(&p1, "x").unwrap();
        let p2 = unique_path(&dir, "a", "csv").unwrap();
        assert_eq!(p2.file_name().unwrap(), "a_2.csv");

        std::fs::write(&p2, "x").unwrap();
        assert_eq!(
            unique_path(&dir, "a", "csv").unwrap().file_name().unwrap(),
            "a_3.csv"
        );
        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
    }

    #[test]
    fn 区切り文字はファイル名にしない() {
        // 区切り文字が消えるので、別のフォルダへは書き出せない
        assert_eq!(safe_stem("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_stem("a/b"), "a_b");
        assert_eq!(safe_stem("c:\\tmp\\x"), "c__tmp_x");
        assert_eq!(safe_stem("a\nb"), "a_b");
    }

    #[test]
    fn 空や予約名を避ける() {
        assert_eq!(safe_stem(""), "unnamed");
        assert_eq!(safe_stem("   "), "unnamed");
        assert_eq!(safe_stem("..."), "unnamed");
        assert_eq!(safe_stem("con"), "_con");
        assert_eq!(safe_stem("LPT9"), "_LPT9");
    }

    #[test]
    fn 普通の名前はそのまま() {
        assert_eq!(safe_stem("app_production"), "app_production");
        assert_eq!(safe_stem("受注管理"), "受注管理");
        assert_eq!(safe_stem("db.v2"), "db.v2");
    }

    #[test]
    fn 長すぎる名前は切り詰める() {
        let long = "a".repeat(200);
        assert_eq!(safe_stem(&long).len(), MAX_BYTES);
        // 日本語でもバイト数で収まり、文字の途中では切れない
        let ja = "受".repeat(200);
        let cut = safe_stem(&ja);
        assert!(cut.len() <= MAX_BYTES);
        assert_eq!(cut.chars().count(), MAX_BYTES / 3);
    }

    #[test]
    fn 拡張子を残して切り詰められる() {
        let long = format!("{}.png", "あ".repeat(100));
        let cut = safe_file_name(&long);
        assert!(cut.ends_with(".png"), "{cut}");
        assert!(cut.len() <= MAX_BYTES + 4);
    }

    #[test]
    fn pgのパターンは文字どおりに渡す() {
        assert_eq!(pg_table_pattern(None, "tbl*"), "\"tbl*\"");
        assert_eq!(
            pg_table_pattern(Some("public"), "t\"x"),
            "\"public\".\"t\"\"x\""
        );
    }
}
