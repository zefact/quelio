//! PostgreSQL の書き出し。
//!
//! pg_dump (プレーン形式) と同じ形にする。
//! - REPEATABLE READ の読み取り専用トランザクションの中で全部を読む (一貫した時点の中身になる)
//! - データは `COPY … TO STDOUT` でそのまま受け取り、`COPY … FROM stdin;` の形で書く
//!   (1行ずつ組み立てるより桁違いに速く、流し込みも COPY で速い)
//! - 主キー・一意制約・インデックスはデータの後、外部キーは最後に作る
//!   (データを入れてから作るほうが速く、外部キーの順番も気にしなくてよい)
//! - 名前はすべてスキーマで修飾する (search_path を空にして読む)

use std::collections::{HashMap, HashSet};

use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{AssertSqlSafe, Row};

use super::sql::{dq_ident, pg_name, std_literal, topo_order};
use super::{Mode, Out, Progress, CHUNK};
use crate::db::format_db_error;
use crate::models::ExportTable;
use crate::tools::Endpoint;

#[derive(Clone, Debug)]
struct Rel {
    oid: i64,
    schema: String,
    name: String,
    /// r: テーブル, p: パーティションの親, v: ビュー, m: マテビュー, f: 外部テーブル
    kind: String,
    est_rows: u64,
    size: u64,
    /// パーティションの親 (自分がパーティションの子のとき)
    parent: Option<i64>,
    /// `FOR VALUES …` (パーティションの子のとき)
    bound: Option<String>,
    /// `PARTITION BY …` (パーティションの親のとき)
    part_key: Option<String>,
    unlogged: bool,
    comment: Option<String>,
}

impl Rel {
    fn full(&self) -> String {
        pg_name(&self.schema, &self.name)
    }
    fn is_table(&self) -> bool {
        self.kind == "r" || self.kind == "p"
    }
    fn is_view(&self) -> bool {
        self.kind == "v" || self.kind == "m"
    }
}

async fn exec(conn: &mut PgConnection, sql: &str) -> Result<(), String> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(format_db_error)
}

fn opt(r: &PgRow, i: usize) -> Option<String> {
    r.try_get::<Option<String>, _>(i).ok().flatten()
}

fn s(r: &PgRow, i: usize) -> String {
    opt(r, i).unwrap_or_default()
}

const REL_COLS: &str = "c.oid::int8, n.nspname, c.relname, c.relkind::text, \
     GREATEST(c.reltuples, 0)::int8, \
     CASE WHEN c.relkind IN ('r', 'm') THEN pg_relation_size(c.oid) ELSE 0 END::int8, \
     (SELECT i.inhparent::int8 FROM pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1), \
     CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END, \
     CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, \
     c.relpersistence = 'u', \
     obj_description(c.oid, 'pg_class')";

fn rel_of(r: &PgRow) -> Rel {
    Rel {
        oid: r.try_get(0).unwrap_or(0),
        schema: s(r, 1),
        name: s(r, 2),
        kind: s(r, 3),
        est_rows: r.try_get::<i64, _>(4).unwrap_or(0).max(0) as u64,
        size: r.try_get::<i64, _>(5).unwrap_or(0).max(0) as u64,
        parent: r.try_get::<Option<i64>, _>(6).ok().flatten(),
        bound: opt(r, 7),
        part_key: opt(r, 8),
        unlogged: r.try_get::<bool, _>(9).unwrap_or(false),
        comment: opt(r, 10),
    }
}

/// 選ばれたテーブルを探す (パーティションの親なら、その子も全部入れる)
async fn resolve(
    conn: &mut PgConnection,
    tables: &[ExportTable],
    p: &Progress,
) -> Result<Vec<Rel>, String> {
    let mut out: Vec<Rel> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for t in tables {
        let schema = t.schema.clone().unwrap_or_else(|| "public".to_string());
        let sql = format!(
            "WITH RECURSIVE tree(oid) AS ( \
               SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $1 AND c.relname = $2 \
               UNION ALL \
               SELECT i.inhrelid FROM pg_inherits i \
               JOIN tree ON i.inhparent = tree.oid \
               JOIN pg_class pc ON pc.oid = tree.oid AND pc.relkind = 'p' \
             ) \
             SELECT {REL_COLS} FROM tree JOIN pg_class c ON c.oid = tree.oid \
             JOIN pg_namespace n ON n.oid = c.relnamespace"
        );
        let rows = p
            .guard(
                sqlx::query(AssertSqlSafe(sql))
                    .bind(&schema)
                    .bind(&t.name)
                    .fetch_all(&mut *conn),
            )
            .await?
            .map_err(format_db_error)?;
        if rows.is_empty() {
            return Err(format!("テーブル {schema}.{} が見つかりません", t.name));
        }
        for r in &rows {
            let rel = rel_of(r);
            if seen.insert(rel.oid) {
                out.push(rel);
            }
        }
    }
    Ok(out)
}

struct Column {
    name: String,
    ty: String,
    notnull: bool,
    default: Option<String>,
    identity: String,
    generated: bool,
    collation: Option<String>,
    comment: Option<String>,
}

async fn columns(conn: &mut PgConnection, oid: i64, ver: i32) -> Result<Vec<Column>, String> {
    let generated = if ver >= 120000 { "a.attgenerated::text" } else { "''" };
    let sql = format!(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                pg_get_expr(ad.adbin, ad.adrelid), a.attidentity::text, {generated}, \
                CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
                     THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END, \
                col_description(a.attrelid, a.attnum) \
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid \
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
         LEFT JOIN pg_collation co ON co.oid = a.attcollation \
         LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace \
         WHERE a.attrelid = $1::int8::oid AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum"
    );
    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(oid)
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| Column {
            name: s(r, 0),
            ty: s(r, 1),
            notnull: r.try_get(2).unwrap_or(false),
            default: opt(r, 3),
            identity: s(r, 4),
            generated: !s(r, 5).is_empty(),
            collation: opt(r, 6),
            comment: opt(r, 7),
        })
        .collect())
}

struct Constraint {
    name: String,
    kind: String,
    def: String,
    /// 自分で持っている制約か (パーティションの親から付いたものは false)
    own: bool,
}

async fn constraints(conn: &mut PgConnection, oid: i64, ver: i32) -> Result<Vec<Constraint>, String> {
    // パーティションの子の制約は、親に付けると自動で付く (conparentid は 11 から)
    let parent = if ver >= 110000 { "con.conparentid = 0" } else { "true" };
    let sql = format!(
        "SELECT con.conname, con.contype::text, pg_get_constraintdef(con.oid), \
                con.conislocal AND {parent} \
         FROM pg_constraint con \
         WHERE con.conrelid = $1::int8::oid AND con.contype IN ('p', 'u', 'f', 'c', 'x') \
         ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'x' THEN 2 \
                                   WHEN 'c' THEN 3 ELSE 4 END, con.conname"
    );
    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(oid)
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| Constraint {
            name: s(r, 0),
            kind: s(r, 1),
            def: s(r, 2),
            own: r.try_get(3).unwrap_or(true),
        })
        .collect())
}

/// 制約の裏にあるもの・親から付いたものを除いたインデックス
async fn indexes(conn: &mut PgConnection, oid: i64) -> Result<Vec<String>, String> {
    let sql = "SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix \
               JOIN pg_class i ON i.oid = ix.indexrelid \
               WHERE ix.indrelid = $1::int8::oid \
                 AND NOT EXISTS (SELECT 1 FROM pg_constraint con \
                                 WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid \
                                   AND con.contype IN ('p', 'u', 'x')) \
                 AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = ix.indexrelid) \
               ORDER BY i.relname";
    let rows = sqlx::query(sql)
        .bind(oid)
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    // パーティションの親のインデックスは「ON ONLY」で返る。子にも作るように外す
    Ok(rows.iter().map(|r| s(r, 0).replacen(" ON ONLY ", " ON ", 1)).collect())
}

struct Sequence {
    full: String,
    ty: String,
    start: i64,
    inc: i64,
    min: i64,
    max: i64,
    cache: i64,
    cycle: bool,
    table: i64,
    column: String,
    /// IDENTITY列の連番 (作るのは列の定義に任せる)
    identity: bool,
}

async fn sequences(conn: &mut PgConnection, oids: &[i64]) -> Result<Vec<Sequence>, String> {
    let sql = "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname), \
                      format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, \
                      s.seqmax, s.seqcache, s.seqcycle, d.refobjid::int8, a.attname, \
                      d.deptype = 'i' \
               FROM pg_sequence s \
               JOIN pg_class c ON c.oid = s.seqrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid \
                AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') \
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
               WHERE d.refobjid::int8 = ANY($1) \
               ORDER BY 1";
    let rows = sqlx::query(sql)
        .bind(oids.to_vec())
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    Ok(rows
        .iter()
        .map(|r| Sequence {
            full: s(r, 0),
            ty: s(r, 1),
            start: r.try_get(2).unwrap_or(1),
            inc: r.try_get(3).unwrap_or(1),
            min: r.try_get(4).unwrap_or(1),
            max: r.try_get(5).unwrap_or(i64::MAX),
            cache: r.try_get(6).unwrap_or(1),
            cycle: r.try_get(7).unwrap_or(false),
            table: r.try_get(8).unwrap_or(0),
            column: s(r, 9),
            identity: r.try_get(10).unwrap_or(false),
        })
        .collect())
}

/// 文の一覧 (1列目の文字) を読む
async fn texts(conn: &mut PgConnection, sql: &str, schemas: &[String]) -> Result<Vec<String>, String> {
    let rows = sqlx::query(AssertSqlSafe(sql.to_string()))
        .bind(schemas.to_vec())
        .fetch_all(&mut *conn)
        .await
        .map_err(format_db_error)?;
    Ok(rows.iter().map(|r| s(r, 0)).filter(|t| !t.is_empty()).collect())
}

/// 拡張機能の持ち物でない型・関数だけを見る条件
const NOT_EXT: &str = "NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = {oid} AND d.deptype = 'e')";

fn not_ext(oid: &str) -> String {
    NOT_EXT.replace("{oid}", oid)
}

/// 書き出しの本体
pub async fn export(
    ep: &Endpoint,
    database: &str,
    tables: &[ExportTable],
    mode: Mode,
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    p.set_stage("接続しています");
    let mut conn = p
        .guard(crate::db::connect_pg(
            &ep.host,
            ep.port,
            &ep.user,
            &ep.password,
            Some(database),
            &ep.tls,
        ))
        .await??;
    for sql in [
        "SET statement_timeout = 0",
        "SET lock_timeout = 0",
        "SET idle_in_transaction_session_timeout = 0",
        "SET client_encoding = 'UTF8'",
        "SET extra_float_digits = 3",
        "SET DateStyle = ISO",
        "SET IntervalStyle = postgres",
    ] {
        let _ = exec(&mut conn, sql).await;
    }
    // 名前をすべてスキーマ付きで返させる (流し込む先の search_path に左右されないように)
    exec(&mut conn, "SELECT pg_catalog.set_config('search_path', '', false)").await?;
    exec(&mut conn, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await?;

    let ver: i32 = sqlx::query_scalar::<_, String>("SELECT current_setting('server_version_num')")
        .fetch_one(&mut conn)
        .await
        .map_err(format_db_error)?
        .parse()
        .unwrap_or(0);
    if ver > 0 && ver < 100000 {
        return Err("PostgreSQL 10 より前の版には、Quelioでの書き出しは対応していません。外部ツール (pg_dump) を使ってください".into());
    }

    p.set_stage("テーブルの情報を読んでいます");
    let rels = resolve(&mut conn, tables, p).await?;
    for r in rels.iter().filter(|r| !r.is_table() && !r.is_view()) {
        p.note(format!("{} は書き出せない種類のため飛ばしました", r.full()));
    }
    let index: HashMap<i64, usize> = rels.iter().enumerate().map(|(i, r)| (r.oid, i)).collect();
    // 親を先に作る
    let parent_deps: Vec<Vec<usize>> = rels
        .iter()
        .map(|r| r.parent.and_then(|o| index.get(&o).copied()).into_iter().collect())
        .collect();
    let order = topo_order(rels.len(), &parent_deps);
    let tabs: Vec<&Rel> = order.iter().map(|&i| &rels[i]).filter(|r| r.is_table()).collect();
    let views: Vec<&Rel> = order.iter().map(|&i| &rels[i]).filter(|r| r.is_view()).collect();
    let table_oids: Vec<i64> = tabs.iter().map(|r| r.oid).collect();
    let mut schemas: Vec<String> = Vec::new();
    for r in &rels {
        if !schemas.contains(&r.schema) {
            schemas.push(r.schema.clone());
        }
    }

    let mut cols: HashMap<i64, Vec<Column>> = HashMap::new();
    let mut cons: HashMap<i64, Vec<Constraint>> = HashMap::new();
    for r in &tabs {
        cols.insert(r.oid, p.guard(columns(&mut conn, r.oid, ver)).await??);
        cons.insert(r.oid, p.guard(constraints(&mut conn, r.oid, ver)).await??);
    }
    let seqs = p.guard(sequences(&mut conn, &table_oids)).await??;

    // データを入れる順: 参照される側を先に (データだけのとき、先の外部キーに引っかからないように)
    let data_order: Vec<&Rel> = {
        let leafs: Vec<&Rel> = tabs.iter().copied().filter(|r| r.kind == "r").collect();
        let fk = sqlx::query(
            "SELECT conrelid::int8, confrelid::int8 FROM pg_constraint \
             WHERE contype = 'f' AND conrelid::int8 = ANY($1)",
        )
        .bind(table_oids.clone())
        .fetch_all(&mut conn)
        .await
        .map_err(format_db_error)?;
        let mut deps = vec![Vec::new(); leafs.len()];
        for r in &fk {
            let from: i64 = r.try_get(0).unwrap_or(0);
            let to: i64 = r.try_get(1).unwrap_or(0);
            // 親に付いた外部キーは、その子 (実際にデータを持つほう) の依存にする
            let froms: Vec<usize> = leafs
                .iter()
                .enumerate()
                .filter(|(_, l)| l.oid == from || l.parent == Some(from))
                .map(|(i, _)| i)
                .collect();
            let tos: Vec<usize> = leafs
                .iter()
                .enumerate()
                .filter(|(_, l)| l.oid == to || l.parent == Some(to))
                .map(|(i, _)| i)
                .collect();
            for &f in &froms {
                for &t in &tos {
                    deps[f].push(t);
                }
            }
        }
        topo_order(leafs.len(), &deps).into_iter().map(|i| leafs[i]).collect()
    };

    let weight = |r: &Rel| -> u64 {
        if mode.rows() && r.kind == "r" {
            r.size + 16 * 1024
        } else {
            0
        }
    };
    let ddl_weight: u64 = if mode.ddl() {
        (tabs.len() + views.len()) as u64 * 16 * 1024 + 64 * 1024
    } else {
        0
    };
    let total: u64 = data_order.iter().map(|r| weight(r)).sum::<u64>() + ddl_weight;
    p.set_total(total.max(1));

    out.text(&header(database)).await?;

    if mode.ddl() {
        p.set_stage("定義を書いています");
        p.begin(64 * 1024, 0);
        let mut text = String::new();

        // 拡張機能とスキーマ
        let ext = sqlx::query(
            "SELECT e.extname, n.nspname FROM pg_extension e \
             JOIN pg_namespace n ON n.oid = e.extnamespace \
             WHERE e.extname <> 'plpgsql' ORDER BY e.extname",
        )
        .fetch_all(&mut conn)
        .await
        .map_err(format_db_error)?;
        let mut made: HashSet<String> = HashSet::new();
        for sc in schemas
            .iter()
            .cloned()
            .chain(ext.iter().map(|r| s(r, 1)))
        {
            if made.insert(sc.clone()) {
                text.push_str(&format!("CREATE SCHEMA IF NOT EXISTS {};\n", dq_ident(&sc)));
            }
        }
        for r in &ext {
            text.push_str(&format!(
                "CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};\n",
                dq_ident(&s(r, 0)),
                dq_ident(&s(r, 1))
            ));
        }

        // 先に消す (ビュー → テーブル。持ち主のテーブルと一緒に連番も消える)
        let drop_views: Vec<String> = views.iter().filter(|v| v.kind == "v").map(|v| v.full()).collect();
        let drop_mviews: Vec<String> = views.iter().filter(|v| v.kind == "m").map(|v| v.full()).collect();
        // 親を消せば子も消えるので、親が入っている子は並べない
        let drop_tables: Vec<String> = tabs
            .iter()
            .filter(|r| r.parent.is_none_or(|o| !table_oids.contains(&o)))
            .map(|r| r.full())
            .collect();
        if !drop_views.is_empty() {
            text.push_str(&format!("\nDROP VIEW IF EXISTS {};\n", drop_views.join(", ")));
        }
        if !drop_mviews.is_empty() {
            text.push_str(&format!(
                "DROP MATERIALIZED VIEW IF EXISTS {};\n",
                drop_mviews.join(", ")
            ));
        }
        if !drop_tables.is_empty() {
            text.push_str(&format!("DROP TABLE IF EXISTS {};\n", drop_tables.join(", ")));
        }

        // 型 (列挙・ドメイン・複合)。既にあれば作らない
        let guard = |body: String| -> String {
            format!(
                "DO $quelio$ BEGIN\n{body};\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $quelio$;\n"
            )
        };
        let enums = texts(
            &mut conn,
            &format!(
                "SELECT 'CREATE TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) \
                        || ' AS ENUM (' || string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) || ')' \
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
                 JOIN pg_enum e ON e.enumtypid = t.oid \
                 WHERE n.nspname::text = ANY($1) AND {} \
                 GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname",
                not_ext("t.oid")
            ),
            &schemas,
        )
        .await?;
        let domains = texts(
            &mut conn,
            &format!(
                "SELECT 'CREATE DOMAIN ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) \
                        || ' AS ' || format_type(t.typbasetype, t.typtypmod) \
                        || COALESCE(' DEFAULT ' || t.typdefault, '') \
                        || CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END \
                        || COALESCE((SELECT string_agg(' CONSTRAINT ' || quote_ident(c.conname) || ' ' \
                                                       || pg_get_constraintdef(c.oid), '') \
                                     FROM pg_constraint c WHERE c.contypid = t.oid), '') \
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
                 WHERE t.typtype = 'd' AND n.nspname::text = ANY($1) AND {} \
                 ORDER BY n.nspname, t.typname",
                not_ext("t.oid")
            ),
            &schemas,
        )
        .await?;
        let composites = texts(
            &mut conn,
            &format!(
                "SELECT 'CREATE TYPE ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) \
                        || ' AS (' || string_agg(quote_ident(a.attname) || ' ' \
                                                 || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) || ')' \
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
                 JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c' \
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 WHERE n.nspname::text = ANY($1) AND {} \
                 GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname",
                not_ext("t.oid")
            ),
            &schemas,
        )
        .await?;
        for t in enums.into_iter().chain(domains).chain(composites) {
            text.push('\n');
            text.push_str(&guard(t));
        }

        // 関数・プロシージャ (列の既定値やCHECKから呼ばれることがあるので、テーブルより先)
        let kinds = if ver >= 110000 {
            "p.prokind IN ('f', 'p')"
        } else {
            "NOT p.proisagg AND NOT p.proiswindow"
        };
        let funcs = texts(
            &mut conn,
            &format!(
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname::text = ANY($1) AND {kinds} AND {} \
                 ORDER BY n.nspname, p.proname, p.oid",
                not_ext("p.oid")
            ),
            &schemas,
        )
        .await?;
        for f in funcs {
            text.push_str(&format!("\n{};\n", f.trim_end()));
        }

        // テーブルが使う連番 (SERIAL)。IDENTITY の連番は列の定義が作る
        for sq in seqs.iter().filter(|s| !s.identity) {
            text.push_str(&format!(
                "\nCREATE SEQUENCE IF NOT EXISTS {} AS {} START WITH {} INCREMENT BY {} \
                 MINVALUE {} MAXVALUE {} CACHE {}{};\n",
                sq.full,
                sq.ty,
                sq.start,
                sq.inc,
                sq.min,
                sq.max,
                sq.cache,
                if sq.cycle { " CYCLE" } else { "" }
            ));
        }

        // テーブル (主キー・インデックス・外部キーは後で付ける)
        for r in &tabs {
            text.push_str(&create_table(r, &rels, &cols[&r.oid], &cons[&r.oid]));
            let names: HashMap<i64, &Rel> = tabs.iter().map(|t| (t.oid, *t)).collect();
            for sq in seqs.iter().filter(|s| !s.identity && s.table == r.oid) {
                if let Some(t) = names.get(&sq.table) {
                    text.push_str(&format!(
                        "ALTER SEQUENCE {} OWNED BY {}.{};\n",
                        sq.full,
                        t.full(),
                        dq_ident(&sq.column)
                    ));
                }
            }
        }
        out.text(&text).await?;
        p.end();
    }

    // データ
    if mode.rows() {
        let n = data_order.len();
        for (i, r) in data_order.iter().enumerate() {
            p.set_stage(format!("{} ({}/{})", r.full(), i + 1, n));
            p.begin(weight(r), r.est_rows);
            let list: Vec<String> = cols
                .get(&r.oid)
                .map(|c| c.iter().filter(|c| !c.generated).map(|c| dq_ident(&c.name)).collect())
                .unwrap_or_default();
            copy_table(&mut conn, r, &list, p, out).await?;
            p.end();
        }
    }

    // データの後に付けるもの
    let mut tail = String::new();
    if mode.ddl() {
        p.set_stage("インデックスと制約を書いています");
        for r in &tabs {
            for c in cons[&r.oid].iter().filter(|c| c.own && matches!(c.kind.as_str(), "p" | "u" | "x")) {
                tail.push_str(&format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
                    r.full(),
                    dq_ident(&c.name),
                    c.def
                ));
            }
            for ix in p.guard(indexes(&mut conn, r.oid)).await?? {
                tail.push_str(&format!("{ix};\n"));
            }
        }
    }
    if mode.rows() {
        // 連番を、書き出した時点の値に合わせる
        for sq in &seqs {
            let row = sqlx::query(AssertSqlSafe(format!(
                "SELECT last_value, is_called FROM {}",
                sq.full
            )))
            .fetch_one(&mut conn)
            .await
            .map_err(format_db_error)?;
            let last: i64 = row.try_get(0).unwrap_or(sq.start);
            let called: bool = row.try_get(1).unwrap_or(false);
            tail.push_str(&format!(
                "SELECT pg_catalog.setval({}, {last}, {called});\n",
                std_literal(&sq.full)
            ));
        }
    }
    if mode.ddl() {
        for r in &tabs {
            for c in cons[&r.oid].iter().filter(|c| c.own && c.kind == "f") {
                tail.push_str(&format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
                    r.full(),
                    dq_ident(&c.name),
                    c.def
                ));
            }
        }
        let parent = if ver >= 130000 { " AND t.tgparentid = 0" } else { "" };
        for r in &tabs {
            let rows = sqlx::query(AssertSqlSafe(format!(
                "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t \
                 WHERE t.tgrelid = $1::int8::oid AND NOT t.tgisinternal{parent} ORDER BY t.tgname"
            )))
            .bind(r.oid)
            .fetch_all(&mut conn)
            .await
            .map_err(format_db_error)?;
            for t in rows.iter().map(|r| s(r, 0)) {
                tail.push_str(&format!("{t};\n"));
            }
        }
        tail.push_str(&view_defs(&mut conn, &views, mode).await?);
    }
    if !tail.is_empty() {
        out.text(&format!("\n{tail}")).await?;
    }

    let _ = exec(&mut conn, "COMMIT").await;
    out.text(&format!(
        "\n-- 出力完了 {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ))
    .await?;
    Ok(())
}

fn header(database: &str) -> String {
    format!(
        "-- Quelio SQLダンプ (PostgreSQL)\n\
         -- データベース: {database}\n\
         -- 作成日時: {}\n\n\
         SET statement_timeout = 0;\n\
         SET lock_timeout = 0;\n\
         SET idle_in_transaction_session_timeout = 0;\n\
         SET client_encoding = 'UTF8';\n\
         SET standard_conforming_strings = on;\n\
         SELECT pg_catalog.set_config('search_path', '', false);\n\
         SET check_function_bodies = false;\n\
         SET client_min_messages = warning;\n\
         SET row_security = off;\n\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    )
}

/// CREATE TABLE 文 (列・CHECK・パーティション・コメント)
fn create_table(r: &Rel, rels: &[Rel], cols: &[Column], cons: &[Constraint]) -> String {
    let full = r.full();
    let mut out = format!("\n--\n-- テーブル {full}\n--\n\n");
    let parent = r.parent.and_then(|o| rels.iter().find(|x| x.oid == o));
    let unlogged = if r.unlogged { "UNLOGGED " } else { "" };
    if let (Some(parent), Some(bound)) = (parent, &r.bound) {
        // パーティションの子は列を親から引き継ぐ
        out.push_str(&format!("CREATE {unlogged}TABLE {full} PARTITION OF {} {bound}", parent.full()));
        if let Some(key) = &r.part_key {
            out.push_str(&format!(" PARTITION BY {key}"));
        }
        out.push_str(";\n");
    } else {
        let mut lines: Vec<String> = Vec::new();
        for c in cols {
            let mut line = format!("    {} {}", dq_ident(&c.name), c.ty);
            if let Some(co) = &c.collation {
                line.push_str(&format!(" COLLATE {co}"));
            }
            match c.identity.as_str() {
                "a" => line.push_str(" GENERATED ALWAYS AS IDENTITY"),
                "d" => line.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                _ => {
                    if c.generated {
                        if let Some(d) = &c.default {
                            line.push_str(&format!(" GENERATED ALWAYS AS ({d}) STORED"));
                        }
                    } else if let Some(d) = &c.default {
                        line.push_str(&format!(" DEFAULT {d}"));
                    }
                }
            }
            if c.notnull {
                line.push_str(" NOT NULL");
            }
            lines.push(line);
        }
        for c in cons.iter().filter(|c| c.own && c.kind == "c") {
            lines.push(format!("    CONSTRAINT {} {}", dq_ident(&c.name), c.def));
        }
        out.push_str(&format!("CREATE {unlogged}TABLE {full} (\n{}\n)", lines.join(",\n")));
        if let Some(key) = &r.part_key {
            out.push_str(&format!("\nPARTITION BY {key}"));
        }
        out.push_str(";\n");
    }
    if let Some(cm) = &r.comment {
        out.push_str(&format!("COMMENT ON TABLE {full} IS {};\n", std_literal(cm)));
    }
    for c in cols {
        if let Some(cm) = &c.comment {
            out.push_str(&format!(
                "COMMENT ON COLUMN {full}.{} IS {};\n",
                dq_ident(&c.name),
                std_literal(cm)
            ));
        }
    }
    out
}

/// 1テーブルを COPY で読んで、そのまま COPY 文として書く
async fn copy_table(
    conn: &mut PgConnection,
    r: &Rel,
    cols: &[String],
    p: &Progress,
    out: &mut Out,
) -> Result<(), String> {
    if cols.is_empty() {
        return Ok(());
    }
    let list = cols.join(", ");
    let full = r.full();
    out.text(&format!("\n--\n-- データ {full}\n--\n\nCOPY {full} ({list}) FROM stdin;\n"))
        .await?;
    let sql = format!("COPY {full} ({list}) TO STDOUT");
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK + CHUNK / 4);
    {
        let mut stream = p
            .guard(conn.copy_out_raw(&sql))
            .await?
            .map_err(|e| format!("{full} を読めませんでした: {}", format_db_error(e)))?;
        loop {
            let chunk = match p.guard(stream.try_next()).await? {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => return Err(format!("{full} を読めませんでした: {}", format_db_error(e))),
            };
            // 1行が1つの改行で終わる (値の中の改行は \n と書かれる)
            p.add_rows(chunk.iter().filter(|b| **b == b'\n').count() as u64);
            buf.extend_from_slice(&chunk);
            if buf.len() >= CHUNK {
                out.write(&mut buf).await?;
            }
        }
    }
    buf.extend_from_slice(b"\\.\n");
    out.write(&mut buf).await
}

/// ビューとマテビュー (ほかのビューを参照していればそちらを先に)
async fn view_defs(conn: &mut PgConnection, views: &[&Rel], mode: Mode) -> Result<String, String> {
    if views.is_empty() {
        return Ok(String::new());
    }
    let oids: Vec<i64> = views.iter().map(|v| v.oid).collect();
    let rows = sqlx::query(
        "SELECT c.oid::int8, pg_get_viewdef(c.oid, true), obj_description(c.oid, 'pg_class') \
         FROM pg_class c WHERE c.oid::int8 = ANY($1)",
    )
    .bind(oids.clone())
    .fetch_all(&mut *conn)
    .await
    .map_err(format_db_error)?;
    let defs: HashMap<i64, (String, Option<String>)> = rows
        .iter()
        .map(|r| (r.try_get::<i64, _>(0).unwrap_or(0), (s(r, 1), opt(r, 2))))
        .collect();
    let dep_rows = sqlx::query(
        "SELECT DISTINCT r.ev_class::int8, d.refobjid::int8 FROM pg_rewrite r \
         JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid \
          AND d.refclassid = 'pg_class'::regclass \
         WHERE r.ev_class::int8 = ANY($1) AND d.refobjid <> r.ev_class",
    )
    .bind(oids)
    .fetch_all(&mut *conn)
    .await
    .map_err(format_db_error)?;
    let pos: HashMap<i64, usize> = views.iter().enumerate().map(|(i, v)| (v.oid, i)).collect();
    let mut deps = vec![Vec::new(); views.len()];
    for r in &dep_rows {
        let v: i64 = r.try_get(0).unwrap_or(0);
        let d: i64 = r.try_get(1).unwrap_or(0);
        if let (Some(&a), Some(&b)) = (pos.get(&v), pos.get(&d)) {
            deps[a].push(b);
        }
    }
    let mut out = String::new();
    let mut refresh = String::new();
    for i in topo_order(views.len(), &deps) {
        let v = views[i];
        let Some((def, comment)) = defs.get(&v.oid) else { continue };
        let def = def.trim().trim_end_matches(';');
        if v.kind == "m" {
            out.push_str(&format!("\nCREATE MATERIALIZED VIEW {} AS\n{def}\nWITH NO DATA;\n", v.full()));
            if mode.rows() {
                refresh.push_str(&format!("REFRESH MATERIALIZED VIEW {};\n", v.full()));
            }
        } else {
            out.push_str(&format!("\nCREATE VIEW {} AS\n{def};\n", v.full()));
        }
        if let Some(c) = comment {
            let word = if v.kind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
            out.push_str(&format!("COMMENT ON {word} {} IS {};\n", v.full(), std_literal(c)));
        }
    }
    out.push_str(&refresh);
    Ok(out)
}
