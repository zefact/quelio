//! 日時を「手元の時計」で見せるための決めごと。
//!
//! ドライバ (sqlx) は既定で接続のタイムゾーンをUTCに固定する。
//! そのままだと `mysql` コマンドや psql で見える時刻と1日のうち何時間かずれ、
//! `information_schema` のテーブル作成日時なども現地の時刻にならない。
//!
//! そこで接続のタイムゾーンを端末に合わせ、
//! ドライバがUTCで受け取る値 (PostgreSQLの `timestamptz`) も
//! 端末の時計に直してから見せる

use chrono::{DateTime, Local, Utc};

/**
 * 端末のUTCからのずれ (`+09:00` の形)。
 *
 * 名前 (`Asia/Tokyo`) ではなくずれを送るのは、
 * MySQLが名前を受け取るにはタイムゾーンの表を入れておく必要があるため。
 * ずれなら、どのサーバーでもそのまま通る。
 *
 * 夏時間のある地域では接続した時点のずれで固定されるが、
 * 接続をまたいで何か月も繋ぎっぱなしにする使い方はしないため、実害は無い
 */
pub fn utc_offset() -> String {
    Local::now().offset().to_string()
}

/**
 * UTCで受け取った日時を、端末の時計に直して文字にする。
 *
 * ずれ (`+09:00`) を末尾に付けるのは、
 * どのタイムゾーンで見ているのかを値そのものに残すため
 * (psql の既定の出し方と同じ考え方)
 */
pub fn fmt_local(dt: DateTime<Utc>) -> String {
    dt.with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S%.f%:z")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ずれは符号付きの時分で返す() {
        let off = utc_offset();
        let b = off.as_bytes();
        assert_eq!(off.len(), 6, "{off}");
        assert!(b[0] == b'+' || b[0] == b'-', "{off}");
        assert_eq!(b[3], b':', "{off}");
        assert!(off[1..3].bytes().all(|c| c.is_ascii_digit()), "{off}");
        assert!(off[4..6].bytes().all(|c| c.is_ascii_digit()), "{off}");
    }

    #[test]
    fn 端末の時計に直して末尾にずれを付ける() {
        let utc = DateTime::parse_from_rfc3339("2026-09-02T01:46:43Z")
            .unwrap()
            .with_timezone(&Utc);
        let s = fmt_local(utc);
        // 端末のタイムゾーンは決め打ちできないので、形と末尾のずれを確かめる
        assert!(s.ends_with(&utc_offset()), "{s}");
        assert_eq!(s.len(), "2026-09-02 10:46:43+09:00".len(), "{s}");
        // 直したあとも、同じ瞬間を指したままであること
        let back = DateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%:z").unwrap();
        assert_eq!(back.with_timezone(&Utc), utc);
    }
}
