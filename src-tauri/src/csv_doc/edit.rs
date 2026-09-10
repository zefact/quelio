//! CSVの編集操作と、その取り消し。
//!
//! 1つの操作を「逆の操作を作れる形」で持ち、取り消しのスタックに積む。
//! 画面から来るのは「セルを直す」「行を足す」といった意味のある単位なので、
//! 取り消しもその単位で戻る (1文字ずつは戻らない)

/// セル1つの書き換え
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellEdit {
    pub row: usize,
    pub col: usize,
    pub before: String,
    pub after: String,
}

/**
 * 取り消せる操作1つ。
 *
 * どの操作も「中身」まで持たせてあり、逆操作が同じ形で作れる
 * (挿入の逆は同じ中身の削除、削除の逆は同じ中身の挿入)。
 * こうしておくと、取り消しとやり直しを何度往復しても中身が痩せない
 */
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Edit {
    /// セルの書き換え (一括置換は複数まとめて1操作にする)
    Cells(Vec<CellEdit>),
    /// 行を入れる (新しい行なら中身は空文字で埋めたもの)
    InsertRows { at: usize, rows: Vec<Vec<String>> },
    /// 行を消す (中身は取り消し用の控え)
    DeleteRows { at: usize, rows: Vec<Vec<String>> },
    /// 列を入れる (values は各行に入れる値。新しい列なら全部空文字)
    InsertCol {
        at: usize,
        name: String,
        values: Vec<String>,
    },
    /// 列を消す (name と values は取り消し用の控え)
    DeleteCol {
        at: usize,
        name: String,
        values: Vec<String>,
    },
    /// 列の名前を変える
    RenameCol {
        at: usize,
        before: String,
        after: String,
    },
    /// 固定長のヘッダ・トレーラのレコードを書き換える。
    ///
    /// 項目の数が少なく、行の増減も起きないので、丸ごと控える
    EdgeRow {
        /// トレーラなら true、ヘッダなら false
        trailer: bool,
        before: Vec<String>,
        after: Vec<String>,
    },
    /// いくつかの操作をひとまとめにしたもの。
    ///
    /// 貼り付けのように「行を足してから値を入れる」操作を、
    /// 取り消し1回で戻せるようにする。
    /// 名前は中身から決められないので、まとめた側が付ける
    Group {
        label: &'static str,
        edits: Vec<Edit>,
    },
}

impl Edit {
    /// 画面に出す操作の名前 (「元に戻す: セルの編集」のように使う)
    pub fn label(&self) -> &'static str {
        match self {
            Edit::Cells(v) if v.len() == 1 => "セルの編集",
            Edit::Cells(_) => "まとめて置換",
            Edit::InsertRows { .. } => "行の追加",
            Edit::DeleteRows { .. } => "行の削除",
            Edit::InsertCol { .. } => "列の追加",
            Edit::DeleteCol { .. } => "列の削除",
            Edit::RenameCol { .. } => "列名の変更",
            Edit::EdgeRow { trailer, .. } => {
                if *trailer {
                    "トレーラの編集"
                } else {
                    "ヘッダの編集"
                }
            }
            Edit::Group { label, .. } => label,
        }
    }

    /// この操作の逆
    pub fn invert(&self) -> Edit {
        match self {
            Edit::Cells(list) => Edit::Cells(
                list.iter()
                    .map(|c| CellEdit {
                        row: c.row,
                        col: c.col,
                        before: c.after.clone(),
                        after: c.before.clone(),
                    })
                    .collect(),
            ),
            Edit::InsertRows { at, rows } => Edit::DeleteRows {
                at: *at,
                rows: rows.clone(),
            },
            Edit::DeleteRows { at, rows } => Edit::InsertRows {
                at: *at,
                rows: rows.clone(),
            },
            Edit::InsertCol { at, name, values } => Edit::DeleteCol {
                at: *at,
                name: name.clone(),
                values: values.clone(),
            },
            Edit::DeleteCol { at, name, values } => Edit::InsertCol {
                at: *at,
                name: name.clone(),
                values: values.clone(),
            },
            Edit::RenameCol { at, before, after } => Edit::RenameCol {
                at: *at,
                before: after.clone(),
                after: before.clone(),
            },
            Edit::EdgeRow {
                trailer,
                before,
                after,
            } => Edit::EdgeRow {
                trailer: *trailer,
                before: after.clone(),
                after: before.clone(),
            },
            // まとめた操作の逆は、後ろから順に逆をたどること
            Edit::Group { label, edits } => Edit::Group {
                label,
                edits: edits.iter().rev().map(|e| e.invert()).collect(),
            },
        }
    }
}

/// 編集の対象 (ヘッダと本文)。
///
/// `CsvDoc` から編集に要る部分だけを借りて渡す。
/// こうしておくと、操作の適用をこのファイルの中だけで書ける
pub struct Sheet<'a> {
    pub header: &'a mut Vec<String>,
    pub rows: &'a mut Vec<Vec<String>>,
    /// 固定長のヘッダレコードの値 (使わないときは空)
    pub head: &'a mut Vec<String>,
    /// 固定長のトレーラレコードの値 (使わないときは空)
    pub tail: &'a mut Vec<String>,
}

impl Sheet<'_> {
    fn width(&self) -> usize {
        self.header.len()
    }

    /// 操作を適用する。範囲の外を指していたらエラーにして、状態は変えない
    pub fn apply(&mut self, edit: &Edit) -> Result<(), String> {
        match edit {
            Edit::Cells(list) => {
                // 途中で失敗して半端に書き換わらないよう、先に全部を確かめる
                for c in list {
                    if c.row >= self.rows.len() || c.col >= self.width() {
                        return Err("そのセルは見つかりません".into());
                    }
                }
                for c in list {
                    self.rows[c.row][c.col] = c.after.clone();
                }
            }
            Edit::InsertRows { at, rows } => {
                if *at > self.rows.len() {
                    return Err("その位置には行を足せません".into());
                }
                let w = self.width();
                for (i, r) in rows.iter().enumerate() {
                    let mut r = r.clone();
                    // 控えと今の列数が違っていても崩れないようにする
                    r.resize(w, String::new());
                    self.rows.insert(at + i, r);
                }
            }
            Edit::DeleteRows { at, rows } => {
                let end = at + rows.len();
                if rows.is_empty() || end > self.rows.len() {
                    return Err("その行は見つかりません".into());
                }
                self.rows.drain(*at..end);
            }
            Edit::InsertCol { at, name, values } => {
                if *at > self.width() {
                    return Err("その位置には列を足せません".into());
                }
                self.header.insert(*at, name.clone());
                for (i, r) in self.rows.iter_mut().enumerate() {
                    r.insert(*at, values.get(i).cloned().unwrap_or_default());
                }
            }
            Edit::DeleteCol { at, .. } => {
                if *at >= self.width() {
                    return Err("その列は見つかりません".into());
                }
                if self.width() == 1 {
                    return Err("最後の1列は消せません".into());
                }
                self.header.remove(*at);
                for r in self.rows.iter_mut() {
                    r.remove(*at);
                }
            }
            Edit::RenameCol { at, after, .. } => {
                if *at >= self.width() {
                    return Err("その列は見つかりません".into());
                }
                self.header[*at] = after.clone();
            }
            Edit::EdgeRow {
                trailer, after, ..
            } => {
                let slot = if *trailer {
                    &mut *self.tail
                } else {
                    &mut *self.head
                };
                *slot = after.clone();
            }
            Edit::Group { edits, .. } => {
                for (i, e) in edits.iter().enumerate() {
                    let Err(err) = self.apply(e) else { continue };
                    // 途中で駄目になったら、済んだぶんを戻して手を付ける前に返す
                    for done in edits[..i].iter().rev() {
                        self.apply(&done.invert())?;
                    }
                    return Err(err);
                }
            }
        }
        Ok(())
    }

    /// 空の行を入れる操作を作る
    pub fn insert_rows(&self, at: usize, count: usize) -> Result<Edit, String> {
        if count == 0 {
            return Err("追加する行数を指定してください".into());
        }
        if at > self.rows.len() {
            return Err("その位置には行を足せません".into());
        }
        Ok(Edit::InsertRows {
            at,
            rows: vec![vec![String::new(); self.width()]; count],
        })
    }

    /// 行を消す操作を作る (消える中身を控えてから渡す)
    pub fn delete_rows(&self, at: usize, count: usize) -> Result<Edit, String> {
        let end = at + count;
        if count == 0 || end > self.rows.len() {
            return Err("その行は見つかりません".into());
        }
        Ok(Edit::DeleteRows {
            at,
            rows: self.rows[at..end].to_vec(),
        })
    }

    /// 空の列を入れる操作を作る
    pub fn insert_col(&self, at: usize, name: &str) -> Result<Edit, String> {
        if at > self.width() {
            return Err("その位置には列を足せません".into());
        }
        Ok(Edit::InsertCol {
            at,
            name: name.to_string(),
            values: vec![String::new(); self.rows.len()],
        })
    }

    /// 列を消す操作を作る (消える名前と全行の値を控える)
    pub fn delete_col(&self, at: usize) -> Result<Edit, String> {
        if at >= self.width() {
            return Err("その列は見つかりません".into());
        }
        Ok(Edit::DeleteCol {
            at,
            name: self.header[at].clone(),
            values: self.rows.iter().map(|r| r[at].clone()).collect(),
        })
    }

    /// 空の列をまとめて入れる操作を作る (取り消し1回で戻る)
    pub fn insert_cols(&self, at: usize, name: &str, count: usize) -> Result<Edit, String> {
        if count == 0 {
            return Err("追加する列数を指定してください".into());
        }
        if at > self.width() {
            return Err("その位置には列を足せません".into());
        }
        if count == 1 {
            return self.insert_col(at, name);
        }
        // 左から順に入れるので、i 番目は at + i の位置に入る
        let edits = (0..count)
            .map(|i| Edit::InsertCol {
                at: at + i,
                name: name.to_string(),
                values: vec![String::new(); self.rows.len()],
            })
            .collect();
        Ok(Edit::Group {
            label: "列の追加",
            edits,
        })
    }

    /// 列をまとめて消す操作を作る (取り消し1回で戻る)
    pub fn delete_cols(&self, at: usize, count: usize) -> Result<Edit, String> {
        if count == 0 || at + count > self.width() {
            return Err("その列は見つかりません".into());
        }
        if self.width() <= count {
            return Err("最後の1列は消せません".into());
        }
        if count == 1 {
            return self.delete_col(at);
        }
        /*
         * 1つ消すたびに右が左へ詰まるので、消す位置はいつも `at`。
         * 控えは元の並びから順に取る
         */
        let edits = (0..count)
            .map(|i| Edit::DeleteCol {
                at,
                name: self.header[at + i].clone(),
                values: self.rows.iter().map(|r| r[at + i].clone()).collect(),
            })
            .collect();
        Ok(Edit::Group {
            label: "列の削除",
            edits,
        })
    }

    /// 列の名前を変える操作を作る
    pub fn rename_col(&self, at: usize, name: &str) -> Result<Edit, String> {
        if at >= self.width() {
            return Err("その列は見つかりません".into());
        }
        Ok(Edit::RenameCol {
            at,
            before: self.header[at].clone(),
            after: name.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 試すときはヘッダ・トレーラを使わないので、空の入れ物を借りる
    struct Edges {
        head: Vec<String>,
        tail: Vec<String>,
    }

    fn sheet<'a>(
        rows: &'a mut Vec<Vec<String>>,
        header: &'a mut Vec<String>,
        edges: &'a mut Edges,
    ) -> Sheet<'a> {
        Sheet {
            header,
            rows,
            head: &mut edges.head,
            tail: &mut edges.tail,
        }
    }

    fn text(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn cell(row: usize, col: usize, before: &str, after: &str) -> CellEdit {
        CellEdit {
            row,
            col,
            before: before.to_string(),
            after: after.to_string(),
        }
    }

    #[test]
    fn 列をまとめて足す() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"]), text(&["3", "4"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let e = sheet(&mut rows, &mut header, &mut edges)
            .insert_cols(1, "新しい列", 3)
            .unwrap();
        assert_eq!(e.label(), "列の追加");
        let mut sh = sheet(&mut rows, &mut header, &mut edges);
        sh.apply(&e).unwrap();
        assert_eq!(header, text(&["a", "新しい列", "新しい列", "新しい列", "b"]));
        assert_eq!(rows[0], text(&["1", "", "", "", "2"]));
        // 取り消し1回で元へ戻る
        sheet(&mut rows, &mut header, &mut edges)
            .apply(&e.invert())
            .unwrap();
        assert_eq!(header, text(&["a", "b"]));
        assert_eq!(rows[0], text(&["1", "2"]));
    }

    #[test]
    fn 列をまとめて消す() {
        let mut header = text(&["a", "b", "c", "d"]);
        let mut rows = vec![text(&["1", "2", "3", "4"]), text(&["5", "6", "7", "8"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let e = sheet(&mut rows, &mut header, &mut edges)
            .delete_cols(1, 2)
            .unwrap();
        assert_eq!(e.label(), "列の削除");
        sheet(&mut rows, &mut header, &mut edges).apply(&e).unwrap();
        assert_eq!(header, text(&["a", "d"]));
        assert_eq!(rows[0], text(&["1", "4"]));
        assert_eq!(rows[1], text(&["5", "8"]));
        // 取り消し1回で、中身も並びも元どおり
        sheet(&mut rows, &mut header, &mut edges)
            .apply(&e.invert())
            .unwrap();
        assert_eq!(header, text(&["a", "b", "c", "d"]));
        assert_eq!(rows[0], text(&["1", "2", "3", "4"]));
        assert_eq!(rows[1], text(&["5", "6", "7", "8"]));
    }

    #[test]
    fn 全部の列は消せない() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let sh = sheet(&mut rows, &mut header, &mut edges);
        assert!(sh.delete_cols(0, 2).is_err());
        // 端をはみ出す指定も断る
        assert!(sh.delete_cols(1, 2).is_err());
        assert!(sh.delete_cols(0, 0).is_err());
    }

    #[test]
    fn 一本だけならまとめない() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let sh = sheet(&mut rows, &mut header, &mut edges);
        assert!(matches!(
            sh.insert_cols(0, "x", 1).unwrap(),
            Edit::InsertCol { .. }
        ));
        assert!(matches!(
            sh.delete_cols(0, 1).unwrap(),
            Edit::DeleteCol { .. }
        ));
    }

    #[test]
    fn まとめた操作は順に効く() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let group = Edit::Group {
            label: "貼り付け",
            edits: vec![
                Edit::InsertRows {
                    at: 1,
                    rows: vec![text(&["", ""])],
                },
                Edit::Cells(vec![cell(1, 0, "", "9")]),
            ],
        };
        sheet(&mut rows, &mut header, &mut edges).apply(&group).unwrap();
        assert_eq!(rows, vec![text(&["1", "2"]), text(&["9", ""])]);
    }

    #[test]
    fn まとめた操作は1回で元へ戻る() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let before = rows.clone();
        let group = Edit::Group {
            label: "貼り付け",
            edits: vec![
                Edit::InsertRows {
                    at: 1,
                    rows: vec![text(&["", ""])],
                },
                Edit::Cells(vec![cell(1, 0, "", "9")]),
            ],
        };
        sheet(&mut rows, &mut header, &mut edges).apply(&group).unwrap();
        sheet(&mut rows, &mut header, &mut edges)
            .apply(&group.invert())
            .unwrap();
        assert_eq!(rows, before);
    }

    #[test]
    fn 途中で駄目になったら手を付ける前に戻す() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: Vec::new(),
        };
        let before = rows.clone();
        let group = Edit::Group {
            label: "貼り付け",
            edits: vec![
                Edit::InsertRows {
                    at: 1,
                    rows: vec![text(&["", ""])],
                },
                // 無い列を指しているので、ここで失敗する
                Edit::Cells(vec![cell(1, 9, "", "9")]),
            ],
        };
        assert!(sheet(&mut rows, &mut header, &mut edges).apply(&group).is_err());
        assert_eq!(rows, before, "失敗したのに行が増えている");
    }

    #[test]
    fn ヘッダのレコードは丸ごと入れ替わる() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: text(&["H", "01"]),
            tail: Vec::new(),
        };
        let e = Edit::EdgeRow {
            trailer: false,
            before: text(&["H", "01"]),
            after: text(&["H", "99"]),
        };
        sheet(&mut rows, &mut header, &mut edges).apply(&e).unwrap();
        assert_eq!(edges.head, text(&["H", "99"]));
        sheet(&mut rows, &mut header, &mut edges)
            .apply(&e.invert())
            .unwrap();
        assert_eq!(edges.head, text(&["H", "01"]), "取り消しで元へ戻る");
        assert_eq!(edges.tail, Vec::<String>::new(), "トレーラは触らない");
    }

    #[test]
    fn トレーラのレコードも入れ替えられる() {
        let mut header = text(&["a", "b"]);
        let mut rows = vec![text(&["1", "2"])];
        let mut edges = Edges {
            head: Vec::new(),
            tail: text(&["T", "0001"]),
        };
        let e = Edit::EdgeRow {
            trailer: true,
            before: text(&["T", "0001"]),
            after: text(&["T", "0002"]),
        };
        sheet(&mut rows, &mut header, &mut edges).apply(&e).unwrap();
        assert_eq!(edges.tail, text(&["T", "0002"]));
        assert_eq!(e.label(), "トレーラの編集");
    }

    #[test]
    fn まとめた操作の名前は付けたものになる() {
        let group = Edit::Group {
            label: "貼り付け",
            edits: vec![Edit::Cells(vec![cell(0, 0, "a", "b")])],
        };
        assert_eq!(group.label(), "貼り付け");
        assert_eq!(group.invert().label(), "貼り付け");
    }
}
