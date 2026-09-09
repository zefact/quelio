use super::*;

fn my() -> SqlStyle {
    SqlStyle::of(DbType::Mysql)
}

fn pg() -> SqlStyle {
    SqlStyle::of(DbType::Postgresql)
}

fn user(name: &str, host: &str) -> UserRef {
    UserRef {
        name: name.to_string(),
        host: host.to_string(),
    }
}

fn newuser(name: &str) -> NewUser {
    NewUser {
        name: name.to_string(),
        host: String::new(),
        password: String::new(),
        can_login: true,
        create_role: false,
        create_db: false,
        conn_limit: String::new(),
        expires: String::new(),
    }
}

// ---------- 名前 ----------

#[test]
fn 名前の決まりを確かめる() {
    assert!(check_name(DbType::Mysql, "app").is_ok());
    assert!(check_name(DbType::Mysql, "").is_err());
    assert!(check_name(DbType::Mysql, " app").is_err());
    assert!(check_name(DbType::Mysql, "a\nb").is_err());
    // MySQLは32文字まで
    assert!(check_name(DbType::Mysql, &"あ".repeat(32)).is_ok());
    assert!(check_name(DbType::Mysql, &"あ".repeat(33)).is_err());
    // PostgreSQLは63バイトまで
    assert!(check_name(DbType::Postgresql, &"a".repeat(63)).is_ok());
    assert!(check_name(DbType::Postgresql, &"a".repeat(64)).is_err());
}

#[test]
fn サーバーが使う名前は断る() {
    assert!(is_system_user("mariadb.sys"));
    assert!(is_system_user("postgres"));
    assert!(!is_system_user("app"));
    assert!(create_user_sql(my(), &newuser("mysql.sys")).is_err());
}

#[test]
fn 自分自身は変えられない() {
    let me = user("app", "%");
    let key = user_key(DbType::Mysql, &me);
    assert!(check_target(&me, &key, DbType::Mysql).is_err());
    assert!(check_target(&user("other", "%"), &key, DbType::Mysql).is_ok());
    // 同じ名前でも接続元が違えば別人
    assert!(check_target(&user("app", "localhost"), &key, DbType::Mysql).is_ok());
}

#[test]
fn 呼び名は引用符を重ねて逃がす() {
    assert_eq!(user_key(DbType::Mysql, &user("a'b", "%")), "'a''b'@'%'");
    assert_eq!(user_key(DbType::Postgresql, &user("a'b", "")), "a'b");
}

// ---------- 作成 ----------

#[test]
fn mysqlはパスワードと接続元を付ける() {
    let mut spec = newuser("app");
    spec.password = "pw".into();
    let sql = create_user_sql(my(), &spec).unwrap();
    assert_eq!(
        sql,
        vec!["CREATE USER 'app'@'%' IDENTIFIED BY 'pw'".to_string()]
    );
}

#[test]
fn 接続元を省くと全部からになる() {
    let sql = create_user_sql(my(), &newuser("app")).unwrap();
    assert!(sql[0].contains("'app'@'%'"));
}

#[test]
fn パスワードの引用符は逃がす() {
    let mut spec = newuser("app");
    spec.password = "a'b".into();
    let sql = create_user_sql(my(), &spec).unwrap();
    assert!(sql[0].ends_with("IDENTIFIED BY 'a''b'"));
}

#[test]
fn パスワードが空なら書かない() {
    let sql = create_user_sql(my(), &newuser("app")).unwrap();
    assert!(!sql[0].contains("IDENTIFIED"));
}

#[test]
fn postgresqlはログインの可否を必ず書く() {
    let sql = create_user_sql(pg(), &newuser("app")).unwrap();
    assert_eq!(sql, vec!["CREATE ROLE \"app\" LOGIN".to_string()]);

    let mut spec = newuser("readers");
    spec.can_login = false;
    let sql = create_user_sql(pg(), &spec).unwrap();
    assert_eq!(sql, vec!["CREATE ROLE \"readers\" NOLOGIN".to_string()]);
}

#[test]
fn postgresqlの上限と期限を付ける() {
    let mut spec = newuser("app");
    spec.password = "pw".into();
    spec.create_db = true;
    spec.conn_limit = "5".into();
    spec.expires = "2027-01-01".into();
    let sql = create_user_sql(pg(), &spec).unwrap();
    assert_eq!(
        sql[0],
        "CREATE ROLE \"app\" LOGIN CREATEDB PASSWORD 'pw' CONNECTION LIMIT 5 \
         VALID UNTIL '2027-01-01'"
    );
}

#[test]
fn 数でない上限と形の違う期限は断る() {
    let mut spec = newuser("app");
    spec.conn_limit = "たくさん".into();
    assert!(create_user_sql(pg(), &spec).is_err());

    let mut spec = newuser("app");
    spec.expires = "2027/01/01".into();
    assert!(create_user_sql(pg(), &spec).is_err());
}

// ---------- 変更・削除 ----------

#[test]
fn パスワードを変える() {
    assert_eq!(
        set_password_sql(my(), &user("app", "%"), "pw").unwrap(),
        "ALTER USER 'app'@'%' IDENTIFIED BY 'pw'"
    );
    assert_eq!(
        set_password_sql(pg(), &user("app", ""), "pw").unwrap(),
        "ALTER ROLE \"app\" PASSWORD 'pw'"
    );
}

#[test]
fn 名前を変えても接続元は引き継ぐ() {
    assert_eq!(
        rename_user_sql(my(), &user("app", "10.0.0.1"), "app2").unwrap(),
        "RENAME USER 'app'@'10.0.0.1' TO 'app2'@'10.0.0.1'"
    );
    assert_eq!(
        rename_user_sql(pg(), &user("app", ""), "app2").unwrap(),
        "ALTER ROLE \"app\" RENAME TO \"app2\""
    );
}

#[test]
fn 入れないようにする書き方はDBで違う() {
    assert_eq!(
        set_lock_sql(my(), &user("app", "%"), true),
        "ALTER USER 'app'@'%' ACCOUNT LOCK"
    );
    assert_eq!(
        set_lock_sql(my(), &user("app", "%"), false),
        "ALTER USER 'app'@'%' ACCOUNT UNLOCK"
    );
    assert_eq!(
        set_lock_sql(pg(), &user("app", ""), true),
        "ALTER ROLE \"app\" NOLOGIN"
    );
}

#[test]
fn 削除の書き方() {
    assert_eq!(
        drop_user_sql(my(), &user("app", "%")).unwrap(),
        "DROP USER 'app'@'%'"
    );
    assert_eq!(
        drop_user_sql(pg(), &user("app", "")).unwrap(),
        "DROP ROLE \"app\""
    );
    assert!(drop_user_sql(pg(), &user("postgres", "")).is_err());
}

#[test]
fn postgresqlの後片付けは持ち物を先に移す() {
    let sql = pg_cleanup_sql(pg(), &user("app", ""));
    assert_eq!(
        sql,
        vec![
            "REASSIGN OWNED BY \"app\" TO CURRENT_USER".to_string(),
            "DROP OWNED BY \"app\"".to_string(),
        ]
    );
}

// ---------- 権限 ----------

fn spec(scope: Scope, target: &str, privs: &[&str]) -> GrantSpec {
    GrantSpec {
        scope,
        target: target.to_string(),
        privileges: privs.iter().map(|s| s.to_string()).collect(),
        grantable: false,
    }
}

#[test]
fn mysqlの範囲ごとの書き方() {
    assert_eq!(
        grant_sql(my(), &user("app", "%"), &spec(Scope::Server, "", &["PROCESS"])).unwrap(),
        "GRANT PROCESS ON *.* TO 'app'@'%'"
    );
    assert_eq!(
        grant_sql(
            my(),
            &user("app", "%"),
            &spec(Scope::Database, "db_a", &["SELECT", "INSERT"])
        )
        .unwrap(),
        "GRANT SELECT, INSERT ON `db_a`.* TO 'app'@'%'"
    );
    assert_eq!(
        grant_sql(
            my(),
            &user("app", "%"),
            &spec(Scope::Table, "db_a.t1", &["SELECT"])
        )
        .unwrap(),
        "GRANT SELECT ON `db_a`.`t1` TO 'app'@'%'"
    );
}

#[test]
fn postgresqlの範囲ごとの書き方() {
    assert_eq!(
        grant_sql(
            pg(),
            &user("app", ""),
            &spec(Scope::Database, "postgres", &["CONNECT"])
        )
        .unwrap(),
        "GRANT CONNECT ON DATABASE \"postgres\" TO \"app\""
    );
    assert_eq!(
        grant_sql(pg(), &user("app", ""), &spec(Scope::Schema, "s1", &["USAGE"])).unwrap(),
        "GRANT USAGE ON SCHEMA \"s1\" TO \"app\""
    );
    assert_eq!(
        grant_sql(
            pg(),
            &user("app", ""),
            &spec(Scope::Table, "s1.t1", &["SELECT"])
        )
        .unwrap(),
        "GRANT SELECT ON TABLE \"s1\".\"t1\" TO \"app\""
    );
}

#[test]
fn 渡せるようにする指定が付く() {
    let mut s = spec(Scope::Database, "db_a", &["SELECT"]);
    s.grantable = true;
    let sql = grant_sql(my(), &user("app", "%"), &s).unwrap();
    assert!(sql.ends_with("WITH GRANT OPTION"));
}

#[test]
fn 外すときは渡せる指定を付けない() {
    let s = spec(Scope::Database, "db_a", &["SELECT"]);
    let sql = revoke_sql(my(), &user("app", "%"), &s).unwrap();
    assert_eq!(sql, ["REVOKE SELECT ON `db_a`.* FROM 'app'@'%'"]);
}

#[test]
fn 渡せる印も一緒に外す() {
    let mut s = spec(Scope::Database, "db_a", &["SELECT"]);
    s.grantable = true;
    assert_eq!(
        revoke_sql(my(), &user("app", "%"), &s).unwrap(),
        [
            "REVOKE SELECT ON `db_a`.* FROM 'app'@'%'",
            "REVOKE GRANT OPTION ON `db_a`.* FROM 'app'@'%'",
        ]
    );
    // PostgreSQL は権限ごと外れるので、印だけの文は要らない
    let mut s = spec(Scope::Table, "s1.t1", &["SELECT"]);
    s.grantable = true;
    assert_eq!(
        revoke_sql(pg(), &user("app", ""), &s).unwrap(),
        [r#"REVOKE SELECT ON TABLE "s1"."t1" FROM "app""#]
    );
}

#[test]
fn サーバー全体をUSAGEに戻す() {
    /*
     * MySQL の USAGE は「権限が無い」という印なので外す文は出さない。
     * 印だけが残った行からは、その印を外す文だけを出す
     */
    let mut s = spec(Scope::Server, "", &["USAGE"]);
    s.grantable = true;
    assert_eq!(
        revoke_sql(my(), &user("app", "%"), &s).unwrap(),
        ["REVOKE GRANT OPTION ON *.* FROM 'app'@'%'"]
    );
    // 本当の権限と混ざっていても、USAGE は並べない
    let s = spec(Scope::Server, "", &["USAGE", "SELECT", "PROCESS"]);
    assert_eq!(
        revoke_sql(my(), &user("app", "%"), &s).unwrap(),
        ["REVOKE SELECT, PROCESS ON *.* FROM 'app'@'%'"]
    );
    // 外すものが何も無ければ断る
    let s = spec(Scope::Server, "", &["USAGE"]);
    assert!(revoke_sql(my(), &user("app", "%"), &s).is_err());
}

#[test]
fn 一覧に無い権限も外せる() {
    // MySQL 8 の動的権限。決め打ちの一覧には載らないが、実際に付いている
    let s = spec(Scope::Server, "", &["APPLICATION_PASSWORD_ADMIN"]);
    assert_eq!(
        revoke_sql(my(), &user("app", "%"), &s).unwrap(),
        ["REVOKE APPLICATION_PASSWORD_ADMIN ON *.* FROM 'app'@'%'"]
    );
    // 小文字で来ても大文字に直す
    let s = spec(Scope::Server, "", &["role_admin"]);
    assert_eq!(
        revoke_sql(my(), &user("app", "%"), &s).unwrap(),
        ["REVOKE ROLE_ADMIN ON *.* FROM 'app'@'%'"]
    );
    // 付けるほうは今までどおり一覧のものだけ
    let s = spec(Scope::Server, "", &["APPLICATION_PASSWORD_ADMIN"]);
    assert!(grant_sql(my(), &user("app", "%"), &s).is_err());
}

#[test]
fn 権限の名前に見えないものは外すときも断る() {
    for bad in [
        "DROP DATABASE; --",
        "SELECT(col)",
        "1SELECT",
        "SELECT  ALL",
        "",
        "権限",
    ] {
        let s = spec(Scope::Server, "", &[bad]);
        assert!(
            revoke_sql(my(), &user("app", "%"), &s).is_err(),
            "{bad} は断るはず"
        );
    }
}

#[test]
fn 知らない権限は受け取らない() {
    let s = spec(Scope::Database, "db_a", &["DROP DATABASE; --"]);
    assert!(grant_sql(my(), &user("app", "%"), &s).is_err());
    // その範囲では扱えないものも断る
    let s = spec(Scope::Table, "db_a.t1", &["CREATE USER"]);
    assert!(grant_sql(my(), &user("app", "%"), &s).is_err());
}

#[test]
fn 権限の名前は大小を気にしない() {
    let s = spec(Scope::Database, "db_a", &["select"]);
    let sql = grant_sql(my(), &user("app", "%"), &s).unwrap();
    assert!(sql.starts_with("GRANT SELECT ON"));
}

#[test]
fn 同じ権限を二重に書かない() {
    let s = spec(Scope::Database, "db_a", &["SELECT", "select"]);
    let sql = grant_sql(my(), &user("app", "%"), &s).unwrap();
    assert_eq!(sql, "GRANT SELECT ON `db_a`.* TO 'app'@'%'");
}

#[test]
fn 権限を選ばないと断る() {
    let s = spec(Scope::Database, "db_a", &[]);
    assert!(grant_sql(my(), &user("app", "%"), &s).is_err());
}

#[test]
fn 対象の名前もクォートして逃がす() {
    let s = spec(Scope::Database, "d`b", &["SELECT"]);
    let sql = grant_sql(my(), &user("app", "%"), &s).unwrap();
    assert!(sql.contains("`d``b`.*"));
}

#[test]
fn テーブルはスキーマ付きで受け取る() {
    let s = spec(Scope::Table, "t1", &["SELECT"]);
    assert!(grant_sql(my(), &user("app", "%"), &s).is_err());
}

#[test]
fn 範囲ごとに選べる権限が違う() {
    assert!(privileges(DbType::Mysql, Scope::Server).contains(&"CREATE USER"));
    assert!(!privileges(DbType::Mysql, Scope::Table).contains(&"CREATE USER"));
    assert!(privileges(DbType::Postgresql, Scope::Schema).contains(&"USAGE"));
    // MySQLにスキーマの段は無い
    assert!(privileges(DbType::Mysql, Scope::Schema).is_empty());
    // PostgreSQLのサーバー全体はロールの属性で決める
    assert!(privileges(DbType::Postgresql, Scope::Server).is_empty());
}

#[test]
fn ロールの付け外し() {
    assert_eq!(
        role_sql(my(), &user("app", "%"), "readers", true).unwrap(),
        "GRANT 'readers' TO 'app'@'%'"
    );
    assert_eq!(
        role_sql(pg(), &user("app", ""), "readers", false).unwrap(),
        "REVOKE \"readers\" FROM \"app\""
    );
}

// ---------- まとめて組み立てる ----------

#[test]
fn 変更の種類ごとにSQLを組み立てる() {
    let u = user("app", "%");
    let got = build(my(), &UserChange::Lock { user: u.clone(), locked: true }).unwrap();
    assert_eq!(got, vec!["ALTER USER 'app'@'%' ACCOUNT LOCK".to_string()]);

    let got = build(
        my(),
        &UserChange::Grant {
            user: u.clone(),
            spec: spec(Scope::Database, "db_a", &["SELECT"]),
            add: false,
        },
    )
    .unwrap();
    assert_eq!(got, vec!["REVOKE SELECT ON `db_a`.* FROM 'app'@'%'".to_string()]);
}

#[test]
fn postgresqlの削除は片付けを前に付ける() {
    let u = user("app", "");
    let got = build(pg(), &UserChange::Drop { user: u.clone(), cleanup: true }).unwrap();
    assert_eq!(got.len(), 3);
    assert!(got[0].starts_with("REASSIGN OWNED"));
    assert!(got[2].starts_with("DROP ROLE"));

    let got = build(pg(), &UserChange::Drop { user: u.clone(), cleanup: false }).unwrap();
    assert_eq!(got.len(), 1);

    // MySQLには片付けの手順が無いので、指定しても増えない
    let got = build(my(), &UserChange::Drop { user: user("app", "%"), cleanup: true }).unwrap();
    assert_eq!(got.len(), 1);
}

#[test]
fn 作るときは相手がいない() {
    assert!(UserChange::Create { spec: newuser("app") }.target().is_none());
    let u = user("app", "%");
    let c = UserChange::Rename { user: u.clone(), name: "app2".into() };
    assert_eq!(c.target().unwrap().name, "app");
}
