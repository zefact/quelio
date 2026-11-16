use super::split::{Flavor, Item, Splitter};
use super::sql::*;

/// ファイルの中身を全部分けて、文の文字だけを並べる
fn split(text: &str, flavor: Flavor) -> Vec<String> {
    let mut sp = Splitter::new(text.as_bytes(), flavor);
    let mut out = Vec::new();
    while let Some(item) = sp.next_item().expect("分けられる") {
        out.push(match item {
            Item::Sql { text, custom, .. } => {
                let t = String::from_utf8(text).unwrap().trim().to_string();
                if custom {
                    format!("[custom]{t}")
                } else {
                    t
                }
            }
            Item::CopyStart { text, .. } => format!("[copy]{}", String::from_utf8(text).unwrap().trim()),
            Item::CopyData { data, .. } => format!("[data]{}", String::from_utf8(data).unwrap()),
            Item::CopyEnd { .. } => "[end]".to_string(),
            Item::Meta { text, .. } => format!("[meta]{text}"),
        });
    }
    out
}

#[test]
fn 区切りで文に分ける() {
    assert_eq!(
        split("SELECT 1;\nSELECT 2;\n", Flavor::Mysql),
        vec!["SELECT 1", "SELECT 2"]
    );
    // 最後の文に区切りが無くても1文
    assert_eq!(split("SELECT 1;SELECT 2", Flavor::Pg), vec!["SELECT 1", "SELECT 2"]);
    // 空の文とコメントだけの文は捨てる
    assert_eq!(split(";;\n-- だけ\n;\nSELECT 1;", Flavor::Sqlite), vec!["SELECT 1"]);
}

#[test]
fn 文字列とコメントの中の区切りでは分けない() {
    let sql = "INSERT INTO t VALUES ('a;b', \"c;d\", 'it''s;'); -- x;y\nSELECT `a;b` /* ; */;";
    let got = split(sql, Flavor::Mysql);
    assert_eq!(got.len(), 2);
    assert!(got[0].starts_with("INSERT"));
    assert!(got[1].contains("SELECT `a;b`"));
}

#[test]
fn mysqlの文字列はバックスラッシュで逃がす() {
    let got = split(r"INSERT INTO t VALUES ('a\';b');SELECT 1;", Flavor::Mysql);
    assert_eq!(got, vec![r"INSERT INTO t VALUES ('a\';b')", "SELECT 1"]);
    // PostgreSQL は E'…' のときだけ
    let got = split(r"SELECT E'a\';b';SELECT 'c\';SELECT 2;", Flavor::Pg);
    assert_eq!(got, vec![r"SELECT E'a\';b'", r"SELECT 'c\'", "SELECT 2"]);
}

#[test]
fn mysqlの行コメントは空白が続くときだけ() {
    // --1 はコメントではない (引き算)
    let got = split("SELECT 1--1;\nSELECT 2;", Flavor::Mysql);
    assert_eq!(got, vec!["SELECT 1--1", "SELECT 2"]);
    let got = split("# コメント;\nSELECT 1;", Flavor::Mysql);
    assert_eq!(got.len(), 1);
}

#[test]
fn delimiterで区切りを変える() {
    let sql = "DELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET NEW.x = 1; SET NEW.y = 2; END ;;\nDELIMITER ;\nSELECT 1;\n";
    let got = split(sql, Flavor::Mysql);
    assert_eq!(got.len(), 2);
    assert!(got[0].starts_with("[custom]CREATE TRIGGER"));
    assert!(got[0].ends_with("END"));
    assert_eq!(got[1], "SELECT 1");
}

#[test]
fn mysqlの実行されるコメントは文として残す() {
    let got = split("/*!40101 SET NAMES utf8mb4 */;\n/* ただのコメント */;\n", Flavor::Mysql);
    assert_eq!(got, vec!["/*!40101 SET NAMES utf8mb4 */"]);
}

#[test]
fn pgのドル引用の中では分けない() {
    let sql = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql;\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT $1;";
    let got = split(sql, Flavor::Pg);
    assert_eq!(got.len(), 3);
    assert!(got[0].ends_with("LANGUAGE plpgsql"));
    assert!(got[1].starts_with("DO $$"));
    assert_eq!(got[2], "SELECT $1");
}

#[test]
fn pgの入れ子のコメント() {
    let got = split("/* a /* b; */ c; */ SELECT 1;", Flavor::Pg);
    assert_eq!(got.len(), 1);
    assert!(got[0].ends_with("SELECT 1"));
}

#[test]
fn pgのcopyのデータを取り出す() {
    let sql = "SET x = 1;\nCOPY public.t (a, b) FROM stdin;\n1\tit's;\n2\t\\N\n\\.\nSELECT 1;\n";
    let got = split(sql, Flavor::Pg);
    assert_eq!(
        got,
        vec![
            "SET x = 1",
            "[copy]COPY public.t (a, b) FROM stdin",
            "[data]1\tit's;\n2\t\\N\n",
            "[end]",
            "SELECT 1",
        ]
    );
    // データが空でも終わりの印は出る
    let got = split("COPY t FROM STDIN;\n\\.\n", Flavor::Pg);
    assert_eq!(got, vec!["[copy]COPY t FROM STDIN", "[end]"]);
}

#[test]
fn pgのcopyが閉じていなければ失敗にする() {
    let mut sp = Splitter::new("COPY t FROM stdin;\n1\n".as_bytes(), Flavor::Pg);
    assert!(matches!(sp.next_item(), Ok(Some(Item::CopyStart { .. }))));
    assert!(sp.next_item().is_err());
}

#[test]
fn psqlの命令は別に知らせる() {
    let got = split("\\restrict abc\nSELECT 1;\n\\connect other\n", Flavor::Pg);
    assert_eq!(got, vec!["[meta]\\restrict abc", "SELECT 1", "[meta]\\connect other"]);
}

#[test]
fn pgのbegin_atomicの中では分けない() {
    let sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END;\nSELECT 3;";
    let got = split(sql, Flavor::Pg);
    assert_eq!(got.len(), 2);
    assert!(got[0].ends_with("END"));
}

#[test]
fn sqliteのトリガの中では分けない() {
    let sql = "CREATE TRIGGER tr AFTER INSERT ON a BEGIN UPDATE b SET x = CASE WHEN 1 THEN 2 END; INSERT INTO c VALUES (1); END;\nSELECT [a;b] FROM t;";
    let got = split(sql, Flavor::Sqlite);
    assert_eq!(got.len(), 2);
    assert!(got[0].ends_with("END"));
    assert_eq!(got[1], "SELECT [a;b] FROM t");
}

#[test]
fn 行とバイトの位置を返す() {
    let text = "\u{feff}SELECT 1;\n\nSELECT 2;";
    let mut sp = Splitter::new(text.as_bytes(), Flavor::Mysql);
    let Some(Item::Sql { line, end, .. }) = sp.next_item().unwrap() else { panic!() };
    assert_eq!((line, end), (1, 12));
    let Some(Item::Sql { line, end, .. }) = sp.next_item().unwrap() else { panic!() };
    assert_eq!((line, end), (3, text.len() as u64));
}

#[test]
fn 読み込みの切れ目をまたいでも分けられる() {
    // 1MBずつ読むので、それより長い文字列の途中で切れる
    let long = "x".repeat(3 * 1024 * 1024);
    let sql = format!("INSERT INTO t VALUES ('{long};');\nSELECT 1;");
    let got = split(&sql, Flavor::Mysql);
    assert_eq!(got.len(), 2);
    assert_eq!(got[1], "SELECT 1");
}

#[test]
fn mysqlの文字列を逃がす() {
    let mut buf = Vec::new();
    push_my_str(&mut buf, b"a'b\"c\\d\n\r\t\0\x1a");
    assert_eq!(buf, br#"'a\'b\"c\\d\n\r\t\0\Z'"#.to_vec());
}

#[test]
fn 標準の文字列は引用符を重ねる() {
    let mut buf = Vec::new();
    push_std_str(&mut buf, "it's '日本'".as_bytes());
    assert_eq!(String::from_utf8(buf).unwrap(), "'it''s ''日本'''");
}

#[test]
fn バイナリは16進で書く() {
    let mut buf = Vec::new();
    push_my_hex(&mut buf, &[0x00, 0xAB, 0x10]);
    assert_eq!(buf, b"0x00AB10".to_vec());
    let mut buf = Vec::new();
    push_my_hex(&mut buf, &[]);
    assert_eq!(buf, b"''".to_vec());
    let mut buf = Vec::new();
    push_sqlite_blob(&mut buf, &[0xFF]);
    assert_eq!(buf, b"X'FF'".to_vec());
}

#[test]
fn 小数は同じ値に戻る形で書く() {
    assert_eq!(float_text(1.0), "1.0");
    assert_eq!(float_text(0.1), "0.1");
    assert_eq!(float_text(1e300), "1e300");
    assert_eq!(float_text(f64::INFINITY), "1e999");
    assert_eq!(float_text(f64::NAN), "NULL");
    let v = 0.1 + 0.2;
    assert_eq!(float_text(v).parse::<f64>().unwrap(), v);
}

#[test]
fn 作り手の指定を外す() {
    assert_eq!(
        strip_definer("CREATE DEFINER=`root`@`%` TRIGGER t"),
        "CREATE TRIGGER t"
    );
    assert_eq!(
        strip_definer("CREATE ALGORITHM=UNDEFINED DEFINER=`a``b`@`localhost` SQL SECURITY DEFINER VIEW v"),
        "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW v"
    );
}

#[test]
fn 参照される側を先に並べる() {
    // 0 は 1 を、1 は 2 を参照
    let order = topo_order(3, &[vec![1], vec![2], vec![]]);
    assert_eq!(order, vec![2, 1, 0]);
    // 輪になっていても全部出る
    let order = topo_order(2, &[vec![1], vec![0]]);
    assert_eq!(order.len(), 2);
}

#[test]
fn mysqlの列の書き方を決める() {
    use super::mysql::{is_generated, kind_of, Kind};
    assert_eq!(kind_of("int"), Kind::Num);
    assert_eq!(kind_of("DECIMAL"), Kind::Num);
    assert_eq!(kind_of("varbinary"), Kind::Hex);
    assert_eq!(kind_of("geometry"), Kind::Hex);
    assert_eq!(kind_of("datetime"), Kind::Str);
    assert_eq!(kind_of("json"), Kind::Str);
    assert!(is_generated("VIRTUAL GENERATED"));
    assert!(is_generated("STORED GENERATED"));
    // 式の既定値は生成列ではない
    assert!(!is_generated("DEFAULT_GENERATED on update CURRENT_TIMESTAMP"));
}

#[test]
fn 進み具合はテーブルの重みで測る() {
    let p = super::Progress::default();
    assert_eq!(p.fraction(), None);
    p.set_total(100);
    p.begin(50, 10);
    p.add_rows(5);
    assert_eq!(p.fraction(), Some(0.25));
    // 見積もりより多くても、テーブルが終わるまでは 99% で止める
    p.add_rows(100);
    assert_eq!(p.fraction(), Some(0.495));
    p.end();
    assert_eq!(p.fraction(), Some(0.5));
}

/// 試しに使う置き場 (テストごとに別の名前)
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("quelio-dump-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn sqlite_ep(path: &std::path::Path) -> crate::tools::Endpoint {
    crate::tools::Endpoint {
        db_type: crate::models::DbType::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        password: String::new(),
        read_only: false,
        tls: crate::db::TlsConfig::default(),
        label: "test".into(),
        sqlite_path: path.to_string_lossy().to_string(),
    }
}

/// 表の中身を、並びと型の分かる文字にする
async fn dump_rows(conn: &mut sqlx::SqliteConnection, sql: &str) -> Vec<String> {
    use sqlx::{Row, TypeInfo, ValueRef};
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_all(&mut *conn)
        .await
        .unwrap();
    rows.iter()
        .map(|r| {
            (0..r.len())
                .map(|i| {
                    let v = r.try_get_raw(i).unwrap();
                    let ty = v.type_info().name().to_string();
                    let shown = match ty.as_str() {
                        "NULL" => "NULL".to_string(),
                        "INTEGER" => r.get::<i64, _>(i).to_string(),
                        "REAL" => r.get::<f64, _>(i).to_string(),
                        "BLOB" => format!("{:?}", r.get::<Vec<u8>, _>(i)),
                        _ => r.get::<String, _>(i),
                    };
                    format!("{ty}:{shown}")
                })
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect()
}

#[tokio::test]
async fn sqliteを書き出して戻すと同じ中身になる() {
    use sqlx::Connection;
    let src = scratch("src.db");
    std::fs::File::create(&src).unwrap();
    let mut conn = crate::db::connect_sqlite(src.to_str().unwrap(), false).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, \
                            price REAL, data BLOB, note TEXT, doubled INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL);
         CREATE INDEX item_name ON item(name);
         CREATE TABLE log (msg TEXT);
         CREATE TRIGGER item_log AFTER INSERT ON item BEGIN
           INSERT INTO log VALUES (CASE WHEN NEW.price > 100 THEN 'high;' ELSE 'low' END);
         END;
         CREATE VIEW cheap AS SELECT name FROM item WHERE price < 100;
         INSERT INTO item (name, price, data, note) VALUES
           ('りんご', 120.5, X'00FF10', 'it''s; \"quoted\"'),
           ('改行', 0.1, NULL, 'a
b'),
           ('空', NULL, X'', NULL);
         DELETE FROM item WHERE name = '空';",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let before_items = dump_rows(&mut conn, "SELECT * FROM item ORDER BY id").await;
    let before_log = dump_rows(&mut conn, "SELECT * FROM log ORDER BY rowid").await;
    conn.close().await.unwrap();

    // 書き出す
    let out_path = scratch("dump.sql");
    let progress = std::sync::Arc::new(super::Progress::default());
    let mut out = super::Out::new(std::fs::File::create(&out_path).unwrap(), progress.clone());
    let tables: Vec<crate::models::ExportTable> = ["item", "log", "cheap"]
        .iter()
        .map(|n| crate::models::ExportTable { schema: None, name: n.to_string() })
        .collect();
    super::sqlite::export(&sqlite_ep(&src), &tables, super::Mode::Full, &progress, &mut out)
        .await
        .unwrap();
    out.finish().await.unwrap();
    assert_eq!(progress.fraction(), Some(1.0));
    let text = std::fs::read_to_string(&out_path).unwrap();
    assert!(text.contains("BEGIN TRANSACTION;"));
    // 生成列は INSERT に書かない
    assert!(text.contains(r#"INSERT INTO "item" ("id","name","price","data","note") VALUES"#));

    // 空のファイルへ戻す
    let dst = scratch("dst.db");
    std::fs::File::create(&dst).unwrap();
    let p2 = super::Progress::default();
    let n = super::restore::run(&sqlite_ep(&dst), "main", &out_path, &p2).await.unwrap();
    assert!(n > 5);
    assert_eq!(p2.fraction(), Some(1.0));

    let mut conn = crate::db::connect_sqlite(dst.to_str().unwrap(), false).await.unwrap();
    assert_eq!(dump_rows(&mut conn, "SELECT * FROM item ORDER BY id").await, before_items);
    // トリガは戻した後に作るので、データを入れても log は増えていない
    assert_eq!(dump_rows(&mut conn, "SELECT * FROM log ORDER BY rowid").await, before_log);
    assert_eq!(
        dump_rows(&mut conn, "SELECT name FROM cheap").await,
        vec!["TEXT:改行".to_string()]
    );
    // AUTOINCREMENT の続きも戻る (消した '空' の番号は使われない)
    sqlx::raw_sql("INSERT INTO item (name) VALUES ('次')").execute(&mut conn).await.unwrap();
    assert_eq!(
        dump_rows(&mut conn, "SELECT id FROM item WHERE name = '次'").await,
        vec!["INTEGER:4".to_string()]
    );
    // トリガも戻っている (元の3行 + いま足した1行)
    assert_eq!(dump_rows(&mut conn, "SELECT count(*) FROM log").await, vec!["INTEGER:4".to_string()]);
}

#[test]
fn mysqlの関数の書き出しは流し込みで1文ずつに戻る() {
    let block = super::mysql::routine_block(
        "DROP PROCEDURE IF EXISTS `p`",
        "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
        "CREATE DEFINER=`root`@`%` PROCEDURE `p`()\nBEGIN\n  SELECT 1;\n  SELECT 'a;b';\nEND",
    );
    let got = split(&format!("{block}SELECT 2;\n"), Flavor::Mysql);
    assert_eq!(got.len(), 6, "{got:?}");
    assert_eq!(got[0], "DROP PROCEDURE IF EXISTS `p`");
    assert_eq!(got[2], "/*!50003 SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION' */");
    assert!(got[3].starts_with("[custom]CREATE PROCEDURE `p`()"));
    assert!(got[3].ends_with("END"));
    assert_eq!(got[5], "SELECT 2");
}

#[test]
fn export_target_check() {
    use super::target::{check, partial_path};
    let file = scratch("backup");
    let dir = file.parent().unwrap().to_path_buf();
    // 拡張子が無ければ .sql を付ける
    assert_eq!(check(&file).unwrap(), dir.join("backup.sql"));
    // 付いていればそのまま
    assert_eq!(check(&dir.join("a.dump")).unwrap(), dir.join("a.dump"));
    // 相対パス・無いフォルダ・フォルダそのものは断る
    assert!(check(std::path::Path::new("backup.sql")).is_err());
    assert!(check(&dir.join("nope").join("a.sql")).is_err());
    assert!(check(&dir).is_err());
    // 途中のファイルは同じフォルダに置く
    assert_eq!(partial_path(&dir.join("a.sql")), dir.join("a.sql.partial"));
}

#[test]
fn export_target_commit_keeps_old_until_done() {
    use super::target::{commit, discard, partial_path};
    let path = scratch("keep.sql");
    std::fs::write(&path, "old").unwrap();
    // 途中で失敗したら、古いほうは残る
    std::fs::write(partial_path(&path), "half").unwrap();
    discard(&path);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
    assert!(!partial_path(&path).exists());
    // 書き終えたら置き換わる
    std::fs::write(partial_path(&path), "new").unwrap();
    commit(&path).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert!(!partial_path(&path).exists());
}
