//! データベースの所有者の読み出しと付け替え (PostgreSQLのみ)

use super::*;

/// PostgreSQLの接続でなければ断る
fn ensure_pg_conn(session: &Session) -> Result<(), String> {
    if matches!(session.conn, DbConn::Pg(_)) {
        Ok(())
    } else {
        Err("データベースの所有者を扱えるのはPostgreSQLだけです".into())
    }
}

/// 今の接続で、所有者の一覧と選べるロールを読む
async fn read_owners(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
) -> Result<catalog::DatabaseOwners, String> {
    let db_label = session.current_db.clone().unwrap_or_default();
    let ctx = LogCtx {
        qlog,
        connection: label,
        database: &db_label,
    };
    match &mut session.conn {
        DbConn::Pg(c) => Ok(catalog::pg_database_owners(c, &ctx).await?),
        _ => Err("データベースの所有者を扱えるのはPostgreSQLだけです".into()),
    }
}

/// データベースの所有者の一覧と、所有者に選べるロール
pub async fn database_owners(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<catalog::DatabaseOwners, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_pg_conn(session)?;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    read_owners(session, qlog, &label).await
}

/// データベースの所有者を付け替える (付け替えたあとの一覧を返す)
pub async fn change_database_owner(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    name: &str,
    owner: &str,
) -> Result<catalog::DatabaseOwners, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_pg_conn(session)?;
    // 書き込みできる接続か・生きているかは、作成・削除と同じく確かめる
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    let sql = crate::dbadmin::alter_database_owner_sql(db_type, name, owner)?;
    let db_label = session.current_db.clone().unwrap_or_default();
    exec_ctl(&mut session.conn, qlog, &label, &db_label, &sql).await?;
    read_owners(session, qlog, &label).await
}
