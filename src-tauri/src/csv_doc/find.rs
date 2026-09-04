//! CSVの検索と置換。
//!
//! 画面は見えている行しか持っていないので、探すのはRust側で行う。
//! 1文字ずつ折りたたんで (大小を無視するときは小文字にして) 比べるため、
//! 位置は「文字数」で数える。バイト位置だと日本語で崩れるため

use serde::{Deserialize, Serialize};

use super::edit::CellEdit;

/// 探し方
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    /// 英字の大小を区別する
    pub match_case: bool,
    /// セルの中身がまるごと同じものだけを対象にする
    pub whole_cell: bool,
    /// この列だけを見る (省略すると全部の列)
    pub column: Option<usize>,
}

/// 見つかったセルの位置
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Match {
    pub row: usize,
    pub col: usize,
}

/// 大小を無視するときは小文字にする。
///
/// `to_lowercase()` は1文字が2文字に増えることがあるが、増やすと位置が
/// ずれてしまうので先頭の1文字だけを使う (CSVの中身では実害が無い)
fn fold(c: char, match_case: bool) -> char {
    if match_case {
        c
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// 比べる用の文字列 (1文字1要素)
fn folded(s: &str, match_case: bool) -> Vec<char> {
    s.chars().map(|c| fold(c, match_case)).collect()
}

/// 探す言葉を、比べられる形にしておく (空なら None = 何も探さない)
pub fn needle(query: &str, o: &FindOptions) -> Option<Vec<char>> {
    if query.is_empty() {
        None
    } else {
        Some(folded(query, o.match_case))
    }
}

/// このセルが引っかかるか
fn hits(cell: &str, q: &[char], o: &FindOptions) -> bool {
    let c = folded(cell, o.match_case);
    if o.whole_cell {
        c == q
    } else {
        c.windows(q.len()).any(|w| w == q)
    }
}

/// 見に行く列の並び (列を絞っていればその1つだけ)
fn columns(width: usize, o: &FindOptions) -> Vec<usize> {
    match o.column {
        Some(c) if c < width => vec![c],
        Some(_) => Vec::new(),
        None => (0..width).collect(),
    }
}

/**
 * 次 (または前) の一致を探す。
 *
 * `from` は今いるセル。そこは飛ばして隣から見はじめ、
 * 端まで行ったら反対の端へ回って一周する
 */
pub fn find_next(
    rows: &[Vec<String>],
    width: usize,
    query: &str,
    o: &FindOptions,
    from: Option<Match>,
    backward: bool,
) -> Option<Match> {
    let q = needle(query, o)?;
    let cols = columns(width, o);
    if rows.is_empty() || cols.is_empty() {
        return None;
    }
    let n = rows.len() * cols.len();

    // 今いるセルを通し番号に直し、その隣から見はじめる
    let begin = match from {
        Some(m) => {
            let ci = cols.iter().position(|&c| c == m.col).unwrap_or(0);
            let at = (m.row.min(rows.len() - 1)) * cols.len() + ci;
            if backward {
                (at + n - 1) % n
            } else {
                (at + 1) % n
            }
        }
        None if backward => n - 1,
        None => 0,
    };

    for k in 0..n {
        let i = if backward {
            (begin + n - k) % n
        } else {
            (begin + k) % n
        };
        let row = i / cols.len();
        let col = cols[i % cols.len()];
        if let Some(cell) = rows.get(row).and_then(|r| r.get(col)) {
            if hits(cell, &q, o) {
                return Some(Match { row, col });
            }
        }
    }
    None
}

/// 引っかかるセルの数 (件数の表示に使う)
pub fn count(rows: &[Vec<String>], width: usize, query: &str, o: &FindOptions) -> usize {
    let Some(q) = needle(query, o) else {
        return 0;
    };
    let cols = columns(width, o);
    rows.iter()
        .map(|r| {
            cols.iter()
                .filter(|&&c| r.get(c).is_some_and(|v| hits(v, &q, o)))
                .count()
        })
        .sum()
}

/// セルの中の一致を全部置き換えた文字列
fn replace_in(cell: &str, q: &[char], to: &str, match_case: bool) -> String {
    let src: Vec<char> = cell.chars().collect();
    let cmp: Vec<char> = src.iter().map(|&c| fold(c, match_case)).collect();
    let mut out = String::with_capacity(cell.len());
    let mut i = 0;
    while i < src.len() {
        if i + q.len() <= src.len() && cmp[i..i + q.len()] == *q {
            out.push_str(to);
            i += q.len();
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    out
}

/// まとめて置き換える書き換えの一覧 (実際に変わるセルだけを返す)
pub fn replace_all(
    rows: &[Vec<String>],
    width: usize,
    query: &str,
    to: &str,
    o: &FindOptions,
) -> Vec<CellEdit> {
    let Some(q) = needle(query, o) else {
        return Vec::new();
    };
    let cols = columns(width, o);
    let mut list = Vec::new();
    for (row, r) in rows.iter().enumerate() {
        for &col in &cols {
            let Some(cell) = r.get(col) else { continue };
            if !hits(cell, &q, o) {
                continue;
            }
            let after = if o.whole_cell {
                to.to_string()
            } else {
                replace_in(cell, &q, to, o.match_case)
            };
            if after != *cell {
                list.push(CellEdit {
                    row,
                    col,
                    before: cell.clone(),
                    after,
                });
            }
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Vec<String>> {
        vec![
            vec!["Apple".into(), "赤".into()],
            vec!["banana".into(), "黄".into()],
            vec!["apple pie".into(), "apple".into()],
        ]
    }

    fn opts(match_case: bool, whole_cell: bool, column: Option<usize>) -> FindOptions {
        FindOptions {
            match_case,
            whole_cell,
            column,
        }
    }

    #[test]
    fn finds_ignoring_case() {
        let o = opts(false, false, None);
        let m = find_next(&rows(), 2, "apple", &o, None, false);
        assert_eq!(m, Some(Match { row: 0, col: 0 }));
    }

    #[test]
    fn finds_with_case() {
        let o = opts(true, false, None);
        let m = find_next(&rows(), 2, "apple", &o, None, false);
        assert_eq!(m, Some(Match { row: 2, col: 0 }));
    }

    #[test]
    fn steps_to_the_next_one() {
        let o = opts(false, false, None);
        let first = Match { row: 0, col: 0 };
        let m = find_next(&rows(), 2, "apple", &o, Some(first), false);
        assert_eq!(m, Some(Match { row: 2, col: 0 }));
    }

    #[test]
    fn wraps_around_to_the_top() {
        let o = opts(false, false, None);
        let last = Match { row: 2, col: 1 };
        let m = find_next(&rows(), 2, "apple", &o, Some(last), false);
        assert_eq!(m, Some(Match { row: 0, col: 0 }));
    }

    #[test]
    fn walks_backward() {
        let o = opts(false, false, None);
        let m = find_next(&rows(), 2, "apple", &o, Some(Match { row: 0, col: 0 }), true);
        assert_eq!(m, Some(Match { row: 2, col: 1 }));
    }

    #[test]
    fn whole_cell_only() {
        let o = opts(false, true, None);
        let m = find_next(&rows(), 2, "apple", &o, None, false);
        assert_eq!(m, Some(Match { row: 0, col: 0 }));
        assert_eq!(count(&rows(), 2, "apple", &o), 2);
    }

    #[test]
    fn only_one_column() {
        let o = opts(false, false, Some(1));
        let m = find_next(&rows(), 2, "apple", &o, None, false);
        assert_eq!(m, Some(Match { row: 2, col: 1 }));
        assert_eq!(count(&rows(), 2, "apple", &o), 1);
    }

    #[test]
    fn finds_japanese() {
        let o = opts(false, false, None);
        let m = find_next(&rows(), 2, "黄", &o, None, false);
        assert_eq!(m, Some(Match { row: 1, col: 1 }));
    }

    #[test]
    fn replaces_every_hit_in_a_cell() {
        assert_eq!(replace_in("aXaXa", &['x'], "-", false), "a-a-a");
    }

    #[test]
    fn replace_all_keeps_the_rest() {
        let o = opts(false, false, None);
        let list = replace_all(&rows(), 2, "apple", "梨", &o);
        assert_eq!(list.len(), 3);
        assert_eq!(list[1].after, "梨 pie");
    }

    #[test]
    fn replace_whole_cell() {
        let o = opts(false, true, None);
        let list = replace_all(&rows(), 2, "apple", "梨", &o);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].after, "梨");
    }

    #[test]
    fn nothing_to_find_when_query_is_empty() {
        let o = opts(false, false, None);
        assert_eq!(find_next(&rows(), 2, "", &o, None, false), None);
        assert_eq!(count(&rows(), 2, "", &o), 0);
        assert!(replace_all(&rows(), 2, "", "x", &o).is_empty());
    }
}
