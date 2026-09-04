//! 2つの表を突き合わせて、どこが違うかを出す。
//!
//! CSV同士だけでなく、片方をDBのテーブルにしても同じ形で使えるよう、
//! 「列名の並び」と「行」だけを受け取る作りにしてある。
//!
//! 突き合わせ方は2通り。
//! - キー: 指定した列の値で行を対応付ける。「どのセルが違うか」まで出せる
//! - 集合: 行まるごとが一致するかだけを見る。キーを決められないとき用
//!
//! 行番号で対応付ける (差分アルゴリズム) 方式は、
//! 数万行で計算量が跳ねるので今は入れていない

#[cfg(test)]
mod csv_diff_tests;

use std::collections::HashMap;

/// 突き合わせ方
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffMode {
    /// 指定した列の値で対応付ける
    Key,
    /// 行まるごとが一致するかだけを見る
    Set,
}

/// 突き合わせの条件
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    pub mode: DiffMode,
    /// キーにする列の名前 (モードが Key のときだけ使う)
    #[serde(default)]
    pub key: Vec<String>,
    /// 前後の空白を無視して比べる
    #[serde(default)]
    pub trim: bool,
    /// 英字の大小を無視して比べる
    #[serde(default)]
    pub ignore_case: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        DiffOptions {
            mode: DiffMode::Key,
            key: Vec::new(),
            trim: false,
            ignore_case: false,
        }
    }
}

/// 行の突き合わせ結果
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RowStatus {
    /// 両方にあって中身も同じ
    Same,
    /// 両方にあるが中身が違う
    Changed,
    /// 左にしか無い (消えた)
    OnlyLeft,
    /// 右にしか無い (増えた)
    OnlyRight,
}

/// 左右の列の対応。片側にしか無い列は反対側が None になる
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPair {
    pub name: String,
    pub left: Option<usize>,
    pub right: Option<usize>,
}

/// 画面に1行として出すもの
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub status: RowStatus,
    /// 左の行位置 (無ければ None = 右にしか無い行)
    pub left: Option<usize>,
    pub right: Option<usize>,
    /// 値が違った列 (`ColumnPair` の並びでの位置)。Changed のときだけ入る
    pub changed: Vec<u32>,
}

/// 件数のまとめ
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub same: usize,
    pub changed: usize,
    pub only_left: usize,
    pub only_right: usize,
}

/// 突き合わせの結果
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub columns: Vec<ColumnPair>,
    pub rows: Vec<DiffRow>,
    pub summary: DiffSummary,
    /// キーが重複していた件数 (同じキーの行が2つ以上あった)
    pub duplicate_keys: usize,
    /// 片側にしか無い列があったか
    pub column_mismatch: bool,
}

/// 比べる前に値をならす
fn norm(v: &str, o: &DiffOptions) -> String {
    let s = if o.trim { v.trim() } else { v };
    if o.ignore_case {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 値の区切り (データに出てこない制御文字を使う)
const SEP: char = '\u{1f}';

/// 指定した列の値からキーを作る。
/// 区切りを含む値と分かれた値を取り違えないよう、長さも混ぜる
fn key_of(row: &[String], cols: &[usize], o: &DiffOptions) -> String {
    let mut out = String::new();
    for (i, &c) in cols.iter().enumerate() {
        if i > 0 {
            out.push(SEP);
        }
        let v = norm(row.get(c).map(|s| s.as_str()).unwrap_or(""), o);
        out.push_str(&v.len().to_string());
        out.push(':');
        out.push_str(&v);
    }
    out
}

/// 行まるごとのキー (集合モード用)
fn whole_key(row: &[String], o: &DiffOptions) -> String {
    let cols: Vec<usize> = (0..row.len()).collect();
    key_of(row, &cols, o)
}

/// 左右の列を名前で対応付ける。
///
/// 左の並びを軸にし、右にしか無い列は後ろへ足す。
/// 同じ名前の列が複数あるときは、出てきた順に1対1で対応させる
pub fn pair_columns(left: &[String], right: &[String]) -> Vec<ColumnPair> {
    // 右の列を「名前 → まだ使っていない位置」で引けるようにする
    let mut rest: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, name) in right.iter().enumerate() {
        rest.entry(name.as_str()).or_default().push(i);
    }
    // 先頭から取り出したいので逆向きにしておく
    for v in rest.values_mut() {
        v.reverse();
    }

    let mut out: Vec<ColumnPair> = Vec::new();
    let mut used = vec![false; right.len()];
    for (i, name) in left.iter().enumerate() {
        let r = rest.get_mut(name.as_str()).and_then(|v| v.pop());
        if let Some(r) = r {
            used[r] = true;
        }
        out.push(ColumnPair {
            name: name.clone(),
            left: Some(i),
            right: r,
        });
    }
    for (i, name) in right.iter().enumerate() {
        if !used[i] {
            out.push(ColumnPair {
                name: name.clone(),
                left: None,
                right: Some(i),
            });
        }
    }
    out
}

/// 対応が付いた1組の行を比べ、違う列の位置を返す
fn changed_cells(
    columns: &[ColumnPair],
    l: &[String],
    r: &[String],
    o: &DiffOptions,
) -> Vec<u32> {
    let mut out = Vec::new();
    for (i, c) in columns.iter().enumerate() {
        let (Some(li), Some(ri)) = (c.left, c.right) else {
            // 片側にしか無い列は「違い」として数えない (列の対応の話なので別に出す)
            continue;
        };
        let a = norm(l.get(li).map(|s| s.as_str()).unwrap_or(""), o);
        let b = norm(r.get(ri).map(|s| s.as_str()).unwrap_or(""), o);
        if a != b {
            out.push(i as u32);
        }
    }
    out
}

/// キーにする列の位置を名前から引く
fn key_indexes(columns: &[String], names: &[String]) -> Result<Vec<usize>, String> {
    let mut out = Vec::new();
    for n in names {
        let i = columns
            .iter()
            .position(|c| c == n)
            .ok_or_else(|| format!("キーの列が見つかりません: {n}"))?;
        out.push(i);
    }
    Ok(out)
}

/// 2つの表を突き合わせる
pub fn compare(
    left_columns: &[String],
    left_rows: &[Vec<String>],
    right_columns: &[String],
    right_rows: &[Vec<String>],
    o: &DiffOptions,
) -> Result<DiffResult, String> {
    let columns = pair_columns(left_columns, right_columns);
    let column_mismatch = columns.iter().any(|c| c.left.is_none() || c.right.is_none());

    // 行のキーを作る関数を、モードに合わせて選ぶ
    let (lk, rk): (Vec<String>, Vec<String>) = match o.mode {
        DiffMode::Key => {
            if o.key.is_empty() {
                return Err("突き合わせに使う列を選んでください".into());
            }
            let li = key_indexes(left_columns, &o.key)?;
            let ri = key_indexes(right_columns, &o.key)?;
            (
                left_rows.iter().map(|r| key_of(r, &li, o)).collect(),
                right_rows.iter().map(|r| key_of(r, &ri, o)).collect(),
            )
        }
        DiffMode::Set => (
            left_rows.iter().map(|r| whole_key(r, o)).collect(),
            right_rows.iter().map(|r| whole_key(r, o)).collect(),
        ),
    };

    // 右をキーで引けるようにする (同じキーが複数あれば出てきた順に使う)
    let mut rest: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, k) in rk.iter().enumerate() {
        rest.entry(k.as_str()).or_default().push(i);
    }
    let mut duplicate_keys = rest.values().filter(|v| v.len() > 1).count();
    for v in rest.values_mut() {
        v.reverse();
    }
    // 左の重複も数える (どちらかに重複があれば画面で知らせる)
    {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for k in &lk {
            *seen.entry(k.as_str()).or_insert(0) += 1;
        }
        duplicate_keys += seen.values().filter(|n| **n > 1).count();
    }

    let mut rows: Vec<DiffRow> = Vec::with_capacity(left_rows.len());
    let mut summary = DiffSummary::default();
    let mut used = vec![false; right_rows.len()];

    for (i, k) in lk.iter().enumerate() {
        match rest.get_mut(k.as_str()).and_then(|v| v.pop()) {
            Some(j) => {
                used[j] = true;
                let changed = changed_cells(&columns, &left_rows[i], &right_rows[j], o);
                let status = if changed.is_empty() {
                    summary.same += 1;
                    RowStatus::Same
                } else {
                    summary.changed += 1;
                    RowStatus::Changed
                };
                rows.push(DiffRow {
                    status,
                    left: Some(i),
                    right: Some(j),
                    changed,
                });
            }
            None => {
                summary.only_left += 1;
                rows.push(DiffRow {
                    status: RowStatus::OnlyLeft,
                    left: Some(i),
                    right: None,
                    changed: Vec::new(),
                });
            }
        }
    }
    // 対応が付かなかった右の行を、元の並びのまま後ろへ足す
    for (j, u) in used.iter().enumerate() {
        if !u {
            summary.only_right += 1;
            rows.push(DiffRow {
                status: RowStatus::OnlyRight,
                left: None,
                right: Some(j),
                changed: Vec::new(),
            });
        }
    }

    Ok(DiffResult {
        columns,
        rows,
        summary,
        duplicate_keys,
        column_mismatch,
    })
}

/**
 * キーに使えそうな列を推測する。
 *
 * 左右の両方にあり、値が重複しない列のうち、
 * 名前が `id` / `code` / `cd` / `no` で終わるものを優先する。
 * 見つからなければ、値が重複しない一番左の列を返す
 */
pub fn guess_key(
    left_columns: &[String],
    left_rows: &[Vec<String>],
    right_columns: &[String],
) -> Vec<String> {
    let unique = |i: usize| -> bool {
        let mut seen = std::collections::HashSet::new();
        left_rows.iter().all(|r| {
            let v = r.get(i).cloned().unwrap_or_default();
            seen.insert(v)
        })
    };
    let looks_like_key = |name: &str| -> bool {
        let n = name.to_ascii_lowercase();
        n == "id" || n.ends_with("_id") || n.ends_with("id") || n.ends_with("code")
            || n.ends_with("cd") || n.ends_with("no")
    };

    let both: Vec<(usize, &String)> = left_columns
        .iter()
        .enumerate()
        .filter(|(_, n)| right_columns.contains(n))
        .collect();

    for (i, name) in &both {
        if looks_like_key(name) && unique(*i) {
            return vec![(*name).clone()];
        }
    }
    for (i, name) in &both {
        if unique(*i) {
            return vec![(*name).clone()];
        }
    }
    Vec::new()
}
