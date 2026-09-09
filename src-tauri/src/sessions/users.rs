//! DBのユーザー (PostgreSQL ではロール) の参照と、作成・変更・削除。
//!
//! 参照は読むだけなので読み取り専用の接続でも使えるが、
//! 変更は `ensure_writable` を通す。
//!
//! 変えてはいけない相手 (サーバーが用意したもの・今つないでいる自分自身) は
//! `dbuser::check_target` で断る。画面でもボタンを出さないが、ここでも止める

use super::*;
use crate::dbuser::{self, UserChange, UserRef};

/// この接続でユーザーの一覧を扱えるか確かめ、接続名を返す
fn begin_users(session: &Session) -> Result<String, String> {
    match session.conn {
        DbConn::Sqlite(_) => {
            Err("SQLiteはファイルを開くだけなので、ユーザーの仕組みがありません".into())
        }
        DbConn::Kv(_) => {
            Err("ValkeyのユーザーはACLという別の仕組みです (この画面では扱えません)".into())
        }
        _ => Ok(conn_label(&session.profile)),
    }
}

/// ユーザー (ロール) の一覧
pub async fn list_users(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<catalog::DbUsersInfo, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let label = begin_users(session)?;
    ensure_alive(session, qlog).await?;
    let read_only = session.profile.read_only;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    let out = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_users(conn, &ctx).await,
        DbConn::Pg(conn) => catalog::pg_users(conn, &ctx).await,
        // begin_users で弾いてあるが、ここでも念のため断る
        _ => return Err("この接続では扱えません".into()),
    };
    let mut info = out?;
    // 読み取り専用の接続では、そもそも変えられない
    if read_only {
        info.can_manage = false;
        info.manage_note =
            "この接続は読み取り専用です (接続先の設定を変えて接続し直すと操作できます)".into();
    }
    Ok(info)
}

/// 1人ぶんの権限
pub async fn user_grants(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    key: &str,
) -> Result<Vec<catalog::DbGrant>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let label = begin_users(session)?;
    ensure_alive(session, qlog).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    let out = match &mut session.conn {
        DbConn::MySql(conn) => catalog::mysql_grants(conn, &ctx, key).await,
        DbConn::Pg(conn) => catalog::pg_grants(conn, &ctx, key).await,
        _ => return Err("この接続では扱えません".into()),
    };
    Ok(out?)
}

/// 範囲ごとに選べる権限の名前 (画面の選択肢を作るのに使う)
pub async fn user_privileges(
    sessions: &Sessions,
    session_id: &str,
) -> Result<crate::catalog::PrivilegeChoices, String> {
    let arc = get_session(sessions, session_id).await?;
    let guard = arc.lock().await;
    let db = guard.profile.db_type;
    let pick = |s: dbuser::Scope| -> Vec<String> {
        dbuser::privileges(db, s)
            .iter()
            .map(|p| p.to_string())
            .collect()
    };
    Ok(crate::catalog::PrivilegeChoices {
        server: pick(dbuser::Scope::Server),
        database: pick(dbuser::Scope::Database),
        schema: pick(dbuser::Scope::Schema),
        table: pick(dbuser::Scope::Table),
    })
}

/**
 * 実行せずに、流すことになるSQLだけを返す。
 *
 * 確認の画面に出すためのもの。パスワードは伏せてから返す
 * (画面に出したものが、そのまま人目に触れることがあるため)
 */
pub async fn preview_change(
    sessions: &Sessions,
    session_id: &str,
    change: UserChange,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let guard = arc.lock().await;
    begin_users(&guard)?;
    let style = ddl::SqlStyle::from_dialect(guard.profile.db_type, &guard.dialect);
    Ok(dbuser::build(style, &change)?
        .iter()
        .map(|s| crate::sql_secret::mask(s))
        .collect())
}

/**
 * 変更を実行する。
 *
 * 変えてよい相手かをここでも確かめる。
 * 画面でもボタンを出さないが、命令だけを組んで送られても止まるようにしておく
 */
pub async fn apply_change(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    change: UserChange,
) -> Result<(), String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let label = begin_users(session)?;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    /*
     * PostgreSQL は、スキーマやテーブルへの権限を
     * 「そのデータベースへ繋いだ状態」でしか付けられない。
     * 画面で選んだデータベースへ繋ぎ直してから流す
     * (MySQL は USE が走るだけで、どのデータベースにも付けられる)
     */
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    let style = ddl::SqlStyle::from_dialect(session.profile.db_type, &session.dialect);

    if let Some(user) = change.target() {
        let me = current_key(&mut session.conn).await;
        dbuser::check_target(user, &me, style.db)?;
    }
    let statements = dbuser::build(style, &change)?;
    let dropping = matches!(change, UserChange::Drop { .. });

    for sql in &statements {
        exec_ctl(&mut session.conn, qlog, &label, database, sql)
            .await
            .map_err(|e| explain(&e.to_string(), dropping))?;
    }
    Ok(())
}

/**
 * サーバーの断り文句に、次の一手を添える。
 *
 * PostgreSQL は「どのデータベースに残っているか」まで教えてくれるが、
 * そこへ接続し直す必要があることまでは書かれていない
 */
fn explain(error: &str, dropping: bool) -> String {
    if dropping && error.contains("depend on it") {
        format!(
            "{error}\n\n(ほかのデータベースに権限か持ち物が残っています。\
             そのデータベースへ接続してから、もう一度お試しください)"
        )
    } else {
        error.to_string()
    }
}

/// 今つないでいるユーザーの呼び名 (聞けなければ空)
async fn current_key(conn: &mut DbConn) -> String {
    match conn {
        DbConn::MySql(c) => {
            let me: String = sqlx::query_scalar("SELECT CURRENT_USER()")
                .fetch_one(&mut *c)
                .await
                .unwrap_or_default();
            match me.rsplit_once('@') {
                Some((u, h)) => dbuser::user_key(
                    DbType::Mysql,
                    &UserRef {
                        name: u.to_string(),
                        host: h.to_string(),
                    },
                ),
                None => me,
            }
        }
        DbConn::Pg(c) => sqlx::query_scalar("SELECT current_user")
            .fetch_one(&mut *c)
            .await
            .unwrap_or_default(),
        _ => String::new(),
    }
}
