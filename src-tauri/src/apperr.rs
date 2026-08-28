//! アプリ内部で使うエラーの「種類」。
//!
//! 中止・タイムアウト・「そもそもトランザクションが無い」は、
//! 画面に出すためだけでなく、後始末 (巻き戻し・接続の張り直し・
//! 次の操作での生存確認) の分かれ道にも使う。
//!
//! これをメッセージの文字列で見分けていると、
//! 文言を直した瞬間に判定が静かに外れる。
//! 種類は型で持ち、文字列は表示のためだけに使う。
//!
//! すべてのエラーをこの型にするわけではない。
//! 「後始末の分かれ道に関わるところ」だけをこの型で扱い、
//! 画面へ返すところ (commands.rs) では文字列に戻す

use std::fmt;

/// タイムアウトのメッセージに必ず入る文言。
///
/// 種類を持たない (文字列のままの) エラーを見分けるのにも使うので、
/// 文言を変えるときはここだけを直せば、判定側もついてくる
pub const TIMEOUT_MARK: &str = "タイムアウトしました";

/// タイムアウトのメッセージを組み立てる (「〜が」+ 上の文言)
pub fn timeout_message(what: &str) -> String {
    format!("{what}が{TIMEOUT_MARK}")
}

/// 後始末の判断に使うエラーの種類
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrKind {
    /// 「中止」を押した結果、実行が打ち切られた
    Cancelled,
    /// 待ち時間の上限を超えたので、応答を待たずに打ち切った。
    /// サーバー側のタイムアウトで打ち切られた場合も含む
    Timeout,
    /// COMMIT / ROLLBACK を送ったが、そもそも開いていなかった
    NoTxn,
    /// それ以外 (表示するだけ)
    Other,
}

/// 種類つきのエラー
#[derive(Debug, Clone)]
pub struct AppError {
    pub kind: ErrKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// 種類を問わないエラー (表示するだけ)
    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrKind::Other, message)
    }

    /// 実行を打ち切ったときのエラー
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrKind::Cancelled, message)
    }

    /// 待ち時間の上限を超えたときのエラー。
    /// 文言はここで組み立てて、書き方をそろえる
    pub fn timeout(what: &str) -> Self {
        Self::new(ErrKind::Timeout, timeout_message(what))
    }

    pub fn is_cancelled(&self) -> bool {
        self.kind == ErrKind::Cancelled
    }

    pub fn is_timeout(&self) -> bool {
        self.kind == ErrKind::Timeout
    }

    pub fn is_no_txn(&self) -> bool {
        self.kind == ErrKind::NoTxn
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

/// 画面へ返すときは文字列に戻す (`?` で自動的に変換される)
impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.message
    }
}

/// 種類の分からない文字列のエラーは Other として受ける
impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::other(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::other(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文字列へ戻すと本文だけになる() {
        let e = AppError::timeout("クエリ");
        assert_eq!(e.message, "クエリがタイムアウトしました");
        assert_eq!(String::from(e.clone()), "クエリがタイムアウトしました");
        assert!(e.is_timeout());
        assert!(!e.is_cancelled());
    }

    #[test]
    fn 文字列から作ると種類なしになる() {
        let e: AppError = "接続できません".into();
        assert_eq!(e.kind, ErrKind::Other);
        assert!(!e.is_timeout());
    }

    #[test]
    fn 種類は本文と独立して見分けられる() {
        // 文言を変えても、種類での判定は影響を受けない
        let e = AppError::cancelled("なにか別の言い回し");
        assert!(e.is_cancelled());
    }
}
