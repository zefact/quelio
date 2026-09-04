//! 選んだ範囲の要約 (セル数・入っているセル数・合計)。
//!
//! 全行はRust側が持っていて、画面には見えている行しか無い。
//! 100万行を選んでも数えられるよう、集計はここでやる。
//!
//! 合計は「数値だけを選んだとき」に出す。
//! 数値以外が混ざっているときは合計に意味が無いので、
//! 代わりに中身の入っているセルの数を数える (表計算ソフトと同じ考え方)

/// 選んだ範囲の要約
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// 選んでいるセルの数
    pub cells: usize,
    /// 中身の入っているセルの数 (空欄は数えない)
    pub filled: usize,
    /// すべて数値なら、その合計 (数値以外が混ざるなら None)
    pub sum: Option<String>,
}

/// 小数点以下の桁数 ("1.50" なら 2)
fn decimals_of(s: &str) -> usize {
    match s.split_once('.') {
        // 指数表記 ("1.5e3") は桁数を数えても意味がないので 0 にする
        Some((_, rest)) if rest.chars().all(|c| c.is_ascii_digit()) => rest.len(),
        _ => 0,
    }
}

/// 3桁ごとにカンマを打つ (小数点以下はそのまま)
fn group(s: &str) -> String {
    let (sign, body) = match s.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", s),
    };
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let mut out = String::with_capacity(int.len() + int.len() / 3 + 2);
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    match frac {
        Some(f) => format!("{sign}{out}.{f}"),
        None => format!("{sign}{out}"),
    }
}

/// 選んだセルの文字列から要約を作る。
///
/// 100万行×20列を選ばれることがあるので、
/// 受け取るのは並びではなく、順に取り出せるものにしてある
/// (全部を一度に置くとそれだけでメモリを食う)
pub fn summarize<'a>(texts: impl IntoIterator<Item = &'a str>) -> Summary {
    let mut cells = 0usize;
    let mut filled = 0;
    // 整数だけで足せているあいだの合計 (小数が出たら None にする)
    let mut ints: Option<i128> = Some(0);
    let mut floats = 0f64;
    let mut decimals = 0usize;
    // 数値以外が混ざったか
    let mut numeric = true;
    // 数値を1つでも見たか (空欄だけのときは合計を出さない)
    let mut any = false;

    for text in texts {
        cells += 1;
        let s = text.trim();
        if s.is_empty() {
            continue;
        }
        filled += 1;
        if !numeric {
            continue;
        }
        if let Ok(n) = s.parse::<i128>() {
            any = true;
            ints = ints.map(|acc| acc.saturating_add(n));
            floats += n as f64;
            continue;
        }
        if let Ok(n) = s.parse::<f64>() {
            if n.is_finite() {
                any = true;
                // 小数が出たら、以降は小数として足す
                ints = None;
                floats += n;
                decimals = decimals.max(decimals_of(s));
                continue;
            }
        }
        numeric = false;
    }

    let sum = if numeric && any {
        Some(group(&match ints {
            Some(n) => n.to_string(),
            None => format!("{floats:.decimals$}"),
        }))
    } else {
        None
    };
    Summary { cells, filled, sum }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum_of(v: &[&str]) -> Option<String> {
        summarize(v.iter().copied()).sum
    }

    #[test]
    fn 整数だけなら合計を出す() {
        assert_eq!(sum_of(&["1", "2", "3"]), Some("6".to_string()));
    }

    #[test]
    fn 大きな整数でも桁が落ちない() {
        assert_eq!(
            sum_of(&["9007199254740993", "1"]),
            Some("9,007,199,254,740,994".to_string())
        );
    }

    #[test]
    fn 小数は桁数を揃えて出す() {
        assert_eq!(sum_of(&["0.1", "0.2"]), Some("0.3".to_string()));
    }

    #[test]
    fn 整数と小数が混ざっても足せる() {
        assert_eq!(sum_of(&["1", "0.5"]), Some("1.5".to_string()));
    }

    #[test]
    fn 空欄は飛ばす() {
        let s = summarize(["1", "", "  ", "2"]);
        assert_eq!(s.cells, 4);
        assert_eq!(s.filled, 2);
        assert_eq!(s.sum, Some("3".to_string()));
    }

    #[test]
    fn 数値以外が混ざったら合計を出さない() {
        let s = summarize(["1", "あ", "3"]);
        assert_eq!(s.sum, None);
        assert_eq!(s.filled, 3);
    }

    #[test]
    fn 空欄だけなら合計を出さない() {
        let s = summarize(["", ""]);
        assert_eq!(s.sum, None);
        assert_eq!(s.filled, 0);
    }

    #[test]
    fn 負の数にもカンマを打つ() {
        assert_eq!(sum_of(&["-1234567"]), Some("-1,234,567".to_string()));
    }

    #[test]
    fn 前後の空白は無視する() {
        assert_eq!(sum_of(&[" 1 ", "2"]), Some("3".to_string()));
    }

    #[test]
    fn 前ゼロの値も数値として足す() {
        // 表示は変えないが、合計を出すぶんには数値として扱う
        assert_eq!(sum_of(&["007", "1"]), Some("8".to_string()));
    }
}
