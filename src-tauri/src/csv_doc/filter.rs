//! 列ごとの絞り込み (表計算ソフトのフィルタ)。
//!
//! 絞り方は2通りあり、どちらも同じ列に掛けられる。
//! ひとつは「値の一覧から選ぶ」、もうひとつは「含む・以上などの条件」。
//! 列の中では両方を満たす行、列どうしは全部を満たす行だけが残る。
//!
//! 大きなファイルでも待たされないよう、絞るのは1行ずつ見るだけにしてある

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::order::{compare, lower, number};

/// 値の一覧に出す上限。
///
/// 10万行のファイルでは値も10万通りになりうるので、頭から数えて打ち切る
pub const VALUE_LIMIT: usize = 5000;

/// 条件の種類
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// 含む
    Contains,
    /// 含まない
    NotContains,
    /// 等しい
    Equals,
    /// 等しくない
    NotEquals,
    /// で始まる
    StartsWith,
    /// で終わる
    EndsWith,
    /// より大きい
    Gt,
    /// 以上
    Ge,
    /// より小さい
    Lt,
    /// 以下
    Le,
    /// 空
    Empty,
    /// 空でない
    NotEmpty,
}

/// 条件1つ
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub kind: Kind,
    #[serde(default)]
    pub value: String,
}

/// 1つの列の絞り込み
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilter {
    pub col: usize,
    /**
     * 選んだ値。
     *
     * `None` なら値では絞らない (「すべて選択」と同じ)。
     * 空の一覧なら、どの行も残らない
     */
    #[serde(default)]
    pub values: Option<Vec<String>>,
    /// 条件 (空なら条件では絞らない)
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// 条件どうしを「かつ」で見るか (false なら「または」)
    #[serde(default)]
    pub all: bool,
}

impl ColumnFilter {
    /// 何も絞っていないか (残す意味の無い絞り込みか)
    pub fn is_empty(&self) -> bool {
        self.values.is_none() && self.rules.is_empty()
    }
}

/// 1つの条件に当てはまるか
pub fn hits(cell: &str, rule: &Rule) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let (c, w) = (lower(cell), lower(&rule.value));
    match rule.kind {
        Kind::Contains => c.contains(&w),
        Kind::NotContains => !c.contains(&w),
        Kind::Equals => c == w,
        Kind::NotEquals => c != w,
        Kind::StartsWith => c.starts_with(&w),
        Kind::EndsWith => c.ends_with(&w),
        Kind::Gt => compare(cell, &rule.value) == Greater,
        Kind::Ge => matches!(compare(cell, &rule.value), Greater | Equal),
        Kind::Lt => compare(cell, &rule.value) == Less,
        Kind::Le => matches!(compare(cell, &rule.value), Less | Equal),
        // 空白だけのセルも「空」とみなす (CSVでは桁合わせで空白が入ることがある)
        Kind::Empty => cell.trim().is_empty(),
        Kind::NotEmpty => !cell.trim().is_empty(),
    }
}

/// 絞り込みを1つぶん、引く用意をしたもの
struct Ready<'a> {
    col: usize,
    values: Option<HashSet<&'a str>>,
    rules: &'a [Rule],
    all: bool,
}

impl Ready<'_> {
    fn keeps(&self, row: &[String]) -> bool {
        let cell = row.get(self.col).map(|s| s.as_str()).unwrap_or("");
        if let Some(set) = &self.values {
            if !set.contains(cell) {
                return false;
            }
        }
        if self.rules.is_empty() {
            return true;
        }
        if self.all {
            self.rules.iter().all(|r| hits(cell, r))
        } else {
            self.rules.iter().any(|r| hits(cell, r))
        }
    }
}

fn ready(filters: &[ColumnFilter], skip: Option<usize>) -> Vec<Ready<'_>> {
    filters
        .iter()
        .filter(|f| !f.is_empty() && Some(f.col) != skip)
        .map(|f| Ready {
            col: f.col,
            values: f
                .values
                .as_ref()
                .map(|v| v.iter().map(|s| s.as_str()).collect()),
            rules: &f.rules,
            all: f.all,
        })
        .collect()
}

/**
 * 絞ったあとに残る行 (元の行番号) を上から順に返す。
 *
 * 絞り込みが1つも無ければ `None` (全行がそのまま見える)
 */
pub fn apply(rows: &[Vec<String>], filters: &[ColumnFilter]) -> Option<Vec<usize>> {
    let list = ready(filters, None);
    if list.is_empty() {
        return None;
    }
    Some(
        rows.iter()
            .enumerate()
            .filter(|(_, r)| list.iter().all(|f| f.keeps(r)))
            .map(|(i, _)| i)
            .collect(),
    )
}

/// 値の一覧に出す1つ
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Value {
    pub text: String,
    /// その値の行数
    pub count: usize,
}

/// 値の一覧
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    pub values: Vec<Value>,
    /// 多すぎて途中で打ち切ったか
    pub truncated: bool,
}

/**
 * その列に入っている値を、多くない順ではなく並べ替えて返す。
 *
 * 数として読めるものを先に小さい順、残りを文字の順に並べる。
 * 数えるのは「その列以外の絞り込みを掛けたあと」の行
 * (表計算ソフトと同じで、他の列で絞った結果の中から選べるようにする)
 */
pub fn values(rows: &[Vec<String>], filters: &[ColumnFilter], col: usize) -> Values {
    let others = ready(filters, Some(col));
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut truncated = false;
    for row in rows.iter().filter(|r| others.iter().all(|f| f.keeps(r))) {
        let cell = row.get(col).map(|s| s.as_str()).unwrap_or("");
        if let Some(n) = counts.get_mut(cell) {
            *n += 1;
        } else if counts.len() >= VALUE_LIMIT {
            truncated = true;
        } else {
            counts.insert(cell, 1);
        }
    }
    let mut seen: Vec<(&str, usize)> = counts.into_iter().collect();
    seen.sort_by(|a, b| match (number(a.0), number(b.0)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        // 数として読めるものを先に出す
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => lower(a.0).cmp(&lower(b.0)),
    });
    Values {
        values: seen
            .into_iter()
            .map(|(text, count)| Value {
                text: text.to_string(),
                count,
            })
            .collect(),
        truncated,
    }
}

#[cfg(test)]
mod tests;
