//! 値の比べ方と、並べ替え。
//!
//! 表計算ソフトと同じく、数として読めるものは数として、
//! そうでないものは文字として比べる。
//! 並べ替えはファイルの中身を動かさず、「どの順に見せるか」だけを決める
//! (CSVエディタは値も並びも勝手に変えない道具なので、保存すると元の順のまま)

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

/// 並べ替えの指定
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub col: usize,
    /// 大きい順に並べるか
    pub desc: bool,
}

/// 英字の大小を無視して比べるための形
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// 数として比べられるなら、その数
pub fn number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok()
}

/**
 * 大小を比べる。
 *
 * どちらも数として読めれば数として、そうでなければ文字として比べる
 * (文字は英字の大小を無視する)
 */
pub fn compare(a: &str, b: &str) -> Ordering {
    match (number(a), number(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => lower(a).cmp(&lower(b)),
    }
}

/**
 * 並べ替えのための比べ方。
 *
 * 数として読めるものを先に、次に文字。空のセルはいつも最後にする
 * (大きい順にしても、空が先頭に並ぶと読みにくいため)
 */
fn rank(a: &str, b: &str, desc: bool) -> Ordering {
    let (ea, eb) = (a.trim().is_empty(), b.trim().is_empty());
    if ea || eb {
        // 空はいつも後ろ (両方空なら同じ)
        return eb.cmp(&ea).reverse();
    }
    let out = match (number(a), number(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        // 数として読めるものを先に出す
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => lower(a).cmp(&lower(b)),
    };
    if desc {
        out.reverse()
    } else {
        out
    }
}

/**
 * 見せる順を決める。
 *
 * `base` は絞り込みで残った行 (絞っていなければ `None`)。
 * 並べ替えの指定が無ければ `base` をそのまま返す。
 *
 * 同じ値どうしは元の並びのままにする (何度掛けても順が入れ替わらない)
 */
pub fn arrange(
    rows: &[Vec<String>],
    base: Option<Vec<usize>>,
    sort: Option<Sort>,
) -> Option<Vec<usize>> {
    let Some(sort) = sort else {
        return base;
    };
    let mut view = base.unwrap_or_else(|| (0..rows.len()).collect());
    let cell = |i: usize| {
        rows.get(i)
            .and_then(|r| r.get(sort.col))
            .map(|s| s.as_str())
            .unwrap_or("")
    };
    view.sort_by(|&a, &b| rank(cell(a), cell(b), sort.desc));
    Some(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Vec<String>> {
        let data = [["b", "10"], ["a", ""], ["C", "9"], ["", "100"]];
        data.iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    #[test]
    fn 数は数として比べる() {
        assert_eq!(compare("9", "10"), Ordering::Less);
        // 文字として比べると "10" のほうが先になってしまう
        assert_eq!(compare("あ", "い"), Ordering::Less);
    }

    #[test]
    fn 文字は大小を区別しないで比べる() {
        assert_eq!(compare("apple", "Apple"), Ordering::Equal);
    }

    #[test]
    fn 並べ替えの指定が無ければそのまま() {
        assert_eq!(arrange(&rows(), None, None), None);
        let base = Some(vec![2, 0]);
        assert_eq!(arrange(&rows(), base.clone(), None), base);
    }

    #[test]
    fn 小さい順に並べる() {
        let got = arrange(&rows(), None, Some(Sort { col: 1, desc: false }));
        // 9, 10, 100 の順。空は最後
        assert_eq!(got, Some(vec![2, 0, 3, 1]));
    }

    #[test]
    fn 大きい順でも空は最後() {
        let got = arrange(&rows(), None, Some(Sort { col: 1, desc: true }));
        assert_eq!(got, Some(vec![3, 0, 2, 1]));
    }

    #[test]
    fn 文字は大小を区別せずに並べる() {
        let got = arrange(&rows(), None, Some(Sort { col: 0, desc: false }));
        // a, b, C の順 (空は最後)
        assert_eq!(got, Some(vec![1, 0, 2, 3]));
    }

    #[test]
    fn 絞ったあとの行だけを並べ替える() {
        let base = Some(vec![0, 2]);
        let got = arrange(&rows(), base, Some(Sort { col: 1, desc: false }));
        assert_eq!(got, Some(vec![2, 0]));
    }

    #[test]
    fn 同じ値どうしは元の並びのまま() {
        let same: Vec<Vec<String>> = (0..3).map(|_| vec!["x".to_string()]).collect();
        let got = arrange(&same, None, Some(Sort { col: 0, desc: true }));
        assert_eq!(got, Some(vec![0, 1, 2]));
    }
}
