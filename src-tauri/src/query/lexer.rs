//! SQLの字句解析と文の分割。
//!
//! 文字列・コメント・ドル引用符の中身を「伏せた」形にしておき、
//! 分割もキーワード探索も同じ走査結果から行う。
//! 別々に見ていると「文の切れ目」と「キーワードの見え方」が食い違う

use super::*;

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
pub(super) struct Tok {
    /// 送るときの形
    pub(super) raw: String,
    /// キーワード探索のときの形 (長さは raw と揃えなくてよい)
    pub(super) masked: String,
    /// 文の区切りか
    pub(super) semi: bool,
    /// 文字列リテラル・コメントなど、中身を読まない字句か
    pub(super) hidden: bool,
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
pub(super) struct Lexed {
    pub(super) toks: Vec<Tok>,
    /// 引用符・コメントが閉じられないまま入力が終わった場合、その説明
    pub(super) unterminated: Option<String>,
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
pub(super) fn lex(d: Dialect, sql: &str) -> Lexed {
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

/// 文単位に分割した結果だけを返す。
/// 画面側の「カーソルのある文だけ実行」でも使う
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
pub(super) fn head_keyword(sql: &str) -> String {
    strip_leading_comments(sql)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}
