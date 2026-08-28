//! カタログの組み立て (SQLの一本化まわり) のテスト

use super::*;

/*
 * ここで使う値は、実際の PostgreSQL 16 に問い合わせて確かめたもの:
 *   pg_get_partkeydef  → "RANGE (at)"
 *   pg_get_expr(relpartbound, oid)
 *       → "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')" / "DEFAULT"
 */

#[test]
fn パーティションの親には分け方を付ける() {
    let lines = vec![
        "    \"id\" bigint NOT NULL".to_string(),
        "    \"at\" date NOT NULL".to_string(),
    ];
    let sql = pg_create_table("\"public\".\"sales\"", &lines, Some("RANGE (at)"));
    assert_eq!(
        sql,
        "CREATE TABLE \"public\".\"sales\" (\n\
         \x20   \"id\" bigint NOT NULL,\n\
         \x20   \"at\" date NOT NULL\n\
         )\nPARTITION BY RANGE (at);"
    );
    // 分かれていないテーブルには付かない
    let plain = pg_create_table("\"public\".\"t\"", &lines, None);
    assert!(!plain.contains("PARTITION BY"), "{plain}");
    assert!(plain.ends_with(");"), "{plain}");
}

#[test]
fn パーティションの子は列を並べ直さない() {
    // 列は親から引き継ぐので、CREATE TABLE … PARTITION OF が本来の形
    let sql = pg_partition_of(
        "\"public\".\"sales_2024_01\"",
        "\"public\".\"sales\"",
        "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')",
        None,
    );
    assert_eq!(
        sql,
        "CREATE TABLE \"public\".\"sales_2024_01\" PARTITION OF \"public\".\"sales\"\n\
         \x20   FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');"
    );
}

#[test]
fn 既定のパーティションと入れ子も書ける() {
    // 受け皿のパーティションは bound が "DEFAULT" で返る
    let sql = pg_partition_of("\"t\"", "\"p\"", "DEFAULT", None);
    assert!(sql.ends_with("PARTITION OF \"p\"\n    DEFAULT;"), "{sql}");

    // 子がさらに分かれている場合は両方書く
    let nested = pg_partition_of("\"t\"", "\"p\"", "FOR VALUES IN ('a')", Some("HASH (id)"));
    assert!(nested.contains("PARTITION OF \"p\""), "{nested}");
    assert!(nested.ends_with("PARTITION BY HASH (id);"), "{nested}");
}

// ---------- カタログSQLの組み立て ----------

#[test]
fn 範囲で変わるのは絞り込みと並び順だけ() {
    // 1テーブルぶんはプレースホルダで絞り、まとめて取るときは絞らない
    let one = mysql_columns_sql(Scope::One);
    let all = mysql_columns_sql(Scope::All);
    assert!(one.contains("WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?"), "{one}");
    assert!(!one.contains("SELECT TABLE_NAME,"), "{one}");
    assert!(!all.contains("AND TABLE_NAME = ?"), "{all}");
    assert!(all.contains("SELECT TABLE_NAME,"), "{all}");
    assert!(all.contains("ORDER BY TABLE_NAME, ORDINAL_POSITION"), "{all}");
    // 取ってくる列そのものは同じ (片方だけ増減していないこと)
    for col in ["COLUMN_TYPE", "COLLATION_NAME", "COLUMN_COMMENT"] {
        assert!(one.contains(col) && all.contains(col), "{col}");
    }
}

#[test]
fn 式インデックスの列は付け外しできる() {
    assert!(mysql_indexes_sql(Scope::One, true).contains("EXPRESSION, "));
    assert!(!mysql_indexes_sql(Scope::One, false).contains("EXPRESSION"));
    // 並び順は主キーが先頭
    assert!(mysql_indexes_sql(Scope::All, true)
        .contains("ORDER BY TABLE_NAME, (INDEX_NAME = 'PRIMARY') DESC"));
}

#[test]
fn postgresqlも同じ形で組み立てる() {
    let one = pg_columns_sql(Scope::One);
    let all = pg_columns_sql(Scope::All);
    assert!(one.contains("n.nspname = $1 AND c.relname = $2"), "{one}");
    assert!(all.contains("pg_catalog"), "{all}");
    assert!(all.contains("n.nspname AS schema, c.relname AS tbl,"), "{all}");
    // 共通の条件はどちらにも入る
    for cond in ["a.attnum > 0", "NOT a.attisdropped"] {
        assert!(one.contains(cond) && all.contains(cond), "{cond}");
    }
    let idx_one = pg_indexes_sql(Scope::One);
    let idx_all = pg_indexes_sql(Scope::All);
    assert!(idx_one.contains("n.nspname = $1 AND t.relname = $2"));
    assert!(idx_all.contains("ORDER BY n.nspname, t.relname, ix.indisprimary DESC"));
}

#[test]
fn ログ用のプレースホルダ置換() {
    assert_eq!(
        fill_binds("WHERE a = ? AND b = ?", &["x", "y"], false),
        "WHERE a = 'x' AND b = 'y'"
    );
    assert_eq!(
        fill_binds("WHERE a = $1 AND b = $2", &["x", "y"], true),
        "WHERE a = 'x' AND b = 'y'"
    );
}
