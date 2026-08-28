//! トランザクションの開始・終了と、その後始末。
//!
//! 「中止した」「タイムアウトした」あとにトランザクションが開いたままだと、
//! 次の操作が待たされたり、意図しない巻き戻しが起きたりする。
//! 状態 (TxnState) の移し替えをここへ集めて、
//! 取り違えが起きないようにしている

use super::*;

/// トランザクションの開始文。
/// SQLiteは読み取りから書き込みへ昇格すると衝突しうる (待てずに SQLITE_BUSY になる) ので、
/// 最初から書き込みで始める
pub(super) fn begin_sql(conn: &DbConn) -> &'static str {
    if matches!(conn, DbConn::Sqlite(_)) {
        "BEGIN IMMEDIATE"
    } else {
        "BEGIN"
    }
}

/// トランザクションを開始し、開いていることをセッションに覚えさせる。
/// SQLite用に "BEGIN IMMEDIATE" を渡せるよう、開始文は引数で受け取る
pub(super) async fn begin_txn(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    sql: &str,
) -> Result<(), String> {
    // 利用者が開いたトランザクションの上に重ねると、
    // MySQLは暗黙コミット、PostgreSQLは同じトランザクションの続きになる
    if session.txn == TxnState::User {
        return Err(USER_TXN_MSG.to_string());
    }
    /*
     * 状態を先に立てる。
     * BEGIN がサーバーに届いた後で応答を受け取り損ねた場合、
     * 「開いていない」と思い込むほうが危ない
     */
    session.txn = TxnState::Open;
    exec_ctl(&mut session.conn, qlog, label, db_label, sql).await?;
    Ok(())
}

/// トランザクションを閉じる (COMMIT / ROLLBACK)。
///
/// 閉じられなかった場合は接続を Broken として覚えておく。
/// 次の操作の入口 (`ensure_alive`) で接続ごと張り直すので、
/// 開いたままのトランザクションはサーバー側で必ず巻き戻される
pub(super) async fn end_txn(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
    commit: bool,
) -> Result<(), String> {
    let sql = if commit { "COMMIT" } else { "ROLLBACK" };
    match exec_ctl(&mut session.conn, qlog, label, db_label, sql).await {
        Ok(()) => {
            session.txn = TxnState::None;
            Ok(())
        }
        // 「トランザクションが無い」と言われたなら、後始末としては目的を果たしている
        // (SQLiteはこれをエラーにする。MySQL・PostgreSQLは成功で返す)
        Err(e) if e.is_no_txn() => {
            session.txn = TxnState::None;
            Ok(())
        }
        Err(e) => {
            session.txn = TxnState::Broken;
            Err(e.into())
        }
    }
}

/// 取り消しを試み、結果に応じた説明を返す (エラーメッセージに添える)
pub(super) async fn rollback_note(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
    db_label: &str,
) -> &'static str {
    match end_txn(session, qlog, label, db_label, false).await {
        Ok(()) => "変更はすべて取り消されました。",
        Err(_) => "取り消せなかったため、接続を張り直して取り消します。",
    }
}

/// 「トランザクションで実行」と、SQLに書いたトランザクション制御が重なったときの案内
pub const TXN_MIX_MSG: &str = concat!(
    "「トランザクションで実行」がONのときは、\n",
    "SQLの中に BEGIN / COMMIT / ROLLBACK を書けません。\n",
    "どちらか一方にしてください。"
);

/// 利用者が開いたトランザクションが残っているときの案内
pub const USER_TXN_MSG: &str = concat!(
    "SQLで開いたトランザクションが残っています。\n",
    "COMMIT または ROLLBACK を実行してから、もう一度お試しください。\n",
    "(このまま続けると、開いたままの変更まで一緒に確定してしまいます)"
);

/// 実行中の文が中断された後の、トランザクションの状態。
///
/// SQLiteは書き込みの文を中断するとトランザクションごと巻き戻す
/// (読み取りの文なら巻き戻さない)。
/// こちらが「まだ開いている」と思い込むと、そのタブでは
/// 以後ずっと変更操作を断り続けることになる。
/// MySQL・PostgreSQLは文だけを止めるのでトランザクションは残る
pub(super) fn txn_after_cancel(db: DbType, txn: TxnState, stmt_read_only: bool) -> TxnState {
    if db == DbType::Sqlite && txn == TxnState::User && !stmt_read_only {
        TxnState::None
    } else {
        txn
    }
}

/// 前の操作がトランザクションを残していた場合に、ログへ出す説明。
/// 後始末が要らないときは None (接続を張り直さない)
pub(super) fn txn_cleanup_note(txn: TxnState) -> Option<&'static str> {
    match txn {
        // 利用者が自分で開いたトランザクションは正当な状態なので勝手に閉じない
        TxnState::None | TxnState::User => None,
        TxnState::Open => Some("トランザクションが開いたままでした"),
        TxnState::Broken => Some("トランザクションの後始末に失敗していました"),
    }
}
