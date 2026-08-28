//! データベース・スキーマの作成と削除。
//!
//! 名前はすべてクォートしてから組み立てるが、
//! クォートでは防げない事故 (制御文字・長すぎる名前・末尾の空白) を
//! ここで先に断ってから使う

use crate::models::DbType;

/// 名前の長さの上限 (MySQLは64文字、PostgreSQLは63バイト)
fn max_name_len(db: DbType) -> usize {
    match db {
        DbType::Postgresql => 63,
        _ => 64,
    }
}

/// 上限と比べる長さ。MySQLは文字数、PostgreSQLはバイト数で数える
fn name_len(db: DbType, name: &str) -> (usize, &'static str) {
    match db {
        DbType::Postgresql => (name.len(), "バイト"),
        _ => (name.chars().count(), "文字"),
    }
}

/// データベース・スキーマの名前として受け付けるか。
///
/// クォートするのでSQLは壊れないが、
/// 作れてしまうと後で消せない名前 (制御文字入りなど) は先に断る
pub fn check_name(db: DbType, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("名前に改行やタブは使えません".into());
    }
    // MySQLは末尾の空白を認めない。他のDBでも見分けが付かず事故のもとなので断る
    if name != name.trim() {
        return Err("名前の前後に空白は使えません".into());
    }
    let (len, unit) = name_len(db, name);
    let max = max_name_len(db);
    if len > max {
        return Err(format!("名前が長すぎます ({len}{unit} / 上限{max}{unit})"));
    }
    Ok(())
}

/// 文字コード・照合順序として受け付けるか (英数字とアンダースコアだけ)
fn check_option(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 64 {
        return Err(format!("{label}の指定が正しくありません"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "{label}には英数字・アンダースコア・ハイフンだけが使えます"
        ));
    }
    Ok(())
}

/// 空文字をNoneにする
fn opt(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

/// CREATE DATABASE 文を組み立てる
pub fn create_database_sql(
    db: DbType,
    name: &str,
    // encoding: MySQLは文字コード、PostgreSQLはエンコーディング
    encoding: Option<&str>,
    // collation: MySQLの照合順序 (PostgreSQLでは使わない)
    collation: Option<&str>,
) -> Result<String, String> {
    check_name(db, name)?;
    let quoted = crate::ddl::quote(db, name);
    match db {
        DbType::Mysql => {
            let mut sql = format!("CREATE DATABASE {quoted}");
            if let Some(cs) = opt(encoding) {
                check_option("文字コード", cs)?;
                sql.push_str(&format!(" CHARACTER SET {cs}"));
            }
            if let Some(co) = opt(collation) {
                check_option("照合順序", co)?;
                sql.push_str(&format!(" COLLATE {co}"));
            }
            Ok(sql)
        }
        DbType::Postgresql => {
            let mut sql = format!("CREATE DATABASE {quoted}");
            if let Some(enc) = opt(encoding) {
                check_option("エンコーディング", enc)?;
                /*
                 * template1 と違うエンコーディングは作れないので、
                 * 指定があるときは template0 から作る
                 */
                sql.push_str(&format!(" ENCODING '{enc}' TEMPLATE template0"));
            }
            Ok(sql)
        }
        DbType::Sqlite => Err("SQLiteはファイル1つが1データベースです".into()),
        DbType::Valkey => Err("Valkey接続ではこの操作はできません".into()),
    }
}

/// サーバーが自分のために使うデータベース。消すとサーバーが壊れる。
///
/// MySQLの `SHOW DATABASES` はこれらもそのまま返してくるので、
/// 一覧に出ても消せないようにしておく
pub fn system_databases(db: DbType) -> &'static [&'static str] {
    match db {
        DbType::Mysql => &["information_schema", "mysql", "performance_schema", "sys"],
        // template0 / template1 は一覧に出ないが、名前を直接指定されても断る
        DbType::Postgresql => &["postgres", "template0", "template1"],
        _ => &[],
    }
}

/// 消してはいけないデータベースか
pub fn is_system_database(db: DbType, name: &str) -> bool {
    system_databases(db)
        .iter()
        .any(|s| name.eq_ignore_ascii_case(s))
}

/// DROP DATABASE 文を組み立てる
pub fn drop_database_sql(db: DbType, name: &str) -> Result<String, String> {
    check_name(db, name)?;
    /*
     * 画面でもボタンを出さないが、ここでも断る。
     * 組み立てを通らずに DROP されることが無いので、この1箇所で塞げる
     */
    if is_system_database(db, name) {
        return Err(format!(
            "{name} はサーバーが使うデータベースなので削除できません"
        ));
    }
    match db {
        DbType::Mysql | DbType::Postgresql => {
            Ok(format!("DROP DATABASE {}", crate::ddl::quote(db, name)))
        }
        DbType::Sqlite => Err("SQLiteはファイル1つが1データベースです".into()),
        DbType::Valkey => Err("Valkey接続ではこの操作はできません".into()),
    }
}

/// CREATE SCHEMA 文を組み立てる (PostgreSQLのみ)
pub fn create_schema_sql(db: DbType, name: &str) -> Result<String, String> {
    ensure_pg(db)?;
    check_name(db, name)?;
    Ok(format!("CREATE SCHEMA {}", crate::ddl::quote(db, name)))
}

/// DROP SCHEMA 文を組み立てる (PostgreSQLのみ)
pub fn drop_schema_sql(db: DbType, name: &str, cascade: bool) -> Result<String, String> {
    ensure_pg(db)?;
    check_name(db, name)?;
    let quoted = crate::ddl::quote(db, name);
    // RESTRICT を明示して、うっかり中身ごと消さないようにする
    Ok(if cascade {
        format!("DROP SCHEMA {quoted} CASCADE")
    } else {
        format!("DROP SCHEMA {quoted} RESTRICT")
    })
}

/// 消してはいけないスキーマか (システムのもの)
pub fn is_system_schema(name: &str) -> bool {
    name == "information_schema" || name.starts_with("pg_")
}

fn ensure_pg(db: DbType) -> Result<(), String> {
    if db == DbType::Postgresql {
        Ok(())
    } else {
        Err("スキーマの操作ができるのはPostgreSQLだけです".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 名前の決まりを確かめる() {
        assert!(check_name(DbType::Mysql, "shop").is_ok());
        assert!(check_name(DbType::Mysql, "").is_err());
        assert!(check_name(DbType::Mysql, "a\nb").is_err());
        assert!(check_name(DbType::Mysql, "shop ").is_err());
        assert!(check_name(DbType::Mysql, &"a".repeat(64)).is_ok());
        assert!(check_name(DbType::Mysql, &"a".repeat(65)).is_err());
        // PostgreSQLは63バイトまで
        assert!(check_name(DbType::Postgresql, &"a".repeat(63)).is_ok());
        assert!(check_name(DbType::Postgresql, &"a".repeat(64)).is_err());
        // 日本語もクォートするので使える (MySQLは文字数で数えるので64文字まで)
        assert!(check_name(DbType::Mysql, "在庫").is_ok());
        assert!(check_name(DbType::Mysql, &"在".repeat(64)).is_ok());
        assert!(check_name(DbType::Mysql, &"在".repeat(65)).is_err());
    }

    #[test]
    fn mysqlの作成文を組み立てる() {
        assert_eq!(
            create_database_sql(DbType::Mysql, "shop", None, None).unwrap(),
            "CREATE DATABASE `shop`"
        );
        assert_eq!(
            create_database_sql(
                DbType::Mysql,
                "sh`op",
                Some("utf8mb4"),
                Some("utf8mb4_bin")
            )
            .unwrap(),
            "CREATE DATABASE `sh``op` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
        );
    }

    #[test]
    fn postgresqlはtemplate0から作る() {
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", None, None).unwrap(),
            "CREATE DATABASE \"shop\""
        );
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", Some("UTF8"), None).unwrap(),
            "CREATE DATABASE \"shop\" ENCODING 'UTF8' TEMPLATE template0"
        );
    }

    #[test]
    fn 文字コードの名前にハイフンを使える() {
        // PostgreSQLは UTF-8 / ISO-8859-1 のような別名も受け付ける
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", Some("UTF-8"), None).unwrap(),
            "CREATE DATABASE \"shop\" ENCODING 'UTF-8' TEMPLATE template0"
        );
    }

    #[test]
    fn 文字コードの指定に記号は使えない() {
        let e = create_database_sql(DbType::Mysql, "shop", Some("utf8mb4'; DROP"), None);
        assert!(e.is_err());
        let e = create_database_sql(DbType::Postgresql, "shop", Some("UTF8' --"), None);
        assert!(e.is_err());
    }

    #[test]
    fn 削除文を組み立てる() {
        assert_eq!(
            drop_database_sql(DbType::Mysql, "shop").unwrap(),
            "DROP DATABASE `shop`"
        );
        assert_eq!(
            drop_database_sql(DbType::Postgresql, "sh\"op").unwrap(),
            "DROP DATABASE \"sh\"\"op\""
        );
        assert!(drop_database_sql(DbType::Sqlite, "shop").is_err());
    }

    #[test]
    fn スキーマはpostgresqlだけ() {
        assert_eq!(
            create_schema_sql(DbType::Postgresql, "app").unwrap(),
            "CREATE SCHEMA \"app\""
        );
        assert_eq!(
            drop_schema_sql(DbType::Postgresql, "app", false).unwrap(),
            "DROP SCHEMA \"app\" RESTRICT"
        );
        assert_eq!(
            drop_schema_sql(DbType::Postgresql, "app", true).unwrap(),
            "DROP SCHEMA \"app\" CASCADE"
        );
        assert!(create_schema_sql(DbType::Mysql, "app").is_err());
    }

    #[test]
    fn システムのデータベースは消せない() {
        /*
         * MySQLの SHOW DATABASES はシステムのDBもそのまま返す。
         * mysql を消すとサーバーが起動しなくなる
         */
        for name in ["information_schema", "mysql", "performance_schema", "sys"] {
            assert!(is_system_database(DbType::Mysql, name), "{name}");
            let err = drop_database_sql(DbType::Mysql, name)
                .expect_err("組み立ての時点で断る");
            assert!(err.contains("削除できません"), "{name}: {err}");
        }
        // 大小を無視して見る (MySQLは設定で区別しないことがある)
        assert!(is_system_database(DbType::Mysql, "MySQL"));
        assert!(is_system_database(DbType::Mysql, "INFORMATION_SCHEMA"));

        // PostgreSQLはテンプレートと postgres を守る
        for name in ["postgres", "template0", "template1"] {
            assert!(is_system_database(DbType::Postgresql, name), "{name}");
            assert!(drop_database_sql(DbType::Postgresql, name).is_err(), "{name}");
        }

        // 利用者のデータベースはこれまでどおり消せる
        assert!(!is_system_database(DbType::Mysql, "shop"));
        assert_eq!(
            drop_database_sql(DbType::Mysql, "shop").unwrap(),
            "DROP DATABASE `shop`"
        );
        // 名前が似ているだけのものは巻き込まない
        assert!(!is_system_database(DbType::Mysql, "mysql_backup"));
        assert!(!is_system_database(DbType::Postgresql, "postgres_old"));
        assert!(drop_database_sql(DbType::Postgresql, "postgres_old").is_ok());
    }

    #[test]
    fn システムのスキーマを見分ける() {
        assert!(is_system_schema("pg_catalog"));
        assert!(is_system_schema("pg_toast"));
        assert!(is_system_schema("information_schema"));
        assert!(!is_system_schema("public"));
        assert!(!is_system_schema("app"));
    }
}
