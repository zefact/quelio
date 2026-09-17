//! `run_query` / `explain` の守りと実行。
//!
//! AIから来るSQLは、利用者が自分で書いたものとは前提が違う。
//! 「頼んでいないことをした」が起きないよう、実行の前に段を重ねる:
//!
//! 1. 1文だけ (2文以上は、後ろの文が見落とされる)
//! 2. トランザクションの開始・終了と、方言を変える文は拒否
//! 3. 更新系は、公開レベルが「更新も許可」のときだけ。
//!    そのうえで **実行のたびに人がQuelioの画面で許可する** (`approval`)
//! 4. 行数に上限を置く
//!
//! 「読み取りのみ」の接続は、これに加えて接続そのものを読み取り専用で張ってある
//! (`session::ai_profile`)。判定をすり抜けてもDB側で止まる

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::models::AiAccess;
use crate::query::{Analyzed, DangerousStatement, Dialect};

use super::approval::{self, Decision, APPROVAL_TIMEOUT};
use super::catalog::database_of;
use super::rows::{self, RowFormat};
use super::session::Opened;
use super::views::{AiResultColumn, AiRows};

/// 返す行数の既定
pub const DEFAULT_MAX_ROWS: usize = 200;

/// 返す行数の上限。
///
/// 既存のページング (`query::PAGE_SIZE` = 1000) を超えては読まない。
/// AIに渡せる量にも限りがある
pub const MAX_ROWS: usize = 1000;

/// 読み取り以外を断る文言
pub const READ_ONLY_ONLY: &str = "AI連携からは読み取りのSQLだけ実行できます";

/// 2文以上を断る文言
pub const SINGLE_ONLY: &str = "AI連携では1つのSQLだけ実行できます (複数の文はまとめて送れません)";

/// トランザクション・設定変更を断る文言
pub const NO_SESSION_CONTROL: &str =
    "AI連携からはトランザクションやセッション設定の操作はできません";

/// 上限と既定を当てはめる。
///
/// 大きすぎる指定は黙って上限へ丸める (断るより、少なく返して続けられる方がよい)
pub fn clamp_max_rows(requested: Option<usize>) -> usize {
    match requested {
        None => DEFAULT_MAX_ROWS,
        // 0 を許すと「何も返らないのに成功した」になるので、1件は返す
        Some(n) => n.clamp(1, MAX_ROWS),
    }
}

/// SQLの見立て
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlKind {
    /// 読み取り。そのまま実行してよい
    Read,
    /// データや定義を変える。人の許可が要る
    Write {
        /// 取り返しのつかない種類 (既存の確認ダイアログと同じ判定)
        dangerous: Vec<DangerousStatement>,
    },
}

/// 実行してよいSQLかを見分ける。
///
/// **断るのはここまで** (形として受け付けられないもの)。
/// 「更新だから通さない」の判断は、公開レベルを知っている `run` 側で行う。
///
/// 方言 (`Dialect`) が要るのは、文の区切りや引用の書き方がDBで違うため
pub fn classify_sql(dialect: Dialect, sql: &str) -> Result<SqlKind, String> {
    if sql.trim().is_empty() {
        return Err("実行するSQLがありません".to_string());
    }
    let stmts = crate::query::split_sql(dialect, sql);
    // 区切りを判断できないものは通さない (見えていない文が走りうる)
    if stmts.unterminated.is_some() {
        return Err(SINGLE_ONLY.to_string());
    }
    if stmts.stmts.len() > 1 {
        return Err(SINGLE_ONLY.to_string());
    }
    let Some(one) = stmts.stmts.first() else {
        return Err("実行するSQLがありません".to_string());
    };
    let a = Analyzed::new(dialect, one);
    // トランザクションと設定変更は、この1回の呼び出しを超えて影響が残る
    if a.changes_dialect() || is_txn_control(&a) {
        return Err(NO_SESSION_CONTROL.to_string());
    }
    if a.is_read_only() {
        return Ok(SqlKind::Read);
    }
    Ok(SqlKind::Write {
        dangerous: crate::query::dangerous_statements(dialect, sql),
    })
}

/// トランザクションの開始・終了そのものか
fn is_txn_control(a: &Analyzed) -> bool {
    matches!(
        a.head(),
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "END" | "SAVEPOINT" | "RELEASE"
    )
}

/// SQLを1つ実行して、行を返す。
///
/// 更新系は、公開レベルが「更新も許可」で、かつ
/// **そのつど人が画面で許可したとき** だけ実行する
pub async fn run(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
    sql: &str,
    max_rows: Option<usize>,
    format: RowFormat,
) -> Result<AiRows, String> {
    let dialect = dialect_of(app, opened).await?;
    let kind = classify_sql(dialect, sql)?;
    let db = database_of(opened, database);

    if let SqlKind::Write { dangerous } = kind {
        // 「読み取りのみ」の接続では、ダイアログを出すまでもなく断る
        // (画面に出すと、押せば通せるように見えてしまう)
        if opened.access != AiAccess::Write {
            return Err(READ_ONLY_ONLY.to_string());
        }
        ask_and_wait(app, opened, &db, sql, dangerous, APPROVAL_TIMEOUT).await?;
    }

    execute(app, opened, &db, sql, clamp_max_rows(max_rows), None, format).await
}

/// 実行計画を返す。
///
/// 更新系は常に断る。`EXPLAIN ANALYZE` は対象のSQLを実際に流して計るので、
/// 「計画を見るだけ」のつもりでデータが変わってしまう
pub async fn explain(
    app: &AppHandle,
    opened: &Opened,
    database: Option<String>,
    sql: &str,
) -> Result<AiRows, String> {
    let dialect = dialect_of(app, opened).await?;
    if classify_sql(dialect, sql)? != SqlKind::Read {
        return Err(READ_ONLY_ONLY.to_string());
    }
    let db = database_of(opened, database);
    execute(
        app,
        opened,
        &db,
        sql,
        DEFAULT_MAX_ROWS,
        Some("explain".to_string()),
        // 実行計画は表そのものを読むので、行の形のまま返す
        RowFormat::Json,
    )
    .await
}

/// 接続の方言を取る (MySQL系かどうかで文の区切りが変わる)
async fn dialect_of(app: &AppHandle, opened: &Opened) -> Result<Dialect, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    crate::sessions::session_dialect(&sessions, &opened.session_id)
        .await
        // 文言は既存のものにそろえる (AI連携が張り直すかどうかは状態で判断する)
        .ok_or_else(|| crate::apperr::NO_SESSION_MSG.to_string())
}

/// 人に許可を求めて待ち、結果を記録する。
///
/// 許可されなかった場合は、その理由をAIへ返す
async fn ask_and_wait(
    app: &AppHandle,
    opened: &Opened,
    database: &str,
    sql: &str,
    dangerous: Vec<DangerousStatement>,
    timeout: Duration,
) -> Result<(), String> {
    let decision = approval::request(
        app,
        approval::Request {
            connection: opened.name.clone(),
            env: opened.env.clone(),
            database: database.to_string(),
            sql: sql.to_string(),
            dangerous,
        },
        timeout,
    )
    .await;

    // 許可も拒否も時間切れも残す (あとから「何が起きたか」を追えるように)
    app.state::<crate::query_log::QueryLog>().add(
        &opened.label,
        database,
        &format!("-- AI連携: {}", decision.note()),
    );

    match decision {
        Decision::Allowed => Ok(()),
        Decision::Denied => Err(approval::DENIED.to_string()),
        Decision::TimedOut => Err(approval::TIMED_OUT.to_string()),
    }
}

/// 既存の実行経路へ渡す (ここまで来たものだけが実行される)
#[allow(clippy::too_many_arguments)]
async fn execute(
    app: &AppHandle,
    opened: &Opened,
    database: &str,
    sql: &str,
    limit: usize,
    explain: Option<String>,
    format: RowFormat,
) -> Result<AiRows, String> {
    let sessions = app.state::<crate::sessions::Sessions>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let timeout = crate::app_settings::load(app)
        .map(|s| s.query_timeout_secs)
        .unwrap_or(crate::query::DEFAULT_QUERY_TIMEOUT_SECS);

    let out = crate::sessions::run_query(
        &sessions,
        &qlog,
        &opened.session_id,
        (!database.is_empty()).then_some(database.to_string()),
        sql,
        0,
        None,
        None,
        // トランザクションは張らない。
        // 1文ずつしか受け付けないので、まとめて戻す相手がいない
        false,
        explain,
        timeout,
        // パラメータ (:name) は受け付けない。
        // AIに値の埋め込みまで任せると、何が実行されたか追いにくくなる
        &std::collections::HashMap::new(),
    )
    .await?;

    if let Some(e) = out.error {
        return Err(e);
    }
    let first = out
        .statements
        .into_iter()
        .next()
        .ok_or("結果がありません")?;
    Ok(to_ai_rows(first.result, limit, format))
}

/// 画面用の結果を、上限で切ってAI向けの形にする
fn to_ai_rows(result: crate::models::QueryResult, limit: usize, format: RowFormat) -> AiRows {
    // 画面は1000行ずつ持っている。そこからさらに上限で切る
    let truncated = result.has_more || result.rows.len() > limit;
    let rows: Vec<Vec<Option<String>>> = result.rows.into_iter().take(limit).collect();
    let row_count = rows.len();
    let columns: Vec<AiResultColumn> = result
        .columns
        .iter()
        .enumerate()
        .map(|(i, name)| AiResultColumn {
            name: name.clone(),
            // 型が取れないDB・経路では null にする (空文字と混ぜない)
            data_type: result
                .column_types
                .get(i)
                .filter(|t| !t.is_empty())
                .cloned(),
        })
        .collect();

    // Markdown / CSV は本文1つにまとめる。行の配列は返さない (二重になるため)
    let (rows, text) = match format {
        RowFormat::Json => (Some(rows), None),
        RowFormat::Markdown => {
            let t = rows::to_markdown(&result.columns, &rows);
            (None, Some(t))
        }
        RowFormat::Csv => {
            let t = rows::to_csv(&result.columns, &rows);
            (None, Some(t))
        }
    };

    AiRows {
        columns,
        rows,
        text,
        row_count,
        truncated,
        // 更新系は行が返らない。何行に効いたかだけを返す
        rows_affected: result.rows_affected,
        elapsed_ms: result.elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: Dialect = Dialect::MYSQL;

    /// 見立てだけを取り出す (中身の比較を短く書くため)
    fn kind(sql: &str) -> SqlKind {
        classify_sql(MY, sql).unwrap_or_else(|e| panic!("{sql}: {e}"))
    }

    #[test]
    fn 読み取りのsqlは読み取りと見る() {
        for sql in [
            "SELECT * FROM users",
            "select id, name from users where id = 1",
            "SHOW TABLES",
            "WITH t AS (SELECT 1) SELECT * FROM t",
            "EXPLAIN SELECT * FROM users",
        ] {
            assert_eq!(kind(sql), SqlKind::Read, "{sql}");
        }
    }

    #[test]
    fn 更新系は更新と見る() {
        for sql in [
            "UPDATE users SET name = 'a' WHERE id = 1",
            "INSERT INTO users VALUES (1)",
            "CREATE TABLE t (a int)",
        ] {
            assert_eq!(kind(sql), SqlKind::Write { dangerous: Vec::new() }, "{sql}");
        }
    }

    #[test]
    fn 取り返しのつかない更新は印を付けて返す() {
        // ダイアログに「何が危ないか」を出すため、判定の中身も一緒に持たせる
        for sql in [
            "DELETE FROM users",
            "DROP TABLE users",
            "TRUNCATE TABLE users",
            "UPDATE users SET name = 'a'",
        ] {
            match kind(sql) {
                SqlKind::Write { dangerous } => {
                    assert!(!dangerous.is_empty(), "{sql} には警告が要る");
                }
                other => panic!("{sql}: {other:?}"),
            }
        }
    }

    #[test]
    fn 行ロックを取る選択は更新扱いにする() {
        // SELECT ... FOR UPDATE は読み取りに見えて、他を待たせる
        assert_ne!(kind("SELECT * FROM users FOR UPDATE"), SqlKind::Read);
    }

    #[test]
    fn 二文以上は拒否する() {
        assert_eq!(
            classify_sql(MY, "SELECT 1; SELECT 2").expect_err("断ること"),
            SINGLE_ONLY
        );
        // 後ろが更新系でも、まず「1文だけ」で断る
        assert_eq!(
            classify_sql(MY, "SELECT 1; DROP TABLE users").expect_err("断ること"),
            SINGLE_ONLY
        );
    }

    #[test]
    fn 末尾のセミコロン1つは1文として通る() {
        assert_eq!(kind("SELECT 1;"), SqlKind::Read);
    }

    #[test]
    fn トランザクションと設定変更は拒否する() {
        for sql in [
            "BEGIN",
            "START TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT a",
            "SET autocommit = 0",
            "SET SESSION sql_mode = ''",
        ] {
            assert_eq!(
                classify_sql(MY, sql).expect_err("断ること"),
                NO_SESSION_CONTROL,
                "{sql}"
            );
        }
    }

    #[test]
    fn 空のsqlは断る() {
        assert!(classify_sql(MY, "   ").is_err());
    }

    #[test]
    fn 行数の上限と既定() {
        assert_eq!(clamp_max_rows(None), DEFAULT_MAX_ROWS);
        assert_eq!(clamp_max_rows(Some(50)), 50);
        // 上限を超える指定は丸める (断らない)
        assert_eq!(clamp_max_rows(Some(1001)), MAX_ROWS);
        assert_eq!(clamp_max_rows(Some(100_000)), MAX_ROWS);
        // 0行では「成功したのに何も返らない」になるので1件は返す
        assert_eq!(clamp_max_rows(Some(0)), 1);
    }

    /// 行だけを持つ結果を作る (上限の切り方を試すため)
    fn result(rows: usize, has_more: bool) -> crate::models::QueryResult {
        crate::models::QueryResult {
            columns: vec!["n".to_string()],
            column_types: vec!["INTEGER".to_string()],
            rows: (0..rows).map(|i| vec![Some(i.to_string())]).collect(),
            clipped: Vec::new(),
            offset: 0,
            has_more,
            pageable: true,
            order_by: None,
            order_dir: None,
            rows_affected: None,
            elapsed_ms: 1,
        }
    }

    #[test]
    fn 上限を超えたら切って打ち切りの印を立てる() {
        let got = to_ai_rows(result(201, false), 200, RowFormat::Json);
        assert_eq!(got.row_count, 200);
        assert_eq!(got.rows.expect("行がある").len(), 200);
        assert!(got.truncated);
    }

    #[test]
    fn 上限に収まれば打ち切らない() {
        let got = to_ai_rows(result(5, false), 200, RowFormat::Json);
        assert_eq!(got.row_count, 5);
        assert!(!got.truncated);
    }

    #[test]
    fn 続きがあるときは行数に収まっていても印を立てる() {
        // 画面のページング側で続きが残っている場合
        let got = to_ai_rows(result(200, true), 200, RowFormat::Json);
        assert!(got.truncated);
    }

    #[test]
    fn 列に型が付く() {
        let got = to_ai_rows(result(1, false), 200, RowFormat::Json);
        assert_eq!(got.columns[0].name, "n");
        assert_eq!(got.columns[0].data_type.as_deref(), Some("INTEGER"));
    }

    #[test]
    fn 型が取れなければnullにする() {
        let mut r = result(1, false);
        r.column_types = Vec::new();
        let got = to_ai_rows(r, 200, RowFormat::Json);
        assert_eq!(got.columns[0].data_type, None);

        // 空文字で来た場合も「無い」として扱う
        let mut r = result(1, false);
        r.column_types = vec![String::new()];
        let got = to_ai_rows(r, 200, RowFormat::Json);
        assert_eq!(got.columns[0].data_type, None);
    }

    #[test]
    fn markdownとcsvは本文で返す() {
        // 行の配列と本文の両方を返すと、同じ中身が二重になる
        for f in [RowFormat::Markdown, RowFormat::Csv] {
            let got = to_ai_rows(result(2, false), 200, f);
            assert!(got.rows.is_none(), "{f:?}");
            let text = got.text.expect("本文がある");
            assert!(text.contains('n'), "{f:?}: {text}");
            // 行数と打ち切りの印は形によらず同じ
            assert_eq!(got.row_count, 2, "{f:?}");
        }
    }

    #[test]
    fn jsonのときは本文を返さない() {
        let got = to_ai_rows(result(2, false), 200, RowFormat::Json);
        assert!(got.text.is_none());
        assert!(got.rows.is_some());
    }

    // ---------- 実物のDB (SQLite) を1本だけ通す ----------

    use crate::csv_job::CsvJobs;
    use crate::models::ConnectionProfile;
    use crate::query_log::QueryLog;
    use crate::sessions::{CancelRegistry, Sessions};

    /// テスト用のSQLiteプロファイル (`sessions` のテストと同じ作り方)
    fn sqlite_profile(name: &str, path: &std::path::Path, read_only: bool) -> ConnectionProfile {
        let mut p: ConnectionProfile = serde_json::from_str(&format!(
            r#"{{"name":"{name}","dbType":"sqlite","host":"","port":0,"user":"","database":{}}}"#,
            serde_json::to_string(&path.to_string_lossy()).expect("書けること")
        ))
        .expect("読めること");
        p.read_only = read_only;
        p
    }

    fn cleanup(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.as_os_str().to_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
    }

    /**
     * SQLiteの実ファイルで、AI用の経路を1往復させる。
     *
     * 確かめたいのは2つ:
     * - 読み取りのSQLが、行として返ってくること
     * - **判定をすり抜けても** 更新が通らないこと。
     *   `check_sql` は素通しにして `sessions::run_query` を直に呼び、
     *   読み取り専用で張った接続 (`session::ai_profile`) がDB側で止めることを見る
     */
    #[tokio::test]
    async fn sqliteで読み取りの往復ができ更新は接続側でも止まる() {
        let path = std::env::temp_dir()
            .join(format!("quelio_mcp_{}.db", std::process::id()));
        cleanup(&path);
        std::fs::File::create(&path).expect("作れること");

        let sessions = Sessions::default();
        let cancel = CancelRegistry::default();
        let qlog = QueryLog::default();
        let jobs = CsvJobs::default();

        // 用意する側は普通の接続で (読み取り専用では表を作れない)
        crate::sessions::connect(
            &sessions,
            &cancel,
            &qlog,
            &jobs,
            "setup".into(),
            sqlite_profile("setup", &path, false),
        )
        .await
        .expect("繋がること");
        crate::sessions::exec_ddl(
            &sessions,
            &qlog,
            "setup",
            None,
            &["CREATE TABLE users(id INTEGER, name TEXT)".into()],
        )
        .await
        .expect("表が作れること");
        crate::sessions::run_query(
            &sessions,
            &qlog,
            "setup",
            None,
            "INSERT INTO users VALUES (1, '山田'), (2, '佐藤')",
            0,
            None,
            None,
            false,
            None,
            30,
            &Default::default(),
        )
        .await
        .expect("入れられること");

        // ここからAI用の接続 (読み取り専用で張る)
        let ai = super::super::session::ai_profile(
            &sqlite_profile("開発DB", &path, false),
            AiAccess::Read,
        );
        assert!(ai.read_only);
        crate::sessions::connect(&sessions, &cancel, &qlog, &jobs, "mcp:x".into(), ai)
            .await
            .expect("繋がること");

        let out = crate::sessions::run_query(
            &sessions,
            &qlog,
            "mcp:x",
            None,
            "SELECT id, name FROM users ORDER BY id",
            0,
            None,
            None,
            false,
            None,
            30,
            &Default::default(),
        )
        .await
        .expect("読めること");
        let rows = to_ai_rows(
            out.statements.into_iter().next().expect("結果があること").result,
            200,
            RowFormat::Json,
        );
        assert_eq!(
            rows.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
            vec!["id".to_string(), "name".to_string()]
        );
        // 型はドライバが返す名前 (SQLiteは INTEGER / TEXT)
        assert!(rows.columns[0].data_type.is_some(), "{:?}", rows.columns);
        assert_eq!(rows.row_count, 2);
        assert_eq!(
            rows.rows.as_ref().expect("行がある")[0][1],
            Some("山田".to_string())
        );
        assert!(!rows.truncated);

        // 判定を通さずに更新を投げても、接続が読み取り専用なので通らない
        let err = crate::sessions::run_query(
            &sessions,
            &qlog,
            "mcp:x",
            None,
            "UPDATE users SET name = 'x'",
            0,
            None,
            None,
            false,
            None,
            30,
            &Default::default(),
        )
        .await
        .expect_err("断ること");
        assert!(!err.is_empty(), "理由が返ること");

        // 元のデータが変わっていないことも見ておく
        let after = crate::sessions::run_query(
            &sessions,
            &qlog,
            "setup",
            None,
            "SELECT name FROM users WHERE id = 1",
            0,
            None,
            None,
            false,
            None,
            30,
            &Default::default(),
        )
        .await
        .expect("読めること");
        assert_eq!(
            after.statements[0].result.rows[0][0],
            Some("山田".to_string())
        );

        cleanup(&path);
    }
}
