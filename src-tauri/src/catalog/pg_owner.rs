//! PostgreSQL: データベースの所有者と、所有者に選べるロール

use super::{db_error, LogCtx, QUERY_TIMEOUT};
use crate::apperr::AppError;
use serde::Serialize;
use sqlx::postgres::PgConnection;
use sqlx::Row;
use tokio::time::timeout;

/// データベース1つと、その所有者
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOwner {
    pub name: String,
    pub owner: String,
}

/// データベースの所有者の一覧と、所有者に選べるロール
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOwners {
    /// データベースごとの所有者 (データベースの一覧と同じものを同じ並びで)
    pub databases: Vec<DatabaseOwner>,
    /**
     * 所有者に選べるロール。
     *
     * 別のロールを所有者にできるのは、そのロールに属しているとき
     * (スーパーユーザーはすべて)。選んでも断られるものは最初から出さない
     */
    pub roles: Vec<String>,
    /// 今つないでいるロール (所有者を指定せずに作ると、これが所有者になる)
    pub me: String,
}

/// PostgreSQL: データベースの所有者と、所有者に選べるロール
pub async fn pg_database_owners(
    conn: &mut PgConnection,
    ctx: &LogCtx<'_>,
) -> Result<DatabaseOwners, AppError> {
    // 並びと絞り込みはデータベースの一覧 (pg_databases) と同じにする
    let sql = "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database \
             WHERE datistemplate = false AND datallowconn \
             ORDER BY datname";
    ctx.log(sql);
    let rows = timeout(QUERY_TIMEOUT, sqlx::query(sql).fetch_all(&mut *conn))
        .await
        .map_err(|_| AppError::timeout("クエリ"))?
        .map_err(db_error)?;
    let databases = rows
        .iter()
        .map(|r| {
            Ok(DatabaseOwner {
                name: r.try_get("datname").map_err(db_error)?,
                owner: r.try_get("owner").map_err(db_error)?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    // pg_ で始まるのはサーバーが用意した役割 (pg_monitor など) なので出さない
    let sql = "SELECT rolname FROM pg_roles \
             WHERE rolname !~ '^pg_' AND pg_has_role(current_user, oid, 'MEMBER') \
             ORDER BY rolname";
    ctx.log(sql);
    let roles = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_all(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    let sql = "SELECT current_user::text";
    ctx.log(sql);
    let me = timeout(
        QUERY_TIMEOUT,
        sqlx::query_scalar::<_, String>(sql).fetch_one(&mut *conn),
    )
    .await
    .map_err(|_| AppError::timeout("クエリ"))?
    .map_err(db_error)?;

    Ok(DatabaseOwners {
        databases,
        roles,
        me,
    })
}
