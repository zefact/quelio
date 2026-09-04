//! 表の中の「端まで飛ぶ」動き (表計算ソフトの Ctrl+矢印 と同じ)。
//!
//! 全行はRust側が持っていて、画面には見えている行しか無い。
//! 100万行の途中から端まで飛ぶには、ここで数えるしかない。
//!
//! 動きは表計算ソフトに合わせてある:
//!  - 今いる所も次も埋まっている → 続いている最後の所で止まる
//!  - 今いる所は埋まっていて次が空 → 空を飛び越えて、次に埋まっている所へ
//!  - 今いる所が空 → 次に埋まっている所へ (無ければ端まで)

/// 一方向へ端まで飛んだ先を返す。
///
/// `filled` はその位置に中身が入っているか、`len` は並びの長さ、
/// `forward` は後ろ (下・右) へ進むかどうか
pub fn edge<F: Fn(usize) -> bool>(filled: F, from: usize, len: usize, forward: bool) -> usize {
    if len == 0 {
        return 0;
    }
    let last = len - 1;
    let from = from.min(last);
    let next = |i: usize| {
        if forward {
            if i >= last {
                None
            } else {
                Some(i + 1)
            }
        } else if i == 0 {
            None
        } else {
            Some(i - 1)
        }
    };

    // もう端にいるなら動かない
    let Some(mut cur) = next(from) else {
        return from;
    };

    if filled(from) && filled(cur) {
        // 続いているあいだ進み、途切れる手前で止まる
        while let Some(n) = next(cur) {
            if !filled(n) {
                break;
            }
            cur = n;
        }
        return cur;
    }

    // 空を飛び越えて、次に中身のある所へ (無ければ端まで)
    loop {
        if filled(cur) {
            return cur;
        }
        match next(cur) {
            Some(n) => cur = n,
            None => return cur,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "1" が入っている所、"." が空
    fn line(pattern: &str) -> (impl Fn(usize) -> bool + '_, usize) {
        let cells: Vec<bool> = pattern.chars().map(|c| c == '1').collect();
        let len = cells.len();
        (move |i: usize| cells[i], len)
    }

    fn go(pattern: &str, from: usize, forward: bool) -> usize {
        let (filled, len) = line(pattern);
        edge(filled, from, len, forward)
    }

    #[test]
    fn 続きの終わりで止まる() {
        // 0から下へ: 2まで続いているので2で止まる
        assert_eq!(go("111..1", 0, true), 2);
    }

    #[test]
    fn 空を飛び越えて次の中身へ() {
        assert_eq!(go("1...1.", 0, true), 4);
    }

    #[test]
    fn 空から始めたら次の中身へ() {
        assert_eq!(go("..1..", 0, true), 2);
    }

    #[test]
    fn 先に中身が無ければ端まで行く() {
        assert_eq!(go("1....", 0, true), 4);
    }

    #[test]
    fn 端にいれば動かない() {
        assert_eq!(go("111", 2, true), 2);
        assert_eq!(go("111", 0, false), 0);
    }

    #[test]
    fn 上へも同じように動く() {
        assert_eq!(go("1..111", 5, false), 3);
        assert_eq!(go("1..111", 3, false), 0);
    }

    #[test]
    fn 空の並びなら0を返す() {
        let (filled, len) = line("");
        assert_eq!(edge(filled, 0, len, true), 0);
    }

    #[test]
    fn 範囲の外から始めても端に収める() {
        assert_eq!(go("111", 9, true), 2);
    }
}
