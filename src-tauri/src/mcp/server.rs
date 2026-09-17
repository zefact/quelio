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
    model::{
        GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation,
        ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult,
        PaginatedRequestParams, Prompt, PromptArgument, PromptMessage, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
        Role, ServerCapabilities, ServerInfo,
    },
    schemars,
    service::{NotificationContext, RequestContext, RoleServer},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::Deserialize;
use tauri::AppHandle;

use super::rows::RowFormat;
use super::views::{
    ai_connections, AiColumnValues, AiConnections, AiDatabases, AiOpenedSheet, AiRows,
    AiSearchResult, AiTableDetail, AiTables,
};
use super::{catalog, editor, prompts, query, resources, session, values};

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
    /// How to return the rows: "json" (default), "markdown" or "csv".
    pub format: Option<RowFormat>,
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

/// 列の値の分布を求める入力
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ColumnValuesArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database to run against. Omit to use the connection's default database.
    pub database: Option<String>,
    /// Table name, optionally qualified as schema.table.
    pub table: String,
    /// Column to summarise.
    pub column: String,
    /// How many distinct values to return (default 50, capped at 200).
    pub limit: Option<usize>,
}

/// エディタへSQLを置く入力
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenInEditorArg {
    /// Connection name as returned by list_connections.
    pub connection: String,
    /// Database the statement is meant for. Only shown to the user; nothing is run.
    pub database: Option<String>,
    /// The SQL to hand to the user (up to 64KB). It is not executed.
    pub sql: String,
    /// Sheet name. Omit for an automatic one.
    pub title: Option<String>,
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
Use the returned name to address a connection in the other tools. \
Call again if a connection you expect is missing; the user may have just shared it."
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
Prefer this over running SHOW CREATE TABLE or querying information_schema yourself. \
To see which values a column actually holds, follow up with column_values. \
To take in a whole database at once, read the \
quelio://<connection>/<database>/schema resource instead \
(for SQLite <database> is main; resources/list has the ones with a default database)."
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
truncated is true when more rows exist than were returned; rowsAffected is set for writes. \
columns always lists each column's name and database type. \
format selects how the rows come back: \"json\" (default) fills rows, \
\"markdown\" and \"csv\" fill text instead. \
Use markdown or csv when you only need to read the data; \
they use far fewer tokens than json."
    )]
    async fn run_query(
        &self,
        Parameters(arg): Parameters<QueryArg>,
    ) -> Result<Json<AiRows>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, sql) = (arg.database.clone(), arg.sql.clone());
            let format = arg.format.unwrap_or_default();
            async move { query::run(&self.app, &o, db, &sql, arg.max_rows, format).await }
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

    #[tool(
        description = "Summarise what a column actually contains: its distinct values with \
row counts (most common first), plus how many rows are NULL. \
Use this before writing a WHERE clause on a code or status column, \
so you match the values that are really stored rather than guessing at spelling or case. \
values excludes NULL; nullCount is null when the list was truncated and NULL was not seen. \
May be slow on very large tables; prefer columns that look like codes or flags."
    )]
    async fn column_values(
        &self,
        Parameters(arg): Parameters<ColumnValuesArg>,
    ) -> Result<Json<AiColumnValues>, McpError> {
        on(&self.app, &arg.connection, |o| {
            let (db, table, column) =
                (arg.database.clone(), arg.table.clone(), arg.column.clone());
            async move {
                values::column_values(&self.app, &o, db, &table, &column, arg.limit).await
            }
        })
        .await
    }

    #[tool(
        description = "Put a SQL statement into a new sheet of Quelio's editor for the user \
to review and run. Nothing is executed and no database is touched. \
Prefer this over run_query when the user asked you to *write* SQL \
rather than to answer a question from the data. \
Returns the sheet name it was placed in."
    )]
    async fn open_in_editor(
        &self,
        Parameters(arg): Parameters<OpenInEditorArg>,
    ) -> Result<Json<AiOpenedSheet>, McpError> {
        // DBに触らないので、AI用セッションは張らない (`on` を通さない)
        editor::open(
            &self.app,
            &arg.connection,
            arg.database,
            &arg.sql,
            arg.title,
        )
        .map(Json)
        .map_err(|e| {
            /*
             * 名前や引数の誤りだけを invalid_params にする。
             * ウィンドウが無い・画面へ渡せないは、AIが入力を直しても
             * 解決しない (直せるのは利用者だけ)
             */
            if editor::is_user_side(&e) {
                McpError::internal_error(e, None)
            } else {
                McpError::invalid_params(e, None)
            }
        })
    }
}

#[tool_handler]
impl ServerHandler for QuelioMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                // スキーマ資料 (quelio://<接続名>/<DB名>/schema) を渡すため
                .enable_resources()
                // 公開する接続を変えたときに知らせるため
                .enable_resources_list_changed()
                // 定型のお願い (スラッシュコマンドとして出る)
                .enable_prompts()
                .build(),
        )
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "Quelio is the user's desktop database client. It runs statements on the \
user's behalf using connections the user has configured and explicitly shared. \
You never see credentials or host names: address a connection by its name. \
Connections not shared by the user are invisible and cannot be reached. \
Read-only statements run immediately. A statement that writes is refused on a \
\"read\" connection, and on a \"write\" connection it runs only after the user approves \
it in Quelio. Transaction control and session settings are always refused. \
Every statement is recorded in Quelio's SQL console, where the user can see it. \
When the user wants SQL to look at rather than an answer from the data, \
use open_in_editor so they can review and run it themselves. \
For the whole layout of a database, read the \
quelio://<connection>/<database>/schema resource instead of describing tables one by one. \
The database part is required (for SQLite it is main); resources/list gives the ones \
whose connection has a default database."
                    .to_string(),
            )
    }

    /// 繋がってきたクライアントを覚える。
    ///
    /// 公開する接続を変えたときに `resources/list_changed` を送る相手になる
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        super::remember_peer(&self.app, context.peer);
    }

    /// 公開中の接続ごとに「既定DBのスキーマ」を1つ並べる
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let list = resources::list(&self.app).map_err(|e| McpError::internal_error(e, None))?;
        Ok(ListResourcesResult::with_all_items(
            list.into_iter()
                .map(|(uri, name)| {
                    Resource::new(uri, format!("{name} のスキーマ"))
                        .with_description(format!(
                            "{name} の既定データベースのテーブル定義 (論理名つき)"
                        ))
                        .with_mime_type(resources::MIME)
                })
                .collect(),
        ))
    }

    /// 既定以外のデータベースも指せるようにする
    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new(resources::URI_TEMPLATE, "Quelio のスキーマ")
                .with_description(
                    "Table definitions of one database, as Markdown with Japanese labels.",
                )
                .with_mime_type(resources::MIME),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let text = resources::read(&self.app, &request.uri)
            .await
            .map_err(|e| {
                // URIの形が違うときだけ、AIが直せる問題として返す
                if resources::is_bad_uri(&e) {
                    McpError::invalid_params(e, None)
                } else {
                    McpError::internal_error(e, None)
                }
            })?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(
            text,
            request.uri,
        )
        .with_mime_type(resources::MIME)])
        .into())
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        Ok(ListPromptsResult::with_all_items(
            prompts::ALL
                .iter()
                .map(|spec| {
                    Prompt::new(
                        spec.name,
                        Some(spec.description),
                        Some(
                            spec.arguments
                                .iter()
                                .map(|(name, note)| {
                                    PromptArgument::new(*name)
                                        .with_description(*note)
                                        // どれも省略できない (埋めないと頼み事にならない)
                                        .with_required(true)
                                })
                                .collect(),
                        ),
                    )
                })
                .collect(),
        ))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        // 引数は素直な文字列の組にして渡す (組み立ては prompts.rs で試せるように)
        let args: Vec<(String, String)> = request
            .arguments
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| {
                let text = match v {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                };
                (k, text)
            })
            .collect();
        let body = prompts::body(&request.name, &args)
            .map_err(|e| McpError::invalid_params(e, None))?;
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, body)])
                .into(),
        )
    }
}
