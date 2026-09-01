//! 日本語のテストデータを作ってテーブルへ入れる。
//!
//! 値の組み立ては `crate::testdata`、ここはDBとのやり取り
//! (定義の確認・外部キーの参照先集め・INSERT) を担う。
//! CSV取り込みと同じく全体を1つのトランザクションで包み、
//! 途中で失敗・中止したときは何も入っていない状態へ戻す

use super::csv::{exec_bound_quiet, mark_rolling_back};
use super::*;
use crate::testdata::{self, FieldKind, GenContext, Rng};

/// 参照先から借りてくる値の上限 (これ以上は読まない)
const FK_SAMPLE_MAX: usize = 1000;

/// 画面から届く「この列をこう作る」の指定
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenColumn {
    pub name: String,
    /// 作る値の種類 (未指定なら定義から推測する)
    pub kind: Option<FieldKind>,
}

/// 画面へ返す「この列はこう作れる」の説明
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlan {
    pub name: String,
    /// コメントから取り出した論理名 (無ければ空)
    pub logical: String,
    pub col_type: String,
    pub nullable: bool,
    /// 自動採番なので作らない列か
    pub auto: bool,
    /// 同じ値を作ってはいけない列か (主キー・ユニーク)
    pub unique: bool,
    /// 推測した種類
    pub kind: FieldKind,
    /// 外部キーの参照先 ("テーブル.列"。無ければ空)
    pub references: String,
}

/// 生成の結果
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenResult {
    pub rows: usize,
    pub cancelled: bool,
}

/// 自動採番 (こちらから値を入れない) 列か
fn is_auto(col: &crate::models::ColumnInfo) -> bool {
    let extra = col.extra.as_deref().unwrap_or("").to_lowercase();
    let default = col.default.as_deref().unwrap_or("").to_lowercase();
    let ctype = col.col_type.to_lowercase();
    extra.contains("auto_increment")
        || extra.contains("identity")
        || ctype.contains("serial")
        || default.starts_with("nextval(")
}

/// テーブルの列を見て、作り方の案を返す
pub async fn plan_test_data(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    comment_delim: &str,
) -> Result<Vec<ColumnPlan>, String> {
    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_alive(session, qlog).await?;
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    let detail = load_detail(session, &database, &schema, table, &ctx).await?;

    // 外部キーの列は、参照先を覚えておく (値はそこから借りる)
    let mut refs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for fk in &detail.foreign_keys {
        for (at, col) in fk.columns.iter().enumerate() {
            let Some(rc) = fk.ref_columns.get(at) else {
                continue;
            };
            refs.insert(col.clone(), format!("{}.{}", fk.ref_table, rc));
        }
    }
    // ユニーク制約のある1列だけのインデックス (複合は列単体では重複してよい)
    let uniques = unique_columns(&detail);

    Ok(detail
        .columns
        .iter()
        .map(|c| {
            let comment = c.comment.clone().unwrap_or_default();
            let logical = crate::export::parse_comment(&comment, comment_delim).0;
            ColumnPlan {
                name: c.name.clone(),
                col_type: c.col_type.clone(),
                nullable: c.nullable,
                auto: is_auto(c),
                unique: uniques.contains(&c.name),
                kind: testdata::guess_kind(&c.name, &logical, &c.col_type),
                references: refs.get(&c.name).cloned().unwrap_or_default(),
                logical,
            }
        })
        .collect())
}

/// 主キーとユニークインデックスに入っている列 (1列だけのもの)
fn unique_columns(detail: &crate::models::TableDetail) -> std::collections::HashSet<String> {
    let mut out: std::collections::HashSet<String> = detail
        .columns
        .iter()
        .filter(|c| c.key.as_deref() == Some("PRI"))
        .map(|c| c.name.clone())
        .collect();
    // 主キーが複数列なら、1列ごとには重複してよい
    if out.len() > 1 {
        out.clear();
    }
    for ix in &detail.indexes {
        if !ix.unique {
            continue;
        }
        let cols: Vec<&str> = ix.columns.split(',').map(|s| s.trim()).collect();
        if cols.len() == 1 {
            out.insert(cols[0].trim_matches(['`', '"']).to_string());
        }
    }
    out
}

/// テーブルの定義を取る (DBごとの違いをここで吸収する)
async fn load_detail(
    session: &mut Session,
    database: &Option<String>,
    schema: &Option<String>,
    table: &str,
    ctx: &LogCtx<'_>,
) -> Result<crate::models::TableDetail, String> {
    let schema_name = schema.clone().unwrap_or_default();
    let got = match &mut session.conn {
        DbConn::MySql(conn) => {
            let db = database.clone().unwrap_or_default();
            catalog::mysql_table_detail(conn, &db, table, ctx).await
        }
        DbConn::Pg(conn) => {
            let sc = if schema_name.is_empty() {
                "public".to_string()
            } else {
                schema_name.clone()
            };
            catalog::pg_table_detail(conn, &sc, table, ctx).await
        }
        DbConn::Sqlite(conn) => catalog::sqlite_table_detail(conn, table, ctx).await,
        DbConn::Kv(_) => return Err("Valkey接続ではこの操作はできません".into()),
    };
    got.map_err(|e| e.to_string())
}

/// 参照先の値を集める (外部キーの整合をとるため)。
///
/// 親に行が無ければ空で返す。呼び出し側で「先に親を作ってください」と伝える
async fn fk_values(
    conn: &mut DbConn,
    db_type: DbType,
    schema: Option<&str>,
    reference: &str,
) -> Result<Vec<String>, String> {
    let (ref_table, ref_col) = reference
        .split_once('.')
        .ok_or_else(|| format!("参照先の形が読めません: {reference}"))?;
    let table_sql = crate::ddl::quote_table(db_type, schema, ref_table);
    let col_sql = crate::ddl::quote(db_type, ref_col);
    // 値は文字にそろえて受け取る (数値でも日付でも同じ扱いにできる)
    let cast = match db_type {
        DbType::Postgresql => format!("{col_sql}::text"),
        DbType::Mysql => format!("CAST({col_sql} AS CHAR)"),
        _ => format!("CAST({col_sql} AS TEXT)"),
    };
    let sql = format!(
        "SELECT {cast} FROM {table_sql} WHERE {col_sql} IS NOT NULL LIMIT {FK_SAMPLE_MAX}"
    );
    // 自分で組み立てた読み取り専用の1文 (値の埋め込みは無い)
    let safe = sqlx::AssertSqlSafe(sql);
    with_sql_conn!(conn, "Valkey接続ではSQLは実行できません", |c| {
        let rows = sqlx::query_scalar::<_, Option<String>>(safe)
            .fetch_all(&mut *c)
            .await
            .map_err(db::format_db_error)?;
        Ok(rows.into_iter().flatten().collect())
    })
}

/// 列ごとの作り方 (生成のときに使う形)
struct Plan {
    /// 参照先から借りた値 (外部キーの列だけ)
    borrowed: Vec<String>,
    kind: FieldKind,
    unique: bool,
    nullable: bool,
    max_len: Option<usize>,
    scale: u32,
}

/// 小数の桁数 (`decimal(10,2)` の 2)
fn scale_of(col_type: &str) -> u32 {
    let t = col_type.to_lowercase();
    let Some(open) = t.find('(') else { return 0 };
    let Some(close) = t[open..].find(')') else {
        return 0;
    };
    t[open + 1..open + close]
        .split(',')
        .nth(1)
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// テストデータを作ってテーブルへ入れる。
///
/// 全体を1つのトランザクションで包む
/// (途中で失敗・中止したら何も入っていない状態へ戻す)
#[allow(clippy::too_many_arguments)]
pub async fn generate_test_data(
    sessions: &Sessions,
    qlog: &QueryLog,
    session_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
    rows: usize,
    null_rate: u8,
    columns: &[GenColumn],
    comment_delim: &str,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<GenResult, String> {
    use crate::csv_import::{build_insert, safe_cast_type, ImportMode, TargetColumn};

    if columns.is_empty() {
        return Err("作る列を1つ以上選んでください".into());
    }
    if rows == 0 {
        return Err("作る行数を1以上にしてください".into());
    }
    if rows > crate::csv_import::MAX_ROWS {
        return Err(format!(
            "一度に作れるのは{}行までです",
            crate::csv_import::fmt_count(crate::csv_import::MAX_ROWS)
        ));
    }

    let arc = get_session(sessions, session_id).await?;
    let mut guard = arc.lock().await;
    let session = &mut *guard;
    ensure_writable(session)?;
    ensure_alive(session, qlog).await?;
    // ここから先は接続を握っている。サーバーへ中止を送っても、無関係なSQLを止めることはない
    if let Some(j) = job {
        j.mark_running();
    }
    if matches!(session.conn, DbConn::Kv(_)) {
        return Err("Valkey接続ではこの操作はできません".into());
    }
    let db_type = session.profile.db_type;
    let label = conn_label(&session.profile);
    let db_label = database.clone().unwrap_or_default();
    ensure_database(session, database.as_ref(), qlog, &label).await?;
    let ctx = LogCtx {
        qlog,
        connection: &label,
        database: &db_label,
    };
    let detail = load_detail(session, &database, &schema, table, &ctx).await?;

    let schema_name = schema.clone().unwrap_or_default();
    let table_schema = if db_type == DbType::Postgresql && schema_name.is_empty() {
        Some("public")
    } else {
        schema.as_deref()
    };
    let table_sql = crate::ddl::quote_table(db_type, table_schema, table);

    let uniques = unique_columns(&detail);
    let mut refs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for fk in &detail.foreign_keys {
        for (at, col) in fk.columns.iter().enumerate() {
            if let Some(rc) = fk.ref_columns.get(at) {
                refs.insert(col.clone(), format!("{}.{}", fk.ref_table, rc));
            }
        }
    }

    let mut targets: Vec<TargetColumn> = Vec::with_capacity(columns.len());
    let mut plans: Vec<Plan> = Vec::with_capacity(columns.len());
    for spec in columns {
        let Some(col) = detail.columns.iter().find(|c| c.name == spec.name) else {
            return Err(format!("カラム '{}' がテーブルにありません", spec.name));
        };
        if targets.iter().any(|t| t.name == col.name) {
            return Err(format!("カラム '{}' を2回選んでいます", col.name));
        }
        let comment = col.comment.clone().unwrap_or_default();
        let logical = crate::export::parse_comment(&comment, comment_delim).0;
        let kind = spec
            .kind
            .unwrap_or_else(|| testdata::guess_kind(&col.name, &logical, &col.col_type));
        // 外部キーの列は、親に入っている値だけを使う (整合を崩さない)
        let borrowed = match refs.get(&col.name) {
            Some(reference) => {
                let values = fk_values(&mut session.conn, db_type, table_schema, reference).await?;
                if values.is_empty() {
                    return Err(format!(
                        "'{}' の参照先 ({reference}) に行がありません。先に参照先のデータを作ってください",
                        col.name
                    ));
                }
                values
            }
            None => Vec::new(),
        };
        let cast_type = if db_type == DbType::Postgresql && safe_cast_type(&col.col_type) {
            Some(col.col_type.clone())
        } else {
            None
        };
        targets.push(TargetColumn {
            name: col.name.clone(),
            cast_type,
        });
        plans.push(Plan {
            borrowed,
            kind,
            unique: uniques.contains(&col.name),
            nullable: col.nullable,
            max_len: testdata::type_len(&col.col_type)
                .filter(|_| matches!(testdata::type_class(&col.col_type), testdata::TypeClass::Text)),
            scale: scale_of(&col.col_type),
        });
    }

    if targets.len() > crate::csv_import::max_params(db_type) {
        return Err(format!(
            "一度に入れられる列は{}個までです",
            crate::csv_import::max_params(db_type)
        ));
    }

    begin_txn(session, qlog, &label, &db_label, begin_sql(&session.conn)).await?;
    qlog.add(
        &label,
        &db_label,
        &format!("-- テストデータ生成開始 {table_sql} ({}行)", rows),
    );

    let batch = crate::csv_import::batch_rows(db_type, targets.len());
    let full_sql = build_insert(db_type, &table_sql, &targets, batch, ImportMode::Append, &[]);
    // 種は毎回変える (同じ内容が2回できると、確かめたいことが分からなくなる)
    let mut rng = Rng::new(now_seed());
    let mut done = 0usize;
    let mut cancelled = false;

    while done < rows {
        if job.is_some_and(|j| j.is_cancelled()) {
            cancelled = true;
            break;
        }
        let n = batch.min(rows - done);
        let mut params: Vec<Option<String>> = Vec::with_capacity(n * targets.len());
        for at in 0..n {
            let row = done + at;
            for plan in &plans {
                params.push(cell(plan, &mut rng, row, null_rate));
            }
        }
        let sql = if n == batch {
            full_sql.clone()
        } else {
            build_insert(db_type, &table_sql, &targets, n, ImportMode::Append, &[])
        };
        if done == 0 {
            qlog.add(&label, &db_label, &sql);
        }
        if let Err(e) = exec_bound_quiet(&mut session.conn, &sql, &params).await {
            if job.is_some_and(|j| j.is_cancelled()) {
                cancelled = true;
                break;
            }
            mark_rolling_back(job);
            let note = rollback_note(session, qlog, &label, &db_label).await;
            return Err(format!("{done}行目までで失敗しました: {e}\n{note}"));
        }
        done += n;
        if let Some(j) = job {
            j.set_rows(done);
        }
    }

    if job.is_some_and(|j| j.is_cancelled()) {
        cancelled = true;
    }
    end_txn(session, qlog, &label, &db_label, !cancelled).await?;
    qlog.add(
        &label,
        &db_label,
        &format!(
            "-- テストデータ生成{} {done}行",
            if cancelled { "中止" } else { "完了" }
        ),
    );
    Ok(GenResult {
        rows: if cancelled { 0 } else { done },
        cancelled,
    })
}

/// 1セルぶんの値を決める
fn cell(plan: &Plan, rng: &mut Rng, row: usize, null_rate: u8) -> Option<String> {
    // 外部キーは親の値からしか選ばない (NULL率も掛けない)
    if !plan.borrowed.is_empty() {
        return rng.pick(&plan.borrowed).cloned();
    }
    // NULLにしてよいのは「NULL可・重複してよい」列だけ
    if plan.nullable && !plan.unique && null_rate > 0 && rng.below(100) < null_rate as usize {
        return None;
    }
    testdata::gen_value(
        plan.kind,
        rng,
        GenContext {
            row,
            unique: plan.unique,
            max_len: plan.max_len,
            scale: plan.scale,
        },
    )
}

/// 乱数の種 (時刻から作る)
fn now_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x5eed_5eed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, col_type: &str, extra: Option<&str>, default: Option<&str>) -> crate::models::ColumnInfo {
        crate::models::ColumnInfo {
            name: name.to_string(),
            col_type: col_type.to_string(),
            nullable: true,
            key: None,
            default: default.map(|s| s.to_string()),
            extra: extra.map(|s| s.to_string()),
            collation: None,
            comment: None,
        }
    }

    #[test]
    fn 自動採番の列を見分ける() {
        assert!(is_auto(&col("id", "int", Some("auto_increment"), None)));
        assert!(is_auto(&col("id", "serial", None, None)));
        assert!(is_auto(&col(
            "id",
            "integer",
            None,
            Some("nextval('t_id_seq'::regclass)")
        )));
        assert!(!is_auto(&col("name", "varchar(20)", None, None)));
    }

    #[test]
    fn 小数の桁数を読む() {
        assert_eq!(scale_of("decimal(10,2)"), 2);
        assert_eq!(scale_of("numeric(8, 3)"), 3);
        assert_eq!(scale_of("int(11)"), 0);
        assert_eq!(scale_of("text"), 0);
    }

    fn plan(nullable: bool, unique: bool, borrowed: &[&str]) -> Plan {
        Plan {
            borrowed: borrowed.iter().map(|s| s.to_string()).collect(),
            kind: FieldKind::Word,
            unique,
            nullable,
            max_len: None,
            scale: 0,
        }
    }

    #[test]
    fn 外部キーは親の値から選ぶ() {
        let mut rng = Rng::new(1);
        let p = plan(true, false, &["1", "2", "3"]);
        for row in 0..50 {
            // NULL率100でも親の値を使う (整合を崩さない)
            let v = cell(&p, &mut rng, row, 100).expect("値が入る");
            assert!(["1", "2", "3"].contains(&v.as_str()), "{v}");
        }
    }

    #[test]
    fn null率0なら空にならない() {
        let mut rng = Rng::new(2);
        let p = plan(true, false, &[]);
        for row in 0..50 {
            assert!(cell(&p, &mut rng, row, 0).is_some());
        }
    }

    #[test]
    fn null不可とユニークは空にしない() {
        let mut rng = Rng::new(3);
        for p in [plan(false, false, &[]), plan(true, true, &[])] {
            for row in 0..50 {
                assert!(cell(&p, &mut rng, row, 100).is_some());
            }
        }
    }
}
