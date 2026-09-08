//! 画面に出ている行の並び。
//!
//! フィルタで絞ると、画面の n 行目は元のファイルの別の行になる。
//! 行を取り出す所すべてで同じ数え方になるよう、ここにまとめてある。
//!
//! 「画面での番号」と「元の行番号」は混ぜないこと。
//! 画面から届く位置は画面での番号、書き換えに使う位置は元の行番号

/// 画面に出ている行 (絞っていなければ全行がそのまま並ぶ)
#[derive(Clone, Copy)]
pub struct Rows<'a> {
    all: &'a [Vec<String>],
    /// 見えている行の元の行番号。`None` なら絞っていない
    view: Option<&'a [usize]>,
}

impl<'a> Rows<'a> {
    /// 見る並びを決める (`view` が `None` なら全行そのまま)
    pub fn new(all: &'a [Vec<String>], view: Option<&'a [usize]>) -> Rows<'a> {
        Rows { all, view }
    }

    /// 画面に出ている行数
    pub fn len(&self) -> usize {
        match self.view {
            Some(v) => v.len(),
            None => self.all.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 絞っているか
    pub fn filtered(&self) -> bool {
        self.view.is_some()
    }

    /// 画面での `i` 行目が、元の何行目か
    pub fn real(&self, i: usize) -> Option<usize> {
        match self.view {
            Some(v) => v.get(i).copied(),
            None => (i < self.all.len()).then_some(i),
        }
    }

    /// 画面での `i` 行目
    pub fn get(&self, i: usize) -> Option<&'a Vec<String>> {
        self.all.get(self.real(i)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Vec<Vec<String>> {
        vec![
            vec!["a".to_string()],
            vec!["b".to_string()],
            vec!["c".to_string()],
        ]
    }

    #[test]
    fn 絞っていなければ元の並びのまま() {
        let all = data();
        let rows = Rows::new(&all, None);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows.real(2), Some(2));
        assert_eq!(rows.get(1).map(|r| r[0].as_str()), Some("b"));
        assert!(!rows.filtered());
    }

    #[test]
    fn 絞ると飛び飛びの行が続けて並ぶ() {
        let all = data();
        let view = vec![2usize];
        let rows = Rows::new(&all, Some(&view));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows.real(0), Some(2));
        assert_eq!(rows.get(0).map(|r| r[0].as_str()), Some("c"));
        assert!(rows.filtered());
    }

    #[test]
    fn 行の数を超えたら何も返さない() {
        let all = data();
        assert!(Rows::new(&all, None).get(3).is_none());
        assert!(Rows::new(&all, None).real(3).is_none());
        let view = vec![1usize];
        assert!(Rows::new(&all, Some(&view)).get(1).is_none());
    }

    #[test]
    fn 並べ替えた順にも出せる() {
        let all = data();
        let view = vec![2usize, 0];
        let rows = Rows::new(&all, Some(&view));
        let got: Vec<&str> = (0..rows.len())
            .filter_map(|i| rows.get(i))
            .map(|r| r[0].as_str())
            .collect();
        assert_eq!(got, vec!["c", "a"]);
    }
}
