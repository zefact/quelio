//! ユーザー (PostgreSQL ではロール) の作成・変更・削除と、権限の付け外しのSQL。
//!
//! `dbadmin.rs` と同じく、ここは文字列を組み立てるだけで接続は持たない。
//! 実行は `sessions/users.rs` が行う。
//!
//! 気をつけていること:
//!
//! - MySQL のユーザーは `` `名前` `` ではなく `'名前'@'ホスト'` の**文字列**で書く。
//!   識別子のクォートが使えないので、文字列リテラルとして逃がす
//! - 権限の名前はクォートできない (`GRANT "SELECT"` とは書けない) ので、
//!   決め打ちの一覧に無いものは受け取らない
//! - サーバーが用意したユーザーと、今つないでいる自分自身は変えさせない

use serde::{Deserialize, Serialize};

use crate::ddl::{literal, quote, SqlStyle};
use crate::models::DbType;

/// 名前の長さの上限 (MySQL 32文字 / PostgreSQL 63バイト)
const MYSQL_NAME_MAX: usize = 32;
const PG_NAME_MAX: usize = 63;

/// サーバーが用意していて、触ってはいけないユーザー
const SYSTEM_USERS: &[&str] = &[
    "mysql.sys",
    "mysql.session",
    "mysql.infoschema",
    "mariadb.sys",
    "postgres",
];

/// 権限が効く範囲
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// サーバー全体 (`*.*` / ロールの属性)
    Server,
    /// データベース1つ
    Database,
    /// スキーマ1つ (PostgreSQL のみ)
    Schema,
    /// テーブル1つ
    Table,
}

/// ユーザーの指定 (MySQL は接続元ホストまで含めて1人)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRef {
    pub name: String,
    /// 接続元ホスト (MySQL のみ。PostgreSQL では空)
    #[serde(default)]
    pub host: String,
}

/// 新しく作るユーザーの中身
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUser {
    pub name: String,
    #[serde(default)]
    pub host: String,
    /// パスワード (空ならパスワード無しで作る)
    #[serde(default)]
    pub password: String,
    /// ログインできるようにするか (PostgreSQL のみ。false ならグループ用のロール)
    #[serde(default)]
    pub can_login: bool,
    /// ロールを作れるようにするか (PostgreSQL のみ)
    #[serde(default)]
    pub create_role: bool,
    /// データベースを作れるようにするか (PostgreSQL のみ)
    #[serde(default)]
    pub create_db: bool,
    /// 同時接続の上限 (0 や空なら決めない)
    #[serde(default)]
    pub conn_limit: String,
    /// 有効期限 (`2027-01-01` のような形。空なら決めない)
    #[serde(default)]
    pub expires: String,
}

/// 権限を1つ付ける / 外すときの指定
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSpec {
    pub scope: Scope,
    /// 対象 (`db` / `db.表` / `スキーマ` など。サーバー全体なら空)
    #[serde(default)]
    pub target: String,
    /// 付ける権限の名前 (`SELECT` など)
    pub privileges: Vec<String>,
    /// 他人へ渡せるようにするか
    #[serde(default)]
    pub grantable: bool,
}

/**
 * ユーザーに対する変更1つぶん。
 *
 * 「実行せずにSQLだけ見る」と「実行する」で同じ形を使う。
 * 2つに分けて書くと、確認で見せたSQLと実際に流すSQLがずれかねない
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UserChange {
    /// 作る
    Create { spec: NewUser },
    /// パスワードを変える
    Password { user: UserRef, password: String },
    /// 名前を変える
    Rename { user: UserRef, name: String },
    /// 入れないようにする / 戻す
    Lock { user: UserRef, locked: bool },
    /// 消す (cleanup: PostgreSQLで先に権限と持ち物を片付けるか)
    Drop { user: UserRef, cleanup: bool },
    /// 権限を付ける / 外す
    Grant {
        user: UserRef,
        spec: GrantSpec,
        add: bool,
    },
    /// ロールに入れる / 外す
    Role {
        user: UserRef,
        role: String,
        add: bool,
    },
}

impl UserChange {
    /// 変える相手 (新しく作るときは相手がいない)
    pub fn target(&self) -> Option<&UserRef> {
        match self {
            UserChange::Create { .. } => None,
            UserChange::Password { user, .. }
            | UserChange::Rename { user, .. }
            | UserChange::Lock { user, .. }
            | UserChange::Drop { user, .. }
            | UserChange::Grant { user, .. }
            | UserChange::Role { user, .. } => Some(user),
        }
    }
}

/// 変更を、実際に流すSQLの並びにする
pub fn build(style: SqlStyle, change: &UserChange) -> Result<Vec<String>, String> {
    Ok(match change {
        UserChange::Create { spec } => create_user_sql(style, spec)?,
        UserChange::Password { user, password } => {
            vec![set_password_sql(style, user, password)?]
        }
        UserChange::Rename { user, name } => vec![rename_user_sql(style, user, name)?],
        UserChange::Lock { user, locked } => vec![set_lock_sql(style, user, *locked)],
        UserChange::Drop { user, cleanup } => {
            let mut sql = Vec::new();
            if *cleanup && style.db == DbType::Postgresql {
                sql.extend(pg_cleanup_sql(style, user));
            }
            sql.push(drop_user_sql(style, user)?);
            sql
        }
        UserChange::Grant { user, spec, add } => {
            if *add {
                vec![grant_sql(style, user, spec)?]
            } else {
                revoke_sql(style, user, spec)?
            }
        }
        UserChange::Role { user, role, add } => {
            vec![role_sql(style, user, role, *add)?]
        }
    })
}

// ---------- 名前の決まり ----------

/// 名前として使えるかを確かめる
pub fn check_name(db: DbType, name: &str) -> Result<(), String> {
    let max = if db == DbType::Postgresql {
        PG_NAME_MAX
    } else {
        MYSQL_NAME_MAX
    };
    check_text(name, "名前", max)
}

/// 接続元ホストとして使えるかを確かめる (MySQL のみ)
pub fn check_host(host: &str) -> Result<(), String> {
    check_text(host, "接続元", 255)
}

/// 共通の決まり (空でない・前後に空白が無い・制御文字が無い・長すぎない)
fn check_text(v: &str, what: &str, max: usize) -> Result<(), String> {
    if v.is_empty() {
        return Err(format!("{what}を入力してください"));
    }
    if v != v.trim() {
        return Err(format!("{what}の前後に空白は使えません"));
    }
    if v.chars().any(|c| c.is_control()) {
        return Err(format!("{what}に使えない文字が含まれています"));
    }
    let len = if max == PG_NAME_MAX {
        v.len()
    } else {
        v.chars().count()
    };
    if len > max {
        return Err(format!("{what}が長すぎます (最大{max})"));
    }
    Ok(())
}

/// パスワードとして使えるかを確かめる
pub fn check_password(password: &str) -> Result<(), String> {
    if password.chars().any(|c| c.is_control()) {
        return Err("パスワードに改行やタブは使えません".into());
    }
    Ok(())
}

/// サーバーが用意したユーザーか (消したり変えたりしてはいけない)
pub fn is_system_user(name: &str) -> bool {
    SYSTEM_USERS.contains(&name)
}

/**
 * 変えてよい相手かを確かめる。
 *
 * サーバーが用意したものと、今つないでいる自分自身は断る。
 * 自分の権限を削ったり自分を消したりすると、
 * 直す手立てまで一緒に失うことがある
 */
pub fn check_target(user: &UserRef, current_key: &str, db: DbType) -> Result<(), String> {
    if is_system_user(&user.name) {
        return Err(format!(
            "「{}」はサーバーが用意したユーザーなので変更できません",
            user.name
        ));
    }
    if user_key(db, user) == current_key {
        return Err(
            "今つないでいるユーザー自身は変更できません (別のユーザーで接続し直してください)"
                .into(),
        );
    }
    Ok(())
}

/// 権限の一覧などで使う呼び名 (MySQL は `'名前'@'ホスト'`)
pub fn user_key(db: DbType, user: &UserRef) -> String {
    if db == DbType::Mysql {
        format!(
            "'{}'@'{}'",
            user.name.replace('\'', "''"),
            user.host.replace('\'', "''")
        )
    } else {
        user.name.clone()
    }
}

// ---------- SQLの中でのユーザーの書き方 ----------

/// SQLに書くユーザーの指定
fn user_sql(style: SqlStyle, user: &UserRef) -> String {
    if style.db == DbType::Mysql {
        format!(
            "{}@{}",
            literal(style, &user.name),
            literal(style, &user.host)
        )
    } else {
        quote(style.db, &user.name)
    }
}

// ---------- 権限の名前 ----------

/// MySQL: サーバー全体に付けられる権限
const MYSQL_SERVER: &[&str] = &[
    "ALL PRIVILEGES",
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "INDEX",
    "CREATE VIEW",
    "SHOW VIEW",
    "CREATE ROUTINE",
    "ALTER ROUTINE",
    "EXECUTE",
    "TRIGGER",
    "EVENT",
    "CREATE TEMPORARY TABLES",
    "LOCK TABLES",
    "REFERENCES",
    "RELOAD",
    "PROCESS",
    "SHOW DATABASES",
    "REPLICATION CLIENT",
    "REPLICATION SLAVE",
    "CREATE USER",
];

/// MySQL: データベース1つに付けられる権限
const MYSQL_DATABASE: &[&str] = &[
    "ALL PRIVILEGES",
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "INDEX",
    "CREATE VIEW",
    "SHOW VIEW",
    "CREATE ROUTINE",
    "ALTER ROUTINE",
    "EXECUTE",
    "TRIGGER",
    "EVENT",
    "CREATE TEMPORARY TABLES",
    "LOCK TABLES",
    "REFERENCES",
];

/// MySQL: テーブル1つに付けられる権限
const MYSQL_TABLE: &[&str] = &[
    "ALL PRIVILEGES",
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "INDEX",
    "CREATE VIEW",
    "SHOW VIEW",
    "TRIGGER",
    "REFERENCES",
];

/// PostgreSQL: データベース1つに付けられる権限
const PG_DATABASE: &[&str] = &["ALL PRIVILEGES", "CONNECT", "CREATE", "TEMPORARY"];

/// PostgreSQL: スキーマ1つに付けられる権限
const PG_SCHEMA: &[&str] = &["ALL PRIVILEGES", "USAGE", "CREATE"];

/// PostgreSQL: テーブル1つに付けられる権限
const PG_TABLE: &[&str] = &[
    "ALL PRIVILEGES",
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
];

/**
 * その範囲に付けられる権限の一覧。
 *
 * 画面の選択肢もここから作るので、
 * 「画面に出したのに付けられない」ということが起きない
 */
pub fn privileges(db: DbType, scope: Scope) -> &'static [&'static str] {
    match (db, scope) {
        (DbType::Mysql, Scope::Server) => MYSQL_SERVER,
        (DbType::Mysql, Scope::Database) => MYSQL_DATABASE,
        (DbType::Mysql, Scope::Table) => MYSQL_TABLE,
        // MySQL にスキーマという段はない (データベースがそれに当たる)
        (DbType::Mysql, Scope::Schema) => &[],
        // PostgreSQL のサーバー全体はロールの属性で決めるので、ここでは扱わない
        (DbType::Postgresql, Scope::Server) => &[],
        (DbType::Postgresql, Scope::Database) => PG_DATABASE,
        (DbType::Postgresql, Scope::Schema) => PG_SCHEMA,
        (DbType::Postgresql, Scope::Table) => PG_TABLE,
        _ => &[],
    }
}

/// 受け取った権限の名前を、決め打ちの一覧と突き合わせて正しい形に直す
fn check_privileges(db: DbType, scope: Scope, want: &[String]) -> Result<Vec<String>, String> {
    if want.is_empty() {
        return Err("権限を1つ以上選んでください".into());
    }
    let allowed = privileges(db, scope);
    let mut out = Vec::new();
    for w in want {
        let hit = allowed
            .iter()
            .find(|a| a.eq_ignore_ascii_case(w.trim()))
            .ok_or_else(|| format!("「{w}」はこの範囲では扱えない権限です"))?;
        if !out.contains(&hit.to_string()) {
            out.push(hit.to_string());
        }
    }
    Ok(out)
}

/// 権限の名前として通してよい形か。
///
/// 英字で始まり、英字・下線・区切りの空白1つだけでできているもの。
/// SQLに書ける字しか通さないので、名前をそのまま並べても安全
fn looks_like_privilege(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let mut space = false;
    for c in name.chars() {
        if c == ' ' {
            // 空白が続くもの・終わりが空白のものは通さない
            if space {
                return false;
            }
            space = true;
            continue;
        }
        if !(c.is_ascii_alphabetic() || c == '_') {
            return false;
        }
        space = false;
    }
    !space
}

/// 外すときの権限の確かめ。
///
/// 付けるときと違い、決め打ちの一覧に無い名前も通す。
/// MySQL 8 の動的権限 (`APPLICATION_PASSWORD_ADMIN` など) は一覧に載らないが、
/// 実際に付いていることがあり、一覧で弾くと外せなくなるため。
/// 代わりに名前の形だけを確かめる
fn check_revoke_privileges(
    db: DbType,
    scope: Scope,
    want: &[String],
) -> Result<Vec<String>, String> {
    if want.is_empty() {
        return Err("権限を1つ以上選んでください".into());
    }
    let allowed = privileges(db, scope);
    let mut out: Vec<String> = Vec::new();
    for w in want {
        let t = w.trim();
        let name = match allowed.iter().find(|a| a.eq_ignore_ascii_case(t)) {
            Some(a) => a.to_string(),
            None if looks_like_privilege(t) => t.to_ascii_uppercase(),
            None => return Err(format!("「{w}」は権限の名前として扱えません")),
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    Ok(out)
}

// ---------- 対象の書き方 ----------

/// 権限の対象をSQLの形にする
fn target_sql(db: DbType, scope: Scope, target: &str) -> Result<String, String> {
    match scope {
        Scope::Server => Ok(if db == DbType::Mysql {
            "*.*".to_string()
        } else {
            return Err("PostgreSQLではサーバー全体の権限を扱えません".into());
        }),
        Scope::Database => {
            check_text(target, "データベース名", PG_NAME_MAX)?;
            Ok(if db == DbType::Mysql {
                format!("{}.*", quote(db, target))
            } else {
                format!("DATABASE {}", quote(db, target))
            })
        }
        Scope::Schema => {
            check_text(target, "スキーマ名", PG_NAME_MAX)?;
            Ok(format!("SCHEMA {}", quote(db, target)))
        }
        Scope::Table => {
            let (schema, table) = split_target(target)?;
            Ok(if db == DbType::Mysql {
                format!("{}.{}", quote(db, &schema), quote(db, &table))
            } else {
                format!("TABLE {}.{}", quote(db, &schema), quote(db, &table))
            })
        }
    }
}

/// `スキーマ.テーブル` を2つに分ける
fn split_target(target: &str) -> Result<(String, String), String> {
    let (schema, table) = target
        .split_once('.')
        .ok_or_else(|| "テーブルは「スキーマ.テーブル」の形で指定してください".to_string())?;
    check_text(schema, "スキーマ名", PG_NAME_MAX)?;
    check_text(table, "テーブル名", PG_NAME_MAX)?;
    Ok((schema.to_string(), table.to_string()))
}

// ---------- ここから組み立て ----------

/// ユーザーを作る
pub fn create_user_sql(style: SqlStyle, spec: &NewUser) -> Result<Vec<String>, String> {
    let db = style.db;
    check_name(db, &spec.name)?;
    if is_system_user(&spec.name) {
        return Err(format!("「{}」はサーバーが使う名前です", spec.name));
    }
    check_password(&spec.password)?;
    let user = UserRef {
        name: spec.name.clone(),
        host: if db == DbType::Mysql && spec.host.is_empty() {
            "%".to_string()
        } else {
            spec.host.clone()
        },
    };
    if db == DbType::Mysql {
        check_host(&user.host)?;
    }
    let who = user_sql(style, &user);

    let mut sql = if db == DbType::Mysql {
        format!("CREATE USER {who}")
    } else {
        format!("CREATE ROLE {who}")
    };

    if db == DbType::Mysql {
        if !spec.password.is_empty() {
            sql.push_str(&format!(" IDENTIFIED BY {}", literal(style, &spec.password)));
        }
        if let Some(n) = number(&spec.conn_limit, "同時接続の上限")? {
            sql.push_str(&format!(" WITH MAX_USER_CONNECTIONS {n}"));
        }
    } else {
        sql.push_str(if spec.can_login { " LOGIN" } else { " NOLOGIN" });
        if spec.create_role {
            sql.push_str(" CREATEROLE");
        }
        if spec.create_db {
            sql.push_str(" CREATEDB");
        }
        if !spec.password.is_empty() {
            sql.push_str(&format!(" PASSWORD {}", literal(style, &spec.password)));
        }
        if let Some(n) = number(&spec.conn_limit, "同時接続の上限")? {
            sql.push_str(&format!(" CONNECTION LIMIT {n}"));
        }
        if !spec.expires.is_empty() {
            check_date(&spec.expires)?;
            sql.push_str(&format!(" VALID UNTIL {}", literal(style, &spec.expires)));
        }
    }
    Ok(vec![sql])
}

/// パスワードを変える
pub fn set_password_sql(
    style: SqlStyle,
    user: &UserRef,
    password: &str,
) -> Result<String, String> {
    check_password(password)?;
    let who = user_sql(style, user);
    Ok(if style.db == DbType::Mysql {
        format!("ALTER USER {who} IDENTIFIED BY {}", literal(style, password))
    } else {
        format!("ALTER ROLE {who} PASSWORD {}", literal(style, password))
    })
}

/// 名前を変える
pub fn rename_user_sql(style: SqlStyle, user: &UserRef, name: &str) -> Result<String, String> {
    check_name(style.db, name)?;
    if is_system_user(name) {
        return Err(format!("「{name}」はサーバーが使う名前です"));
    }
    let who = user_sql(style, user);
    Ok(if style.db == DbType::Mysql {
        let to = UserRef {
            name: name.to_string(),
            host: user.host.clone(),
        };
        format!("RENAME USER {who} TO {}", user_sql(style, &to))
    } else {
        format!("ALTER ROLE {who} RENAME TO {}", quote(style.db, name))
    })
}

/**
 * 入れないようにする / 入れるように戻す。
 *
 * MySQL は錠を掛ける仕組みがあり、PostgreSQL は
 * 「ログインできる」という属性を外して同じことをする
 */
pub fn set_lock_sql(style: SqlStyle, user: &UserRef, locked: bool) -> String {
    let who = user_sql(style, user);
    if style.db == DbType::Mysql {
        let what = if locked { "LOCK" } else { "UNLOCK" };
        format!("ALTER USER {who} ACCOUNT {what}")
    } else {
        let what = if locked { "NOLOGIN" } else { "LOGIN" };
        format!("ALTER ROLE {who} {what}")
    }
}

/// ユーザーを消す
pub fn drop_user_sql(style: SqlStyle, user: &UserRef) -> Result<String, String> {
    if is_system_user(&user.name) {
        return Err(format!(
            "「{}」はサーバーが用意したユーザーなので削除できません",
            user.name
        ));
    }
    let who = user_sql(style, user);
    Ok(if style.db == DbType::Mysql {
        format!("DROP USER {who}")
    } else {
        format!("DROP ROLE {who}")
    })
}

/**
 * PostgreSQL で消す前の後片付け。
 *
 * 権限や持ち物が1つでも残っていると `DROP ROLE` は断られる。
 * しかもこの2つは「今つないでいるデータベース」にしか効かないので、
 * ほかのデータベースのぶんは、そちらへつなぎ直して同じことをする必要がある
 */
pub fn pg_cleanup_sql(style: SqlStyle, user: &UserRef) -> Vec<String> {
    let who = user_sql(style, user);
    vec![
        format!("REASSIGN OWNED BY {who} TO CURRENT_USER"),
        format!("DROP OWNED BY {who}"),
    ]
}

/// 権限を付ける
pub fn grant_sql(style: SqlStyle, user: &UserRef, spec: &GrantSpec) -> Result<String, String> {
    let db = style.db;
    let privs = check_privileges(db, spec.scope, &spec.privileges)?;
    let target = target_sql(db, spec.scope, &spec.target)?;
    let mut sql = format!(
        "GRANT {} ON {} TO {}",
        privs.join(", "),
        target,
        user_sql(style, user)
    );
    if spec.grantable {
        sql.push_str(" WITH GRANT OPTION");
    }
    Ok(sql)
}

/// 権限を外す
pub fn revoke_sql(
    style: SqlStyle,
    user: &UserRef,
    spec: &GrantSpec,
) -> Result<Vec<String>, String> {
    let db = style.db;
    let mut privs = check_revoke_privileges(db, spec.scope, &spec.privileges)?;
    /*
     * MySQL の USAGE は「権限が無い」という印で、外しても何も起きない。
     * 並べても紛らわしいだけなので落とす
     * (PostgreSQL の USAGE は本物の権限なので、そのまま残す)
     */
    if db == DbType::Mysql {
        privs.retain(|p| p != "USAGE");
    }
    if privs.is_empty() && !spec.grantable {
        return Err("外せる権限がありません".into());
    }
    let target = target_sql(db, spec.scope, &spec.target)?;
    let who = user_sql(style, user);
    let mut out = Vec::new();
    if !privs.is_empty() {
        out.push(format!("REVOKE {} ON {} FROM {}", privs.join(", "), target, who));
    }
    /*
     * MySQL は、権限を全部外しても「他人に渡せる」印だけが残る。
     * 残ったままだと USAGE だけの行になって外す手立てが無くなるので、
     * ここで一緒に外す
     * (PostgreSQL は権限ごと外れるので要らない)
     */
    if spec.grantable && db == DbType::Mysql {
        out.push(format!("REVOKE GRANT OPTION ON {target} FROM {who}"));
    }
    Ok(out)
}

/// ロールに入れる / ロールから外す
pub fn role_sql(
    style: SqlStyle,
    user: &UserRef,
    role: &str,
    add: bool,
) -> Result<String, String> {
    check_name(style.db, role)?;
    let who = user_sql(style, user);
    let role_sql = if style.db == DbType::Mysql {
        /*
         * ロールは名前だけで書く。
         *
         * 一覧では `'名前'@''` の形で出てくるが、
         * 付け外しのSQLで接続元まで書くと構文エラーになる
         */
        literal(style, role)
    } else {
        quote(style.db, role)
    };
    Ok(if add {
        format!("GRANT {role_sql} TO {who}")
    } else {
        format!("REVOKE {role_sql} FROM {who}")
    })
}

// ---------- 小さな確かめ ----------

/// 数だけを受け取る (空なら None)
fn number(v: &str, what: &str) -> Result<Option<u32>, String> {
    let v = v.trim();
    if v.is_empty() || v == "0" {
        return Ok(None);
    }
    v.parse::<u32>()
        .map(Some)
        .map_err(|_| format!("{what}は数で入力してください"))
}

/// 日付の形だけを確かめる (`2027-01-01`)
fn check_date(v: &str) -> Result<(), String> {
    let ok = v.len() == 10
        && v.as_bytes()[4] == b'-'
        && v.as_bytes()[7] == b'-'
        && v
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if ok {
        Ok(())
    } else {
        Err("有効期限は 2027-01-01 の形で入力してください".into())
    }
}

#[cfg(test)]
mod tests;
