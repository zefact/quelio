//! 選んだ範囲を、クリップボードへ渡すタブ区切りテキストにする。
//!
//! 全行はRust側が持っていて、画面には見えている行しか無い。
//! 画面に出ていない行を選んでいてもコピーできるよう、文字を組み立てるのはここでやる。
//!
//! ⌘+クリックで離れた所も選べるので、選んだ位置の関係はそのまま保つ。
//! 横に並んでいるものは同じ行にタブで並び、間が空いていれば
//! 空いた列のぶんだけ空の項目が入る。
//! 縦に離れているぶんは詰める (何万行も離れた所を選んだときに、
//! 空の行がその数だけ出てしまうため)。
//!
//! 値そのものは変えない。
//! CSVエディタは開いたファイルをそのまま扱う道具なので、
//! 表計算ソフト向けの細工 (数式に見える値へ `'` を足すなど) はしない
//! (ファイルを直接開いたときと同じ中身が渡る)

/// 一度にコピーできるセルの上限。
///
/// 100万行を全部選ばれると、組み立てた文字だけで数百MBになる。
/// 断ったほうが、固まって何も分からなくなるよりよい
pub const MAX_CELLS: usize = 2_000_000;

/// セル1つぶんの表記。
///
/// 値にタブや改行が入っていると、貼り付け先で列や行が増えてしまう。
/// 表計算ソフトはダブルクォート囲みを解釈するので、そのときだけ囲む。
/// 画面側の `gridCopy.ts` (SQL結果のコピー) と同じ判断にしてある
pub fn tsv_cell(text: &str) -> String {
    let quoted = text.starts_with('"') || text.contains(['\t', '\r', '\n']);
    if !quoted {
        return text.to_string();
    }
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// 行の並びをタブ区切りの1つのテキストにする (行の区切りは改行)
pub fn to_tsv<'a, R, C>(rows: R) -> String
where
    R: IntoIterator<Item = C>,
    C: IntoIterator<Item = &'a str>,
{
    let mut out = String::new();
    for (i, row) in rows.into_iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        for (j, cell) in row.into_iter().enumerate() {
            if j > 0 {
                out.push('\t');
            }
            out.push_str(&tsv_cell(cell));
        }
    }
    out
}


/// 選んでいる四角1つ (端を含む)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub top: usize,
    pub bottom: usize,
    pub left: usize,
    pub right: usize,
}

/// 出す表の形
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// 出す行 (元の行番号。選んだセルが1つも無い行は入らない)
    pub rows: Vec<usize>,
    /// 出す列の範囲 (端を含む)
    pub left: usize,
    pub right: usize,
}

impl Plan {
    /// 出す表のセル数 (選んでいない隙間も含む)
    pub fn cells(&self) -> usize {
        self.rows.len().saturating_mul(self.right - self.left + 1)
    }
}

/// そのセルがどれかの四角に入っているか
pub fn selected(rects: &[Rect], row: usize, col: usize) -> bool {
    rects
        .iter()
        .any(|r| row >= r.top && row <= r.bottom && col >= r.left && col <= r.right)
}

/// 出す表の形を決める。
///
/// 列は「いちばん左の四角の左端」から「いちばん右の四角の右端」まで。
/// 間に選んでいない列があっても、離れ具合が分かるように残す。
/// 行は選んだセルのある行だけを、上から順に並べる
pub fn plan(rects: &[Rect]) -> Option<Plan> {
    let mut rows: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    let mut left = usize::MAX;
    let mut right = 0usize;
    for r in rects {
        if r.top > r.bottom || r.left > r.right {
            continue;
        }
        rows.extend(r.top..=r.bottom);
        left = left.min(r.left);
        right = right.max(r.right);
    }
    if rows.is_empty() {
        return None;
    }
    Some(Plan {
        rows: rows.into_iter().collect(),
        left,
        right,
    })
}

/// 決めた形に沿って、タブ区切りのテキストを組み立てる。
///
/// `value` はセルの中身を返す。
/// 画面に出ていない行も渡せるよう、中身の取り出しは呼ぶ側に任せる
pub fn to_text<'a>(
    plan: &Plan,
    rects: &[Rect],
    value: impl Fn(usize, usize) -> &'a str,
) -> String {
    let value = &value;
    to_tsv(plan.rows.iter().map(move |&row| {
        (plan.left..=plan.right).map(move |col| {
            if selected(rects, row, col) {
                value(row, col)
            } else {
                ""
            }
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 表の形のままタブと改行で並べる() {
        assert_eq!(to_tsv([["a", "b"], ["c", "d"]]), "a\tb\nc\td");
    }

    #[test]
    fn セル1つだけなら中身がそのまま出る() {
        assert_eq!(to_tsv([["あ"]]), "あ");
    }

    #[test]
    fn 空欄はそのまま空で置く() {
        assert_eq!(to_tsv([["a", "", "c"]]), "a\t\tc");
    }

    #[test]
    fn タブを含む値は囲んで列がずれないようにする() {
        assert_eq!(to_tsv([["a\tb", "c"]]), "\"a\tb\"\tc");
    }

    #[test]
    fn 改行を含む値は囲んで行がずれないようにする() {
        assert_eq!(to_tsv([["a\nb"]]), "\"a\nb\"");
    }

    #[test]
    fn 囲むときは中のダブルクォートを二重にする() {
        assert_eq!(to_tsv([["a\t\"b\""]]), "\"a\t\"\"b\"\"\"");
    }

    #[test]
    fn 先頭がダブルクォートの値も囲む() {
        // 囲まずに渡すと、貼り付け先が引用の始まりとして読んでしまう
        assert_eq!(to_tsv([["\"a"]]), "\"\"\"a\"");
    }

    #[test]
    fn 途中のダブルクォートだけなら囲まない() {
        // 囲むと、テキストエディタへ貼ったときに見た目が変わってしまう
        assert_eq!(to_tsv([["a\"b"]]), "a\"b");
    }

    #[test]
    fn 数式に見える値でも中身を変えない() {
        // CSVエディタは開いたファイルをそのまま扱う (`'` を足さない)
        assert_eq!(to_tsv([["=1+1", "-1"]]), "=1+1\t-1");
    }

    #[test]
    fn 行が無ければ空になる() {
        let rows: Vec<Vec<&str>> = vec![];
        assert_eq!(to_tsv(rows), "");
    }

    // ---------- 選んだ位置の関係 ----------

    fn rect(top: usize, left: usize, bottom: usize, right: usize) -> Rect {
        Rect {
            top,
            left,
            bottom,
            right,
        }
    }

    /// 中身は「行,列」にしておくと、どこが出たか一目で分かる
    fn grid(rects: &[Rect]) -> String {
        let plan = plan(rects).expect("選んでいる四角があること");
        let cells: Vec<Vec<String>> = plan
            .rows
            .iter()
            .map(|&r| (plan.left..=plan.right).map(|c| format!("{r},{c}")).collect())
            .collect();
        to_text(&plan, rects, |r, c| {
            let i = plan.rows.iter().position(|&x| x == r).unwrap();
            cells[i][c - plan.left].as_str()
        })
    }

    #[test]
    fn 何も選んでいなければ形を決められない() {
        assert_eq!(plan(&[]), None);
    }

    #[test]
    fn 四角1つならその範囲がそのまま出る() {
        assert_eq!(grid(&[rect(1, 2, 2, 3)]), "1,2\t1,3\n2,2\t2,3");
    }

    #[test]
    fn 横に並んだ2つは同じ行にタブで並ぶ() {
        // 5行目の1列目と2列目を別々に選んだ形
        assert_eq!(grid(&[rect(5, 1, 5, 1), rect(5, 2, 5, 2)]), "5,1\t5,2");
    }

    #[test]
    fn 離れているぶんだけ空の項目が入る() {
        // 1列目と4列目。間の2・3列目は選んでいないので空で埋まる
        assert_eq!(grid(&[rect(5, 1, 5, 1), rect(5, 4, 5, 4)]), "5,1\t\t\t5,4");
    }

    #[test]
    fn 縦に離れていても間の行は出さない() {
        // 2行目と9行目。間の7行は空行にせず詰める
        assert_eq!(grid(&[rect(2, 0, 2, 0), rect(9, 0, 9, 0)]), "2,0\n9,0");
    }

    #[test]
    fn 選んでいない所は行が違えば空になる() {
        // 左上と右下を選ぶと、選んでいない角は空欄で出る
        assert_eq!(grid(&[rect(0, 0, 0, 0), rect(1, 1, 1, 1)]), "0,0\t\n\t1,1");
    }

    #[test]
    fn 重なっていても行は1度しか出ない() {
        let p = plan(&[rect(0, 0, 2, 0), rect(1, 0, 3, 0)]).unwrap();
        assert_eq!(p.rows, vec![0, 1, 2, 3]);
    }

    #[test]
    fn 選ぶ順が逆でも同じ形になる() {
        assert_eq!(
            plan(&[rect(5, 4, 5, 4), rect(5, 1, 5, 1)]),
            plan(&[rect(5, 1, 5, 1), rect(5, 4, 5, 4)])
        );
    }

    #[test]
    fn セル数は隙間も含めて数える() {
        // 1行 × (1列目から4列目まで) = 4セル
        let p = plan(&[rect(5, 1, 5, 1), rect(5, 4, 5, 4)]).unwrap();
        assert_eq!(p.cells(), 4);
    }
}
