//! 任意のSQL実行と結果セットの文字列化

use std::time::Instant;

use futures_util::{Stream, TryStreamExt};
use sqlx::mysql::{MySqlConnection, MySqlRow};
use sqlx::postgres::{PgConnection, PgRow};
use sqlx::sqlite::{SqliteConnection, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tokio::time::{timeout, Duration};

use crate::csv_job::CsvJob;
use crate::db::format_db_error;
use crate::export::CsvCell;
use crate::models::{DbType, QueryResult};

/// SQL実行タイムアウトの既定値 (秒)。設定画面から変更できる
pub const DEFAULT_QUERY_TIMEOUT_SECS: u64 = 60;

/// SQL実行タイムアウト。0は無制限 (実装上は十分大きな値) として扱う
pub fn query_timeout(secs: u64) -> Duration {
    if secs == 0 {
        Duration::from_secs(60 * 60 * 24 * 365)
    } else {
        Duration::from_secs(secs)
    }
}

/// 1ページの行数
pub const PAGE_SIZE: usize = 1000;

/// 1セルとして画面へ返す最大文字数。
/// 長大なTEXT/JSON列をそのまま持つとメモリを圧迫するため、超えた分は切り詰める
pub const MAX_CELL_CHARS: usize = 1000;

/// 「全文を取得」で返す最大文字数。
/// 画面用の上限は外すが、数百MBの値をそのまま画面へ渡すと固まるため上限は残す
pub const FETCH_CELL_MAX: usize = 1_000_000;

/// 切り詰めた場所。
///
/// 値そのものには「先頭 + … (全N文字)」を入れたままにしている
/// (グリッドのコピーはDOMの文字列を読むため、注記を消すと
///  切り詰められたことに気づかないままコピーされてしまう)。
/// 画面側がこの注記を文字列として読み戻さずに済むよう、位置は別に返す
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// 注記を除いた、実際に入っている先頭の文字数
    pub head: usize,
    /// 切り詰める前の全体の文字数
    pub total: usize,
}

/// セル1つの読み取り結果 (値と、切り詰めた場合の位置)。
/// NULL は None
type CellText = Option<(String, Option<Clip>)>;

/// 切り詰めたセルの位置 (結果1つぶんをまとめて返す)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClippedCell {
    /// このページの中での行番号 (0始まり)
    pub row: usize,
    /// 列番号 (0始まり)
    pub col: usize,
    pub head: usize,
    pub total: usize,
}

/// セル文字列を表示用に切り詰める (切り詰めた場合は全体の文字数を添える)。
/// maxにusize::MAXを渡すと切り詰めない (CSV出力用)
fn clip_cell(s: String, max: usize) -> (String, Option<Clip>) {
    // 大半の値は短いので、まず安価なバイト長で判定する
    // (1文字1バイト以上なので、バイト長が上限以下なら文字数も上限以下)
    if s.len() <= max {
        return (s, None);
    }
    let total = s.chars().count();
    if total <= max {
        return (s, None);
    }
    let head: String = s.chars().take(max).collect();
    (
        format!("{head}… (全{total}文字)"),
        Some(Clip { head: max, total }),
    )
}

/// 切り詰めたうえでCSV用のセルにする
fn cell_of(text: String, max: usize, numeric: bool) -> CsvCell {
    let (text, clip) = clip_cell(text, max);
    CsvCell {
        text,
        numeric,
        clip,
    }
}

/// 実行計画: LIMIT自動付与の有無を決めた実行用SQL
pub struct PlannedQuery {
    /// 実際に発行するSQL
    pub sql: String,
    pub is_fetch: bool,
    pub pageable: bool,
    pub offset: usize,
    /// サーバーサイドソート中のカラムと方向
    pub order_by: Option<String>,
    pub order_dir: Option<String>,
    /// trueなら値の切り詰めも行数の打ち切りもしない。
    /// EXPLAIN の実行計画は1セルに長い木が入るため、途中で切れると読めなくなる
    pub full: bool,
}

/// SQLの書き方の違い。文の分割で見分けが要るものだけを持つ
#[derive(Clone, Copy, PartialEq)]
pub struct Dialect {
    /// 文字列の中でバックスラッシュがエスケープになるか (MySQL)
    pub backslash_escape: bool,
    /// # から行末までがコメントか (MySQL)。
    /// PostgreSQLでは #> などの演算子なのでコメントにしてはいけない
    pub hash_comment: bool,
    /// $$ … $$ / $tag$ … $tag$ の引用符があるか (PostgreSQL)
    pub dollar_quote: bool,
    /// E'…' と前置きした文字列だけバックスラッシュがエスケープになるか (PostgreSQL)。
    /// standard_conforming_strings が on でも E'…' は常にエスケープを解釈する
    pub e_string: bool,
    /// " が文字列ではなく識別子の引用符か (MySQLの sql_mode = ANSI_QUOTES)。
    /// 識別子の引用符の中ではバックスラッシュはただの文字になる
    pub ansi_quotes: bool,
    /// -- が行コメントになるには直後に空白が要るか (MySQL)。
    /// MySQLの `1--2` は引き算であってコメントではない
    pub dash_needs_space: bool,
    /// `/*! … */` の中身をサーバーが実行するか (MySQL)。
    /// コメントとして読み飛ばすと、中に書かれたSQLを見落とす
    pub exec_comment: bool,
    /// ブロックコメントが入れ子にできるか (PostgreSQL)
    pub nested_comment: bool,
}

impl Dialect {
    pub const MYSQL: Dialect = Dialect {
        backslash_escape: true,
        hash_comment: true,
        dollar_quote: false,
        e_string: false,
        ansi_quotes: false,
        dash_needs_space: true,
        exec_comment: true,
        nested_comment: false,
    };
    pub const POSTGRESQL: Dialect = Dialect {
        backslash_escape: false,
        hash_comment: false,
        dollar_quote: true,
        e_string: true,
        ansi_quotes: false,
        dash_needs_space: false,
        exec_comment: false,
        nested_comment: true,
    };
    pub const SQLITE: Dialect = Dialect {
        backslash_escape: false,
        hash_comment: false,
        dollar_quote: false,
        e_string: false,
        ansi_quotes: false,
        dash_needs_space: false,
        exec_comment: false,
        nested_comment: false,
    };

    /// DBの種類から見た既定の方言。
    /// 実際の方言はサーバーの設定 (MySQLのsql_mode、PostgreSQLの
    /// standard_conforming_strings) で変わるため、接続後は
    /// `crate::dialect::resolve` で解決した値を使うこと
    pub fn of(db: DbType) -> Dialect {
        match db {
            DbType::Mysql => Dialect::MYSQL,
            DbType::Postgresql => Dialect::POSTGRESQL,
            _ => Dialect::SQLITE,
        }
    }
}

/// 直前の文字が識別子の一部か。
/// `report$2024$q1` のような名前をドル引用符の開始と読み違えないために使う
fn ident_before(chars: &[char], i: usize) -> bool {
    i > 0 && {
        let p = chars[i - 1];
        p.is_alphanumeric() || p == '_' || p == '$'
    }
}

/// 位置 i から `--` の行コメントが始まるか。
/// MySQLは `--` の直後に空白・制御文字・行末が必要 (`SELECT 1--2` は引き算)
fn line_comment_at(d: Dialect, chars: &[char], i: usize) -> bool {
    if chars.get(i) != Some(&'-') || chars.get(i + 1) != Some(&'-') {
        return false;
    }
    if !d.dash_needs_space {
        return true;
    }
    match chars.get(i + 2) {
        None => true,
        Some(c) => c.is_whitespace() || c.is_control(),
    }
}

/// PostgreSQLの `E'…'` の前置きか。
/// i は `'` の位置。直前が E/e で、そのさらに前が識別子の一部でないときだけ真
fn e_prefixed(chars: &[char], i: usize) -> bool {
    if i == 0 || !matches!(chars[i - 1], 'E' | 'e') {
        return false;
    }
    if i == 1 {
        return true;
    }
    let p = chars[i - 2];
    !(p.is_alphanumeric() || p == '_' || p == '$')
}

/// `$tag$` の開始かどうかを見て、そのタグ (`$tag$`) を返す。
/// タグに使えるのは英数字と `_` のみ (PostgreSQLの規則)
fn dollar_tag(rest: &[char]) -> Option<String> {
    if rest.first() != Some(&'$') {
        return None;
    }
    // タグは数字で始められない ($1$2 は位置パラメータであって引用符ではない)
    if rest.get(1).is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut tag = String::from("$");
    for c in &rest[1..] {
        match c {
            '$' => {
                tag.push('$');
                return Some(tag);
            }
            c if c.is_alphanumeric() || *c == '_' => tag.push(*c),
            _ => return None,
        }
    }
    None
}

/// SQLを走査して得た字句。
///
/// 1つの字句は「そのまま送る形 (raw)」と
/// 「キーワード探索のときの形 (masked)」の2つを持つ。
/// 文字列やコメントの中身は masked では空白になるので、
/// 値の中の DELETE などに引きずられない。
///
/// 文の分割 (`split_sql`) もキーワード探索 (`strip_literals`) も
/// この結果から組み立てる。走査を2つ持つと、どちらかだけ直したときに
/// 「文としては1つなのに、探索では2つに見える」といった食い違いが生まれる
struct Tok {
    /// 送るときの形
    raw: String,
    /// キーワード探索のときの形 (長さは raw と揃えなくてよい)
    masked: String,
    /// 文の区切りか
    semi: bool,
    /// 文字列リテラル・コメントなど、中身を読まない字句か
    hidden: bool,
}

impl Tok {
    /// そのままSQLとして読む字句
    fn code(raw: String) -> Tok {
        Tok {
            masked: raw.clone(),
            raw,
            semi: false,
            hidden: false,
        }
    }

    /// 中身を見ない字句 (文字列・コメント)。前後の単語がくっつかないよう空白を残す
    fn hidden(raw: String) -> Tok {
        Tok {
            raw,
            masked: " ".to_string(),
            semi: false,
            hidden: true,
        }
    }

    fn semi() -> Tok {
        Tok {
            raw: ";".to_string(),
            masked: ";".to_string(),
            semi: true,
            hidden: false,
        }
    }
}

/// 走査の結果
struct Lexed {
    toks: Vec<Tok>,
    /// 引用符・コメントが閉じられないまま入力が終わった場合、その説明
    unterminated: Option<String>,
}

/// 引用符の中を読み飛ばして、閉じ記号の次の位置を返す。
/// 閉じられていなければ None
fn scan_quoted(chars: &[char], start: usize, quote: char, esc: bool) -> Option<usize> {
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == '\\' && esc {
            i += 2;
            continue;
        }
        if chars[i] == quote {
            // '' / "" / `` は引用符そのもの。ここでは閉じない
            if chars.get(i + 1) == Some(&quote) {
                i += 2;
                continue;
            }
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// ブロックコメントの終わり (`*/` の次) を返す。閉じられていなければ None。
/// PostgreSQLは入れ子にできるので、その場合は深さを数える
fn scan_block_comment(chars: &[char], start: usize, nested: bool) -> Option<usize> {
    let mut depth = 1usize;
    let mut i = start + 2;
    while i + 1 < chars.len() {
        if chars[i] == '*' && chars[i + 1] == '/' {
            depth -= 1;
            if depth == 0 {
                return Some(i + 2);
            }
            i += 2;
            continue;
        }
        if nested && chars[i] == '/' && chars[i + 1] == '*' {
            depth += 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    None
}

/// MySQLの実行可能コメントの開始 (`/*!12345` や `/*+`) の長さ。
/// 中身は普通のSQLとしてサーバーが実行するので、読み飛ばしてはいけない
fn exec_comment_head(chars: &[char], i: usize) -> Option<usize> {
    if chars.get(i + 2) == Some(&'+') {
        return Some(3);
    }
    if chars.get(i + 2) != Some(&'!') {
        return None;
    }
    // /*!50000 のようにバージョン番号が続くことがある
    let mut n = 3;
    while chars.get(i + n).is_some_and(|c| c.is_ascii_digit()) {
        n += 1;
    }
    Some(n)
}

/// SQLを1回だけ走査して字句に分ける。
///
/// 何を引用符・コメントとみなすかはサーバーの設定で変わるため、
/// 接続から解決した方言 (`Dialect`) を受け取る
fn lex(d: Dialect, sql: &str) -> Lexed {
    let chars: Vec<char> = sql.chars().collect();
    let mut toks: Vec<Tok> = Vec::new();
    let mut code = String::new();
    let mut i = 0;
    macro_rules! flush {
        () => {
            if !code.is_empty() {
                toks.push(Tok::code(std::mem::take(&mut code)));
            }
        };
    }
    // start..末尾 を丸ごと1つの字句にして終わる (閉じ忘れ)
    macro_rules! rest_as_hidden {
        ($start:expr, $why:expr) => {{
            flush!();
            toks.push(Tok::hidden(chars[$start..].iter().collect()));
            return Lexed {
                toks,
                unterminated: Some($why),
            };
        }};
    }

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\'' | '"' | '`' => {
                /*
                 * 識別子の引用符 (` と ANSI_QUOTES の ") ではエスケープは効かない。
                 * PostgreSQLの E'…' は standard_conforming_strings によらず
                 * バックスラッシュをエスケープとして解釈する
                 */
                let ident_quote = c == '`' || (c == '"' && d.ansi_quotes);
                let esc = !ident_quote
                    && (d.backslash_escape
                        || (d.e_string && c == '\'' && e_prefixed(&chars, i)));
                match scan_quoted(&chars, i, c, esc) {
                    Some(end) => {
                        flush!();
                        toks.push(Tok::hidden(chars[i..end].iter().collect()));
                        i = end;
                    }
                    None => rest_as_hidden!(i, format!("引用符 {c} が閉じられていません")),
                }
            }
            // 直前が識別子の一部なら `a$b$c` という名前なので引用符ではない
            '$' if d.dollar_quote && !ident_before(&chars, i) => {
                let Some(tag) = dollar_tag(&chars[i..]) else {
                    code.push(c);
                    i += 1;
                    continue;
                };
                let t: Vec<char> = tag.chars().collect();
                let mut j = i + t.len();
                while j < chars.len() && !chars[j..].starts_with(&t[..]) {
                    j += 1;
                }
                if j >= chars.len() {
                    rest_as_hidden!(i, format!("ドル引用符 {tag} が閉じられていません"));
                }
                flush!();
                let end = j + t.len();
                toks.push(Tok::hidden(chars[i..end].iter().collect()));
                i = end;
            }
            '-' if line_comment_at(d, &chars, i) => {
                i = push_line_comment(&chars, i, &mut toks, &mut code);
            }
            '#' if d.hash_comment => {
                i = push_line_comment(&chars, i, &mut toks, &mut code);
            }
            // MySQLの実行可能コメントは、中身をサーバーが実行する。
            // コメントとして隠すと、読み取り専用の判定も危険なSQLの確認も
            // すり抜けてしまうので、目印だけを伏せて中身は普通に読み進める
            '/' if next == Some('*')
                && d.exec_comment
                && exec_comment_head(&chars, i).is_some() =>
            {
                let n = exec_comment_head(&chars, i).unwrap();
                flush!();
                toks.push(Tok::hidden(chars[i..i + n].iter().collect()));
                i += n;
            }
            '/' if next == Some('*') => match scan_block_comment(&chars, i, d.nested_comment) {
                Some(end) => {
                    flush!();
                    toks.push(Tok::hidden(chars[i..end].iter().collect()));
                    i = end;
                }
                None => rest_as_hidden!(
                    i,
                    "ブロックコメント /* が閉じられていません".to_string()
                ),
            },
            ';' => {
                flush!();
                toks.push(Tok::semi());
                i += 1;
            }
            _ => {
                code.push(c);
                i += 1;
            }
        }
    }
    flush!();
    Lexed {
        toks,
        unterminated: None,
    }
}

/// 行コメントを1つの字句にして、その次の位置を返す。
/// 改行が来ないまま終わっても閉じ忘れとは見なさない
fn push_line_comment(
    chars: &[char],
    start: usize,
    toks: &mut Vec<Tok>,
    code: &mut String,
) -> usize {
    let mut j = start;
    while j < chars.len() && chars[j] != '\n' {
        j += 1;
    }
    // 改行まで含めて1つの字句にする (文を組み立て直したときに形が変わらない)
    let end = (j + 1).min(chars.len());
    if !code.is_empty() {
        toks.push(Tok::code(std::mem::take(code)));
    }
    toks.push(Tok::hidden(chars[start..end].iter().collect()));
    end
}

/// 文の分割結果
pub struct SplitSql {
    /// セミコロンで区切った文 (空の文・コメントだけの文は含まない)
    pub stmts: Vec<String>,
    /// 引用符・コメントが閉じられないまま入力が終わった場合、その説明。
    /// 方言の見立てが実際のサーバーと食い違っているときに起きやすいので、
    /// 読み取り専用の接続では、この状態のSQLは実行しない
    pub unterminated: Option<String>,
}

/// SQLテキストをセミコロンで文単位に分割する。
/// 文字列リテラル ('...', "...", `...`)、行コメント (-- , MySQLの #)、
/// ブロックコメント (/* */)、PostgreSQLのドル引用符 ($$ … $$) の中の
/// セミコロンは区切りとして扱わない
pub fn split_sql(d: Dialect, sql: &str) -> SplitSql {
    let lexed = lex(d, sql);
    let mut stmts = Vec::new();
    let mut raw = String::new();
    // コメントだけの「文」は送っても意味が無いので、中身があるかを見ておく
    let mut has_code = false;
    let mut push = |raw: &mut String, has_code: &mut bool| {
        let t = raw.trim();
        if *has_code && !t.is_empty() {
            stmts.push(t.to_string());
        }
        raw.clear();
        *has_code = false;
    };
    for tok in &lexed.toks {
        if tok.semi {
            push(&mut raw, &mut has_code);
            continue;
        }
        raw.push_str(&tok.raw);
        has_code |= !tok.masked.trim().is_empty();
    }
    push(&mut raw, &mut has_code);
    SplitSql {
        stmts,
        unterminated: lexed.unterminated,
    }
}

/// 文単位に分割した結果だけを返す (テスト用)
#[cfg(test)]
pub fn split_statements(d: Dialect, sql: &str) -> Vec<String> {
    split_sql(d, sql).stmts
}

/// 先頭のコメント (行コメント -- / #、ブロックコメント /* */) と空白を読み飛ばす。
/// 「-- explain」のようなコメントで始まるSELECT文をSELECT系と判定できるようにする
fn strip_leading_comments(mut s: &str) -> &str {
    loop {
        s = s.trim_start();
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix('#') {
            s = rest.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r);
        } else {
            return s;
        }
    }
}

/// SQLの先頭キーワード (コメントを除いた最初の単語) を大文字で返す
fn head_keyword(sql: &str) -> String {
    strip_leading_comments(sql)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// SQLに埋め込むパラメータの値。
///
/// 値をプレースホルダのまま渡す (バインド変数にする) のが理想だが、
/// PostgreSQLは列の型が分からないと値を送れず、sqlxはプリペアド時の
/// パラメータを必ずバイナリ形式で送るため、型未指定で送ることもできない。
/// そのため埋め込みは文字列のままにし、代わりに
/// **判定 (文の分割・読み取り専用・危険なSQL) はすべて埋め込む前に済ませる**。
/// こうすると、値が「何が実行されるか」を左右できなくなる
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamValue {
    pub value: String,
    /// "auto" (推測) / "string" (常に囲む) / "number" ・ "raw" (そのまま)
    #[serde(default)]
    pub kind: String,
}

/// 文字列リテラルとして囲む。
///
/// `'` は重ねる。バックスラッシュがエスケープとして働く接続 (MySQLの既定) では
/// `\` も重ねる。重ねないと `'a\'` のように文字列が閉じず、
/// 後ろのSQLまで値の一部として読まれてしまう
fn quote_literal(d: Dialect, text: &str) -> String {
    let body = if d.backslash_escape {
        text.replace('\\', "\\\\")
    } else {
        text.to_string()
    };
    format!("'{}'", body.replace('\'', "''"))
}

/// `-12` `3.5` のような、そのまま数値として書ける形か
fn looks_number(t: &str) -> bool {
    let body = t.strip_prefix('-').unwrap_or(t);
    let mut parts = body.splitn(2, '.');
    let int = parts.next().unwrap_or("");
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(frac) => !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// 入力値をSQLリテラルにする
pub fn format_param(d: Dialect, v: &ParamValue) -> String {
    let t = v.value.trim();
    match v.kind.as_str() {
        "string" => quote_literal(d, t),
        "number" | "raw" => {
            if t.is_empty() {
                "NULL".to_string()
            } else {
                t.to_string()
            }
        }
        // "auto" とそれ以外 (未知の指定は安全側=文字列として扱う)
        _ => {
            if t.is_empty() {
                return "''".to_string();
            }
            if t.eq_ignore_ascii_case("null") {
                return "NULL".to_string();
            }
            if looks_number(t) {
                return t.to_string();
            }
            /*
             * 自分で 'ABC' と囲んだ値は、その中身を文字列として扱う。
             * そのまま通すと `'' OR 1=1 --'` のような値が条件として効いてしまう
             * (SQLの断片を入れたいときは kind に "raw" を選ぶ)
             */
            let chars: Vec<char> = t.chars().collect();
            if chars.len() >= 2 && chars[0] == '\'' && chars[chars.len() - 1] == '\'' {
                let inner: String = chars[1..chars.len() - 1].iter().collect();
                return quote_literal(d, &inner.replace("''", "'"));
            }
            quote_literal(d, t)
        }
    }
}

/// パラメータ名の1文字目に使える文字 (画面側の sqlParams.ts と揃える)
fn name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || (c as u32) >= 0xC0
}

/// パラメータ名の2文字目以降に使える文字
fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || (c as u32) >= 0xC0
}

/// コードの字句の中でパラメータを置き換える
fn fill_code(d: Dialect, code: &str, values: &std::collections::HashMap<String, ParamValue>) -> String {
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::with_capacity(code.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ':' || c == '@' {
            // PostgreSQLのキャスト (::type) とシステム変数 (@@var) は名前ではない
            if chars.get(i + 1) == Some(&c) {
                out.push(c);
                out.push(c);
                i += 2;
                continue;
            }
            let start = i + 1;
            if chars.get(start).copied().is_some_and(name_start) {
                let mut j = start + 1;
                while j < chars.len() && name_char(chars[j]) {
                    j += 1;
                }
                let name: String = chars[start..j].iter().collect();
                if let Some(v) = values.get(&name) {
                    out.push_str(&format_param(d, v));
                    i = j;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// SQL中のパラメータ (`:name` / `@name`) を値に置き換える。
///
/// 文字列リテラルとコメントの中は置き換えない (字句解析は分割と同じもの)。
/// **判定を済ませた後に呼ぶこと** — 値が文の切れ目や
/// 読み取り専用の判定に影響しないのが、この順番の目的
pub fn substitute_params(
    d: Dialect,
    sql: &str,
    values: &std::collections::HashMap<String, ParamValue>,
) -> String {
    if values.is_empty() {
        return sql.to_string();
    }
    let lexed = lex(d, sql);
    let mut out = String::with_capacity(sql.len());
    for t in &lexed.toks {
        if t.hidden {
            out.push_str(&t.raw);
        } else {
            out.push_str(&fill_code(d, &t.raw, values));
        }
    }
    out
}

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
fn strip_literals(d: Dialect, sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    for tok in &lex(d, sql).toks {
        out.push_str(&tok.masked);
    }
    out
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
        let (masked, head) = masked_head(d, &stmt);
        let body = masked.to_ascii_uppercase();
        // サブクエリの中のWHEREは対象の絞り込みにならないため、括弧の外だけを見る
        let has_where = has_top_level_word(&body, "WHERE");
        let kind = match head.as_str() {
            "DROP" => Some("DROP (テーブルやデータベースごと削除)"),
            "TRUNCATE" => Some("TRUNCATE (全行削除)"),
            // ALTER・RENAME はデータが消えるわけではないので、設定で確認を省ける
            "ALTER" => Some("ALTER (定義の変更)"),
            "RENAME" => Some("RENAME (名前の変更)"),
            "DELETE" if !has_where => Some("WHERE の無い DELETE (全行削除)"),
            "UPDATE" if !has_where => Some("WHERE の無い UPDATE (全行更新)"),
            // WITH の中で更新するCTE (WITH x AS (DELETE ...) ...) も実際にデータが変わる
            "WITH" if contains_write_keyword(d, &stmt) => {
                Some("データを変更する WITH (CTEの中で INSERT / UPDATE / DELETE)")
            }
            // EXPLAIN ANALYZE は対象のSQLを実際に実行する
            // EXPLAIN (ANALYZE) … のように括弧で指定する書き方もあるため、
            // ANALYZE は括弧の外に限らず探す
            "EXPLAIN"
                if contains_word(&body, "ANALYZE") && contains_write_keyword(d, &stmt) =>
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
                definition_change: matches!(head.as_str(), "ALTER" | "RENAME"),
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
pub fn txn_effect(db: DbType, d: Dialect, sql: &str) -> Option<bool> {
    let (masked, head) = masked_head(d, sql);
    let body = masked.to_ascii_uppercase();
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    match head.as_str() {
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
        _ if db == DbType::Mysql && MYSQL_IMPLICIT_COMMIT.contains(&head.as_str()) => Some(false),
        _ => None,
    }
}

/// SQLの読み方 (方言) が変わりうる文か。
///
/// `SET sql_mode = …` や `SET standard_conforming_strings = …` を実行されると、
/// 接続時に聞いた方言が古くなる。何が方言を変えるかはサーバー任せなので、
/// 設定を触る文はまとめて対象にして、実行後に聞き直す
pub fn changes_dialect(d: Dialect, sql: &str) -> bool {
    let (masked, head) = masked_head(d, sql);
    if matches!(head.as_str(), "SET" | "RESET" | "DISCARD") {
        return true;
    }
    // PostgreSQLの set_config(...) は SELECT の形でセッション設定を変える
    contains_word(&masked.to_ascii_uppercase(), "SET_CONFIG")
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
fn is_fetch(sql: &str) -> bool {
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

/// 読み取り専用で断る理由が「行ロック」かどうか (画面に出す説明を変えるために使う)。
///
/// UPDATE の副問い合わせに FOR UPDATE がある場合など、そもそも参照系でないSQLに
/// 「データは変わりませんが」と説明しないよう、参照系の先頭キーワードに限る
pub fn locks_rows(d: Dialect, sql: &str) -> bool {
    let (masked, head) = masked_head(d, sql);
    matches!(
        head.as_str(),
        "SELECT" | "TABLE" | "VALUES" | "WITH" | "EXPLAIN"
    ) && takes_row_lock(&masked.to_ascii_uppercase())
}

/// データを変えないSQLかどうか (読み取り専用の接続で許可する範囲)
pub fn is_read_only(d: Dialect, sql: &str) -> bool {
    let (masked, head) = masked_head(d, sql);
    let body = masked.to_ascii_uppercase();
    match head.as_str() {
        // SELECT ... INTO は新しいテーブル・ファイルを作るので除く
        // 行ロックを取る指定 (FOR UPDATE 等) も読み取り専用では認めない
        "SELECT" | "TABLE" | "VALUES" => {
            !has_top_level_word(&body, "INTO") && !takes_row_lock(&body)
        }
        "SHOW" | "DESCRIBE" | "DESC" => true,
        // PRAGMA は設定にも使えるため、参照だけの決まったものに限る
        "PRAGMA" => is_read_only_pragma(&body),
        // WITH / EXPLAIN は中身にデータ変更が無いことを確かめる
        // (SELECT ... INTO でテーブルやファイルを作れる点も同じく見る)
        "WITH" | "EXPLAIN" => {
            !contains_write_keyword(d, sql)
                && !has_top_level_word(&body, "INTO")
                && !takes_row_lock(&body)
        }
        _ => false,
    }
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
pub fn is_analyzable(d: Dialect, sql: &str) -> bool {
    let (masked, head) = masked_head(d, sql);
    let body = masked.to_ascii_uppercase();
    match head.as_str() {
        // SELECT ... INTO は新しいテーブル・ファイルを作るので参照系ではない
        "SELECT" | "TABLE" | "VALUES" => !has_top_level_word(&body, "INTO"),
        // WITH は本体がDML (WITH x AS (...) DELETE ...) の場合があるため中身を見る
        "WITH" => !contains_write_keyword(d, sql) && !has_top_level_word(&body, "INTO"),
        _ => false,
    }
}

/// データを変更するキーワードを含むか (単語として一致するもののみ)
fn contains_write_keyword(d: Dialect, sql: &str) -> bool {
    const WRITE: [&str; 10] = [
        "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT",
        "CALL",
    ];
    // 文字列やコメントの中の "delete" などに反応しないよう、先に取り除く
    let upper = strip_literals(d, sql).to_ascii_uppercase();
    WRITE.iter().any(|kw| contains_word(&upper, kw))
}

/// 大文字化済みの文字列に、単語として word が含まれるか
fn contains_word(haystack: &str, word: &str) -> bool {
    haystack.match_indices(word).any(|(i, _)| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + word.len()..].chars().next();
        let is_ident = |c: char| c.is_alphanumeric() || c == '_';
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

/// 識別子をDB種別に応じてクォートする
fn quote_ident(name: &str, mysql_quoting: bool) -> String {
    if mysql_quoting {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

/// LIMIT/OFFSETを自動付与できる (＝ページングできる) SQLかどうか
fn is_pageable(trimmed: &str) -> bool {
    is_fetch(trimmed)
        && matches!(
            head_keyword(trimmed).as_str(),
            "SELECT" | "WITH" | "TABLE" | "VALUES"
        )
        && !trimmed.to_ascii_uppercase().contains("LIMIT")
}

/// CSV出力用のSQLを組み立てる。
/// ページングのLIMITは付けずに全件を対象とし、
/// 画面でソート中ならサブクエリで包んで同じ並び順にする
pub fn plan_export(sql: &str, order: Option<(&str, &str)>, mysql_quoting: bool) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    match order {
        Some((column, dir)) if is_pageable(trimmed) => {
            let quoted = quote_ident(column, mysql_quoting);
            format!("SELECT * FROM ({trimmed}) AS q ORDER BY {quoted} {dir}")
        }
        _ => trimmed.to_string(),
    }
}

/// SQLからページング用の実行計画を作る。
/// LIMITを含まないSELECT系には `LIMIT PAGE_SIZE+1 OFFSET n` を付与し、
/// orderが指定されていればサブクエリで包んで ORDER BY を付ける (サーバーサイドソート)。
pub fn plan(
    sql: &str,
    offset: usize,
    order: Option<(&str, &str)>,
    mysql_quoting: bool,
) -> PlannedQuery {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let fetch = is_fetch(trimmed);
    let pageable = is_pageable(trimmed);

    if !pageable {
        return PlannedQuery {
            sql: trimmed.to_string(),
            is_fetch: fetch,
            pageable: false,
            offset: 0,
            order_by: None,
            order_dir: None,
            full: false,
        };
    }

    match order {
        Some((column, dir)) => {
            let quoted = quote_ident(column, mysql_quoting);
            PlannedQuery {
                sql: format!(
                    "SELECT * FROM ({trimmed}) AS q ORDER BY {quoted} {dir} LIMIT {} OFFSET {offset}",
                    PAGE_SIZE + 1
                ),
                is_fetch: fetch,
                pageable: true,
                offset,
                order_by: Some(column.to_string()),
                order_dir: Some(dir.to_ascii_lowercase()),
                full: false,
            }
        }
        None => PlannedQuery {
            sql: format!("{trimmed} LIMIT {} OFFSET {offset}", PAGE_SIZE + 1),
            is_fetch: fetch,
            pageable: true,
            offset,
            order_by: None,
            order_dir: None,
            full: false,
        },
    }
}

fn bytes_preview(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().take(32).map(|b| format!("{b:02x}")).collect();
    if bytes.len() > 32 {
        format!("0x{hex}… ({} bytes)", bytes.len())
    } else {
        format!("0x{hex}")
    }
}

/// 1マクロで複数の型を順に試すセル文字列化。
/// `型 => 数値かどうか` の並びで書く (数値はCSVでクォートしないため)
macro_rules! try_types {
    ($row:expr, $i:expr, $max:expr, [$($t:ty => $num:expr),+ $(,)?]) => {
        $(
            if let Ok(v) = $row.try_get::<Option<$t>, _>($i) {
                return v.map(|x| cell_of(x.to_string(), $max, $num));
            }
        )+
    };
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
fn mysql_cell(row: &MySqlRow, i: usize) -> CellText {
    mysql_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
fn mysql_cell_all(row: &MySqlRow, i: usize) -> CellText {
    mysql_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn mysql_cell_fetch(row: &MySqlRow) -> Option<String> {
    mysql_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
fn mysql_cell_full(row: &MySqlRow, i: usize) -> Option<CsvCell> {
    mysql_cell_max(row, i, usize::MAX)
}

fn mysql_cell_max(row: &MySqlRow, i: usize, max: usize) -> Option<CsvCell> {
    // FLOATは4バイトのまま届くことがあり、f64として読むと
    // 0.1 が 0.10000000149011612 になる。列の型を見てf32で読む
    if row
        .try_get_raw(i)
        .is_ok_and(|v| v.type_info().name() == "FLOAT")
    {
        if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
            return v.map(|x| cell_of(x.to_string(), max, true));
        }
    }
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        u64 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        bool => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
fn pg_cell(row: &PgRow, i: usize) -> CellText {
    pg_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
fn pg_cell_all(row: &PgRow, i: usize) -> CellText {
    pg_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn pg_cell_fetch(row: &PgRow) -> Option<String> {
    pg_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
fn pg_cell_full(row: &PgRow, i: usize) -> Option<CsvCell> {
    pg_cell_max(row, i, usize::MAX)
}

fn pg_cell_max(row: &PgRow, i: usize, max: usize) -> Option<CsvCell> {
    try_types!(row, i, max, [
        String => false,
        i64 => true,
        i32 => true,
        i16 => true,
        rust_decimal::Decimal => true,
        f64 => true,
        f32 => true,
        bool => false,
        chrono::NaiveDateTime => false,
        chrono::DateTime<chrono::Utc> => false,
        chrono::NaiveDate => false,
        chrono::NaiveTime => false,
        uuid::Uuid => false,
        serde_json::Value => false,
    ]);
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| CsvCell::text(bytes_preview(&b)));
    }
    Some(CsvCell::text("(未対応の型)".into()))
}

/// 画面表示用のセル値 (長すぎる値は切り詰める)
fn sqlite_cell(row: &SqliteRow, i: usize) -> CellText {
    sqlite_cell_max(row, i, MAX_CELL_CHARS).map(|c| (c.text, c.clip))
}

/// 切り詰めない画面表示用のセル値 (EXPLAINの実行計画など)
fn sqlite_cell_all(row: &SqliteRow, i: usize) -> CellText {
    sqlite_cell_max(row, i, usize::MAX).map(|c| (c.text, c.clip))
}

/// 「全文を取得」用のセル値 (上限まで切り詰めない)
pub fn sqlite_cell_fetch(row: &SqliteRow) -> Option<String> {
    sqlite_cell_max(row, 0, FETCH_CELL_MAX).map(|c| c.text)
}

/// CSV出力用のセル値 (切り詰めず、数値かどうかも返す)
fn sqlite_cell_full(row: &SqliteRow, i: usize) -> Option<CsvCell> {
    sqlite_cell_max(row, i, usize::MAX)
}

/// SQLiteは列ではなく値ごとに型が決まる (動的型付け) ため、
/// 宣言型ではなく実際に入っている値の型で文字列化する
fn sqlite_cell_max(row: &SqliteRow, i: usize, max: usize) -> Option<CsvCell> {
    let Ok(raw) = row.try_get_raw(i) else {
        return Some(CsvCell::text("(取得できません)".into()));
    };
    if raw.is_null() {
        return None;
    }
    let type_name = raw.type_info().name().to_string();
    match type_name.as_str() {
        "INTEGER" => row
            .try_get::<Option<i64>, _>(i)
            .ok()
            .flatten()
            .map(|v| cell_of(v.to_string(), max, true)),
        "REAL" => row
            .try_get::<Option<f64>, _>(i)
            .ok()
            .flatten()
            .map(|v| cell_of(v.to_string(), max, true)),
        "BLOB" => row
            .try_get::<Option<Vec<u8>>, _>(i)
            .ok()
            .flatten()
            .map(|b| CsvCell::text(bytes_preview(&b))),
        // TEXT・その他はすべて文字列として扱う
        _ => row
            .try_get::<Option<String>, _>(i)
            .ok()
            .flatten()
            .map(|s| cell_of(s, max, false)),
    }
}

/// 結果セットのストリームから1ページ分 (PAGE_SIZE行) だけ読み取る。
///
/// PAGE_SIZE+1行目が届いた時点で読み取りを打ち切ってストリームを閉じるため、
/// LIMITを付けられないSQL (LIMIT指定済み・SHOW等) で結果が何百万行あっても、
/// アプリが保持する行数は常に1ページ分に収まる。
/// 戻り値は (カラム名, 行データ, 次ページの有無)
/// 1ページぶんの読み取り結果 (行と、切り詰めたセルの位置)
struct Page {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    clipped: Vec<ClippedCell>,
    has_more: bool,
}

async fn fetch_page<R, S>(
    mut stream: S,
    cell: fn(&R, usize) -> CellText,
    limit: usize,
) -> Result<Page, String>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
{
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut clipped: Vec<ClippedCell> = Vec::new();
    let mut has_more = false;
    while let Some(row) = stream.try_next().await.map_err(format_db_error)? {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= limit {
            // 次のページがあることが分かれば十分なので、ここで読み取りをやめる
            has_more = true;
            break;
        }
        let at = rows.len();
        let mut cells: Vec<Option<String>> = Vec::with_capacity(row.columns().len());
        for i in 0..row.columns().len() {
            match cell(&row, i) {
                Some((text, clip)) => {
                    if let Some(c) = clip {
                        clipped.push(ClippedCell {
                            row: at,
                            col: i,
                            head: c.head,
                            total: c.total,
                        });
                    }
                    cells.push(Some(text));
                }
                None => cells.push(None),
            }
        }
        rows.push(cells);
    }
    Ok(Page {
        columns,
        rows,
        clipped,
        has_more,
    })
}

/// 結果セットのストリームをCSVとして書き出す。
/// 1行ずつ書き出すので、何百万行でもメモリ使用量は一定。
/// 戻り値は (書き出した行数, キャンセルされたか)
async fn write_csv<R, S, W>(
    mut stream: S,
    cell: fn(&R, usize) -> Option<CsvCell>,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String>
where
    R: Row,
    S: Stream<Item = Result<R, sqlx::Error>> + Unpin,
    W: std::io::Write,
{
    let mut count = 0usize;
    let mut wrote_header = false;
    loop {
        /*
         * 中止を押すとサーバー側からも1本を止めに行くので、
         * 1行目が返る前でも、その結果のエラーとして返ってくる。
         * 失敗ではなく「中止」として扱う
         */
        let next = match stream.try_next().await {
            Ok(v) => v,
            Err(e) => {
                if job.is_some_and(|j| j.is_cancelled()) {
                    return Ok((count, true));
                }
                return Err(format_db_error(e));
            }
        };
        let Some(row) = next else { break };
        if !wrote_header {
            let cols: Vec<Option<CsvCell>> = row
                .columns()
                .iter()
                .map(|c| Some(CsvCell::text(c.name().to_string())))
                .collect();
            out.write_all(crate::export::csv_row_cells(&cols).as_bytes())
                .map_err(|e| format!("CSVを書き込めません: {e}"))?;
            wrote_header = true;
        }
        // 文字列・日時はクォートで囲み、数値はそのまま、NULLは空欄にする
        let fields: Vec<Option<CsvCell>> = (0..row.columns().len())
            .map(|i| cell(&row, i))
            .collect();
        out.write_all(crate::export::csv_row_cells(&fields).as_bytes())
            .map_err(|e| format!("CSVを書き込めません: {e}"))?;
        count += 1;
        // 進捗の共有とキャンセル要求の確認 (どちらもアトミック変数なので軽い)
        if let Some(job) = job {
            job.set_rows(count);
            if job.is_cancelled() {
                return Ok((count, true));
            }
        }
    }
    Ok((count, false))
}

/// SQLの実行方法。
///
/// `Raw` はテキストプロトコル (simple query) でそのまま送る。
/// `Prepared` はプリペアドステートメント (extended query) で送る。
/// MySQL (COM_STMT_PREPARE) と PostgreSQL (Parse) は1回に1文しか受け付けないため、
/// 字句解析が方言を取り違えて文の切れ目を見落としても、
/// 意図しない2文目がサーバー側で弾かれる (多層防御)。
///
/// SQLiteのドライバは1つの文字列を `;` で割ってすべて実行するため、
/// この保護は効かない。SQLiteの読み取り専用接続は
/// ファイルを SQLITE_OPEN_READONLY で開くことで守っている
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SqlMode {
    Raw,
    /// プリペアドで送る。
    /// `retry_text` は、バイナリ形式で受け取れない型に当たったときに
    /// テキスト形式でやり直してよいか (トランザクションの中では不可)
    Prepared { retry_text: bool },
}

impl SqlMode {
    /// 読み取り専用の接続ではプリペアドで送る。
    ///
    /// トランザクションが開いている間は、1度エラーになると
    /// PostgreSQLはそのトランザクション全体を中断状態にするため、
    /// やり直しても必ず失敗する (本来のエラーも見えなくなる)
    pub fn for_read_only(read_only: bool, in_txn: bool) -> SqlMode {
        if read_only {
            SqlMode::Prepared {
                retry_text: !in_txn,
            }
        } else {
            SqlMode::Raw
        }
    }

    fn prepared(self) -> bool {
        matches!(self, SqlMode::Prepared { .. })
    }
}

/// MySQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_mysql<W: std::io::Write>(
    conn: &mut MySqlConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String> {
    let stream = if mode.prepared() {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .persistent(false)
            .fetch(&mut *conn)
    } else {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).fetch(&mut *conn)
    };
    write_csv(stream, mysql_cell_full, out, job).await
}

/// PostgreSQL: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_pg<W: std::io::Write>(
    conn: &mut PgConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String> {
    let stream = if mode.prepared() {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .persistent(false)
            .fetch(&mut *conn)
    } else {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).fetch(&mut *conn)
    };
    write_csv(stream, pg_cell_full, out, job).await
}

/// SQLite: SQLの結果を全件CSVへ書き出す
pub async fn export_csv_sqlite<W: std::io::Write>(
    conn: &mut SqliteConnection,
    sql: &str,
    mode: SqlMode,
    out: &mut W,
    job: Option<&CsvJob>,
) -> Result<(usize, bool), String> {
    let stream = if mode.prepared() {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .persistent(false)
            .fetch(&mut *conn)
    } else {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).fetch(&mut *conn)
    };
    write_csv(stream, sqlite_cell_full, out, job).await
}

pub async fn run_mysql(
    conn: &mut MySqlConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let stream = if mode.prepared() {
            sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                .persistent(false)
                .fetch(&mut *conn)
        } else {
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch(&mut *conn)
        };
        let page = timeout(
            query_timeout(timeout_secs),
            fetch_page(
                stream,
                if plan.full { mysql_cell_all } else { mysql_cell },
                if plan.full { usize::MAX } else { PAGE_SIZE },
            ),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())??;

        Ok(QueryResult {
            columns: page.columns,
            rows: page.rows,
            clipped: page.clipped,
            offset: plan.offset,
            has_more: page.has_more,
            pageable: plan.pageable,
            order_by: plan.order_by.clone(),
            order_dir: plan.order_dir.clone(),
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let run = timeout(query_timeout(timeout_secs), async {
            if mode.prepared() {
                sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .persistent(false)
                    .execute(&mut *conn)
                    .await
            } else {
                sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .execute(&mut *conn)
                    .await
            }
        });
        let res = run
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            clipped: Vec::new(),
            offset: 0,
            has_more: false,
            pageable: false,
            order_by: None,
            order_dir: None,
            rows_affected: Some(res.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// PostgreSQLが「この型はバイナリ形式で送れない」と言ってきたか。
///
/// プリペアド (拡張プロトコル) では結果をバイナリ形式で受け取るが、
/// `aclitem` などバイナリの出力関数を持たない型があり、
/// `SELECT * FROM pg_class` のようなカタログの参照が失敗する。
/// メッセージが英語でない場合は見分けられないが、その場合は
/// 今までどおりエラーになるだけで、危険側には倒れない
fn pg_needs_text_format(msg: &str) -> bool {
    msg.contains("no binary output function")
}

pub async fn run_pg(
    conn: &mut PgConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let res = run_pg_once(conn, plan, mode, timeout_secs).await;
    /*
     * バイナリ形式で受け取れない型が混ざっていたときだけ、テキストで送り直す。
     * この1文はこちらで分割済みなので、テキストで送っても複数文にはならない
     * (=守りは「字句解析まかせ」に一段落ちるが、読み取り専用の判定は効いている)
     */
    match res {
        Err(e)
            if matches!(mode, SqlMode::Prepared { retry_text: true })
                && pg_needs_text_format(&e) =>
        {
            run_pg_once(conn, plan, SqlMode::Raw, timeout_secs).await
        }
        other => other,
    }
}

async fn run_pg_once(
    conn: &mut PgConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let stream = if mode.prepared() {
            sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                .persistent(false)
                .fetch(&mut *conn)
        } else {
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch(&mut *conn)
        };
        let page = timeout(
            query_timeout(timeout_secs),
            fetch_page(
                stream,
                if plan.full { pg_cell_all } else { pg_cell },
                if plan.full { usize::MAX } else { PAGE_SIZE },
            ),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())??;

        Ok(QueryResult {
            columns: page.columns,
            rows: page.rows,
            clipped: page.clipped,
            offset: plan.offset,
            has_more: page.has_more,
            pageable: plan.pageable,
            order_by: plan.order_by.clone(),
            order_dir: plan.order_dir.clone(),
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let run = timeout(query_timeout(timeout_secs), async {
            if mode.prepared() {
                sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .persistent(false)
                    .execute(&mut *conn)
                    .await
            } else {
                sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .execute(&mut *conn)
                    .await
            }
        });
        let res = run
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            clipped: Vec::new(),
            offset: 0,
            has_more: false,
            pageable: false,
            order_by: None,
            order_dir: None,
            rows_affected: Some(res.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

pub async fn run_sqlite(
    conn: &mut SqliteConnection,
    plan: &PlannedQuery,
    mode: SqlMode,
    timeout_secs: u64,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    if plan.is_fetch {
        let stream = if mode.prepared() {
            sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                .persistent(false)
                .fetch(&mut *conn)
        } else {
            sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone())).fetch(&mut *conn)
        };
        let page = timeout(
            query_timeout(timeout_secs),
            fetch_page(
                stream,
                if plan.full { sqlite_cell_all } else { sqlite_cell },
                if plan.full { usize::MAX } else { PAGE_SIZE },
            ),
        )
        .await
        .map_err(|_| "クエリがタイムアウトしました".to_string())??;

        Ok(QueryResult {
            columns: page.columns,
            rows: page.rows,
            clipped: page.clipped,
            offset: plan.offset,
            has_more: page.has_more,
            pageable: plan.pageable,
            order_by: plan.order_by.clone(),
            order_dir: plan.order_dir.clone(),
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    } else {
        let run = timeout(query_timeout(timeout_secs), async {
            if mode.prepared() {
                sqlx::query(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .persistent(false)
                    .execute(&mut *conn)
                    .await
            } else {
                sqlx::raw_sql(sqlx::AssertSqlSafe(plan.sql.clone()))
                    .execute(&mut *conn)
                    .await
            }
        });
        let res = run
            .await
            .map_err(|_| "クエリがタイムアウトしました".to_string())?
            .map_err(format_db_error)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            clipped: Vec::new(),
            offset: 0,
            has_more: false,
            pageable: false,
            order_by: None,
            order_dir: None,
            rows_affected: Some(res.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 行ロックを取るselectは読み取り専用で通さない() {
        for sql in [
            "SELECT * FROM t FOR UPDATE",
            "select * from t for update",
            "SELECT * FROM t\n  FOR   UPDATE",
            "SELECT * FROM t FOR NO KEY UPDATE",
            "SELECT * FROM t FOR SHARE",
            "SELECT * FROM t LOCK IN SHARE MODE",
            "WITH x AS (SELECT 1) SELECT * FROM t FOR UPDATE",
            "SELECT * FROM (SELECT * FROM t FOR UPDATE) s",
            "SELECT GET_LOCK('x', -1)",
            "SELECT pg_advisory_lock(1)",
            "SELECT pg_advisory_lock_shared(1)",
            "SELECT pg_try_advisory_xact_lock(1)",
        ] {
            assert!(!is_read_only(Dialect::of(DbType::Postgresql), sql), "{sql}");
            assert!(!is_read_only(Dialect::of(DbType::Mysql), sql), "{sql}");
        }
    }

    #[test]
    fn 普通のselectは読み取り専用で通る() {
        for sql in [
            "SELECT * FROM t",
            "SELECT 'for update' AS memo FROM t",
            "SELECT forupdate FROM t",
            "SELECT * FROM t WHERE name = 'lock in share mode'",
            // 同じ名前の列・テーブルは関数呼び出しではないので通す
            "SELECT get_lock FROM t",
            // 解放する関数はロックを取らない
            "SELECT pg_advisory_unlock_all()",
            "SELECT * FROM pg_advisory_lock_log",
        ] {
            assert!(is_read_only(Dialect::of(DbType::Postgresql), sql), "{sql}");
        }
    }

    #[test]
    fn postgresqlのドル引用符は分割しない() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  SELECT 1;\n  RETURN 2;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT 3;";
        let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert!(stmts[0].contains("RETURN 2"));
        assert_eq!(stmts[1], "SELECT 3");
    }

    #[test]
    fn ドル引用符はタグ付きも扱える() {
        let sql = "DO $body$ BEGIN; PERFORM 1; END $body$; SELECT 1;";
        let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
    }

    #[test]
    fn postgresqlのシャープはコメントではない() {
        let sql = "SELECT data #> '{a}' FROM t; SELECT 1";
        let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert!(stmts[0].contains("#>"));
    }

    #[test]
    fn mysqlのシャープはコメント() {
        let sql = "SELECT 1 # これはコメント; ここも\nUNION SELECT 2; SELECT 3";
        let stmts = split_statements(Dialect::of(DbType::Mysql), sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert!(stmts[0].contains("UNION"));
    }

    #[test]
    fn no_backslash_escapesのmysqlは文を見落とさない() {
        // sql_mode に NO_BACKSLASH_ESCAPES があると \ はただの文字になり、
        // ' はそこで閉じる。既定の方言のままだと1文に見えてしまう
        let sql = r"SELECT 'a\'; DELETE FROM t; -- '";
        let mut d = Dialect::MYSQL;
        assert_eq!(split_statements(d, sql).len(), 1);
        assert!(is_read_only(d, sql));

        d.backslash_escape = false;
        // ' がそこで閉じるので DELETE が別の文として現れる
        // (末尾に残る "-- '" はコメントだけなので文にはならない)
        let stmts = split_statements(d, sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert_eq!(stmts[1], "DELETE FROM t");
        assert!(!is_read_only(d, &stmts[1]));
        // WHERE の無い DELETE として確認ダイアログの対象になる
        assert_eq!(dangerous_statements(d, sql).len(), 1);
    }

    #[test]
    fn standard_conforming_strings_offのpostgresqlは文を切りすぎない() {
        // off のときは \ がエスケープになるため ' は閉じない
        let sql = r"SELECT 'a\'; DELETE FROM t; -- '";
        let d = Dialect::POSTGRESQL;
        assert_eq!(split_statements(d, sql).len(), 2);

        let mut off = Dialect::POSTGRESQL;
        off.backslash_escape = true;
        assert_eq!(split_statements(off, sql).len(), 1);
        assert!(is_read_only(off, sql));
    }

    #[test]
    fn postgresqlのe文字列はバックスラッシュを解釈する() {
        // E'…' は standard_conforming_strings が on でもエスケープが効くため、
        // ここで閉じたと見なすと2文目を見落とす
        let sql = r"SELECT E'a\'; DELETE FROM t; -- '";
        let d = Dialect::POSTGRESQL;
        assert_eq!(split_statements(d, sql).len(), 1);
        assert!(is_read_only(d, sql));
        assert!(dangerous_statements(d, sql).is_empty());

        // 識別子の末尾の e は前置きではない (列名 note のあとの文字列など)
        let sql = r"SELECT note'a\'; DELETE FROM t; -- '";
        assert_eq!(split_statements(d, sql).len(), 2);
    }

    #[test]
    fn ansi_quotesのダブルクォートは識別子() {
        // ANSI_QUOTES では " は識別子の引用符。中の \ はエスケープにならないので
        // "a\" はそこで閉じ、DELETE が別の文になる
        let sql = r#"SELECT 1 AS "a\" ; DELETE FROM t; -- ""#;
        let mut d = Dialect::MYSQL;
        assert_eq!(split_statements(d, sql).len(), 1);

        d.ansi_quotes = true;
        let stmts = split_statements(d, sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert_eq!(stmts[1], "DELETE FROM t");
        assert_eq!(dangerous_statements(d, sql).len(), 1);
    }

    #[test]
    fn mysqlのハイフン2つは直後に空白が要る() {
        // MySQLの 1--2 は引き算であってコメントではない
        let sql = "SELECT 1--2;DELETE FROM t";
        assert_eq!(split_statements(Dialect::MYSQL, sql).len(), 2);
        assert_eq!(dangerous_statements(Dialect::MYSQL, sql).len(), 1);
        // 空白があれば従来どおりコメント
        assert_eq!(
            split_statements(Dialect::MYSQL, "SELECT 1-- 2;DELETE FROM t").len(),
            1
        );
        // PostgreSQL・SQLiteは空白が要らない
        assert_eq!(split_statements(Dialect::POSTGRESQL, sql).len(), 1);
    }

    #[test]
    fn 引用符を2つ重ねると閉じない() {
        let d = Dialect::POSTGRESQL;
        // E'a''b\'; …' は全体で1つの文字列
        let sql = r"SELECT E'a''b\'; DELETE FROM t; -- '";
        assert_eq!(split_statements(d, sql).len(), 1);
        assert!(is_read_only(d, sql));
        // 普通の文字列でも '' は閉じない
        assert_eq!(split_statements(d, "SELECT 'a''b;c'").len(), 1);
        // キーワード探索でも文字列の中身は見ない
        assert!(is_read_only(
            d,
            r"WITH x AS (SELECT E'a''b\'; DELETE FROM t; -- ') SELECT 1"
        ));
    }

    #[test]
    fn ドル記号を含む識別子は引用符ではない() {
        let d = Dialect::POSTGRESQL;
        // report$2024$q1 は名前であってドル引用符ではない
        let sql = "SELECT id FROM report$2024$q1; DROP TABLE t";
        let stmts = split_statements(d, sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
        assert!(split_sql(d, sql).unterminated.is_none());
        assert_eq!(dangerous_statements(d, sql).len(), 1);
    }

    #[test]
    fn 区切りが分からないsqlは確認の対象にする() {
        let d = Dialect::POSTGRESQL;
        let found = dangerous_statements(d, "SELECT 'abc");
        assert_eq!(found.len(), 1);
        assert!(found[0].kind.contains("区切り"));
    }

    #[test]
    fn 行ロックの説明は参照系のsqlにだけ使う() {
        let d = Dialect::POSTGRESQL;
        assert!(locks_rows(d, "SELECT * FROM t FOR UPDATE"));
        // UPDATE は「データは変わりません」ではないので行ロックの説明にしない
        assert!(!locks_rows(
            d,
            "UPDATE t SET x = 1 WHERE id IN (SELECT id FROM u FOR UPDATE)"
        ));
    }

    #[test]
    fn トランザクションの開始と終了を見分ける() {
        let d = Dialect::POSTGRESQL;
        let pg = |sql| txn_effect(DbType::Postgresql, d, sql);
        assert_eq!(pg("BEGIN"), Some(true));
        assert_eq!(pg("begin transaction"), Some(true));
        assert_eq!(pg("START TRANSACTION"), Some(true));
        assert_eq!(pg("COMMIT"), Some(false));
        assert_eq!(pg("END"), Some(false));
        assert_eq!(pg("ROLLBACK"), Some(false));
        // AND CHAIN は続けて新しいトランザクションを開く
        assert_eq!(pg("COMMIT AND CHAIN"), Some(true));
        assert_eq!(pg("COMMIT AND NO CHAIN"), Some(false));
        // SAVEPOINT へのロールバックは終わらせない
        assert_eq!(pg("ROLLBACK TO SAVEPOINT s1"), None);
        assert_eq!(pg("SAVEPOINT s1"), None);
        // 普通のSQLは関係なし。文字列の中の COMMIT にも反応しない
        assert_eq!(pg("SELECT 1"), None);
        assert_eq!(pg("SELECT 'COMMIT'"), None);
        // 先頭のコメントは読み飛ばす
        assert_eq!(pg("-- メモ\nCOMMIT"), Some(false));
        // PL/pgSQL の BEGIN は関数の本体であってトランザクションではない
        assert_eq!(pg("DO $$ BEGIN PERFORM 1; END $$"), None);
    }

    #[test]
    fn mysqlの暗黙のトランザクションを見分ける() {
        let d = Dialect::MYSQL;
        let my = |sql| txn_effect(DbType::Mysql, d, sql);
        // autocommit を切ると、以降が暗黙のトランザクションになる
        assert_eq!(my("SET autocommit = 0"), Some(true));
        assert_eq!(my("SET @@session.autocommit=OFF"), Some(true));
        assert_eq!(my("SET autocommit = 1"), Some(false));
        assert_eq!(my("SET SESSION autocommit = ON"), Some(false));
        // DDLなどは暗黙コミットするのでトランザクションは終わる
        assert_eq!(my("CREATE TABLE t (a INT)"), Some(false));
        assert_eq!(my("TRUNCATE TABLE t"), Some(false));
        assert_eq!(my("LOCK TABLES t WRITE"), Some(false));
        // レプリケーションの START はトランザクションではない
        assert_eq!(my("START REPLICA"), None);
        assert_eq!(my("START SLAVE"), None);
        // 他のDBでは暗黙コミットしないので落とさない
        assert_eq!(txn_effect(DbType::Postgresql, Dialect::POSTGRESQL, "CREATE TABLE t (a INT)"), None);
        assert_eq!(txn_effect(DbType::Postgresql, Dialect::POSTGRESQL, "SET autocommit = 0"), None);
    }

    fn pv(value: &str, kind: &str) -> ParamValue {
        ParamValue {
            value: value.to_string(),
            kind: kind.to_string(),
        }
    }

    fn vals(pairs: &[(&str, &str, &str)]) -> std::collections::HashMap<String, ParamValue> {
        pairs
            .iter()
            .map(|(n, v, k)| (n.to_string(), pv(v, k)))
            .collect()
    }

    #[test]
    fn パラメータを値に置き換える() {
        let d = Dialect::POSTGRESQL;
        let v = vals(&[("a", "1", "auto"), ("b", "x", "auto")]);
        assert_eq!(
            substitute_params(d, "SELECT * FROM t WHERE a = :a AND b = :b", &v),
            "SELECT * FROM t WHERE a = 1 AND b = 'x'"
        );
        // 同じ名前は何度でも
        assert_eq!(substitute_params(d, "SELECT :a, :a", &v), "SELECT 1, 1");
        // @ でも書ける
        assert_eq!(substitute_params(d, "SELECT @a", &v), "SELECT 1");
    }

    #[test]
    fn 文字列とコメントの中は置き換えない() {
        let d = Dialect::POSTGRESQL;
        let v = vals(&[("a", "x", "auto")]);
        assert_eq!(
            substitute_params(d, "SELECT ':a' AS memo, :a FROM t -- :a", &v),
            "SELECT ':a' AS memo, 'x' FROM t -- :a"
        );
        // PostgreSQLのキャストとMySQLのシステム変数は名前ではない
        assert_eq!(
            substitute_params(d, "SELECT :a::text", &v),
            "SELECT 'x'::text"
        );
        assert_eq!(
            substitute_params(Dialect::MYSQL, "SELECT @@version, @a", &v),
            "SELECT @@version, 'x'"
        );
        // 値が無いパラメータはそのまま残す (SQLエラーになって気づける)
        assert_eq!(substitute_params(d, "SELECT :zzz", &v), "SELECT :zzz");
    }

    #[test]
    fn 値は実行される文を増やせない() {
        /*
         * 埋め込みの前に分割と読み取り専用の判定を済ませる、という順番の要。
         * 値に `; DELETE …` を入れても、判定の対象は :a のままなので
         * 「1文のSELECT」として扱われる
         */
        let d = Dialect::POSTGRESQL;
        let sql = "SELECT * FROM t WHERE a = :a";
        assert_eq!(split_statements(d, sql).len(), 1);
        assert!(is_read_only(d, sql));
        assert!(dangerous_statements(d, sql).is_empty());

        // 値を入れても、閉じた文字列の中に収まる
        let v = vals(&[("a", "x'; DELETE FROM t; --", "auto")]);
        let filled = substitute_params(d, sql, &v);
        assert_eq!(filled, "SELECT * FROM t WHERE a = 'x''; DELETE FROM t; --'");
        assert_eq!(split_statements(d, &filled).len(), 1);
        assert!(is_read_only(d, &filled));
    }

    #[test]
    fn バックスラッシュは方言に合わせて重ねる() {
        let v = vals(&[("p", r"C:\temp\", "string")]);
        // MySQLの既定。重ねないと末尾の \ が ' を打ち消して文字列が閉じない
        let mut mysql = Dialect::MYSQL;
        mysql.backslash_escape = true;
        assert_eq!(
            substitute_params(mysql, "SELECT :p", &v),
            r"SELECT 'C:\\temp\\'"
        );
        // PostgreSQL・SQLiteでは \ はただの文字なので、重ねると値が変わってしまう
        assert_eq!(
            substitute_params(Dialect::POSTGRESQL, "SELECT :p", &v),
            r"SELECT 'C:\temp\'"
        );
        // 重ねた結果でも文はひとつのまま
        let escape = vals(&[("p", r"x\' OR 1=1 -- ", "string")]);
        let filled = substitute_params(mysql, "SELECT * FROM t WHERE a = :p", &escape);
        assert_eq!(split_statements(mysql, &filled).len(), 1);
        assert!(is_read_only(mysql, &filled));
    }

    #[test]
    fn 埋め込み方を種類で選ぶ() {
        let d = Dialect::POSTGRESQL;
        assert_eq!(format_param(d, &pv("42", "auto")), "42");
        assert_eq!(format_param(d, &pv("-3.5", "auto")), "-3.5");
        assert_eq!(format_param(d, &pv("null", "auto")), "NULL");
        assert_eq!(format_param(d, &pv("NULL", "auto")), "NULL");
        assert_eq!(format_param(d, &pv("abc", "auto")), "'abc'");
        assert_eq!(format_param(d, &pv("", "auto")), "''");
        // 数値に見えない形は文字列として囲む
        assert_eq!(format_param(d, &pv("1.2.3", "auto")), "'1.2.3'");
        assert_eq!(format_param(d, &pv("1.", "auto")), "'1.'");
        assert_eq!(format_param(d, &pv("-", "auto")), "'-'");
        // 種類を選んだとき
        assert_eq!(format_param(d, &pv("42", "string")), "'42'");
        assert_eq!(format_param(d, &pv("", "number")), "NULL");
        assert_eq!(format_param(d, &pv("1+1", "raw")), "1+1");
        // 未知の種類は安全側 (文字列) に倒す
        assert_eq!(format_param(d, &pv("1+1", "なにか")), "'1+1'");
    }

    #[test]
    fn 引用済みに見えても中身は文字列として扱う() {
        let d = Dialect::POSTGRESQL;
        // そのまま通していた頃は `'' OR 1=1 --'` が条件として効いてしまった
        assert_eq!(
            format_param(d, &pv("'' OR 1=1 --'", "auto")),
            "''' OR 1=1 --'"
        );
        assert_eq!(format_param(d, &pv("'a' || 'b'", "auto")), "'a'' || ''b'");
        // 書いたとおりの値になる (中身の '' は ' へ戻してから囲み直す)
        assert_eq!(format_param(d, &pv("'abc'", "auto")), "'abc'");
        assert_eq!(format_param(d, &pv("'a''b'", "auto")), "'a''b'");
    }

    #[test]
    fn 切り詰めた位置を構造で返す() {
        // 上限以下ならそのまま
        let (text, clip) = clip_cell("あいう".to_string(), 5);
        assert_eq!(text, "あいう");
        assert!(clip.is_none());

        // 上限ちょうども切り詰めない
        let (_, clip) = clip_cell("あ".repeat(5), 5);
        assert!(clip.is_none());

        /*
         * 切り詰めたときは、注記付きの文字列と位置の両方を返す。
         * 画面側は「… (全N文字)」を読み戻さずに済む
         */
        let (text, clip) = clip_cell("あ".repeat(12), 5);
        let clip = clip.expect("切り詰めたら位置が返る");
        assert_eq!(clip.head, 5);
        assert_eq!(clip.total, 12);
        assert_eq!(text, format!("{}… (全12文字)", "あ".repeat(5)));
        // head は注記を除いた先頭の文字数
        assert_eq!(text.chars().take(clip.head).collect::<String>(), "あ".repeat(5));

        // 値がたまたま注記と同じ形で終わっていても、切り詰めとは扱わない
        let (_, clip) = clip_cell("短い… (全5000文字)".to_string(), 1000);
        assert!(clip.is_none());
    }

    #[test]
    fn 定義の変更だけを見分ける() {
        let d = Dialect::MYSQL;
        // 設定で確認を省ける対象 (データは消えない)
        for sql in ["ALTER TABLE t ADD COLUMN c int", "RENAME TABLE a TO b"] {
            let found = dangerous_statements(d, sql);
            assert_eq!(found.len(), 1, "{sql}");
            assert!(found[0].definition_change, "{sql}");
        }
        // 戻せない・影響範囲が読めないものは常に確認する
        for sql in [
            "DROP TABLE t",
            "TRUNCATE TABLE t",
            "DELETE FROM t",
            "UPDATE t SET a = 1",
            "SELECT 'abc",
        ] {
            let found = dangerous_statements(d, sql);
            assert_eq!(found.len(), 1, "{sql}");
            assert!(!found[0].definition_change, "{sql}");
        }
    }

    #[test]
    fn バイナリ形式で送れない型を見分ける() {
        assert!(pg_needs_text_format(
            "DBエラー: error returned from database: no binary output function available for type aclitem"
        ));
        // 別のエラーでやり直すと、無駄に2回実行することになる
        assert!(!pg_needs_text_format("DBエラー: relation \"t\" does not exist"));
        assert!(!pg_needs_text_format("実行を中止しました"));
        assert!(!pg_needs_text_format("クエリがタイムアウトしました"));
    }

    #[test]
    fn トランザクション中はテキスト形式でやり直さない() {
        /*
         * PostgreSQLは1度エラーになるとトランザクション全体が中断状態になり、
         * やり直しても必ず失敗する (本来のエラーも見えなくなる)
         */
        assert!(matches!(
            SqlMode::for_read_only(true, false),
            SqlMode::Prepared { retry_text: true }
        ));
        assert!(matches!(
            SqlMode::for_read_only(true, true),
            SqlMode::Prepared { retry_text: false }
        ));
        // 書き込みできる接続は今までどおりそのまま送る
        assert_eq!(SqlMode::for_read_only(false, false), SqlMode::Raw);
        assert_eq!(SqlMode::for_read_only(false, true), SqlMode::Raw);
    }

    #[test]
    fn 方言が変わりうる文を見分ける() {
        assert!(changes_dialect(Dialect::POSTGRESQL, "SET sql_mode = 'NO_BACKSLASH_ESCAPES'"));
        assert!(changes_dialect(Dialect::POSTGRESQL, "set standard_conforming_strings = off"));
        assert!(changes_dialect(Dialect::POSTGRESQL, "RESET ALL"));
        assert!(changes_dialect(Dialect::POSTGRESQL, "DISCARD ALL"));
        // 先頭のコメントは読み飛ばす
        assert!(changes_dialect(Dialect::POSTGRESQL, "-- メモ\nSET x = 1"));
        // set_config は SELECT の形でセッション設定を変える
        assert!(changes_dialect(
            Dialect::POSTGRESQL,
            "SELECT set_config('standard_conforming_strings', 'off', false)"
        ));
        // 普通のSQLは聞き直さない (毎回問い合わせると遅くなる)
        assert!(!changes_dialect(Dialect::POSTGRESQL, "SELECT 1"));
        assert!(!changes_dialect(Dialect::POSTGRESQL, "SELECT 'SET sql_mode'"));
        assert!(!changes_dialect(Dialect::POSTGRESQL, "UPDATE t SET a = 1"));
    }

    #[test]
    fn sqliteのsavepointはトランザクションを開く() {
        let d = Dialect::SQLITE;
        assert_eq!(txn_effect(DbType::Sqlite, d, "SAVEPOINT s1"), Some(true));
        // COMMIT で抜けられる (SAVEPOINTで始めたトランザクションも閉じられる)
        assert_eq!(txn_effect(DbType::Sqlite, d, "COMMIT"), Some(false));
        // RELEASE は最外かどうかが分からないので「開いたまま」と思っておく
        assert_eq!(txn_effect(DbType::Sqlite, d, "RELEASE s1"), None);
    }

    #[test]
    fn 分割とキーワード探索は同じ見方をする() {
        // (SQL, 文の数, リテラルの外に残るセミコロンの数)
        let cases: &[(&str, usize, usize)] = &[
            ("SELECT 'a;b'", 1, 0),
            ("SELECT 'a;b'; DROP TABLE t", 2, 1),
            ("SELECT 1 -- ;メモ\n; DROP TABLE t", 2, 1),
            ("SELECT 1 /* ; */; DROP TABLE t", 2, 1),
            ("SELECT $$a;b$$; DROP TABLE t", 2, 1),
            ("SELECT \"a;b\"; DROP TABLE t", 2, 1),
        ];
        let d = Dialect::POSTGRESQL;
        for (sql, stmts, semis) in cases {
            let got = split_statements(d, sql);
            assert_eq!(got.len(), *stmts, "{sql} -> {got:?}");
            let body = strip_literals(d, sql);
            /*
             * 走査は1か所なので、文の切れ目とキーワード探索の見え方はずれない。
             * ずれると「1文に見えるのに2文が実行される」ことになる
             */
            assert_eq!(body.matches(';').count(), *semis, "{sql} -> {body:?}");
            // 引用符やコメントの中身は残さない
            assert!(!body.contains("a;b"), "{sql} -> {body:?}");
        }
    }

    #[test]
    fn mysqlの実行可能コメントは中身を読む() {
        let d = Dialect::MYSQL;
        // MySQLは実行可能コメントの中身を実行する。
        // コメントとして読み飛ばすと、読み取り専用の判定も
        // 危険なSQLの確認もすり抜けてしまう
        let sql = "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */";
        assert!(!is_read_only(d, sql), "読み取り専用で通してはいけない");
        // 他のDBでは本当にただのコメントなので、通ってよい
        assert!(is_read_only(Dialect::POSTGRESQL, sql));

        // コメントの中だけに書かれた破壊的なSQLも確認の対象にする
        let sql = "/*!50000 DROP TABLE t */";
        assert_eq!(dangerous_statements(d, sql).len(), 1);
        assert!(!is_read_only(d, sql));
        assert!(dangerous_statements(Dialect::POSTGRESQL, sql).is_empty());

        // 送る形は変えない (目印ごとサーバーへ渡す)
        assert_eq!(split_statements(d, sql), vec![sql]);

        // 最適化ヒント (/*+ … *​/) も中身が読める形にする
        assert!(!is_read_only(d, "SELECT 1 /*+ INTO OUTFILE 'x' */"));
    }

    #[test]
    fn postgresqlのブロックコメントは入れ子にできる() {
        let d = Dialect::POSTGRESQL;
        // PostgreSQLは入れ子にできるので、内側の *​/ では閉じない
        let sql = "/* メモ /* 内側 */ */ SELECT 1";
        let stmts = split_statements(d, sql);
        assert_eq!(stmts.len(), 1, "{stmts:?}");
        assert!(is_read_only(d, sql));
        // MySQL・SQLiteは入れ子にならない (最初の *​/ で閉じる)
        assert_eq!(split_statements(Dialect::MYSQL, "/* a /* b */ SELECT 1").len(), 1);
    }

    #[test]
    fn コメントだけの入力は文にしない() {
        let d = Dialect::POSTGRESQL;
        // 「実行するSQLがありません」と言えるよう、文としては数えない
        assert!(split_statements(d, "-- メモ").is_empty());
        assert!(split_statements(d, "/* メモ */").is_empty());
        assert!(split_statements(d, "  ;  ; ").is_empty());
        assert!(split_statements(d, "").is_empty());
        // 中身があれば当然数える
        assert_eq!(split_statements(d, "-- メモ\nSELECT 1").len(), 1);
    }

    #[test]
    fn ドル記号と数字は位置パラメータ() {
        let d = Dialect::POSTGRESQL;
        // $1 $2 は引用符ではない (閉じ忘れ扱いにすると正当なSQLを断ってしまう)
        let sql = "SELECT $1$2 FROM t";
        assert!(split_sql(d, sql).unterminated.is_none());
        assert_eq!(split_statements(d, sql).len(), 1);
        // 文字始まりのタグは今までどおり引用符
        assert!(split_sql(d, "SELECT $tag$a;b").unterminated.is_some());
    }

    #[test]
    fn 閉じ忘れを見つける() {
        let d = Dialect::POSTGRESQL;
        assert!(split_sql(d, "SELECT 1").unterminated.is_none());
        // 行コメントは改行が無いまま終わっても普通
        assert!(split_sql(d, "SELECT 1 -- メモ").unterminated.is_none());
        assert!(split_sql(d, "SELECT 'abc").unterminated.is_some());
        assert!(split_sql(d, "SELECT \"abc").unterminated.is_some());
        assert!(split_sql(d, "SELECT 1 /* メモ").unterminated.is_some());
        assert!(split_sql(d, "SELECT $$abc").unterminated.is_some());
        assert!(split_sql(Dialect::MYSQL, "SELECT `abc")
            .unterminated
            .is_some());
    }

    #[test]
    fn バックスラッシュの扱いはdbで変わる() {
        // MySQLは \\' が「'」なので文字列が続く → 1文
        let sql = "SELECT 'a\\'; SELECT 2";
        assert_eq!(split_statements(Dialect::of(DbType::Mysql), sql).len(), 1);
        // PostgreSQLは \\ をエスケープ扱いしないので、'a\\' で閉じる → 2文
        assert_eq!(split_statements(Dialect::of(DbType::Postgresql), sql).len(), 2);
    }

    #[test]
    fn 文字列とコメントの中のセミコロンは区切らない() {
        let sql = "SELECT ';' AS a; -- ; コメント\nSELECT /* ; */ 2;";
        let stmts = split_statements(Dialect::of(DbType::Sqlite), sql);
        assert_eq!(stmts.len(), 2, "{stmts:?}");
    }

    #[test]
    fn ドル引用符の中の危険なsqlも見つける() {
        // 関数定義の中のDROPは1文として扱われる (分割で壊れない)
        let sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE t; END $$ LANGUAGE plpgsql;";
        let stmts = split_statements(Dialect::of(DbType::Postgresql), sql);
        assert_eq!(stmts.len(), 1, "{stmts:?}");
    }
    #[test]
    fn postgresqlの演算子で危険判定が外れない() {
        // #> 以降がコメント扱いされると DELETE を見落とす
        let sql =
            "WITH x AS (SELECT data #> '{a}' FROM t) DELETE FROM u WHERE id IN (SELECT id FROM x)";
        assert!(!is_analyzable(Dialect::of(DbType::Postgresql), sql));
        assert!(!is_read_only(Dialect::of(DbType::Postgresql), sql));
        assert_eq!(dangerous_statements(Dialect::of(DbType::Postgresql), sql).len(), 1);
    }

    #[test]
    fn postgresqlのjsonb演算子でwhereを見失わない() {
        let sql = "UPDATE t SET j = j #- '{a}' WHERE id = 1";
        assert!(dangerous_statements(Dialect::of(DbType::Postgresql), sql).is_empty());
        // MySQLでは # から行末までコメントなので、WHEREが消えて確認対象になる
        assert_eq!(dangerous_statements(Dialect::of(DbType::Mysql), sql).len(), 1);
    }

    #[test]
    fn 括弧で指定したexplain_analyzeも確認対象() {
        let sql = "EXPLAIN (ANALYZE) DELETE FROM t";
        assert_eq!(dangerous_statements(Dialect::of(DbType::Postgresql), sql).len(), 1);
        assert!(!is_analyzable(Dialect::of(DbType::Postgresql), sql));
    }

    #[test]
    fn ドル引用符の中身はキーワード探索から外す() {
        let sql = "SELECT $$ DELETE FROM t $$ AS s";
        assert!(is_read_only(Dialect::of(DbType::Postgresql), sql));
        assert!(is_analyzable(Dialect::of(DbType::Postgresql), sql));
    }
}
