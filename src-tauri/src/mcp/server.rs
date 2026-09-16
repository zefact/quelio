//! AIへ公開するツールの定義。
//!
//! ツールの中身は、既存の処理を呼ぶだけの薄い包みにする
//! (DB周りをここで作り直さない。安全装置を通る道が二重になってしまうため)。
//! 実際の処理は `catalog.rs` / `query.rs` にあり、ここは
//! 「引数を受けて・接続を用意して・呼ぶ」だけに留める。
//!
//! `description` はAIが読むものなので英語で書く。画面に出る文言ではない

use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    model::{Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::Deserialize;
use tauri::AppHandle;

use super::views::{
    ai_connections, AiConnections, AiDatabases, AiRows, AiSearchResult, AiTableDetail, AiTables,
};
use super::{catalog, query, session};

/// 接続名だけを受けるツールの入力
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
}

/// 接続名とデータベース名を受ける入力
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DatabaseArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database name. For PostgreSQL this is the database, not the schema;
    /// qualify tables as schema.table instead.
    /// Omit to use the connection's default database. Ignored for SQLite.
    pub database: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database to use. Omit to use the connection's default database.
    pub database: Option<String>,
    /// Table or view name. PostgreSQL may be qualified as "schema.table".
    pub table: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database to search in. Omit to use the connection's default database.
    pub database: Option<String>,
    /// Substring to look for in table names, column names and comments.
    pub keyword: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database to run against. Omit to use the connection's default database.
    pub database: Option<String>,
    /// A single read-only SQL statement.
    pub sql: String,
    /// Maximum rows to return (default 200, capped at 1000).
    pub max_rows: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExplainArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database to run against. Omit to use the connection's default database.
    pub database: Option<String>,
    /// A single read-only SQL statement to explain.
    pub sql: String,
}

/// AIからの呼び出しを受ける本体。
///
/// 1リクエストごとに複製されるので、持つのはハンドルだけにしておく
#[derive(Clone)]
pub struct QuelioMcp {
    app: AppHandle,
}

impl QuelioMcp {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

}

/// 接続を用意して処理を行い、結果をAIへ返す形にする。
///
/// 「繋がっていない」だけなら1度だけ張り直す (`with_session`)。
/// エラーは本文をそのまま返す。原因が読めないと、AIは同じ失敗を繰り返す
async fn on<T, F, Fut>(app: &AppHandle, name: &str, run: F) -> Result<Json<T>, McpError>
where
    F: Fn(session::Opened) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    session::with_session(app, name, run)
        .await
        .map(Json)
        .map_err(|e| McpError::invalid_params(e, None))
}

#[tool_router]
impl QuelioMcp {
    #[tool(
        description = "List the database connections that the user has explicitly shared with AI. \
Returns only the connection name, database type, environment label and access level \
(\"read\" = read-only, \"write\" = writes need the user's approval in Quelio). \
Credentials, hosts and SSH settings are never exposed. \
Use the returned name to address a connection in the other tools."
    )]
    async fn list_connections(&self) -> Result<Json<AiConnections>, McpError> {
        // 復号しない読み込みを使う。
        // 一覧に要るのは名前・種別・環境・公開レベルだけで、
        // そのためにパスワードを平文でメモリへ載せる理由が無い
        let store = crate::storage::load_without_secrets(&self.app).map_err(|e| {
            // 設定ファイルが読めない等。AIが原因を読めるよう本文をそのまま返す
            McpError::internal_error(e, None)
        })?;
        Ok(Json(AiConnections {
            connections: ai_connections(&store),
        }))
    }

    #[tool(
        description = "List the databases available on a connection. \
Returns an empty list for SQLite, which is a single file. \
Call this before list_tables when you do not know which database to use."
    )]
    async fn list_databases(
        &self,
        Parameters(arg): Parameters<ConnectionArg>,
    ) -> Result<Json<AiDatabases>, McpError> {
        on(&self.app, &arg.connection, |o| async move {
            catalog::list_databases(&self.app, &o).await
        })
        .await
    }

    #[tool(
        description = "List tables and views in a database, with their estimated row counts. \
Use describe_table afterwards to get columns and the Japanese label of a specific table."
    )]
    async fn list_tables(
        &self,
        Parameters(arg): Parameters<DatabaseArg>,
    ) -> Result<Json<AiTables>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let db = arg.database.clone();
            async move { catalog::list_tables(&self.app, &o, db).await }
        })
        .await
    }

    #[tool(
        description = "Describe one table: columns (type, nullability, default, Japanese label \
taken from the column comment), primary key, indexes and foreign keys. \
Prefer this over running SHOW CREATE TABLE or querying information_schema yourself."
    )]
    async fn describe_table(
        &self,
        Parameters(arg): Parameters<TableArg>,
    ) -> Result<Json<AiTableDetail>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, table) = (arg.database.clone(), arg.table.clone());
            async move { catalog::describe_table(&self.app, &o, db, &table).await }
        })
        .await
    }

    #[tool(
        description = "Find tables and columns whose name or comment contains a keyword. \
Useful when the user names something in Japanese and you need the physical name. \
At most 100 hits are returned; truncated is true when there were more."
    )]
    async fn search_schema(
        &self,
        Parameters(arg): Parameters<SearchArg>,
    ) -> Result<Json<AiSearchResult>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, keyword) = (arg.database.clone(), arg.keyword.clone());
            async move { catalog::search_schema(&self.app, &o, db, &keyword).await }
        })
        .await
    }

    #[tool(
        description = "Run a single SQL statement and return up to max_rows rows \
(default 200, max 1000). Read-only statements run immediately. \
A statement that writes is refused outright on a \"read\" connection; on a \"write\" connection \
it pauses while Quelio asks the user to approve it, and is refused if the user declines or does \
not answer within two minutes — so a write call may take a while to return. \
Transaction control and session settings are always refused. \
Bind parameters are not supported; write literal values into the SQL. \
truncated is true when more rows exist than were returned; rowsAffected is set for writes."
    )]
    async fn run_query(
        &self,
        Parameters(arg): Parameters<QueryArg>,
    ) -> Result<Json<AiRows>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, sql) = (arg.database.clone(), arg.sql.clone());
            async move { query::run(&self.app, &o, db, &sql, arg.max_rows).await }
        })
        .await
    }

    #[tool(
        description = "Show the execution plan for a single read-only SQL statement \
(EXPLAIN on MySQL/PostgreSQL, EXPLAIN QUERY PLAN on SQLite). \
The statement itself is not executed. Writes are rejected."
    )]
    async fn explain(
        &self,
        Parameters(arg): Parameters<ExplainArg>,
    ) -> Result<Json<AiRows>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, sql) = (arg.database.clone(), arg.sql.clone());
            async move { query::explain(&self.app, &o, db, &sql).await }
        })
        .await
    }
}

#[tool_handler]
impl ServerHandler for QuelioMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "Quelio is the user's desktop database client. It executes statements on the \
user's behalf using connections the user has configured and explicitly shared. \
You never see credentials or host names: address a connection by its name. \
Connections not shared by the user are invisible and cannot be reached. \
Only read-only statements are allowed; every statement is recorded in Quelio's SQL console."
                    .to_string(),
            )
    }
}
