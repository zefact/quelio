//! DBのユーザー (PostgreSQL ではロール) と、その権限の読み出し。
//!
//! 読むだけで、作成・変更・削除はしない。
//! 権限が足りない接続でも落ちずに「見えるぶんだけ」返す。
//!
//! MySQL と PostgreSQL で置き場所がまったく違うため、
//! 画面から見た形 (`DbUser` / `DbGrant`) にここで揃える:
//!
//! - MySQL は `mysql.user` と `information_schema` の4つの権限ビュー。
//!   ユーザーは「名前 + 接続元ホスト」の2つ組で1人になる
//! - PostgreSQL は `pg_roles` と、対象ごとのアクセス権 (acl) を
//!   `aclexplode()` でほどいたもの。ユーザーとグループの区別は無く
//!   「ログインできるロール」がユーザーに当たる

use super::{db_error, LogCtx, QUERY_TIMEOUT};
use crate::apperr::AppError;
use serde::Serialize;
use sqlx::mysql::MySqlConnection;
use sqlx::postgres::PgConnection;
use sqlx::Row;
use tokio::time::timeout;

/// ユーザー1人 (PostgreSQL ではロール1つ)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbUser {
    /// 名前
    pub name: String,
    /// 接続元ホスト (MySQL のみ。PostgreSQL では空)
    pub host: String,
    /// 権限を引くときの呼び名 (MySQL は `'名前'@'ホスト'`、PostgreSQL は名前)
    pub key: String,
    /// ログインできるか (できないものはグループ用のロール)
    pub can_login: bool,
    /// 何でもできる管理者か
    pub superuser: bool,
    /// サーバーが用意したもの (消したり変えたりしてはいけない)
    pub system: bool,
    /// 今この画面がつないでいるユーザーか
    pub is_self: bool,
    /// 画面に出す短い印 (「ユーザー作成可」「停止中」など)
    pub badges: Vec<String>,
    /// 所属しているロール
    pub member_of: Vec<String>,
    /// 同時接続の上限 (無制限なら空)
    pub conn_limit: String,
    /// 有効期限 (無ければ空)
    pub expires: String,
    /// 認証の方式 (MySQL の plugin。PostgreSQL では空)
    pub auth: String,
}

/// 権限1つ
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbGrant {
    /// 効く範囲 (server / database / schema / table / column / default)
    pub scope: String,
    /// 対象の名前 (`*.*` や `db.表.列` など)
    pub target: String,
    /// 権限の名前 (SELECT など)
    pub privilege: String,
    /// 他人に渡せるか
    pub grantable: bool,
}

/// 一覧の取得結果 (画面に出す断り書きも一緒に返す)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbUsersInfo {
    pub users: Vec<DbUser>,
    /// 今つないでいるユーザーの呼び名
    pub current: String,
    /// 一覧を全部は見られなかったとき、その理由 (見えたときは空)
    pub note: String,
    /// この接続でユーザーを作ったり変えたりできるか
    pub can_manage: bool,
    /// できないとき、その理由 (できるときは空)
    pub manage_note: String,
}

/// 範囲ごとに選べる権限の名前 (画面の選択肢を作るのに使う)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeChoices {
    pub server: Vec<String>,
    pub database: Vec<String>,
    pub schema: Vec<String>,
    pub table: Vec<String>,
}

/// `mysql.user` から読みたい列。無い版もあるので、あるものだけを使う
const MYSQL_WANT: &[&str] = &[
    "plugin",
    "password_expired",
    "account_locked",
    "is_role",
    "max_user_connections",
    "default_role",
    "Super_priv",
    "Create_user_priv",
    "Grant_priv",
];

/**
 * `mysql.user` を引くSQLを、その版にある列だけで組み立てる。
 *
 * MariaDB には `account_locked` が無く、MySQL には `is_role` が無い、
 * というように版で列が違う。無い列を書くとエラーで一覧ごと出せなくなるので、
 * 先に列の一覧を聞いてから、あるものだけを選ぶ
 */
fn mysql_user_sql(cols: &[String]) -> String {
    let mut sql = String::from("SELECT `User`, `Host`");
    for want in MYSQL_WANT {
        if cols.iter().any(|c| c.eq_ignore_ascii_case(want)) {
            sql.push_str(&format!(", `{want}`"));
        }
    }
    sql.push_str(" FROM mysql.user ORDER BY `User`, `Host`");
    sql
}

/// 行にその列があれば文字列で取り出す (無い列は空文字)
fn cell(row: &sqlx::mysql::MySqlRow, name: &str) -> String {
    row.try_get::<String, _>(name)
        .or_else(|_| row.try_get::<Option<String>, _>(name).map(|v| v.unwrap_or_default()))
        .unwrap_or_default()
}

/// MySQL の `Y`/`N` 列を真偽に直す
fn yes(v: &str) -> bool {
    v.eq_ignore_ascii_case("Y") || v == "1"
}

/// MySQL: サーバーが用意していて触ってはいけないユーザーか
fn mysql_system_user(name: &str) -> bool {
    matches!(
        name,
        "mysql.sys" | "mysql.session" | "mysql.infoschema" | "mariadb.sys" | ""
    )
}

/// PostgreSQL: サーバーが用意しているロールか (`pg_` で始まるもの)
fn pg_system_role(name: &str) -> bool {
    name.starts_with("pg_")
}

/// MySQL の権限を引くときの呼び名 `'名前'@'ホスト'` を作る
fn mysql_key(name: &str, host: &str) -> String {
    format!("'{}'@'{}'", name.replace('\'', "''"), host.replace('\'', "''"))
}

/// MySQL: ユーザーとロールの一覧
pub async fn mysql_users(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Result<DbUsersInfo, AppError> {
    let sql = "SELECT CURRENT_USER() AS me";
    ctx.log(sql);
    let current: String = timeout(QUERY_TIMEOUT, sqlx::query_scalar(sql).fetch_one(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    // CURRENT_USER() は 名前@ホスト の形なので、権限の呼び名に合わせる。
    // 名前のほうに @ が入ることがあるので、後ろから切る
    let (me_name, me_host) = match current.rsplit_once('@') {
        Some((u, h)) => (u.to_string(), h.to_string()),
        None => (current.clone(), "%".to_string()),
    };
    let current = mysql_key(&me_name, &me_host);

    let sql = "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
               WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user'";
    ctx.log(sql);
    let cols: Vec<String> = timeout(QUERY_TIMEOUT, sqlx::query_scalar(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let sql = mysql_user_sql(&cols);
    ctx.log(&sql);
    let rows = timeout(
        QUERY_TIMEOUT,
        // 組み立てているのは列名だけで、外から来た値は入らない
        sqlx::query(sqlx::AssertSqlSafe(sql.clone())).fetch_all(&mut *conn),
    )
    .await;
    let rows = match rows {
        Err(_) => return Err(AppError::timeout("クエリ")),
        // 権限が足りないと mysql.user を読めない。そのときは自分のぶんだけ返す
        Ok(Err(_)) => {
            return Ok(DbUsersInfo {
                users: vec![DbUser {
                    name: me_name,
                    host: me_host,
                    key: current.clone(),
                    can_login: true,
                    superuser: false,
                    system: false,
                    is_self: true,
                    badges: Vec::new(),
                    member_of: Vec::new(),
                    conn_limit: String::new(),
                    expires: String::new(),
                    auth: String::new(),
                }],
                current,
                note: "mysql.user を読む権限が無いため、この接続のユーザーだけを出しています"
                    .into(),
                can_manage: false,
                manage_note: "この接続にはユーザーを作る権限 (CREATE USER) がありません".into(),
            })
        }
        Ok(Ok(rows)) => rows,
    };

    let mapping = mysql_role_map(conn, ctx).await;
    let mut users = Vec::new();
    for r in &rows {
        let name: String = r.try_get("User").unwrap_or_default();
        let host: String = r.try_get("Host").unwrap_or_default();
        let key = mysql_key(&name, &host);
        let is_role = yes(&cell(r, "is_role"));
        let superuser = yes(&cell(r, "Super_priv"));
        let locked = yes(&cell(r, "account_locked"));
        let expired = yes(&cell(r, "password_expired"));

        let mut badges = Vec::new();
        if is_role {
            badges.push("ロール".into());
        }
        if superuser {
            badges.push("管理者".into());
        }
        if yes(&cell(r, "Create_user_priv")) {
            badges.push("ユーザー作成可".into());
        }
        if yes(&cell(r, "Grant_priv")) {
            badges.push("権限付与可".into());
        }
        if locked {
            badges.push("停止中".into());
        }
        if expired {
            badges.push("パスワード期限切れ".into());
        }

        let limit = cell(r, "max_user_connections");
        users.push(DbUser {
            member_of: mapping
                .iter()
                .filter(|(u, h, _)| u == &name && h == &host)
                .map(|(_, _, role)| role.clone())
                .collect(),
            can_login: !is_role,
            superuser,
            system: mysql_system_user(&name),
            is_self: key == current,
            badges,
            conn_limit: if limit.is_empty() || limit == "0" {
                String::new()
            } else {
                limit
            },
            expires: String::new(),
            auth: cell(r, "plugin"),
            name,
            host,
            key,
        });
    }
    // ログインできるものを先に、そのあと名前順
    users.sort_by(|a, b| {
        b.can_login
            .cmp(&a.can_login)
            .then(a.name.cmp(&b.name))
            .then(a.host.cmp(&b.host))
    });
    let (can_manage, manage_note) = mysql_can_manage(conn, ctx, &current).await;
    Ok(DbUsersInfo {
        users,
        current,
        note: String::new(),
        can_manage,
        manage_note,
    })
}

/**
 * MySQL: この接続でユーザーを作れるか。
 *
 * できないのに作る画面を出すと、押してから断られることになる。
 * 先に確かめて、押せない理由をそのまま画面に出す
 */
async fn mysql_can_manage(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
    current: &str,
) -> (bool, String) {
    let sql = "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES \
               WHERE GRANTEE = ? AND PRIVILEGE_TYPE = 'CREATE USER'";
    ctx.log(&super::fill_binds(sql, &[current], false));
    let got = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, i64>(sql).bind(current).fetch_one(&mut *conn),
    )
    .await;
    match got {
        Ok(Ok(n)) if n > 0 => (true, String::new()),
        Ok(Ok(_)) => (
            false,
            "この接続にはユーザーを作る権限 (CREATE USER) がありません".into(),
        ),
        _ => (
            false,
            "この接続で何ができるかを確かめられませんでした".into(),
        ),
    }
}

/**
 * MySQL: 誰がどのロールに入っているか。
 *
 * 置き場所が MariaDB (`roles_mapping`) と MySQL 8 (`role_edges`) で違い、
 * どちらも無い版もある。読めなければ「所属なし」として静かに諦める
 */
async fn mysql_role_map(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
) -> Vec<(String, String, String)> {
    let sql = "SELECT `User`, `Host`, `Role` FROM mysql.roles_mapping";
    ctx.log(sql);
    if let Ok(Ok(rows)) = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn)).await {
        return rows
            .iter()
            .map(|r| {
                (
                    r.try_get("User").unwrap_or_default(),
                    r.try_get("Host").unwrap_or_default(),
                    r.try_get("Role").unwrap_or_default(),
                )
            })
            .collect();
    }
    let sql = "SELECT TO_USER AS `User`, TO_HOST AS `Host`, FROM_USER AS `Role` \
               FROM mysql.role_edges";
    ctx.log(sql);
    if let Ok(Ok(rows)) = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn)).await {
        return rows
            .iter()
            .map(|r| {
                (
                    r.try_get("User").unwrap_or_default(),
                    r.try_get("Host").unwrap_or_default(),
                    r.try_get("Role").unwrap_or_default(),
                )
            })
            .collect();
    }
    Vec::new()
}

/**
 * MySQL: 1人ぶんの権限。
 *
 * `SHOW GRANTS` はパスワードのハッシュまで返してしまうので使わず、
 * `information_schema` の4つのビューから読む。
 * このビューは見る人の権限に応じて中身が絞られるので、
 * 権限が足りなくてもエラーにはならない
 */
pub async fn mysql_grants(
    conn: &mut MySqlConnection,
    ctx: &LogCtx<'_>,
    key: &str,
) -> Result<Vec<DbGrant>, AppError> {
    let sql = "\
SELECT 'server' AS scope, '*.*' AS target, PRIVILEGE_TYPE AS priv, IS_GRANTABLE AS grantable
  FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?
UNION ALL
SELECT 'database', TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE
  FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ?
UNION ALL
SELECT 'table', CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), PRIVILEGE_TYPE, IS_GRANTABLE
  FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ?
UNION ALL
SELECT 'column', CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME), PRIVILEGE_TYPE, IS_GRANTABLE
  FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ?
ORDER BY 1, 2, 3";
    ctx.log(&super::fill_binds(sql, &[key, key, key, key], false));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql)
            .bind(key)
            .bind(key)
            .bind(key)
            .bind(key)
            .fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    Ok(rows
        .iter()
        .map(|r| DbGrant {
            scope: r.try_get("scope").unwrap_or_default(),
            target: r.try_get("target").unwrap_or_default(),
            privilege: r.try_get("priv").unwrap_or_default(),
            grantable: yes(&r
                .try_get::<String, _>("grantable")
                .unwrap_or_default()),
        })
        .collect())
}

/// PostgreSQL: ロールの一覧
pub async fn pg_users(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<DbUsersInfo, AppError> {
    let sql = "\
SELECT r.rolname,
       r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
       r.rolreplication, r.rolbypassrls, r.rolinherit, r.rolconnlimit,
       COALESCE(to_char(r.rolvaliduntil, 'YYYY-MM-DD HH24:MI'), '') AS valid_until,
       COALESCE((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
                   FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = r.oid), '') AS member_of,
       (r.rolname = current_user) AS is_self
  FROM pg_roles r
 ORDER BY r.rolcanlogin DESC, r.rolname";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;

    let mut current = String::new();
    let users = rows
        .iter()
        .map(|r| {
            let name: String = r.try_get("rolname").unwrap_or_default();
            let is_self: bool = r.try_get("is_self").unwrap_or(false);
            if is_self {
                current = name.clone();
            }
            let superuser: bool = r.try_get("rolsuper").unwrap_or(false);
            let can_login: bool = r.try_get("rolcanlogin").unwrap_or(false);
            let limit: i32 = r.try_get("rolconnlimit").unwrap_or(-1);

            let mut badges = Vec::new();
            if !can_login {
                badges.push("ロール".into());
            }
            if superuser {
                badges.push("管理者".into());
            }
            if r.try_get::<bool, _>("rolcreaterole").unwrap_or(false) {
                badges.push("ロール作成可".into());
            }
            if r.try_get::<bool, _>("rolcreatedb").unwrap_or(false) {
                badges.push("DB作成可".into());
            }
            if r.try_get::<bool, _>("rolreplication").unwrap_or(false) {
                badges.push("レプリケーション".into());
            }
            if r.try_get::<bool, _>("rolbypassrls").unwrap_or(false) {
                badges.push("行レベル制限を無視".into());
            }
            if !r.try_get::<bool, _>("rolinherit").unwrap_or(true) {
                badges.push("権限を継承しない".into());
            }

            let member_of: String = r.try_get("member_of").unwrap_or_default();
            DbUser {
                key: name.clone(),
                can_login,
                superuser,
                system: pg_system_role(&name),
                is_self,
                badges,
                member_of: member_of
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                conn_limit: if limit < 0 {
                    String::new()
                } else {
                    limit.to_string()
                },
                expires: r.try_get("valid_until").unwrap_or_default(),
                auth: String::new(),
                host: String::new(),
                name,
            }
        })
        .collect();
    let (can_manage, manage_note) = pg_can_manage(conn, ctx).await;
    Ok(DbUsersInfo {
        users,
        current,
        note: String::new(),
        can_manage,
        manage_note,
    })
}

/// PostgreSQL: この接続でロールを作れるか
async fn pg_can_manage(conn: &mut PgConnection, ctx: &LogCtx<'_>) -> (bool, String) {
    let sql = "SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user";
    ctx.log(sql);
    let got = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, bool>(sql).fetch_one(&mut *conn),
    )
    .await;
    match got {
        Ok(Ok(true)) => (true, String::new()),
        Ok(Ok(false)) => (
            false,
            "この接続にはロールを作る権限 (CREATEROLE) がありません".into(),
        ),
        _ => (
            false,
            "この接続で何ができるかを確かめられませんでした".into(),
        ),
    }
}

/**
 * PostgreSQL: 1ロールぶんの権限。
 *
 * データベースとロールはサーバー全体で1つだが、
 * スキーマ・テーブル・列は「今つないでいるデータベース」の中にしかない。
 * ほかのデータベースのぶんは、そちらへつなぎ直さないと見えない
 */
pub async fn pg_grants(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
    name: &str,
) -> Result<Vec<DbGrant>, AppError> {
    let sql = "\
SELECT 'database' AS scope, d.datname AS target, a.privilege_type AS priv, a.is_grantable AS grantable
  FROM pg_database d, aclexplode(d.datacl) a JOIN pg_roles r ON r.oid = a.grantee
 WHERE r.rolname = $1
UNION ALL
SELECT 'schema', n.nspname, a.privilege_type, a.is_grantable
  FROM pg_namespace n, aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid = a.grantee
 WHERE r.rolname = $1
UNION ALL
SELECT 'table', c.relnamespace::regnamespace || '.' || c.relname, a.privilege_type, a.is_grantable
  FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
 WHERE r.rolname = $1 AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
UNION ALL
SELECT 'column', c.relnamespace::regnamespace || '.' || c.relname || '.' || at.attname,
       a.privilege_type, a.is_grantable
  FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid,
       aclexplode(at.attacl) a JOIN pg_roles r ON r.oid = a.grantee
 WHERE r.rolname = $1
UNION ALL
SELECT 'default', COALESCE(d.defaclnamespace::regnamespace::text, '(すべて)'),
       a.privilege_type, a.is_grantable
  FROM pg_default_acl d, aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid = a.grantee
 WHERE r.rolname = $1
 ORDER BY 1, 2, 3";
    ctx.log(&super::fill_binds(sql, &[name], true));
    let rows = timeout(
        QUERY_TIMEOUT,
        sqlx::query(sql).bind(name).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    Ok(rows
        .iter()
        .map(|r| DbGrant {
            scope: r.try_get("scope").unwrap_or_default(),
            target: r.try_get("target").unwrap_or_default(),
            privilege: r.try_get("priv").unwrap_or_default(),
            grantable: r.try_get("grantable").unwrap_or(false),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ある列だけを選ぶ() {
        // MariaDB 10.11 相当 (account_locked が無い)
        let sql = mysql_user_sql(&cols(&[
            "User",
            "Host",
            "plugin",
            "is_role",
            "Super_priv",
        ]));
        assert!(sql.contains("`is_role`"));
        assert!(sql.contains("`Super_priv`"));
        assert!(!sql.contains("account_locked"));
    }

    #[test]
    fn 列が1つも無くても名前は選ぶ() {
        let sql = mysql_user_sql(&[]);
        assert_eq!(
            sql,
            "SELECT `User`, `Host` FROM mysql.user ORDER BY `User`, `Host`"
        );
    }

    #[test]
    fn 大文字小文字は同じ列として扱う() {
        let sql = mysql_user_sql(&cols(&["SUPER_PRIV"]));
        assert!(sql.contains("`Super_priv`"));
    }

    #[test]
    fn 呼び名は引用符を重ねて逃がす() {
        assert_eq!(mysql_key("a'b", "%"), "'a''b'@'%'");
        assert_eq!(mysql_key("u", "localhost"), "'u'@'localhost'");
    }

    #[test]
    fn サーバーが用意したものは印を付ける() {
        assert!(mysql_system_user("mariadb.sys"));
        assert!(!mysql_system_user("root"));
        assert!(pg_system_role("pg_read_all_data"));
        assert!(!pg_system_role("postgres"));
    }

    #[test]
    fn 有無の列は文字でも数字でも読める() {
        assert!(yes("Y"));
        assert!(yes("y"));
        assert!(yes("1"));
        assert!(!yes("N"));
        assert!(!yes(""));
    }
}
