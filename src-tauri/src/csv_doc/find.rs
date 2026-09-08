//! CSVの検索と置換。
//!
//! 画面は見えている行しか持っていないので、探すのはRust側で行う。
//! ふつうの文字で探すときは1文字ずつ折りたたんで
//! (大小を無視するときは小文字にして) 比べるため、位置は「文字数」で数える。
//! バイト位置だと日本語で崩れるため。
//!
//! 正規表現で探すときは、その道具 (regex) に任せる

use serde::{Deserialize, Serialize};

use super::edit::CellEdit;
use super::view::Rows;

/// 探す範囲の四角1つ (端を含む)
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub top: usize,
    pub bottom: usize,
    pub left: usize,
    pub right: usize,
}

/// 探し方
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    /// 英字の大小を区別する
    pub match_case: bool,
    /// セルの中身がまるごと同じものだけを対象にする
    pub whole_cell: bool,
    /// 正規表現として扱う
    #[serde(default)]
    pub regex: bool,
    /// 探す範囲 (空なら表全体)
    #[serde(default)]
    pub areas: Vec<Area>,
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

/// 探すもの
enum Needle {
    /// ふつうの文字 (折りたたみ済み)
    Plain(Vec<char>),
    /// 正規表現
    Re(regex::Regex),
}

/**
 * 探す準備をひとまとめにしたもの。
 *
 * 正規表現は組み立てに手間がかかるので、
 * 「探す」「数える」「置き換える」で作り直さずに使い回す
 */
pub struct Matcher {
    needle: Needle,
    options: FindOptions,
}

impl Matcher {
    /// このセルが引っかかるか
    fn hits(&self, cell: &str) -> bool {
        match &self.needle {
            Needle::Plain(q) => {
                let c = folded(cell, self.options.match_case);
                if self.options.whole_cell {
                    c == *q
                } else {
                    c.windows(q.len()).any(|w| w == q.as_slice())
                }
            }
            // まるごと一致は組み立てのときに前後を留めてある
            Needle::Re(re) => re.is_match(cell),
        }
    }

    /// その位置が探す範囲に入っているか (範囲を決めていなければ全部が対象)
    fn in_area(&self, row: usize, col: usize) -> bool {
        self.options.areas.is_empty()
            || self
                .options
                .areas
                .iter()
                .any(|a| row >= a.top && row <= a.bottom && col >= a.left && col <= a.right)
    }
}

/**
 * 探す準備をする。
 *
 * 探す言葉が空なら `None` (何も探さない)。
 * 正規表現として読めないときは、その理由を返す
 */
pub fn matcher(query: &str, o: &FindOptions) -> Result<Option<Matcher>, String> {
    if query.is_empty() {
        return Ok(None);
    }
    let needle = if o.regex {
        // まるごと一致は、前後を留めた正規表現にして同じ道で扱う
        let pattern = if o.whole_cell {
            format!("^(?:{query})$")
        } else {
            query.to_string()
        };
        let re = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!o.match_case)
            .build()
            .map_err(|e| format!("正規表現が正しくありません: {e}"))?;
        Needle::Re(re)
    } else {
        Needle::Plain(folded(query, o.match_case))
    };
    Ok(Some(Matcher {
        needle,
        options: o.clone(),
    }))
}

/**
 * 次 (または前) の一致を探す。
 *
 * `from` は今いるセル。そこは飛ばして隣から見はじめ、
 * 端まで行ったら反対の端へ回って一周する。
 *
 * 受け取る位置も返す位置も「画面での行番号」
 * (絞り込み中は、絞ったあとの並びで数えた番号)
 */
pub fn find_next(
    rows: Rows<'_>,
    width: usize,
    m: &Matcher,
    from: Option<Match>,
    backward: bool,
) -> Option<Match> {
    if rows.is_empty() || width == 0 {
        return None;
    }
    let n = rows.len() * width;

    // 今いるセルを通し番号に直し、その隣から見はじめる
    let begin = match from {
        Some(at) => {
            let i = at.row.min(rows.len() - 1) * width + at.col.min(width - 1);
            if backward {
                (i + n - 1) % n
            } else {
                (i + 1) % n
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
        let (row, col) = (i / width, i % width);
        if !m.in_area(row, col) {
            continue;
        }
        if let Some(cell) = rows.get(row).and_then(|r| r.get(col)) {
            if m.hits(cell) {
                return Some(Match { row, col });
            }
        }
    }
    None
}

/// 引っかかるセルの数 (件数の表示に使う)
pub fn count(rows: Rows<'_>, width: usize, m: &Matcher) -> usize {
    let mut n = 0;
    for row in 0..rows.len() {
        let Some(r) = rows.get(row) else { continue };
        for col in 0..width {
            if !m.in_area(row, col) {
                continue;
            }
            if r.get(col).is_some_and(|v| m.hits(v)) {
                n += 1;
            }
        }
    }
    n
}

/// セルの中の一致を全部置き換えた文字列 (ふつうの文字で探すとき)
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

/**
 * セル1つぶんの書き換え。
 *
 * 探す範囲の外・引っかからない・置き換えても中身が変わらない、
 * のいずれかなら `None` を返す
 */
fn edit_cell(
    rows: Rows<'_>,
    m: &Matcher,
    row: usize,
    col: usize,
    to: &str,
) -> Option<CellEdit> {
    if !m.in_area(row, col) {
        return None;
    }
    let cell = rows.get(row)?.get(col)?;
    if !m.hits(cell) {
        return None;
    }
    let after = match &m.needle {
        // 正規表現は $1 のような書き方も使えるよう、道具側に任せる
        Needle::Re(re) => re.replace_all(cell, to).into_owned(),
        Needle::Plain(_) if m.options.whole_cell => to.to_string(),
        Needle::Plain(q) => replace_in(cell, q, to, m.options.match_case),
    };
    if after == *cell {
        return None;
    }
    Some(CellEdit {
        // 書き換えるのは元の行なので、ここで元の行番号に直す
        row: rows.real(row)?,
        col,
        before: cell.clone(),
        after,
    })
}

/// まとめて置き換える書き換えの一覧 (実際に変わるセルだけを、元の行番号で返す)
pub fn replace_all(rows: Rows<'_>, width: usize, m: &Matcher, to: &str) -> Vec<CellEdit> {
    let mut list = Vec::new();
    for row in 0..rows.len() {
        for col in 0..width {
            if let Some(e) = edit_cell(rows, m, row, col, to) {
                list.push(e);
            }
        }
    }
    list
}

/**
 * 今いるセル1つだけを置き換える。
 *
 * そのセルが引っかからないときは何もしない (`None`)。
 * 「次へ」で移ってきた所を置き換えて、また次へ進む使い方を想定している
 */
pub fn replace_at(
    rows: Rows<'_>,
    width: usize,
    m: &Matcher,
    at: Match,
    to: &str,
) -> Option<CellEdit> {
    if at.col >= width {
        return None;
    }
    edit_cell(rows, m, at.row, at.col, to)
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

    fn opts(match_case: bool, whole_cell: bool) -> FindOptions {
        FindOptions {
            match_case,
            whole_cell,
            regex: false,
            areas: Vec::new(),
        }
    }

    /// 探す準備 (試すときは必ず作れる前提)
    fn m(query: &str, o: &FindOptions) -> Matcher {
        matcher(query, o).expect("読める").expect("空でない")
    }

    /// 絞らずに全行を見る
    fn all(data: &[Vec<String>]) -> Rows<'_> {
        Rows::new(data, None)
    }

    #[test]
    fn 大小を区別せずに見つける() {
        let o = opts(false, false);
        let got = find_next(all(&rows()), 2, &m("apple", &o), None, false);
        assert_eq!(got, Some(Match { row: 0, col: 0 }));
    }

    #[test]
    fn 大小を区別すると別のものが当たる() {
        let o = opts(true, false);
        let got = find_next(all(&rows()), 2, &m("apple", &o), None, false);
        assert_eq!(got, Some(Match { row: 2, col: 0 }));
    }

    #[test]
    fn 次の一致へ進む() {
        let o = opts(false, false);
        let first = Match { row: 0, col: 0 };
        let got = find_next(all(&rows()), 2, &m("apple", &o), Some(first), false);
        assert_eq!(got, Some(Match { row: 2, col: 0 }));
    }

    #[test]
    fn 端まで行ったら先頭へ回る() {
        let o = opts(false, false);
        let last = Match { row: 2, col: 1 };
        let got = find_next(all(&rows()), 2, &m("apple", &o), Some(last), false);
        assert_eq!(got, Some(Match { row: 0, col: 0 }));
    }

    #[test]
    fn 前へも探せる() {
        let o = opts(false, false);
        let from = Match { row: 0, col: 0 };
        let got = find_next(all(&rows()), 2, &m("apple", &o), Some(from), true);
        assert_eq!(got, Some(Match { row: 2, col: 1 }));
    }

    #[test]
    fn まるごと同じものだけを当てる() {
        let o = opts(false, true);
        let mt = m("apple", &o);
        assert_eq!(find_next(all(&rows()), 2, &mt, None, false), Some(Match { row: 0, col: 0 }));
        assert_eq!(count(all(&rows()), 2, &mt), 2);
    }

    #[test]
    fn 日本語も見つける() {
        let o = opts(false, false);
        let got = find_next(all(&rows()), 2, &m("黄", &o), None, false);
        assert_eq!(got, Some(Match { row: 1, col: 1 }));
    }

    #[test]
    fn 探す言葉が空なら何もしない() {
        let o = opts(false, false);
        assert!(matcher("", &o).expect("読める").is_none());
    }

    // ---------- 探す範囲 ----------

    fn area(top: usize, left: usize, bottom: usize, right: usize) -> Area {
        Area {
            top,
            left,
            bottom,
            right,
        }
    }

    #[test]
    fn 範囲を決めるとその中だけを探す() {
        let mut o = opts(false, false);
        // 右の列だけを範囲にする
        o.areas = vec![area(0, 1, 2, 1)];
        let mt = m("apple", &o);
        assert_eq!(find_next(all(&rows()), 2, &mt, None, false), Some(Match { row: 2, col: 1 }));
        assert_eq!(count(all(&rows()), 2, &mt), 1);
    }

    #[test]
    fn 範囲を決めなければ表全体を探す() {
        let o = opts(false, false);
        assert_eq!(count(all(&rows()), 2, &m("apple", &o)), 3);
    }

    #[test]
    fn 離れた範囲も両方見る() {
        let mut o = opts(false, false);
        o.areas = vec![area(0, 0, 0, 0), area(2, 1, 2, 1)];
        assert_eq!(count(all(&rows()), 2, &m("apple", &o)), 2);
    }

    #[test]
    fn 範囲の外は置き換えない() {
        let mut o = opts(false, false);
        o.areas = vec![area(2, 1, 2, 1)];
        let list = replace_all(all(&rows()), 2, &m("apple", &o), "梨");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].row, 2);
        assert_eq!(list[0].col, 1);
    }

    // ---------- 正規表現 ----------

    fn re_opts(whole_cell: bool) -> FindOptions {
        FindOptions {
            match_case: false,
            whole_cell,
            regex: true,
            areas: Vec::new(),
        }
    }

    #[test]
    fn 正規表現で探せる() {
        let o = re_opts(false);
        let got = find_next(all(&rows()), 2, &m("^ban", &o), None, false);
        assert_eq!(got, Some(Match { row: 1, col: 0 }));
    }

    #[test]
    fn 正規表現でも大小の区別が効く() {
        let mut o = re_opts(false);
        // 小文字で始まるのは "apple pie" と "apple" の2つ
        o.match_case = true;
        assert_eq!(count(all(&rows()), 2, &m("^apple", &o)), 2);
        // 区別しなければ "Apple" も入って3つ
        o.match_case = false;
        assert_eq!(count(all(&rows()), 2, &m("^apple", &o)), 3);
    }

    #[test]
    fn 正規表現のまるごと一致は前後を留める() {
        let o = re_opts(true);
        // "apple pie" は当たらず、"Apple" と "apple" だけ
        assert_eq!(count(all(&rows()), 2, &m("apples?", &o)), 2);
    }

    #[test]
    fn 正規表現の置換では後方参照が使える() {
        let o = re_opts(false);
        let list = replace_all(all(&rows()), 2, &m("(a)(pple)", &o), "$2-$1");
        assert_eq!(list[0].after, "pple-A");
    }

    #[test]
    fn 読めない正規表現は理由を返す() {
        let o = re_opts(false);
        let Err(err) = matcher("(", &o) else {
            panic!("読めない正規表現なのに通ってしまった");
        };
        assert!(err.contains("正規表現"), "{err}");
    }

    // ---------- 置き換え ----------

    #[test]
    fn セルの中の一致を全部置き換える() {
        assert_eq!(replace_in("aXaXa", &['x'], "-", false), "a-a-a");
    }

    #[test]
    fn 置き換えても他の文字は残る() {
        let o = opts(false, false);
        let list = replace_all(all(&rows()), 2, &m("apple", &o), "梨");
        assert_eq!(list.len(), 3);
        assert_eq!(list[1].after, "梨 pie");
    }

    #[test]
    fn まるごと置き換える() {
        let o = opts(false, true);
        let list = replace_all(all(&rows()), 2, &m("apple", &o), "梨");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].after, "梨");
    }

    #[test]
    fn 指定のセルだけを置き換える() {
        let o = opts(false, false);
        let at = Match { row: 2, col: 0 };
        let got = replace_at(all(&rows()), 2, &m("apple", &o), at, "梨").expect("当たる");
        assert_eq!((got.row, got.col), (2, 0));
        assert_eq!(got.after, "梨 pie");
    }

    #[test]
    fn 引っかからないセルは置き換えない() {
        let o = opts(false, false);
        let at = Match { row: 1, col: 0 };
        assert!(replace_at(all(&rows()), 2, &m("apple", &o), at, "梨").is_none());
    }

    #[test]
    fn 探す範囲の外のセルは置き換えない() {
        let mut o = opts(false, false);
        o.areas = vec![Area {
            top: 0,
            bottom: 0,
            left: 0,
            right: 1,
        }];
        let at = Match { row: 2, col: 0 };
        assert!(replace_at(all(&rows()), 2, &m("apple", &o), at, "梨").is_none());
    }
}
