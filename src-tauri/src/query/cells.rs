//! 結果のセルを文字列にする。
//!
//! 長すぎる値は切り詰め、どこを切ったかを別に持つ
//! (画面ではその位置から全文を取り直せるようにするため)

use super::*;

/// 切り詰めた場所。
///
/// 値そのものには「先頭 + … (全N文字)」を入れたままにしている
/// (グリッドのコピーはDOMの文字列を読むため、注記を消すと
///  切り詰められたことに気づかないままコピーされてしまう)。
/// 画面側がこの注記を文字列として読み戻さずに済むよう、位置は別に返す
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// 注記を除いた、実際に入っている先頭の文字数
    pub head: usize,
    /// 切り詰める前の全体の文字数
    pub total: usize,
}

/// セル1つの読み取り結果 (値と、切り詰めた場合の位置)。
/// NULL は None
pub(super) type CellText = Option<(String, Option<Clip>)>;

/// 切り詰めたセルの位置 (結果1つぶんをまとめて返す)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClippedCell {
    /// このページの中での行番号 (0始まり)
    pub row: usize,
    /// 列番号 (0始まり)
    pub col: usize,
    pub head: usize,
    pub total: usize,
}

/// セル文字列を表示用に切り詰める (切り詰めた場合は全体の文字数を添える)。
/// maxにusize::MAXを渡すと切り詰めない (CSV出力用)
pub(super) fn clip_cell(s: String, max: usize) -> (String, Option<Clip>) {
    // 大半の値は短いので、まず安価なバイト長で判定する
    // (1文字1バイト以上なので、バイト長が上限以下なら文字数も上限以下)
    if s.len() <= max {
        return (s, None);
    }
    let total = s.chars().count();
    if total <= max {
        return (s, None);
    }
    let head: String = s.chars().take(max).collect();
    (
        format!("{head}… (全{total}文字)"),
        Some(Clip { head: max, total }),
    )
}

/// 切り詰めたうえでCSV用のセルにする
fn cell_of(text: String, max: usize, numeric: bool) -> CsvCell {
    let (text, clip) = clip_cell(text, max);
    CsvCell {
        text,
        numeric,
        clip,
    }
}

fn bytes_preview(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().take(32).map(|b| format!("{b:02x}")).collect();
    if bytes.len() > 32 {
        format!("0x{hex}… ({} bytes)", bytes.len())
    } else {
        format!("0x{hex}")
    }
}

/// 1マクロで複数の型を順に試すセル文字列化。
/// `型 => 数値かどうか` の並びで書く (数値はCSVでクォートしないため)
macro_rules! try_types {
    ($row:expr, $i:expr, $max:expr, [$($t:ty => $num:expr),+ $(,)?]) => {
        $(
            if let Ok(v) = $row.try_get::<Option<$t>, _>($i) {
                return v.map(|x| cell_of(x.to_string(), $max, $num));
            }
        )+
    };
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
pub(super) fn mysql_cell(row: &MySqlRow, i: usize) -> CellText {
    mysql_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
pub(super) fn mysql_cell_all(row: &MySqlRow, i: usize) -> CellText {
    mysql_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn mysql_cell_fetch(row: &MySqlRow) -> Option<String> {
    mysql_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
pub(super) fn mysql_cell_full(row: &MySqlRow, i: usize) -> Option<CsvCell> {
    mysql_cell_max(row, i, usize::MAX)
}

fn mysql_cell_max(row: &MySqlRow, i: usize, max: usize) -> Option<CsvCell> {
    // FLOATは4バイトのまま届くことがあり、f64として読むと
    // 0.1 が 0.10000000149011612 になる。列の型を見てf32で読む
    if row
        .try_get_raw(i)
        .is_ok_and(|v| v.type_info().name() == "FLOAT")
    {
        if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
            return v.map(|x| cell_of(x.to_string(), max, true));
        }
    }
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        u64 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        bool => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
pub(super) fn pg_cell(row: &PgRow, i: usize) -> CellText {
    pg_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
pub(super) fn pg_cell_all(row: &PgRow, i: usize) -> CellText {
    pg_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn pg_cell_fetch(row: &PgRow) -> Option<String> {
    pg_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
pub(super) fn pg_cell_full(row: &PgRow, i: usize) -> Option<CsvCell> {
    pg_cell_max(row, i, usize::MAX)
}

fn pg_cell_max(row: &PgRow, i: usize, max: usize) -> Option<CsvCell> {
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        i32 => true,
        i16 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        bool => false,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        uuid::Uuid => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
pub(super) fn sqlite_cell(row: &SqliteRow, i: usize) -> CellText {
    sqlite_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
pub(super) fn sqlite_cell_all(row: &SqliteRow, i: usize) -> CellText {
    sqlite_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn sqlite_cell_fetch(row: &SqliteRow) -> Option<String> {
    sqlite_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
pub(super) fn sqlite_cell_full(row: &SqliteRow, i: usize) -> Option<CsvCell> {
    sqlite_cell_max(row, i, usize::MAX)
}

/// SQLiteは列ではなく値ごとに型が決まる (動的型付け) ため、
/// 宣言型ではなく実際に入っている値の型で文字列化する
fn sqlite_cell_max(row: &SqliteRow, i: usize, max: usize) -> Option<CsvCell> {
    let Ok(raw) = row.try_get_raw(i) else {
        return Some(CsvCell::text("(取得できません)".into()));
    };
    if raw.is_null() {
        return None;
    }
    let type_name = raw.type_info().name().to_string();
    match type_name.as_str() {
        "INTEGER" => row
            .try_get::<Option<i64>, _>(i)
            .ok()
            .flatten()
            .map(|v| cell_of(v.to_string(), max, true)),
        "REAL" => row
            .try_get::<Option<f64>, _>(i)
            .ok()
            .flatten()
            .map(|v| cell_of(v.to_string(), max, true)),
        "BLOB" => row
            .try_get::<Option<Vec<u8>>, _>(i)
            .ok()
            .flatten()
            .map(|b| CsvCell::text(bytes_preview(&b))),
        // TEXT・その他はすべて文字列として扱う
        _ => row
            .try_get::<Option<String>, _>(i)
            .ok()
            .flatten()
            .map(|s| cell_of(s, max, false)),
    }
}
