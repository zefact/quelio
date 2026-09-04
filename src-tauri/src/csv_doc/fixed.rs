//! 固定長ファイルの読み書き。
//!
//! CSVと違って区切り文字が無く、桁の幅で項目が決まる。
//! 銀行やホストから来るファイルは Shift_JIS の「バイト数」で桁が決まっていることが
//! 多いので、数え方はバイトと文字の両方を選べるようにしてある
//! (バイトで数えるときは、文字に直す前の生バイトのまま切り分ける)。
//!
//! 幅・詰める向き・埋める文字は開いたときに推測し、
//! そのまま保存に使う (触っていない行が書き換わらないようにするため)

use serde::{Deserialize, Serialize};

/// 桁幅の数え方
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WidthUnit {
    /// バイト数 (Shift_JISなら漢字は2桁ぶん)
    Byte,
    /// 文字数 (漢字も1桁ぶん)
    Char,
}

/// 桁の中で値を寄せる向き
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    /// 左に寄せて右を埋める (名前などの文字)
    Left,
    /// 右に寄せて左を埋める (金額・コードなど)
    Right,
}

/// 桁1つ
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedColumn {
    /// 桁の幅 (単位はレイアウト側の unit に従う)
    pub width: usize,
    pub align: Align,
    /// 余りを埋める文字 (空白か 0)
    pub pad: char,
    /// 項目名 (固定長のファイルには見出しが無いので、レイアウト側で持つ)
    #[serde(default)]
    pub name: String,
}

impl FixedColumn {
    /// 幅だけ決めた桁 (左寄せ・空白埋め)
    pub fn new(width: usize) -> FixedColumn {
        FixedColumn {
            width,
            align: Align::Left,
            pad: ' ',
            name: String::new(),
        }
    }
}

/// ファイル1つぶんの桁の並び
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedLayout {
    pub unit: WidthUnit,
    pub columns: Vec<FixedColumn>,
    /// 読むときに埋め文字を落とすか (落とすと素直に編集できる)
    #[serde(default = "yes")]
    pub trim: bool,
}

fn yes() -> bool {
    true
}

impl FixedLayout {
    /// 幅の並びからレイアウトを作る (詰め方は既定のまま)
    pub fn from_widths(unit: WidthUnit, widths: &[usize]) -> FixedLayout {
        FixedLayout {
            unit,
            columns: widths.iter().map(|w| FixedColumn::new(*w)).collect(),
            trim: true,
        }
    }

    /// 項目名 (付いていない桁は空文字)
    pub fn names(&self) -> Vec<String> {
        self.columns.iter().map(|c| c.name.clone()).collect()
    }
}

/// 幅を数える単位ごとの「1行」。
///
/// バイトで数えるときは生バイト、文字で数えるときは文字の並びになる。
/// 切り分けの手順はどちらも同じなので、この形にそろえてから扱う
enum Line<'a> {
    Bytes(&'a [u8]),
    Chars(Vec<char>),
}

impl Line<'_> {
    fn len(&self) -> usize {
        match self {
            Line::Bytes(b) => b.len(),
            Line::Chars(c) => c.len(),
        }
    }

    /// その位置が空白か (行より短ければ空白として扱う)
    fn is_space_at(&self, at: usize) -> bool {
        match self {
            Line::Bytes(b) => b.get(at).is_none_or(|c| *c == b' '),
            Line::Chars(c) => c.get(at).is_none_or(|c| *c == ' '),
        }
    }
}

/// 改行で行に分ける (末尾の CR は落とす)。空行は捨てる
fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    bytes
        .split(|b| *b == b'\n')
        .map(|l| {
            if l.last() == Some(&b'\r') {
                &l[..l.len() - 1]
            } else {
                l
            }
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// 桁の区切りを推測するときに見る行数
const SAMPLE_LINES: usize = 200;

/**
 * 桁の区切りを推測する。
 *
 * 「見たすべての行で空白になっている位置」を桁の切れ目とみなす。
 * 空白が続いた後に中身が始まる位置が、次の桁の先頭になる
 */
fn guess_widths(lines: &[Line]) -> Vec<usize> {
    let max = lines.iter().map(|l| l.len()).max().unwrap_or(0);
    if max == 0 {
        return Vec::new();
    }
    // その位置が全行で空白か
    let blank: Vec<bool> = (0..max)
        .map(|at| lines.iter().all(|l| l.is_space_at(at)))
        .collect();

    // 空白 → 中身 に変わる位置が桁の先頭
    let mut starts = vec![0usize];
    for at in 1..max {
        if blank[at - 1] && !blank[at] {
            starts.push(at);
        }
    }
    let mut widths: Vec<usize> = starts.windows(2).map(|w| w[1] - w[0]).collect();
    widths.push(max - starts[starts.len() - 1]);
    widths
}

/// 1行を桁ごとに切り分ける (足りない分は空文字)
fn cut(line: &Line, widths: &[usize]) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(widths.len());
    let mut at = 0usize;
    for w in widths {
        let from = at.min(line.len());
        let to = (at + w).min(line.len());
        out.push((from, to));
        at += w;
    }
    out
}

/**
 * 桁の中の値から、詰める向きと埋め文字を見分ける。
 *
 * 判断は「埋め文字が付いている側はどちらか」だけで行う。
 * 末尾に埋め文字が付いている値が1つでもあれば左寄せ、
 * 付いておらず頭に付いているものがあれば右寄せとみなす
 */
fn detect_pad(values: &[String]) -> (Align, char) {
    let filled: Vec<&String> = values.iter().filter(|v| !v.trim().is_empty()).collect();
    if filled.is_empty() {
        return (Align::Left, ' ');
    }
    // 数字だけで、頭が0で埋まっている → 右寄せのゼロ埋め
    let all_digit = filled.iter().all(|v| v.chars().all(|c| c.is_ascii_digit()));
    if all_digit && filled.iter().any(|v| v.starts_with('0')) {
        return (Align::Right, '0');
    }
    // 末尾に空白が無く、頭に空白が付いているものがある → 右寄せの空白埋め
    let no_trailing = filled.iter().all(|v| !v.ends_with(' '));
    let some_leading = filled.iter().any(|v| v.starts_with(' '));
    if no_trailing && some_leading {
        return (Align::Right, ' ');
    }
    (Align::Left, ' ')
}

/// 読み取った桁の値から埋め文字を落とす
fn unpad(value: &str, col: &FixedColumn) -> String {
    match col.align {
        Align::Left => value.trim_end_matches(col.pad).to_string(),
        Align::Right => {
            let cut = value.trim_start_matches(col.pad);
            // 全部が埋め文字だった桁は空にする (0埋めの "0000" は 0 ではなく空)
            if cut.is_empty() && col.pad == '0' && !value.is_empty() {
                "0".to_string()
            } else {
                cut.to_string()
            }
        }
    }
}

/// 読み込んだ結果
pub struct LoadedFixed {
    pub layout: FixedLayout,
    pub rows: Vec<Vec<String>>,
    /// 桁の合計より短い・長い行があったか
    pub ragged: bool,
}

/// 桁をどう決めて読むか
pub enum Reading<'a> {
    /// 幅も詰め方も中身から推測する
    Guess,
    /// 幅だけ決めて、詰め方は中身から見分ける
    Widths(&'a [usize]),
    /// すべて指定どおりに読む (保存したレイアウトを使うとき)
    Layout(&'a FixedLayout),
}

/**
 * 固定長として読む。
 *
 * 保存したレイアウトを渡したときは詰め方も指定どおりにする
 * (開くたびに見分け直すと、保存の形が変わってしまうため)
 */
pub fn load(
    bytes: &[u8],
    enc: &'static encoding_rs::Encoding,
    unit: WidthUnit,
    reading: Reading,
) -> LoadedFixed {
    let raw = split_lines(bytes);
    // バイトで数えるときだけ、文字に直す前のまま切り分ける
    let decoded: Vec<String> = if unit == WidthUnit::Char {
        raw.iter().map(|l| enc.decode(l).0.into_owned()).collect()
    } else {
        Vec::new()
    };
    let lines: Vec<Line> = if unit == WidthUnit::Char {
        decoded.iter().map(|s| Line::Chars(s.chars().collect())).collect()
    } else {
        raw.iter().map(|b| Line::Bytes(b)).collect()
    };

    let sample = lines.len().min(SAMPLE_LINES);
    let widths: Vec<usize> = match &reading {
        Reading::Layout(l) => l.columns.iter().map(|c| c.width).collect(),
        Reading::Widths(w) => w.to_vec(),
        Reading::Guess => guess_widths(&lines[..sample]),
    };
    if widths.is_empty() {
        return LoadedFixed {
            layout: FixedLayout::from_widths(unit, &[]),
            rows: Vec::new(),
            ragged: false,
        };
    }

    // 桁ごとに切って、文字に直す
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(lines.len());
    let mut ragged = false;
    let total: usize = widths.iter().sum();
    for (at, line) in lines.iter().enumerate() {
        if line.len() != total {
            ragged = true;
        }
        let cells: Vec<String> = cut(line, &widths)
            .into_iter()
            .map(|(from, to)| match line {
                Line::Bytes(_) => enc.decode(&raw[at][from..to]).0.into_owned(),
                Line::Chars(c) => c[from..to].iter().collect(),
            })
            .collect();
        rows.push(cells);
    }

    // 詰め方はレイアウトがあればそれに従い、無ければ中身から見分ける
    let out = match &reading {
        Reading::Layout(l) => (*l).clone(),
        _ => {
            let columns = widths
                .iter()
                .enumerate()
                .map(|(c, w)| {
                    let values: Vec<String> = rows
                        .iter()
                        .take(SAMPLE_LINES)
                        .filter_map(|r| r.get(c).cloned())
                        .collect();
                    let (align, pad) = detect_pad(&values);
                    FixedColumn {
                        width: *w,
                        align,
                        pad,
                        name: String::new(),
                    }
                })
                .collect();
            FixedLayout {
                unit,
                columns,
                trim: true,
            }
        }
    };

    if out.trim {
        for row in &mut rows {
            for (c, cell) in row.iter_mut().enumerate() {
                if let Some(col) = out.columns.get(c) {
                    *cell = unpad(cell, col);
                }
            }
        }
    }

    LoadedFixed {
        layout: out,
        rows,
        ragged,
    }
}

/// 桁に収まらなかった値
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TooLong {
    /// 行位置 (0始まり)
    pub row: usize,
    /// 列位置 (0始まり)
    pub col: usize,
    pub value: String,
    /// その値の長さ
    pub len: usize,
    pub width: usize,
}

/// 桁1つぶんに整える (収まらなければ長さを返す)
fn fit(
    value: &str,
    col: &FixedColumn,
    unit: WidthUnit,
    enc: &'static encoding_rs::Encoding,
) -> Result<Vec<u8>, usize> {
    let body: Vec<u8> = match unit {
        WidthUnit::Byte => enc.encode(value).0.into_owned(),
        // 文字で数えるときも、書き出すのは符号化した後のバイト
        WidthUnit::Char => enc.encode(value).0.into_owned(),
    };
    let len = match unit {
        WidthUnit::Byte => body.len(),
        WidthUnit::Char => value.chars().count(),
    };
    if len > col.width {
        return Err(len);
    }
    // 埋め文字は空白か0なので、どの文字コードでも1バイト
    let fill = vec![col.pad as u8; col.width - len];
    let mut out = Vec::with_capacity(col.width);
    match col.align {
        Align::Left => {
            out.extend_from_slice(&body);
            out.extend_from_slice(&fill);
        }
        Align::Right => {
            out.extend_from_slice(&fill);
            out.extend_from_slice(&body);
        }
    }
    Ok(out)
}

/**
 * 固定長として書き出す。
 *
 * 桁からはみ出す値があれば、書かずにその場所を返す。
 * 固定長は桁がずれると後ろの工程が丸ごと壊れるので、黙って切り詰めない
 */
pub fn dump(
    rows: &[Vec<String>],
    layout: &FixedLayout,
    enc: &'static encoding_rs::Encoding,
    newline: &str,
) -> Result<Vec<u8>, Vec<TooLong>> {
    let mut out: Vec<u8> = Vec::new();
    let mut bad: Vec<TooLong> = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, col) in layout.columns.iter().enumerate() {
            let value = row.get(c).map(String::as_str).unwrap_or("");
            match fit(value, col, layout.unit, enc) {
                Ok(cell) => out.extend_from_slice(&cell),
                Err(len) => {
                    // 見つけた分はまとめて返す (直す場所が一度に分かるように)
                    if bad.len() < 20 {
                        bad.push(TooLong {
                            row: r,
                            col: c,
                            value: value.to_string(),
                            len,
                            width: col.width,
                        });
                    }
                }
            }
        }
        out.extend_from_slice(newline.as_bytes());
    }
    if bad.is_empty() {
        Ok(out)
    } else {
        Err(bad)
    }
}

#[cfg(test)]
mod tests;
