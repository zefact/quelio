//! プレースホルダ (:name) への値の埋め込み。
//!
//! 値は文字列として埋め込むが、
//! 判定 (文の分割・読み取り専用・危険なSQL) は埋め込む前に済ませる。
//! こうすると、値が「何が実行されるか」を左右できない

use super::*;

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

/// パラメータの値が、選んだ型として書ける形かを確かめる。
///
/// 「数値」と「そのまま」はクォートせずSQLへ入るので、
/// 値がSQLの意味を変えてしまわないよう、入れる前に見ておく
/// (「そのまま」はSQLの断片を入れるための指定なので中身は見ない。
///  文を増やせないことは、値を入れた後のSQLで別途確かめる)
pub fn check_params(
    values: &std::collections::HashMap<String, ParamValue>,
) -> Result<(), String> {
    for (name, v) in values {
        let t = v.value.trim();
        if t.is_empty() {
            continue;
        }
        if v.kind == "number" && !looks_number(t) {
            return Err(format!(
                "パラメータ :{name} は「数値」ですが、数値ではない値が入っています: {t}\n\
                 数値以外を入れるときは、型を「文字列」か「そのまま」にしてください"
            ));
        }
    }
    Ok(())
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
