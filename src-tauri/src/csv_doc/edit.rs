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
