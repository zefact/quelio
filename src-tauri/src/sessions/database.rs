//! データベース / スキーマそのものの操作。
//!
//! 作成・削除・切り替えは、テーブルの読み書きとは別の注意がいる。
//! (接続中のDBは消せない、PostgreSQLは対象DBへ接続を張り直す、
//!  一覧を取り直してセッションに覚えさせる)
//! その手順をここへ集めている

use super::*;

/// 接続しているサーバーのデータベース一覧を取り直してセッションに覚えさせる
async fn refresh_databases(
    session: &mut Session,
    qlog: &QueryLog,
    label: &str,
) -> Result<Vec<String>, String> {
    let db_label = session.current_db.clone().unwrap_or_default();
    let ctx = LogCtx {
        qlog,
        connection: label,
        database: &db_label,
    };
    let list = match &mut session.conn {
        DbConn::MySql(c) => catalog::mysql_databases(c, &ctx).await?,
        DbConn::Pg(c) => catalog::pg_databases(c, &ctx).await?,
        _ => return Err("この接続では扱えません".into()),
    };
    session.databases = list.clone();
    Ok(list)
}

/// MySQLが今どのデータベースを使っているかをサーバーに聞く。
///
/// ユーザーがSQLエディタで `USE` を打つと接続の既定が変わるので、
/// 覚えている値 (`current_db`) だけを信じない
async fn mysql_current_db(conn: &mut DbConn) -> Option<String> {
    let DbConn::MySql(c) = conn else { return None };
    sqlx::query_scalar::<_, Option<String>>("SELECT DATABASE()")
        .fetch_one(&mut *c)
        .await
        .ok()
        .flatten()
}

/// データベースの作成・削除に共通の下ごしらえ (書き込み可・生存・種類の確認)
async fn begin_db_admin(
    session: &mut Session,
    qlog: &QueryLog,
) -> Result<(DbType, String), String> {
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    match session.conn {
        DbConn::Sqlite(_) => {
            return Err("SQLiteはファイル1つが1データベースです".into())
        }
        DbConn::Kv(_) => return Err("Valkey接続ではこの操作はできません".into()),
        _ => {}
    }
    Ok((session.profile.db_type, conn_label(&session.profile)))
}

/// データベースを作る (作成後の一覧を返す)
pub async fn create_database(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    name: &str,
    encoding: Option<String>,
    collation: Option<String>,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    let sql = crate::dbadmin::create_database_sql(
        db_type,
        name,
        encoding.as_deref(),
        collation.as_deref(),
    )?;
    let db_label = session.current_db.clone().unwrap_or_default();
    exec_ctl(&mut session.conn, qlog, &label, &db_label, &sql).await?;
    refresh_databases(session, qlog, &label).await
}

/// データベースを消す (削除後の一覧を返す)
pub async fn drop_database(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    name: &str,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    /*
     * 今つないでいるデータベースは消せない。
     * PostgreSQLはサーバーが断り、MySQLは消せてしまうが
     * 行き先の無い接続が残ってしまう
     */
    let mut current = session.current_db.clone();
    if db_type == DbType::Mysql {
        // 覚えている値がずれていることがあるので、サーバーにも聞く
        if let Some(actual) = mysql_current_db(&mut session.conn).await {
            session.current_db = Some(actual.clone());
            current = Some(actual);
        }
    }
    // MySQLはDB名の大小を区別しない設定があるので、大小を無視して見る
    if current
        .as_deref()
        .is_some_and(|c| c.eq_ignore_ascii_case(name))
    {
        return Err(
            "今つないでいるデータベースは削除できません (別のデータベースに切り替えてから実行してください)"
                .into(),
        );
    }
    let sql = crate::dbadmin::drop_database_sql(db_type, name)?;
    let db_label = session.current_db.clone().unwrap_or_default();
    exec_ctl(&mut session.conn, qlog, &label, &db_label, &sql).await?;
    refresh_databases(session, qlog, &label).await
}

/// 文字コード (エンコーディング) と照合順序の一覧。
///
/// データベースを作るときに画面で選べるようにするために使う
pub async fn list_charsets(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<Vec<catalog::CharsetInfo>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let db_label = session.current_db.clone().unwrap_or_default();
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    let out = match &mut session.conn {
        DbConn::MySql(c) => catalog::mysql_charsets(c, &ctx).await,
        DbConn::Pg(c) => catalog::pg_encodings(c, &ctx).await,
        // SQLite・Valkeyにはデータベースを作る操作が無い
        _ => Ok(Vec::new()),
    };
    Ok(out?)
}

/// スキーマの一覧 (PostgreSQLのみ)
pub async fn list_schemas(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    /*
     * ensure_database はMySQLとSQLite以外をPostgreSQLとみなして接続を張り直す。
     * Valkeyを渡してしまわないよう、先に種類を確かめる
     */
    if !matches!(session.conn, DbConn::Pg(_)) {
        return Err("スキーマを扱えるのはPostgreSQLだけです".into());
    }
    let label = conn_label(&session.profile);
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    let out = match &mut session.conn {
        DbConn::Pg(c) => catalog::pg_schemas(c, &ctx).await,
        _ => Err("スキーマを扱えるのはPostgreSQLだけです".into()),
    };
    Ok(out?)
}

/// スキーマを作る / 消す (処理後の一覧を返す)
pub async fn change_schema(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    name: &str,
    // drop: trueなら削除、falseなら作成
    drop: bool,
    // cascade: 削除時に中身ごと消すか
    cascade: bool,
) -> Result<Vec<String>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    let (db_type, label) = begin_db_admin(session, qlog).await?;
    if drop && crate::dbadmin::is_system_schema(name) {
        return Err("システムのスキーマは削除できません".into());
    }
    let sql = if drop {
        crate::dbadmin::drop_schema_sql(db_type, name, cascade)?
    } else {
        crate::dbadmin::create_schema_sql(db_type, name)?
    };
    ensure_database(session, Some(&database.to_string()), qlog, &label).await?;
    exec_ctl(&mut session.conn, qlog, &label, database, &sql).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database,
    };
    let out = match &mut session.conn {
        DbConn::Pg(c) => catalog::pg_schemas(c, &ctx).await,
        _ => Err("スキーマを扱えるのはPostgreSQLだけです".into()),
    };
    Ok(out?)
}

/// PostgreSQLで指定DBに接続していなければ張り直す
pub(super) async fn ensure_pg_database(
    session: &mut Session,
    database: &str,
    qlog: &QueryLog,
) -> Result<(), String> {
    if session.current_db.as_deref() != Some(database) {
        // 接続を張り直すと未コミットの変更が消えるので、黙って捨てない
        if session.txn == TxnState::User {
            return Err(USER_TXN_MSG.to_string());
        }
        qlog.add(
            &conn_label(&session.profile),
            database,
            &format!("-- データベース '{database}' に接続を切り替え"),
        );
        let new_conn = db::connect_pg(
            &session.host,
            session.port,
            &session.profile.user,
            &session.profile.password,
            Some(database),
            &db::TlsConfig::from_profile(&session.profile, session.tunnel.is_some()),
        )
        .await?;
        // 旧接続はTerminateを送って閉じる
        let old = std::mem::replace(&mut session.conn, DbConn::Pg(new_conn));
        invalidate_cancel_conn(session);
        close_conn_gracefully(old).await;
        session.current_db = Some(database.to_string());
        // 新しい接続にトランザクションは無い (旧接続の分はサーバーが巻き戻す)
        session.txn = TxnState::None;
        // 接続が変わったので方言を解決し直す
        session.dialect = resolve_dialect(
            session.profile.db_type,
            &mut session.conn,
            qlog,
            &conn_label(&session.profile),
            database,
        )
        .await;
        if session.profile.read_only {
            let label = conn_label(&session.profile);
            // 読み取り専用を掛けられなかった接続は使わせない (次の操作で張り直す)
            if let Err(e) = apply_read_only(&mut session.conn, qlog, &label, database).await {
                session.txn = TxnState::Broken;
                return Err(e);
            }
        }
        // 接続が変わったのでキャンセル用の接続IDを更新する
        if let Ok(conn_id) = fetch_conn_id(&mut session.conn).await {
            session.cancel.edit(&session.id, |t| t.conn_id = conn_id);
        }
    }
    Ok(())
}
