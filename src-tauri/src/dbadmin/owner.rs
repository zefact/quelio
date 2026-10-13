//! データベースの所有者 (PostgreSQLのみ)。
//!
//! 所有者は作るときに決められ、あとから ALTER DATABASE で付け替えられる。
//! ロール名もクォートしてから組み立てるが、データベース名と同じく
//! クォートでは防げない名前 (制御文字・長すぎる名前・前後の空白) は先に断る。
//! MySQLのデータベースには所有者という考えが無い

use super::{check_name, is_system_database, opt};
use crate::ddl::quote;
use crate::models::DbType;

/// ロール名として受け付けるか (決まりはデータベース名と同じ)
fn check_role(owner: &str) -> Result<(), String> {
    check_name(DbType::Postgresql, owner).map_err(|e| format!("所有者: {e}"))
}

/// CREATE DATABASE に足す所有者の指定 (指定が無ければ空)
pub(super) fn owner_clause(db: DbType, owner: Option<&str>) -> Result<String, String> {
    let Some(owner) = opt(owner) else {
        return Ok(String::new());
    };
    if db != DbType::Postgresql {
        return Err("所有者を指定できるのはPostgreSQLだけです".into());
    }
    check_role(owner)?;
    Ok(format!(" OWNER {}", quote(db, owner)))
}

/// 所有者を付け替える ALTER DATABASE 文を組み立てる
pub fn alter_database_owner_sql(db: DbType, name: &str, owner: &str) -> Result<String, String> {
    if db != DbType::Postgresql {
        return Err("所有者を変更できるのはPostgreSQLだけです".into());
    }
    check_name(db, name)?;
    /*
     * サーバーが使うデータベース (postgres など) は、削除と同じく触らせない。
     * 付け替えても壊れはしないが、元に戻す人が困る
     */
    if is_system_database(db, name) {
        return Err(format!(
            "{name} はサーバーが使うデータベースなので所有者を変更できません"
        ));
    }
    let owner = opt(Some(owner)).ok_or("新しい所有者を選んでください")?;
    check_role(owner)?;
    Ok(format!(
        "ALTER DATABASE {} OWNER TO {}",
        quote(db, name),
        quote(db, owner)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dbadmin::create_database_sql;

    #[test]
    fn 作るときに所有者を指定できる() {
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", None, None, Some("app")).unwrap(),
            "CREATE DATABASE \"shop\" OWNER \"app\""
        );
        // ほかの指定と一緒でもよい
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", Some("UTF8"), None, Some("app"))
                .unwrap(),
            "CREATE DATABASE \"shop\" OWNER \"app\" ENCODING 'UTF8' TEMPLATE template0"
        );
        // 空なら付けない (接続しているロールが所有者になる)
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", None, None, Some(" ")).unwrap(),
            "CREATE DATABASE \"shop\""
        );
    }

    #[test]
    fn 所有者の名前もクォートする() {
        assert_eq!(
            create_database_sql(DbType::Postgresql, "shop", None, None, Some("a\"b")).unwrap(),
            "CREATE DATABASE \"shop\" OWNER \"a\"\"b\""
        );
        assert!(create_database_sql(DbType::Postgresql, "shop", None, None, Some("a\nb")).is_err());
    }

    #[test]
    fn mysqlには所有者が無い() {
        assert!(create_database_sql(DbType::Mysql, "shop", None, None, Some("app")).is_err());
        assert!(create_database_sql(DbType::Mysql, "shop", None, None, None).is_ok());
        assert!(alter_database_owner_sql(DbType::Mysql, "shop", "app").is_err());
    }

    #[test]
    fn 所有者を付け替える() {
        assert_eq!(
            alter_database_owner_sql(DbType::Postgresql, "shop", "app").unwrap(),
            "ALTER DATABASE \"shop\" OWNER TO \"app\""
        );
        assert_eq!(
            alter_database_owner_sql(DbType::Postgresql, "sh\"op", "a\"pp").unwrap(),
            "ALTER DATABASE \"sh\"\"op\" OWNER TO \"a\"\"pp\""
        );
    }

    #[test]
    fn 付け替えられないもの() {
        // 新しい所有者が無い
        assert!(alter_database_owner_sql(DbType::Postgresql, "shop", "").is_err());
        assert!(alter_database_owner_sql(DbType::Postgresql, "shop", "  ").is_err());
        // サーバーが使うデータベース
        for name in ["postgres", "template0", "template1"] {
            let e = alter_database_owner_sql(DbType::Postgresql, name, "app").unwrap_err();
            assert!(e.contains("変更できません"), "{name}: {e}");
        }
        // 制御文字の入ったロール名
        assert!(alter_database_owner_sql(DbType::Postgresql, "shop", "a\tb").is_err());
    }
}
