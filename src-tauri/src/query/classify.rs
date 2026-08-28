//! SQLが何をする文かの判定。
//!
//! 読み取り専用か・行ロックを取るか・トランザクションを開くか・
//! 取り返しのつかない操作か。
//! どれも「文字列とコメントを伏せた形」を見て決める

use super::*;

/// 取り返しのつかない可能性があるSQL (実行前に確認を出す対象)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DangerousStatement {
    /// 種類の説明 (画面にそのまま出す)
    pub kind: String,
    /// 対象のSQL (長い場合は先頭のみ)
    pub sql: String,
    /// 定義を変えるだけで、データが消えるわけではない種類か
    /// (ALTER / RENAME)。設定で確認を省ける対象になる
    pub definition_change: bool,
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
}

impl Analyzed {
    pub fn new(d: Dialect, sql: &str) -> Self {
        let (masked, head) = masked_head(d, sql);
        Self {
            body: masked.to_ascii_uppercase(),
            head,
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
        match self.head.as_str() {
            // SELECT ... INTO は新しいテーブル・ファイルを作るので除く
            // 行ロックを取る指定 (FOR UPDATE 等) も読み取り専用では認めない
            "SELECT" | "TABLE" | "VALUES" => {
                !has_top_level_word(&self.body, "INTO") && !takes_row_lock(&self.body)
            }
            "SHOW" | "DESCRIBE" | "DESC" => true,
            // PRAGMA は設定にも使えるため、参照だけの決まったものに限る
            "PRAGMA" => is_read_only_pragma(&self.body),
            // WITH / EXPLAIN は中身にデータ変更が無いことを確かめる
            // (SELECT ... INTO でテーブルやファイルを作れる点も同じく見る)
            "WITH" | "EXPLAIN" => {
                !self.contains_write_keyword()
                    && !has_top_level_word(&self.body, "INTO")
                    && !takes_row_lock(&self.body)
            }
            _ => false,
        }
    }

    /// 読み取り専用で断る理由が「行ロック」かどうか。
    ///
    /// UPDATE の副問い合わせに FOR UPDATE がある場合など、
    /// そもそも参照系でないSQLに「データは変わりませんが」と説明しないよう、
    /// 参照系の先頭キーワードに限る
    pub fn locks_rows(&self) -> bool {
        matches!(
            self.head.as_str(),
            "SELECT" | "TABLE" | "VALUES" | "WITH" | "EXPLAIN"
        ) && takes_row_lock(&self.body)
    }

    /// EXPLAIN ANALYZE を付けても安全なSQLかどうか
    pub fn is_analyzable(&self) -> bool {
        match self.head.as_str() {
            // SELECT ... INTO は新しいテーブル・ファイルを作るので参照系ではない
            "SELECT" | "TABLE" | "VALUES" => !has_top_level_word(&self.body, "INTO"),
            // WITH は本体がDML (WITH x AS (...) DELETE ...) の場合があるため中身を見る
            "WITH" => !self.contains_write_keyword() && !has_top_level_word(&self.body, "INTO"),
            _ => false,
        }
    }

    /// SQLの読み方 (方言) が変わりうる文か
    pub fn changes_dialect(&self) -> bool {
        if matches!(self.head.as_str(), "SET" | "RESET" | "DISCARD") {
            return true;
        }
        // PostgreSQLの set_config(...) は SELECT の形でセッション設定を変える
        contains_word(&self.body, "SET_CONFIG")
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

/// キーワード探索用に整えたSQLと、その先頭キーワード。
///
/// 先頭キーワードは「コメントを除いた最初の単語」だが、
/// MySQLの `/*! … */` は中身が実行されるのでコメントとして飛ばしてはいけない。
/// 整えた後の文字列から取れば、方言ごとの違いを1か所で吸収できる
fn masked_head(d: Dialect, sql: &str) -> (String, String) {
    let masked = strip_literals(d, sql);
    let head = head_keyword(&masked);
    (masked, head)
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

/// 実行前に確認したいSQLを抜き出す。
/// 消えると戻せないもの (DROP/TRUNCATE) と、
/// 対象を絞っていない一括更新・一括削除 (WHERE の無い UPDATE/DELETE) が対象
pub fn dangerous_statements(d: Dialect, sql: &str) -> Vec<DangerousStatement> {
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
        });
    }
    for stmt in split.stmts {
        let a = Analyzed::new(d, &stmt);
        let (body, head) = (a.body(), a.head());
        // サブクエリの中のWHEREは対象の絞り込みにならないため、括弧の外だけを見る
        let has_where = has_top_level_word(body, "WHERE");
        let kind = match head {
            "DROP" => Some("DROP (テーブルやデータベースごと削除)"),
            "TRUNCATE" => Some("TRUNCATE (全行削除)"),
            // ALTER・RENAME はデータが消えるわけではないので、設定で確認を省ける
            "ALTER" => Some("ALTER (定義の変更)"),
            "RENAME" => Some("RENAME (名前の変更)"),
            "DELETE" if !has_where => Some("WHERE の無い DELETE (全行削除)"),
            "UPDATE" if !has_where => Some("WHERE の無い UPDATE (全行更新)"),
            // 条件はあるが、常に真なので全行が対象になるもの
            "DELETE" if where_is_tautology(body) => {
                Some("条件が常に真の DELETE (全行削除)")
            }
            "UPDATE" if where_is_tautology(body) => {
                Some("条件が常に真の UPDATE (全行更新)")
            }
            // WITH の中で更新するCTE (WITH x AS (DELETE ...) ...) も実際にデータが変わる
            "WITH" if a.contains_write_keyword() => {
                Some("データを変更する WITH (CTEの中で INSERT / UPDATE / DELETE)")
            }
            // EXPLAIN ANALYZE は対象のSQLを実際に実行する
            // EXPLAIN (ANALYZE) … のように括弧で指定する書き方もあるため、
            // ANALYZE は括弧の外に限らず探す
            "EXPLAIN"
                if contains_word(body, "ANALYZE") && a.contains_write_keyword() =>
            {
                Some("EXPLAIN ANALYZE (対象のSQLが実際に実行されます)")
            }
            _ => None,
        };
        if let Some(kind) = kind {
            // 長い文はそのまま出すと読めないので先頭だけにする
            let one_line = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
            let sql = if one_line.chars().count() > 200 {
                let head: String = one_line.chars().take(200).collect();
                format!("{head} …")
            } else {
                one_line
            };
            found.push(DangerousStatement {
                kind: kind.to_string(),
                sql,
                definition_change: matches!(head, "ALTER" | "RENAME"),
            });
        }
    }
    found
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
    "CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE", "LOCK", "UNLOCK",
    "FLUSH", "ANALYZE", "OPTIMIZE",
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
/// `pg_advisory_lock_shared` や `pg_try_advisory_xact_lock` など派生が多いので
/// 前方一致で見る。同じ名前の列・テーブルを誤って拒否しないよう、
/// 直後が `(` の「関数呼び出しの形」だけを対象にする
fn calls_lock_function(flat: &str) -> bool {
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
        // ロックを解放する関数 (pg_advisory_unlock 等) は対象外
        if called
            && !word.contains("UNLOCK")
            && (word == "GET_LOCK"
                || word.starts_with("PG_ADVISORY")
                || word.starts_with("PG_TRY_ADVISORY"))
        {
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
