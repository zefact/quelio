//! SQLが何をする文かの判定。
//!
//! 読み取り専用か・行ロックを取るか・トランザクションを開くか・
//! 取り返しのつかない操作か。
//! どれも「文字列とコメントを伏せた形」を見て決める

use super::*;

/// 取り返しのつかない可能性があるSQL (実行前に確認を出す対象)
// PartialEq / Eq は、判定の結果を比べて試せるようにするため
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DangerousStatement {
    /// 種類の説明 (画面にそのまま出す)
    pub kind: String,
    /// 対象のSQL (長い場合は先頭のみ)
    pub sql: String,
    /// 定義を変えるだけで、データが消えるわけではない種類か
    /// (ALTER / RENAME)。設定で確認を省ける対象になる
    pub definition_change: bool,
    /// 本番環境で、データを変える文として拾ったか。
    /// 確認ダイアログの見出しを「本番環境で更新を実行します」に変えるのに使う
    pub prod_update: bool,
}

/// 文字列リテラルとコメントを空白に置き換える。
/// キーワード探索が、値やコメントの中身に引きずられないようにするため。
///
/// 分割 (`split_sql`) と同じ走査結果を使うので、
/// 「文の切れ目」と「キーワードの見え方」が食い違うことはない
pub(super) fn strip_literals(d: Dialect, sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    for tok in &lex(d, sql).toks {
        out.push_str(&tok.masked);
    }
    out
}

/// 1文を1回だけ走査した結果。
///
/// 判定はどれも「文字列とコメントを伏せて大文字にそろえた形」を見るだけなのに、
/// これまでは判定を呼ぶたびに同じ文をもう一度走査していた。
/// 長いSQLでは、その回数ぶんそのまま待ち時間になる。
/// 1文につき一度だけ作って使い回す
pub struct Analyzed {
    /// 文字列・コメントを伏せ、大文字にそろえたSQL
    body: String,
    /// 先頭キーワード (大文字)
    head: String,
    /// 引用符で囲んだ識別子の名前 (大文字)。
    /// 伏せた本文からは見えないので、関数名の検出のために別に持つ
    idents: Vec<String>,
    /// 1つの文の中に `;` で区切られた文が入っているとき、その1つずつ。
    ///
    /// `DELIMITER //` で区切りを変えると、`SELECT 1; DROP TABLE t //` は
    /// 字句の上では1文になる。けれどサーバーは複数の文として順に実行するので、
    /// 先頭の SELECT だけで「読み取り」と決めると DROP を見落とす。
    /// 入っていなければ空
    parts: Vec<Part>,
}

/// 1つの文の中に入っていた文 (`Analyzed::parts`)
pub struct Part {
    /// その文のSQL
    pub sql: String,
    /// その文を見た結果
    pub a: Analyzed,
}

impl Analyzed {
    pub fn new(d: Dialect, sql: &str) -> Self {
        let (masked, idents) = masked_idents(d, sql);
        let head = head_keyword(&masked);
        let parts = if masked.contains(';') {
            inner_parts(d, sql)
        } else {
            Vec::new()
        };
        Self {
            body: masked.to_ascii_uppercase(),
            head,
            idents,
            parts,
        }
    }

    /// 1つの文の中に、`;` で区切られた文が2つ以上入っているか
    /// (`DELIMITER` で区切りを変えたときにだけ起きる)
    pub fn has_inner_statements(&self) -> bool {
        !self.parts.is_empty()
    }

    /// 中に入っている文 (無ければ空)
    pub fn parts(&self) -> &[Part] {
        &self.parts
    }

    /// ストアド・トリガー・イベントの本体 (`BEGIN … END`) を定義する文か。
    ///
    /// この形の中の `;` は本体の区切りで、定義する時点では実行されない。
    /// それ以外で `;` が入っていれば、サーバーは別々の文として実行する
    pub fn defines_routine_body(&self) -> bool {
        let Some(first) = self.parts.first() else {
            return false;
        };
        let body = first.a.body();
        let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
        match first.a.head() {
            "CREATE" | "ALTER" => {
                contains_word(body, "BEGIN")
                    && ["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]
                        .iter()
                        .any(|w| contains_word(body, w))
            }
            // MariaDBの無名ブロック
            "BEGIN" => contains_phrase(&flat, "BEGIN NOT ATOMIC"),
            _ => false,
        }
    }

    /// 先頭キーワード (大文字)
    pub fn head(&self) -> &str {
        &self.head
    }

    /// 文字列・コメントを伏せ、大文字にそろえたSQL
    pub(super) fn body(&self) -> &str {
        &self.body
    }

    /// データを変えないSQLかどうか (読み取り専用の接続で許可する範囲)
    pub fn is_read_only(&self) -> bool {
        // 中に複数の文があれば、どれも読み取りのときだけ読み取り
        if !self.parts.is_empty() {
            return self.parts.iter().all(|p| p.a.is_read_only());
        }
        match self.head.as_str() {
            /*
             * SELECT ... INTO は新しいテーブル・ファイルを作るので除く。
             * MySQLは `(SELECT … INTO OUTFILE …)` と括弧の中にも書けるので、
             * 括弧の外に限らず探す (INTO は予約語なので、名前と取り違えることはない)。
             * 行ロックを取る指定 (FOR UPDATE 等) と、
             * 副作用のある関数 (setval・pg_terminate_backend 等) も読み取り専用では認めない
             */
            "SELECT" | "TABLE" | "VALUES" => {
                !contains_word(&self.body, "INTO")
                    && !self.takes_row_lock()
                    && !self.calls_side_effect_function()
            }
            "SHOW" | "DESCRIBE" | "DESC" => true,
            // PRAGMA は設定にも使えるため、参照だけの決まったものに限る
            "PRAGMA" => is_read_only_pragma(&self.body),
            // WITH / EXPLAIN は中身にデータ変更が無いことを確かめる
            // (SELECT ... INTO でテーブルやファイルを作れる点も同じく見る)
            "WITH" | "EXPLAIN" => {
                !self.contains_write_keyword()
                    && !contains_word(&self.body, "INTO")
                    && !self.takes_row_lock()
                    && !self.calls_side_effect_function()
            }
            _ => false,
        }
    }

    /// 行ロックを取るか (引用符で囲んだロック関数の名前も見る)
    fn takes_row_lock(&self) -> bool {
        takes_row_lock(&self.body) || self.idents.iter().any(|n| is_lock_function(n))
    }

    /// 副作用のある関数を呼んでいるか。
    ///
    /// `SELECT setval(…)` や `SELECT pg_terminate_backend(…)` は SELECT の形でも
    /// データやサーバーの状態を変える。引用符で囲んだ名前
    /// (`"setval"(…)`) も、何の名前か読めない `U&"…"` も同じ扱いにする
    fn calls_side_effect_function(&self) -> bool {
        let flat = self.body.split_whitespace().collect::<Vec<_>>().join(" ");
        calls_function(&flat, is_side_effect_function)
            // MariaDBのシーケンスは関数の形でなくても進められる
            || contains_phrase(&flat, "NEXT VALUE FOR")
            || self
                .idents
                .iter()
                .any(|n| n == super::lexer::OPAQUE_IDENT || is_side_effect_function(n))
    }

    /// 読み取り専用で断る理由が「行ロック」かどうか。
    ///
    /// UPDATE の副問い合わせに FOR UPDATE がある場合など、
    /// そもそも参照系でないSQLに「データは変わりませんが」と説明しないよう、
    /// 参照系の先頭キーワードに限る
    pub fn locks_rows(&self) -> bool {
        if !self.parts.is_empty() {
            return self.parts.iter().any(|p| p.a.locks_rows());
        }
        matches!(
            self.head.as_str(),
            "SELECT" | "TABLE" | "VALUES" | "WITH" | "EXPLAIN"
        ) && self.takes_row_lock()
    }

    /// EXPLAIN ANALYZE を付けても安全なSQLかどうか
    pub fn is_analyzable(&self) -> bool {
        if !self.parts.is_empty() {
            return self.parts.iter().all(|p| p.a.is_analyzable());
        }
        match self.head.as_str() {
            // SELECT ... INTO は新しいテーブル・ファイルを作るので参照系ではない。
            // 副作用のある関数も、ANALYZE で実際に実行されてしまう
            "SELECT" | "TABLE" | "VALUES" => {
                !contains_word(&self.body, "INTO") && !self.calls_side_effect_function()
            }
            // WITH は本体がDML (WITH x AS (...) DELETE ...) の場合があるため中身を見る
            "WITH" => {
                !self.contains_write_keyword()
                    && !contains_word(&self.body, "INTO")
                    && !self.calls_side_effect_function()
            }
            _ => false,
        }
    }

    /// SQLの読み方 (方言) が変わりうる文か
    pub fn changes_dialect(&self) -> bool {
        if matches!(self.head.as_str(), "SET" | "RESET" | "DISCARD") {
            return true;
        }
        if self.parts.iter().any(|p| p.a.changes_dialect()) {
            return true;
        }
        // PostgreSQLの set_config(...) は SELECT の形でセッション設定を変える。
        // 名前を引用符で囲んだ "set_config"(...) も同じ
        contains_word(&self.body, "SET_CONFIG")
            || self
                .idents
                .iter()
                .any(|n| n == "SET_CONFIG" || n == super::lexer::OPAQUE_IDENT)
    }

    /// トランザクションの開始・終了そのものかどうか
    pub fn txn_effect(&self, db: DbType) -> Option<bool> {
        let flat = self.body.split_whitespace().collect::<Vec<_>>().join(" ");
        match self.head.as_str() {
            "BEGIN" => Some(true),
            // START REPLICA / START SLAVE などはトランザクションと無関係
            "START" if contains_phrase(&flat, "TRANSACTION") => Some(true),
            // COMMIT AND CHAIN / ROLLBACK AND CHAIN は続けて新しいトランザクションを開く
            "COMMIT" | "END" | "ROLLBACK" if contains_phrase(&flat, "AND CHAIN") => Some(true),
            // ROLLBACK TO SAVEPOINT はトランザクションを終わらせない
            "ROLLBACK" if contains_phrase(&flat, "TO") => None,
            "COMMIT" | "END" | "ROLLBACK" => Some(false),
            // SQLiteは、トランザクションの外の SAVEPOINT がトランザクションを開始する
            // (MySQL・PostgreSQLでは開始しないので対象外)
            "SAVEPOINT" if db == DbType::Sqlite => Some(true),
            // MySQLの autocommit=0 は、以降のすべての文を暗黙のトランザクションにする
            "SET" if db == DbType::Mysql && contains_word(&flat, "AUTOCOMMIT") => {
                Some(!autocommit_on(&flat))
            }
            // MySQLはDDLなどで暗黙コミットする (開いていたトランザクションは終わる)
            _ if db == DbType::Mysql && MYSQL_IMPLICIT_COMMIT.contains(&self.head.as_str()) => {
                Some(false)
            }
            _ => None,
        }
    }

    /// データを変更するキーワードを含むか (単語として一致するもののみ)。
    /// 文字列やコメントの中の "delete" などには反応しない (伏せた形を見るため)
    fn contains_write_keyword(&self) -> bool {
        const WRITE: [&str; 10] = [
            "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT",
            "CALL",
        ];
        WRITE.iter().any(|kw| contains_word(&self.body, kw))
    }
}

/// キーワード探索用に整えたSQLと、引用符で囲んだ識別子の名前。
///
/// 先頭キーワードは整えた後の文字列から取る (`head_keyword`)。
/// MySQLの `/*! … */` は中身が実行されるのでコメントとして飛ばしてはいけないが、
/// 整えた後の文字列から取れば、方言ごとの違いを1か所で吸収できる
fn masked_idents(d: Dialect, sql: &str) -> (String, Vec<String>) {
    let lexed = lex(d, sql);
    let mut masked = String::with_capacity(sql.len());
    let mut idents = Vec::new();
    for tok in lexed.toks {
        masked.push_str(&tok.masked);
        if let Some(name) = tok.ident {
            idents.push(name);
        }
    }
    (masked, idents)
}

/// 1つの文の中に `;` で区切られた文が2つ以上あれば、その1つずつを返す。
///
/// `DELIMITER` を読まない方言で分け直す (サーバーが文を区切るのと同じ見方)。
/// 1つしか無ければ空を返す
fn inner_parts(d: Dialect, sql: &str) -> Vec<Part> {
    let plain = Dialect {
        delimiter_command: false,
        ..d
    };
    let split = split_sql(plain, sql);
    if split.stmts.len() < 2 {
        return Vec::new();
    }
    split
        .stmts
        .into_iter()
        .map(|sql| Part {
            a: Analyzed::new(plain, &sql),
            sql,
        })
        .collect()
}

/// 括弧の外側 (深さ0) に、単語として word が現れるか。
/// サブクエリの中のWHEREを本体のWHEREと取り違えないために使う
fn has_top_level_word(body: &str, word: &str) -> bool {
    let mut depth = 0i32;
    for (i, c) in body.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth == 0 && body[i..].starts_with(word) => {
                let before = body[..i].chars().next_back();
                let after = body[i + word.len()..].chars().next();
                let is_ident = |c: char| c.is_alphanumeric() || c == '_';
                if !before.is_some_and(is_ident) && !after.is_some_and(is_ident) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// WHERE の条件が「常に真」になっていないか。
///
/// `WHERE 1=1` や `WHERE TRUE` は、書き方こそ違うが全行が対象になる。
/// とくにパラメータで条件を渡す使い方 (`WHERE :cond`) では、
/// 値に `1=1` を入れて全行を書き換えてしまう事故が起きやすい。
///
/// 見るのは「文字列とコメントを伏せた、大文字化済みの本文」。
/// 判定できない書き方は素通しにする (確認が出ないだけで、今までと同じ)
fn where_is_tautology(body: &str) -> bool {
    let Some(cond) = top_level_where_condition(body) else {
        return false;
    };
    // 空白を落として形だけを見る
    let c: String = cond.chars().filter(|ch| !ch.is_whitespace()).collect();
    if c == "TRUE" || c == "1" {
        return true;
    }
    // 1=1 や ID=ID のように、同じものを比べているだけの条件
    let mut parts = c.split('=');
    let (Some(left), Some(right), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let word = |t: &str| {
        !t.is_empty()
            && t.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
    };
    word(left) && left == right
}

/// 括弧の外にある WHERE 以降の条件部分を返す。
///
/// UPDATE / DELETE の WHERE は基本的に文の最後だが、
/// PostgreSQLの RETURNING などが続くこともあるので、そこで切る
fn top_level_where_condition(body: &str) -> Option<&str> {
    let mut depth = 0i32;
    let mut start = None;
    for (i, c) in body.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth == 0 && start.is_none() && body[i..].starts_with("WHERE") => {
                let before = body[..i].chars().next_back();
                let is_ident = |c: char| c.is_alphanumeric() || c == '_';
                if !before.is_some_and(is_ident) {
                    start = Some(i + "WHERE".len());
                }
            }
            _ => {}
        }
    }
    let rest = &body[start?..];
    // 条件の後ろに続く句があれば、そこまでを条件とみなす
    let end = ["RETURNING", "ORDER", "LIMIT"]
        .iter()
        .filter_map(|w| rest.find(w))
        .min()
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// 文の先頭がその語で始まるか (`DROP USER` のように2語で見分けるのに使う)
fn starts_with_word(body: &str, word: &str) -> bool {
    let head: String = body
        .trim_start()
        .chars()
        .take(word.len() + 1)
        .collect::<String>()
        .to_ascii_uppercase();
    head == word || head.starts_with(&format!("{word} ")) || head.starts_with(&format!("{word}\t"))
}

/// 確認をどこまで出すか。接続の環境と読み取り専用かどうかから決まる
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ConfirmEnv {
    /// 本番ではない: 危険なSQLだけ確認する (今までどおり)
    #[default]
    NotProd,
    /// 本番: データが変わる文はすべて確認する
    Prod,
    /// 接続の状態が読めない: 本番の可能性があるので Prod と同じ扱いにする。
    /// 出せなかった確認より、余分な確認の方が害が小さい
    Unknown,
}

impl ConfirmEnv {
    /// データを変える文をすべて確認する段階か
    pub fn confirms_updates(self) -> bool {
        !matches!(self, ConfirmEnv::NotProd)
    }

    /// 更新として拾ったときに出す説明
    fn update_kind(self, head: &str) -> Option<String> {
        match self {
            ConfirmEnv::NotProd => None,
            ConfirmEnv::Prod => Some(format!("{head} (本番環境への更新)")),
            ConfirmEnv::Unknown => Some(format!(
                "{head} (接続の状態を確かめられませんでした。本番環境の可能性があるため確認します)"
            )),
        }
    }
}

/// トランザクションの区切りか、セッションの設定か。
///
/// データも定義も変えないので、本番でも確認を挟まない。
/// ここで止めると、BEGIN や SET を書くたびにダイアログが出て、
/// 肝心の UPDATE の確認まで「いつも出るもの」として流されてしまう。
///
/// ただし `SET` と `START` は、語が同じでも中身が別物になる
/// (`SET GLOBAL …` はサーバー全体の設定を変え、`START REPLICA` は複製を動かす)。
/// 何を変えない書き方かを並べ、それ以外は更新として扱う
fn changes_nothing(a: &Analyzed) -> bool {
    let body = a.body();
    match a.head() {
        "BEGIN" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "END" | "USE" | "LOCK"
        | "UNLOCK" => true,
        // トランザクションの開始だけ。START REPLICA / START SLAVE は対象外。
        // 空白の数で結果が変わらないよう、txn_effect と同じ見方にそろえる
        "START" => {
            let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
            contains_phrase(&flat, "TRANSACTION")
        }
        "SET" => is_session_set(body),
        _ => false,
    }
}

/// そのセッションの読み書きの作法を変えるだけの `SET` か。
///
/// 変数への代入 (`SET @x = 1`) と、接続ごとの設定を並べる。
/// `SET PASSWORD` / `SET GLOBAL …` / `SET PERSIST …` はここに入らないので、
/// 本番では確認の対象になる
fn is_session_set(body: &str) -> bool {
    let rest = body.trim_start().trim_start_matches("SET").trim_start();
    /*
     * 変数への代入。
     *
     * ユーザー変数 (`SET @x = 1`) と、範囲を書かない・セッションに限る形だけを
     * 外す。範囲を `@@GLOBAL` / `@@PERSIST` / `@@PERSIST_ONLY` で書いたものは
     * サーバー全体 (と再起動後) に効くので、本番では確認の対象にする
     */
    if rest.starts_with('@') {
        let upper = rest.to_ascii_uppercase();
        let Some(scope) = upper.strip_prefix("@@") else {
            // ユーザー変数 (@x)
            return true;
        };
        let name: String = scope
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        return !matches!(name.as_str(), "GLOBAL" | "PERSIST" | "PERSIST_ONLY");
    }
    const SESSION_SETTINGS: [&str; 8] = [
        "AUTOCOMMIT",
        "TRANSACTION",
        "SESSION",
        "LOCAL",
        "NAMES",
        "SEARCH_PATH",
        "SQL_MODE",
        "TIME_ZONE",
    ];
    let word: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_ascii_uppercase();
    SESSION_SETTINGS.contains(&word.as_str())
}

/// 実行前に一段止めたい文かどうか (本番・状態不明のとき)。
///
/// 本番では「危険なSQL」でなくても、データが変わる文はすべて確認する。
/// `UPDATE … WHERE id = 1` は本来なら安全な書き方だが、
/// つなぎ先が本番だと気づかないまま流すのがいちばん多い事故なので、
/// 一度手を止めてもらう。
///
/// 読み取り (SELECT・EXPLAIN・定義の参照) は止めない
pub fn needs_update_confirm(env: ConfirmEnv, a: &Analyzed) -> bool {
    if !env.confirms_updates() {
        return false;
    }
    if a.is_read_only() {
        return false;
    }
    !changes_nothing(a)
}

/// 実行前に確認したいSQLを抜き出す。
/// 消えると戻せないもの (DROP/TRUNCATE) と、
/// 対象を絞っていない一括更新・一括削除 (WHERE の無い UPDATE/DELETE) が対象
pub fn dangerous_statements(d: Dialect, sql: &str) -> Vec<DangerousStatement> {
    statements_to_confirm(d, sql, ConfirmEnv::NotProd)
}

/// 実行前に確認したいSQLを抜き出す (環境も見る)。
///
/// 本番 (と状態が読めないとき) は、危険なSQLに加えて
/// データが変わる文すべてを確認の対象にする。
/// 文の分割は一度で済ませたいので、どちらの判定もここでまとめて行う
pub fn statements_to_confirm(
    d: Dialect,
    sql: &str,
    env: ConfirmEnv,
) -> Vec<DangerousStatement> {
    let mut found = Vec::new();
    let split = split_sql(d, sql);
    // どこまでが1文か分からないと、危険なSQLも見落としうる。
    // 黙って通さず、確認ダイアログに出して利用者に判断してもらう
    if let Some(reason) = &split.unterminated {
        found.push(DangerousStatement {
            kind: "SQLの区切りを判断できません (意図しない文が実行される可能性があります)"
                .to_string(),
            sql: reason.clone(),
            definition_change: false,
            prod_update: false,
        });
    }
    for stmt in split.stmts {
        let a = Analyzed::new(d, &stmt);
        /*
         * `DELIMITER` で区切りを変えた中に `;` で並べた文は、
         * サーバーが1つずつ実行するので、1つずつ確かめる。
         * ストアドなどの本体 (BEGIN … END) の中の `;` は定義するだけなので、
         * これまでどおり定義の文として見る
         */
        if a.has_inner_statements() && !a.defines_routine_body() {
            for p in a.parts() {
                found.extend(confirm_one(env, &p.sql, &p.a));
            }
        } else {
            found.extend(confirm_one(env, &stmt, &a));
        }
    }
    found
}

/// 1つの文について、確認を出すなら何として出すかを決める
fn confirm_one(env: ConfirmEnv, stmt: &str, a: &Analyzed) -> Option<DangerousStatement> {
    let (body, head) = (a.body(), a.head());
    // サブクエリの中のWHEREは対象の絞り込みにならないため、括弧の外だけを見る
    let has_where = has_top_level_word(body, "WHERE");
    let kind = match head {
        "DROP" if starts_with_word(body, "DROP USER")
            || starts_with_word(body, "DROP ROLE") =>
        {
            Some("DROP USER / DROP ROLE (ユーザーの削除)")
        }
        "DROP" => Some("DROP (テーブルやデータベースごと削除)"),
        // 誰が何をできるかが変わる。消えるわけではないので設定で確認を省ける
        "GRANT" => Some("GRANT (権限の付与)"),
        "REVOKE" => Some("REVOKE (権限の取り消し)"),
        "TRUNCATE" => Some("TRUNCATE (全行削除)"),
        // ALTER・RENAME はデータが消えるわけではないので、設定で確認を省ける
        "ALTER" => Some("ALTER (定義の変更)"),
        "RENAME" => Some("RENAME (名前の変更)"),
        "DELETE" if !has_where => Some("WHERE の無い DELETE (全行削除)"),
        "UPDATE" if !has_where => Some("WHERE の無い UPDATE (全行更新)"),
        // 条件はあるが、常に真なので全行が対象になるもの
        "DELETE" if where_is_tautology(body) => Some("条件が常に真の DELETE (全行削除)"),
        "UPDATE" if where_is_tautology(body) => Some("条件が常に真の UPDATE (全行更新)"),
        // WITH の中で更新するCTE (WITH x AS (DELETE ...) ...) も実際にデータが変わる
        "WITH" if a.contains_write_keyword() => {
            Some("データを変更する WITH (CTEの中で INSERT / UPDATE / DELETE)")
        }
        // EXPLAIN ANALYZE は対象のSQLを実際に実行する
        // EXPLAIN (ANALYZE) … のように括弧で指定する書き方もあるため、
        // ANALYZE は括弧の外に限らず探す
        "EXPLAIN" if contains_word(body, "ANALYZE") && a.contains_write_keyword() => {
            Some("EXPLAIN ANALYZE (対象のSQLが実際に実行されます)")
        }
        _ => None,
    };
    // 本番では、危険な書き方でなくてもデータが変わる文は確認する
    let prod_update = needs_update_confirm(env, a);
    let kind = kind.map(str::to_string).or_else(|| {
        // 危険なSQLではないが、更新として拾うもの
        prod_update.then(|| env.update_kind(head)).flatten()
    })?;
    // 長い文はそのまま出すと読めないので先頭だけにする
    let one_line = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
    let sql = if one_line.chars().count() > 200 {
        let head: String = one_line.chars().take(200).collect();
        format!("{head} …")
    } else {
        one_line
    };
    Some(DangerousStatement {
        kind,
        sql,
        definition_change: matches!(head, "ALTER" | "RENAME" | "GRANT" | "REVOKE"),
        prod_update,
    })
}

/// SQLがトランザクションの開始・終了そのものかどうか。
///
/// 利用者がSQLエディタに直接書いた `BEGIN` / `COMMIT` も追いかけないと、
/// 開いたままのトランザクションに気づけない。
/// `Some(true)` は開始、`Some(false)` は終了、`None` はどちらでもない。
///
/// 判断がつかないものは `None` にして「開いたまま」と思っておく (安全側)
#[cfg(test)]
pub fn txn_effect(db: DbType, d: Dialect, sql: &str) -> Option<bool> {
    Analyzed::new(d, sql).txn_effect(db)
}

/// SQLの読み方 (方言) が変わりうる文か。
///
/// `SET sql_mode = …` や `SET standard_conforming_strings = …` を実行されると、
/// 接続時に聞いた方言が古くなる。何が方言を変えるかはサーバー任せなので、
/// 設定を触る文はまとめて対象にして、実行後に聞き直す
pub fn changes_dialect(d: Dialect, sql: &str) -> bool {
    Analyzed::new(d, sql).changes_dialect()
}

/// MySQLで暗黙コミットを起こす文の先頭キーワード。
/// 開いていたトランザクションはここで終わるので、覚えている状態も落とす
const MYSQL_IMPLICIT_COMMIT: [&str; 12] = [
    "CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE", "LOCK", "UNLOCK", "FLUSH",
    "ANALYZE", "OPTIMIZE",
];

/// `SET autocommit = …` の指定がONかどうか (大文字化・詰め済みの文字列を渡す)
fn autocommit_on(flat: &str) -> bool {
    let rest = flat.split("AUTOCOMMIT").nth(1).unwrap_or("");
    let value: String = rest
        .chars()
        .skip_while(|c| *c == '=' || c.is_whitespace())
        .take_while(|c| c.is_alphanumeric())
        .collect();
    matches!(value.as_str(), "1" | "ON" | "TRUE")
}

/// 結果セットを返す種類のSQLかどうか
pub(super) fn is_fetch(sql: &str) -> bool {
    matches!(
        head_keyword(sql).as_str(),
        "SELECT"
            | "SHOW"
            | "WITH"
            | "EXPLAIN"
            | "DESCRIBE"
            | "DESC"
            | "VALUES"
            | "TABLE"
            // SQLiteのPRAGMAは結果を返すものがある
            | "PRAGMA"
    )
}

/// 単語として phrase を含むか (複数語の言い回し用)。
/// 空白の数や改行に左右されないよう、詰めた文字列を渡すこと
fn contains_phrase(flat: &str, phrase: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(at) = flat[from..].find(phrase) {
        let i = from + at;
        let before = flat[..i].chars().next_back();
        let after = flat[i + phrase.len()..].chars().next();
        if !before.is_some_and(is_ident) && !after.is_some_and(is_ident) {
            return true;
        }
        from = i + 1;
    }
    false
}

/// 行ロックを取る指定が付いているか。
///
/// `SELECT ... FOR UPDATE` はデータを変えないが、本番で長時間ロックを掴んでしまう。
/// 読み取り専用の接続では「何も起こさない」ことを約束したいので止める。
/// 副問い合わせの中でもロックは効くため、括弧の中も対象にする
fn takes_row_lock(body: &str) -> bool {
    // 空白の数・改行のばらつきを吸収する
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    [
        "FOR UPDATE",
        "FOR NO KEY UPDATE",
        "FOR SHARE",
        "FOR KEY SHARE",
        "LOCK IN SHARE MODE",
    ]
    .iter()
    .any(|p| contains_phrase(&flat, p))
        || calls_lock_function(&flat)
}

/// 明示的にロックを取る関数を呼んでいるか。
///
/// 同じ名前の列・テーブルを誤って拒否しないよう、
/// 直後が `(` の「関数呼び出しの形」だけを対象にする
fn calls_lock_function(flat: &str) -> bool {
    calls_function(flat, is_lock_function)
}

/// ロックを取る関数の名前か (大文字で渡す)。
///
/// `pg_advisory_lock_shared` や `pg_try_advisory_xact_lock` など派生が多いので
/// 前方一致で見る。ロックを解放する関数 (pg_advisory_unlock 等) は対象外
fn is_lock_function(name: &str) -> bool {
    !name.contains("UNLOCK")
        && (name == "GET_LOCK"
            || name.starts_with("PG_ADVISORY")
            || name.starts_with("PG_TRY_ADVISORY"))
}

/// SELECT の形のままデータやサーバーの状態を変える関数の名前か (大文字で渡す)。
///
/// 読み取り専用のトランザクションでも止まらないもの (pg_terminate_backend など) や、
/// 更新を許した接続で「参照だから」と確認なしに通ってしまうもの (setval など) を並べる。
/// 利用者が作った関数の中身までは分からないので、ここに無い関数は読み取りとみなす
/// (AI連携では、参照も読み取り専用のトランザクションの中で実行して補う)
fn is_side_effect_function(name: &str) -> bool {
    const EXACT: [&str; 41] = [
        // シーケンス (PostgreSQL・MariaDB)
        "NEXTVAL",
        "SETVAL",
        // セッション設定 (読み取り専用の設定そのものを外せる)
        "SET_CONFIG",
        // 他の接続・サーバーへの操作
        "PG_CANCEL_BACKEND",
        "PG_TERMINATE_BACKEND",
        "PG_RELOAD_CONF",
        "PG_ROTATE_LOGFILE",
        "PG_PROMOTE",
        "PG_SWITCH_WAL",
        "PG_SWITCH_XLOG",
        "PG_LOG_BACKEND_MEMORY_CONTEXTS",
        "PG_WAL_REPLAY_PAUSE",
        "PG_WAL_REPLAY_RESUME",
        "PG_BACKUP_START",
        "PG_BACKUP_STOP",
        "PG_START_BACKUP",
        "PG_STOP_BACKUP",
        "PG_IMPORT_SYSTEM_COLLATIONS",
        "PG_REPLICATION_SLOT_ADVANCE",
        "PG_LOGICAL_SLOT_GET_CHANGES",
        "PG_LOGICAL_SLOT_GET_BINARY_CHANGES",
        "PG_LOGICAL_EMIT_MESSAGE",
        "PG_NOTIFY",
        // ラージオブジェクト (サーバーのファイルの読み書きを含む)
        "LO_IMPORT",
        "LO_EXPORT",
        "LO_UNLINK",
        "LO_CREATE",
        "LO_CREAT",
        "LO_FROM_BYTEA",
        "LO_PUT",
        "LOWRITE",
        "LO_TRUNCATE",
        "LO_TRUNCATE64",
        // 別のサーバーでSQLを実行する (dblink)
        "DBLINK",
        "DBLINK_EXEC",
        "DBLINK_CONNECT",
        "DBLINK_CONNECT_U",
        "DBLINK_SEND_QUERY",
        "DBLINK_OPEN",
        // サーバーのファイルを書く (adminpack)
        "PG_FILE_WRITE",
        // SQLiteの拡張の読み込み
        "LOAD_EXTENSION",
    ];
    const PREFIX: [&str; 6] = [
        // pg_create_restore_point / pg_create_logical_replication_slot など
        "PG_CREATE_",
        "PG_DROP_",
        "PG_COPY_",
        "PG_REPLICATION_ORIGIN_",
        "PG_STAT_RESET",
        // pg_file_rename / pg_file_unlink / pg_file_sync (adminpack)
        "PG_FILE_",
    ];
    EXACT.contains(&name) || PREFIX.iter().any(|p| name.starts_with(p))
}

/// 関数呼び出しの形 (`名前(`) で、名前が条件に合うものがあるか。
/// 詰めた・大文字化済みの文字列を渡す
fn calls_function(flat: &str, matches: fn(&str) -> bool) -> bool {
    let bytes = flat.as_bytes();
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < bytes.len() {
        // 単語の先頭でなければ次へ
        if !is_ident(bytes[i]) || (i > 0 && is_ident(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_ident(bytes[i]) {
            i += 1;
        }
        let word = &flat[start..i];
        let called = flat[i..].trim_start().starts_with('(');
        if called && matches(word) {
            return true;
        }
    }
    false
}

/// 読み取り専用で断る理由が「行ロック」かどうか
/// (画面に出す説明を変えるために使う)
#[cfg(test)]
pub fn locks_rows(d: Dialect, sql: &str) -> bool {
    Analyzed::new(d, sql).locks_rows()
}

/// データを変えないSQLかどうか (読み取り専用の接続で許可する範囲)
pub fn is_read_only(d: Dialect, sql: &str) -> bool {
    Analyzed::new(d, sql).is_read_only()
}

/// 参照だけのPRAGMAか (大文字化・リテラル除去済みの文字列を渡す)
fn is_read_only_pragma(body: &str) -> bool {
    const READ_ONLY_PRAGMAS: [&str; 12] = [
        "TABLE_INFO",
        "TABLE_XINFO",
        "TABLE_LIST",
        "INDEX_LIST",
        "INDEX_INFO",
        "INDEX_XINFO",
        "FOREIGN_KEY_LIST",
        "DATABASE_LIST",
        "COLLATION_LIST",
        "COMPILE_OPTIONS",
        "INTEGRITY_CHECK",
        "ENCODING",
    ];
    // "PRAGMA" の次の単語 (schema.name の形もあるので '.' の後ろを見る)
    let rest = body.trim_start().trim_start_matches("PRAGMA").trim_start();
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.')
        .collect();
    let name = name.rsplit('.').next().unwrap_or("").to_string();
    READ_ONLY_PRAGMAS.contains(&name.as_str())
}

/// EXPLAIN ANALYZE を付けても安全なSQLかどうか。
/// PostgreSQL・MySQLの EXPLAIN ANALYZE は対象のSQLを実際に実行するため、
/// 参照系(結果を取り出すだけ)のSQLに限って許可する
#[cfg(test)]
pub fn is_analyzable(d: Dialect, sql: &str) -> bool {
    Analyzed::new(d, sql).is_analyzable()
}

/// 大文字化済みの文字列に、単語として word が含まれるか
pub(super) fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(i, _)| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + word.len()..].chars().next();
        let is_ident = |c: char| c.is_alphanumeric() || c == '_';
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}
