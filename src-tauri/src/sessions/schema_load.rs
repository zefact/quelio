//! スキーマ (テーブル・カラム・インデックス) の収集。
//!
//! ER図やスキーマ差分は、タブのSQL実行を止めずに集めたい。
//! そのため MySQL / PostgreSQL では専用の接続を別に張り、
//! 中止もその接続だけを対象にする。
//! 接続の後始末を取り違えないよう、ここにまとめている

use super::*;

/// 指定DBの全テーブルのスキーマ情報 (テーブル+カラム+インデックス) を収集する
async fn collect_schema_local(
    session: &mut Session,
    qlog: &QueryLog,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    // PostgreSQLは対象のDBにつながっていないとカタログが見えない
    if matches!(session.conn, DbConn::Pg(_)) {
        ensure_pg_database(session, database, qlog).await?;
    }
    let label = conn_label(&session.profile);
    collect_schema_conn(&mut session.conn, qlog, &label, database).await
}

/// スキーマ収集の本体 (接続だけを受け取る)。
///
/// PostgreSQLは「対象のDBにつながっている接続」を渡すこと
async fn collect_schema_conn(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    let ctx = LogCtx {
        qlog,
        connection: label,
        database,
    };

    // テーブル一覧
    let tables = match conn {
        DbConn::MySql(c) => catalog::mysql_tables(c, database, &ctx).await?,
        DbConn::Pg(c) => catalog::pg_tables(c, &ctx).await?,
        DbConn::Sqlite(c) => catalog::sqlite_tables(c, &ctx).await?,
        DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
    };

    // テーブルごとの詳細。
    // 1テーブルずつ問い合わせるとテーブル数×3回の往復になるため、
    // MySQL / PostgreSQL はスキーマ全体を数クエリで取ってから振り分ける
    let mut items = Vec::with_capacity(tables.len());
    match conn {
        DbConn::MySql(conn) => {
            let mut all = catalog::mysql_schema_details(conn, database, &ctx).await?;
            for t in &tables {
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail: all.remove(&t.name).unwrap_or_default(),
                });
            }
        }
        DbConn::Pg(conn) => {
            let mut all = catalog::pg_schema_details(conn, &ctx).await?;
            for t in &tables {
                let schema = t.schema.clone().unwrap_or_else(|| "public".to_string());
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail: all.remove(&(schema, t.name.clone())).unwrap_or_default(),
                });
            }
        }
        DbConn::Sqlite(conn) => {
            // SQLiteはローカルファイルなので、1テーブルずつでも十分速い
            for t in &tables {
                let detail = catalog::sqlite_table_detail(conn, &t.name, &ctx).await?;
                items.push(SchemaEntry {
                    table: t.clone(),
                    detail,
                });
            }
        }
        DbConn::Kv(_) => return Err("Valkey接続では使用できません".into()),
    }
    Ok(items)
}

/// スキーマ収集の鍵に付ける通し番号 (同じタブで同時に走っても区別できるように)
static SCHEMA_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// スキーマ収集用の接続をキャンセル対象として登録するときの鍵。
/// タブ本体のSQL実行 (鍵はセッションID) と混ざらないよう区切り文字を挟む
fn schema_cancel_key(session_id: &str) -> String {
    let n = SCHEMA_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}{n}", schema_cancel_prefix(session_id))
}

pub(super) fn schema_cancel_prefix(session_id: &str) -> String {
    format!("{session_id}\u{0}schema\u{0}")
}

/// スキーマ収集中の接続を中止する。
/// 同じタブで複数走っていることがあるので、そのタブのぶんを全て止める
pub async fn cancel_schema_load(
    cancel: &CancelRegistry,
    qlog: &QueryLog,
    session_id: &str,
) -> Result<(), String> {
    let prefix = schema_cancel_prefix(session_id);
    let keys = cancel.keys_with_prefix(&prefix);
    let mut last_err = None;
    for k in keys {
        // 押した直後に終わっていることがあるので、消えていたら成功扱いにする
        if !cancel.contains(&k) {
            continue;
        }
        if let Err(e) = cancel_query(cancel, qlog, &k).await {
            last_err = Some(e);
        }
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/*
 * スキーマ収集は、テーブル数が多いDBだと分単位で掛かる。
 * タブの接続をそのまま使うとその間タブが操作できなくなるため、
 * MySQL / PostgreSQL は同じ接続先へ「もう1本だけ」つないで、そちらで集める。
 *
 * SQLiteはローカルファイルなのでタブの接続をそのまま使う
 * (別ハンドルを開いても速くならず、書き込みロックの取り合いになるだけ)。
 */

/// スキーマ収集専用の接続。
///
/// 「中止」できるようキャンセル用レジストリに登録し、
/// 途中で落ちても (パニックしても) Drop で必ず登録を消す
struct SchemaConn {
    conn: Option<DbConn>,
    /// コンソールに出す接続名 (タブの接続と見分けられるようにする)
    label: String,
    cancel: CancelRegistry,
    key: String,
    /// 自前で張ったSSHトンネル。
    /// セッション側の張り直しに巻き込まれないよう、収集用は別に張る
    tunnel: Option<SshTunnel>,
}

impl SchemaConn {
    fn conn(&mut self) -> &mut DbConn {
        // close() は self を消費するので、閉じた後にここへ来ることはない
        self.conn.as_mut().expect("接続は閉じられています")
    }

    fn unregister(&self) {
        self.cancel.unregister(&self.key);
    }

    /// 使い終わった接続とトンネルを閉じる。
    /// 先に登録を消しておくと、この後に「中止」が始まることがなくなる
    async fn close(mut self) {
        self.unregister();
        if let Some(c) = self.conn.take() {
            close_conn_gracefully(c).await;
        }
        // 踏み台へも切断を伝える (伝えないと相手側に異常切断として残る)
        if let Some(t) = self.tunnel.as_mut() {
            t.close().await;
        }
    }
}

impl Drop for SchemaConn {
    fn drop(&mut self) {
        self.unregister();
    }
}

/// スキーマ収集用にもう1本つなぐ。
///
/// Noneを返したときは呼び出し側がタブの接続で集める。
/// - SQLite / Valkey は専用接続の意味が無い
/// - 接続数の上限などで張れなかった場合も、失敗させずにタブの接続へ譲る
async fn open_schema_conn(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Option<SchemaConn>, String> {
    let arc = get_session(sessions, session_id).await?;

    /*
     * 接続先の情報だけを写し取ってロックを離す。
     * ここから先はタブを止めない (逆に、タブが長いSQLを実行している間は
     * この1行で待たされる。写し取るだけなので待ちは一瞬では済まないが、
     * 収集そのものはタブと並行して走る)
     */
    let (profile, cancel) = {
        let guard = arc.lock().await;
        (guard.profile.clone(), guard.cancel.clone())
    };
    if !matches!(profile.db_type, DbType::Mysql | DbType::Postgresql) {
        return Ok(None);
    }
    let label = format!("{} (スキーマ収集)", conn_label(&profile));
    match connect_schema_conn(&profile, &label, cancel, session_id, qlog, database).await {
        Ok(sc) => Ok(Some(sc)),
        Err(e) => {
            // 接続数の上限・踏み台の同時接続数などで張れないことがある。
            // 以前と同じくタブの接続で集めれば、機能そのものは使える
            qlog.add(
                &label,
                database,
                &format!("-- 収集用の接続を開けないため、タブの接続で集めます ({e})"),
            );
            Ok(None)
        }
    }
}

/// 収集用の接続を1本張って、中止できるよう登録する
async fn connect_schema_conn(
    profile: &ConnectionProfile,
    label: &str,
    cancel: CancelRegistry,
    session_id: &str,
    qlog: &QueryLog,
    database: &str,
) -> Result<SchemaConn, String> {
    // トンネルも自前で張る。セッション側が張り直しても収集が切れないようにする
    let ep = db::resolve_endpoint(profile).await?;
    let via_ssh = ep.tunnel.is_some();
    let tls = db::TlsConfig::from_profile(profile, via_ssh);
    let conn = match profile.db_type {
        // MySQLはDB名を明示して information_schema を引くため、接続先DBは指定しない
        DbType::Mysql => DbConn::MySql(
            db::connect_mysql(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                None,
                &tls,
            )
            .await?,
        ),
        // PostgreSQLは対象のDBにつながっていないとカタログが見えない
        _ => DbConn::Pg(
            db::connect_pg(
                &ep.host,
                ep.port,
                &profile.user,
                &profile.password,
                Some(database),
                &tls,
            )
            .await?,
        ),
    };

    let mut sc = SchemaConn {
        conn: Some(conn),
        label: label.to_string(),
        cancel,
        key: schema_cancel_key(session_id),
        tunnel: ep.tunnel,
    };

    // 読み取り専用の接続なら、収集用の接続にも同じ縛りを掛ける
    let prepared = async {
        if profile.read_only {
            let label = sc.label.clone();
            apply_read_only(sc.conn(), qlog, &label, database).await?;
        }
        fetch_conn_id(sc.conn()).await
    }
    .await;
    let conn_id = match prepared {
        Ok(id) => id,
        Err(e) => {
            sc.close().await;
            return Err(e);
        }
    };
    qlog.add(
        label,
        database,
        &format!("-- 収集用の接続を開きました (接続ID {conn_id})"),
    );

    // 「中止」ボタンから止められるようにする
    let sqlite_cancel = install_sqlite_cancel(sc.conn()).await;
    sc.cancel.register(
        sc.key.clone(),
        CancelTarget {
            db_type: profile.db_type,
            label: sc.label.clone(),
            host: ep.host.clone(),
            port: ep.port,
            user: profile.user.clone(),
            password: zeroize::Zeroizing::new(profile.password.clone()),
            conn_id,
            tls: profile.tls,
            tls_sni: via_ssh.then(|| profile.host.clone()),
            db_tls: tls,
            sqlite_cancel,
        },
    );
    Ok(sc)
}

/// スキーマスナップショットを返す (差分ビューア・ER図・スキーマ一覧用)
pub async fn schema_snapshot(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<Vec<SchemaEntry>, String> {
    if let Some(mut sc) = open_schema_conn(sessions, qlog, session_id, database).await? {
        let label = sc.label.clone();
        let result = collect_schema_conn(sc.conn(), qlog, &label, database).await;
        sc.close().await;
        return result;
    }
    // SQLite / Valkey はタブの接続で集める
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    collect_schema_local(session, qlog, database).await
}

/// 選択中DBの全テーブルの定義・カラム・インデックスをCSV文字列で返す
/// (tables.csv, columns.csv, indexes.csv の3つ)
pub async fn export_schema(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
    comment_delimiter: &str,
) -> Result<(String, String, String), String> {
    let items = schema_snapshot(sessions, qlog, session_id, database).await?;

    Ok((
        export::tables_csv(&items),
        export::columns_csv(&items, comment_delimiter),
        export::indexes_csv(&items),
    ))
}

/// ER図用: スキーマと外部キーを1本の接続でまとめて取る。
///
/// 別々のコマンドにすると収集用の接続 (とSSHトンネル) が2本になるため、
/// 1回の呼び出しで両方を返す
pub async fn schema_with_foreign_keys(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: &str,
) -> Result<(Vec<SchemaEntry>, Vec<crate::models::FkInfo>), String> {
    if let Some(mut sc) = open_schema_conn(sessions, qlog, session_id, database).await? {
        let label = sc.label.clone();
        let result = async {
            let entries = collect_schema_conn(sc.conn(), qlog, &label, database).await?;
            let fks = foreign_keys_conn(sc.conn(), qlog, &label, database).await?;
            Ok((entries, fks))
        }
        .await;
        sc.close().await;
        return result;
    }
    // SQLite / Valkey はタブの接続で集める
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    // PostgreSQLは対象のDBにつながっていないとカタログが見えない
    if matches!(session.conn, DbConn::Pg(_)) {
        ensure_pg_database(session, database, qlog).await?;
    }
    let label = conn_label(&session.profile);
    let entries = collect_schema_conn(&mut session.conn, qlog, &label, database).await?;
    let fks = foreign_keys_conn(&mut session.conn, qlog, &label, database).await?;
    Ok((entries, fks))
}

/// 外部キーの取得 (接続だけを受け取る)。
/// PostgreSQLは「対象のDBにつながっている接続」を渡すこと
async fn foreign_keys_conn(
    conn: &mut DbConn,
    qlog: &QueryLog,
    label: &str,
    database: &str,
) -> Result<Vec<crate::models::FkInfo>, String> {
    let ctx = LogCtx {
        qlog,
        connection: label,
        database,
    };
    let out = match conn {
        DbConn::MySql(c) => catalog::mysql_foreign_keys(c, database, &ctx).await,
        DbConn::Pg(c) => catalog::pg_foreign_keys(c, &ctx).await,
        DbConn::Sqlite(c) => catalog::sqlite_foreign_keys(c, &ctx).await,
        DbConn::Kv(_) => Err("Valkey接続では使用できません".into()),
    };
    Ok(out?)
}
