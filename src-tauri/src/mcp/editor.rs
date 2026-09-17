//! AIが書いたSQLを、Quelioのエディタへ **置くだけ** のツール (`open_in_editor`)。
//!
//! 「SQLを書いて」と頼んだのに勝手に実行されるのが一番困るので、
//! ここはDBに触らない。画面へイベントを送るだけにしてある。
//!
//! そのため AI用セッションも張らない (名前の解決だけ行う)。
//! 「ついでに実行する」選択肢は作らない

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::session;
use super::views::AiOpenedSheet;

/// 画面へ送るイベント名
pub const EVENT: &str = "mcp-open-sql";

/// 受け取るSQLの長さの上限。
///
/// 実行しないので中身は見ないが、いくらでも送れると
/// 画面のエディタが固まるため区切りは置く
pub const MAX_SQL_BYTES: usize = 64 * 1024;

/// 省略されたときのシート名
const DEFAULT_TITLE: &str = "AIの提案";

pub const EMPTY_SQL: &str = "SQLが空です";
pub const TOO_LONG: &str = "SQLが長すぎます (64KBまで)";
pub const NO_WINDOW: &str =
    "Quelioのウィンドウが見つかりません。画面を開いてからもう一度試してください";
pub const EMIT_FAILED: &str = "画面へ渡せませんでした";

/// 要求の通し番号 (画面で同じ要求を二度置かないための見分け)
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 自動で付けるシート名の連番。
///
/// 要求の番号とは別にする。名前を指定した呼び出しでも進めてしまうと、
/// 自動の名前が「AIの提案 1」「AIの提案 3」と飛ぶ
static TITLE_SEQ: AtomicU64 = AtomicU64::new(0);

fn next(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::Relaxed) + 1
}

/// シート名を決める。
///
/// 指定があればそれを使い、無ければ「AIの提案 1」「AIの提案 2」…にする
/// (同じ名前が並ぶと、どれが今のものか分からなくなる)
fn sheet_title(given: Option<&str>, seq: u64) -> String {
    match given.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => format!("{DEFAULT_TITLE} {seq}"),
    }
}

/// 画面へ渡す中身。
///
/// `profile_id` は「どのタブに置くか」を決めるために渡す。
/// 接続情報そのものは渡さない (画面側がすでに持っている)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSql {
    /// 画面側での取り違え防止 (同じ要求を二度置かないため)
    id: String,
    profile_id: String,
    connection: String,
    database: Option<String>,
    sql: String,
    title: String,
}

/// AIが直しようのない失敗か (画面側の事情)。
///
/// 接続名やSQLの誤りは AI が直せるが、
/// 「ウィンドウが無い」「画面へ渡せない」は利用者しか直せない
pub fn is_user_side(message: &str) -> bool {
    message == NO_WINDOW || message.starts_with(EMIT_FAILED)
}

/// SQLをエディタへ置く (実行はしない)
pub fn open(
    app: &AppHandle,
    connection: &str,
    database: Option<String>,
    sql: &str,
    title: Option<String>,
) -> Result<AiOpenedSheet, String> {
    /*
     * 公開していない接続には置けない
     * (名前の総当たりで存在を探られないよう「公開されていません」で一律に断る)。
     *
     * ここはDBに触らないので、パスワードの状態は見ない。
     * 「鍵が要る」と返すと、その名前の接続があることを教えてしまう
     */
    let store = crate::storage::load_without_secrets(app)?;
    let profile = session::find_exposed_by_name(&store, connection)?;

    let sql = sql.trim();
    if sql.is_empty() {
        return Err(EMPTY_SQL.to_string());
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err(TOO_LONG.to_string());
    }

    // 送る前に確かめる。送れなかったのに「置いた」と返すと、
    // AIは利用者の画面に出ている前提で話を続けてしまう
    if app.get_webview_window("main").is_none() {
        return Err(NO_WINDOW.to_string());
    }

    // 連番は名前を省かれたときだけ進める
    let given = title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let title = match given {
        Some(t) => t.to_string(),
        None => sheet_title(None, next(&TITLE_SEQ)),
    };
    let seq = next(&SEQ);
    let payload = OpenSql {
        id: format!("mcp-sql-{seq}"),
        profile_id: profile.id.clone(),
        connection: profile.name.clone(),
        database: database
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        sql: sql.to_string(),
        title: title.clone(),
    };
    app.emit_to("main", EVENT, payload)
        .map_err(|e| format!("{EMIT_FAILED}: {e}"))?;
    // フォーカスは奪わない (打っている途中のキーを取らないため)
    super::approval::notify_user(app);

    Ok(AiOpenedSheet {
        sheet: title,
        opened: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 名前が無ければ連番を振る() {
        assert_eq!(sheet_title(None, 1), "AIの提案 1");
        assert_eq!(sheet_title(None, 12), "AIの提案 12");
    }

    #[test]
    fn 空白だけの名前は指定なしとして扱う() {
        assert_eq!(sheet_title(Some("   "), 3), "AIの提案 3");
        assert_eq!(sheet_title(Some(""), 3), "AIの提案 3");
    }

    #[test]
    fn 名前があればそれを使う() {
        assert_eq!(sheet_title(Some("  売上集計 "), 1), "売上集計");
    }

    #[test]
    fn 連番は進む() {
        let a = next(&SEQ);
        let b = next(&SEQ);
        assert!(b > a, "{a} -> {b}");
    }

    #[test]
    fn 名前の連番と要求の番号は別に数える() {
        // 名前を指定した呼び出しで、自動の名前の番号が飛ばないこと
        let before = TITLE_SEQ.load(Ordering::Relaxed);
        let _ = next(&SEQ);
        assert_eq!(TITLE_SEQ.load(Ordering::Relaxed), before);
    }

    #[test]
    fn 画面側の事情だけを見分ける() {
        assert!(is_user_side(NO_WINDOW));
        assert!(is_user_side(&format!("{EMIT_FAILED}: 何か")));
        // 名前・引数の誤りはAIが直せる
        assert!(!is_user_side(TOO_LONG));
        assert!(!is_user_side(EMPTY_SQL));
        assert!(!is_user_side(super::super::session::NOT_EXPOSED));
    }

    #[test]
    fn 長さの上限は64kb() {
        assert_eq!(MAX_SQL_BYTES, 65_536);
    }
}
