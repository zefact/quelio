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

/**
 * レコードの種別を、値で見分ける決まり。
 *
 * ヘッダ行とボディ行が交互に来るファイルのためのもの。
 * レコードの決まった位置にある値を見て、どちらの桁で切るかを決める
 */
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedKey {
    /// 見る位置 (レコードの先頭からいくつ目か。0始まり。単位は桁幅と同じ)
    pub at: usize,
    /// 見る長さ
    pub len: usize,
    /// この値ならヘッダ行 (前後の空白は落として比べる)
    pub header: String,
}

/**
 * レコードの種別1つ。
 *
 * 「決まった場所がこの値ならこの桁で切る」という決まりと、
 * その桁の並びをひとまとめにしたもの。
 * 種別はいくつでも足せて、見る場所は種別ごとに違ってよい
 */
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedKind {
    /// 画面に出す名前 (「ヘッダ」「明細」など)
    pub name: String,
    /// 見る位置 (レコードの先頭からいくつ目か。0始まり。単位は桁幅と同じ)
    pub at: usize,
    /// 見る長さ
    pub len: usize,
    /// この値ならこの種別 (前後の空白は落として比べる)
    pub value: String,
    /// この種別の桁の並び
    pub columns: Vec<FixedColumn>,
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
    /**
     * 行が改行で区切られているか。
     *
     * false のときは、ファイルに改行が無く、桁の合計ぶんずつが1行になる
     * (ホストから来るファイルにはこの形がある)。
     * 古い設定には無い項目なので、既定は「改行で区切る」
     */
    #[serde(default = "yes")]
    pub newline: bool,
    /**
     * 先頭のヘッダレコードの桁 (空なら「ヘッダは無い」)。
     *
     * データ行と項目の分け方が違うレコードが先頭に1つだけ入っているファイルがある。
     * データ行とは長さも違うことがあるので、桁の並びごと別に持つ
     */
    #[serde(default)]
    pub header: Vec<FixedColumn>,
    /// 末尾のトレーラレコードの桁 (空なら「トレーラは無い」)
    #[serde(default)]
    pub trailer: Vec<FixedColumn>,
    /**
     * レコードの種別を値で見分ける決まり (無ければ見分けない)。
     *
     * これを決めると、ヘッダは「先頭の1件」ではなく
     * 「この値になっているレコードすべて」になる。
     * ヘッダ行とボディ行が交互に来るファイルはこの形で読む
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<FixedKey>,
    /**
     * レコードの種別 (空なら見分けない)。
     *
     * 上から順に見て、はじめに当てはまった種別の桁で切る。
     * どれにも当てはまらないレコードは `columns` の桁で切る。
     * ヘッダが2種類あるファイルなどは、ここに並べて決める
     */
    #[serde(default)]
    pub kinds: Vec<FixedKind>,
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
            newline: true,
            header: Vec::new(),
            trailer: Vec::new(),
            key: None,
            kinds: Vec::new(),
        }
    }

    /// 項目名 (付いていない桁は空文字)
    pub fn names(&self) -> Vec<String> {
        self.columns.iter().map(|c| c.name.clone()).collect()
    }

    /**
     * その種別の桁の並び。
     *
     * 0 はどの種別にも当てはまらないレコード (ふつうのデータ行)
     */
    pub fn columns_of(&self, kind: u32) -> &[FixedColumn] {
        match kind.checked_sub(1).and_then(|i| self.kinds.get(i as usize)) {
            Some(k) => &k.columns,
            None => &self.columns,
        }
    }

    /// 表に要る列の数 (種別によって項目の数が違うので、いちばん多いものに合わせる)
    pub fn width(&self) -> usize {
        self.kinds
            .iter()
            .map(|k| k.columns.len())
            .chain(std::iter::once(self.columns.len()))
            .chain(std::iter::once(self.header.len()))
            .max()
            .unwrap_or(0)
    }

    /**
     * 古い形の設定を、今の形に直したもの。
     *
     * 以前は「ヘッダ1種類だけ」を `key` と `header` で持っていた。
     * それを種別の一覧へ移し替える (保存しておいたお気に入りをそのまま使えるように)
     */
    pub fn migrated(&self) -> FixedLayout {
        let mut out = self.clone();
        let Some(key) = out.key.take() else {
            return out;
        };
        if out.kinds.is_empty() && !out.header.is_empty() {
            out.kinds.push(FixedKind {
                name: "ヘッダ".to_string(),
                at: key.at,
                len: key.len,
                value: key.header,
                columns: std::mem::take(&mut out.header),
            });
        }
        out
    }
}

/// 桁の合計 (1レコードの長さ)
pub fn total_width(columns: &[FixedColumn]) -> usize {
    columns.iter().map(|c| c.width).sum()
}

/// 切り出す位置 (始まりと終わり)
type Span = (usize, usize);

/// 切り出す位置と、その種別 (0 はどの種別にも当てはまらないレコード)
pub type KindSpan = (usize, usize, u32);

/**
 * 種別を見ながら、長さで切る位置を求める。
 *
 * レコードの種別ごとに長さが違うので、先頭から順に
 * 「その位置のレコードがどの種別か」を見て、その長さだけ進む。
 * 見分けと長さは呼ぶ側に任せる (中身の読み方をここに持ち込まないため)。
 *
 * 長さが 0 の種別があると先へ進めないので、そこで打ち切る
 */
pub fn spans_by_kind(
    len: usize,
    kind_at: impl Fn(usize) -> u32,
    width_of: impl Fn(u32) -> usize,
) -> Vec<KindSpan> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < len {
        let kind = kind_at(at);
        let width = width_of(kind);
        if width == 0 {
            break;
        }
        let end = (at + width).min(len);
        out.push((at, end, kind));
        at = end;
    }
    out
}

/**
 * 改行の無いファイルを、長さで切る位置に分ける。
 *
 * 先頭からヘッダのぶん、末尾からトレーラのぶんを先に取り、
 * 残りをデータ行の長さで順に切る。
 * 足りないときは無理に取らない (半端なレコードを作らないため)
 */
pub fn spans(
    len: usize,
    head: usize,
    body: usize,
    tail: usize,
) -> (Option<Span>, Vec<Span>, Option<Span>) {
    let mut from = 0usize;
    let mut to = len;
    let head_span = if head > 0 && len >= head {
        from = head;
        Some((0, head))
    } else {
        None
    };
    let tail_span = if tail > 0 && to >= from + tail {
        to -= tail;
        Some((to, to + tail))
    } else {
        None
    };
    let mut body_spans = Vec::new();
    if body > 0 {
        let mut at = from;
        while at < to {
            let end = (at + body).min(to);
            body_spans.push((at, end));
            at = end;
        }
    }
    (head_span, body_spans, tail_span)
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

    /// 決まった位置の値を取り出す (行より短ければ短いまま)
    fn slice(&self, at: usize, len: usize, enc: &'static encoding_rs::Encoding) -> String {
        let from = at.min(self.len());
        let to = (at + len).min(self.len());
        match self {
            Line::Bytes(b) => enc.decode(&b[from..to]).0.into_owned(),
            Line::Chars(c) => c[from..to].iter().collect(),
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

/// 末尾の改行と、先頭のUTF-8のBOMを外す。
///
/// 改行の無いファイルを長さで切るとき、この2つが混ざると1バイトずつずれてしまう
fn trim_edges(bytes: &[u8]) -> &[u8] {
    let mut out = bytes;
    if out.starts_with(&[0xEF, 0xBB, 0xBF]) {
        out = &out[3..];
    }
    while matches!(out.last(), Some(b'\n') | Some(b'\r')) {
        out = &out[..out.len() - 1];
    }
    out
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
    /// 先頭のヘッダレコードの値 (無ければ空)
    pub head: Vec<String>,
    /// 末尾のトレーラレコードの値 (無ければ空)
    pub tail: Vec<String>,
    /**
     * 各行の種別 (種別を見分けているときだけ入る)。
     *
     * 行と同じ並び順で、0 はどの種別にも当てはまらないレコード。
     * 見分けていなければ空
     */
    pub kinds: Vec<u32>,
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
    /*
     * 古い形の設定 (ヘッダ1種類だけを `key` で決めていたもの) は、
     * 種別の一覧に直してから読む
     */
    let migrated;
    let reading = match reading {
        Reading::Layout(l) if l.key.is_some() => {
            migrated = l.migrated();
            Reading::Layout(&migrated)
        }
        other => other,
    };
    // 先に分かっている桁の並び (推測のときだけ無い)
    let known: Option<Vec<usize>> = match &reading {
        Reading::Layout(l) => Some(l.columns.iter().map(|c| c.width).collect()),
        Reading::Widths(w) => Some(w.to_vec()),
        Reading::Guess => None,
    };
    // ヘッダ・トレーラはレイアウトで決めたときだけ使う
    let (head_cols, tail_cols): (&[FixedColumn], &[FixedColumn]) = match &reading {
        Reading::Layout(l) => (&l.header, &l.trailer),
        _ => (&[], &[]),
    };
    let total_known: usize = known.iter().flatten().sum();
    /*
     * 改行ではなく長さで切るか。
     *
     * レイアウトでそう決めていて、桁の合計も分かっているときだけ。
     * 合計が分からないまま切ると、ファイル全体が1行になってしまう
     */
    let by_length = matches!(&reading, Reading::Layout(l) if !l.newline) && total_known > 0;
    let body = if by_length { trim_edges(bytes) } else { bytes };

    /*
     * レコードの種別を値で見分けるか。
     *
     * 見分けるときは、種別の行も「先頭の1件」ではなく
     * 「その値になっているレコードすべて」になり、1つの表に混ざって並ぶ
     */
    let by_kind: Option<&FixedLayout> = match &reading {
        Reading::Layout(l) if !l.kinds.is_empty() => Some(l),
        _ => None,
    };

    // レコードに切り分ける (ヘッダ・本体・トレーラ)
    let mut head_line: Option<Line> = None;
    let mut tail_line: Option<Line> = None;
    // 各行の種別 (見分けていなければ空のまま)
    let mut kinds: Vec<u32> = Vec::new();
    let lines: Vec<Line> = if let Some(layout) = by_kind {
        split_by_kind(body, enc, unit, by_length, layout, total_known, &mut kinds)
    } else if by_length && unit == WidthUnit::Byte {
        let (h, b, t) = spans(
            body.len(),
            total_width(head_cols),
            total_known,
            total_width(tail_cols),
        );
        head_line = h.map(|(f, e)| Line::Bytes(&body[f..e]));
        tail_line = t.map(|(f, e)| Line::Bytes(&body[f..e]));
        b.into_iter().map(|(f, e)| Line::Bytes(&body[f..e])).collect()
    } else if by_length {
        let text = enc.decode(body).0.into_owned();
        let chars: Vec<char> = text.chars().collect();
        let (h, b, t) = spans(
            chars.len(),
            total_width(head_cols),
            total_known,
            total_width(tail_cols),
        );
        head_line = h.map(|(f, e)| Line::Chars(chars[f..e].to_vec()));
        tail_line = t.map(|(f, e)| Line::Chars(chars[f..e].to_vec()));
        b.into_iter()
            .map(|(f, e)| Line::Chars(chars[f..e].to_vec()))
            .collect()
    } else {
        let raw = split_lines(body);
        let mut all: Vec<Line> = if unit == WidthUnit::Char {
            raw.iter()
                .map(|l| Line::Chars(enc.decode(l).0.chars().collect()))
                .collect()
        } else {
            raw.into_iter().map(Line::Bytes).collect()
        };
        // 改行で区切るときは、先頭と末尾の行をそのままヘッダ・トレーラにする
        if !head_cols.is_empty() && !all.is_empty() {
            head_line = Some(all.remove(0));
        }
        if !tail_cols.is_empty() && !all.is_empty() {
            tail_line = all.pop();
        }
        all
    };

    let sample = lines.len().min(SAMPLE_LINES);
    let widths: Vec<usize> = match known {
        Some(w) => w,
        None => guess_widths(&lines[..sample]),
    };
    if widths.is_empty() {
        return LoadedFixed {
            layout: FixedLayout::from_widths(unit, &[]),
            rows: Vec::new(),
            ragged: false,
            head: Vec::new(),
            tail: Vec::new(),
            kinds: Vec::new(),
        };
    }

    // 桁ごとに切って、文字に直す
    let kind_widths: Vec<Vec<usize>> = match by_kind {
        Some(l) => l
            .kinds
            .iter()
            .map(|k| k.columns.iter().map(|c| c.width).collect())
            .collect(),
        None => Vec::new(),
    };
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(lines.len());
    let mut ragged = false;
    for (at, line) in lines.iter().enumerate() {
        // 種別を見分けているときは、その行の種別の桁で切る
        let kind = kinds.get(at).copied().unwrap_or(0);
        let use_widths = match kind.checked_sub(1).and_then(|i| kind_widths.get(i as usize)) {
            Some(w) => w,
            None => &widths,
        };
        if line.len() != use_widths.iter().sum::<usize>() {
            ragged = true;
        }
        rows.push(split_cells(line, use_widths, enc));
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
                newline: true,
                header: Vec::new(),
                trailer: Vec::new(),
                key: None,
                kinds: Vec::new(),
            }
        }
    };

    if out.trim {
        for (at, row) in rows.iter_mut().enumerate() {
            let kind = kinds.get(at).copied().unwrap_or(0);
            unpad_row(row, out.columns_of(kind));
        }
    }

    /*
     * 表は四角にしておく。
     *
     * 種別によって項目の数が違うので、少ないほうを空欄で埋めて、
     * どの行も同じ列数にそろえる
     */
    if !kinds.is_empty() {
        let width = out.width().max(widths.len());
        for row in &mut rows {
            row.resize(width, String::new());
        }
    }

    // ヘッダ・トレーラは、それぞれの桁で切る
    let edge = |line: Option<Line>, cols: &[FixedColumn]| -> Vec<String> {
        let Some(line) = line else {
            return Vec::new();
        };
        let widths: Vec<usize> = cols.iter().map(|c| c.width).collect();
        let mut cells = split_cells(&line, &widths, enc);
        if out.trim {
            unpad_row(&mut cells, cols);
        }
        cells
    };
    let head = edge(head_line, head_cols);
    let tail = edge(tail_line, tail_cols);

    LoadedFixed {
        layout: out,
        rows,
        ragged,
        head,
        tail,
        kinds,
    }
}

/**
 * 種別を見分けながらレコードに切り分ける。
 *
 * どの位置のレコードも、まず決まった場所の値を見て種別を決め、
 * その種別の長さぶんだけ進む (改行で区切るファイルは、行ごとに種別を見る)
 */
fn split_by_kind<'a>(
    body: &'a [u8],
    enc: &'static encoding_rs::Encoding,
    unit: WidthUnit,
    by_length: bool,
    layout: &FixedLayout,
    body_total: usize,
    kinds: &mut Vec<u32>,
) -> Vec<Line<'a>> {
    /// その位置の値が当てはまる種別 (0 はどれにも当てはまらない)
    fn kind_of(layout: &FixedLayout, slice: impl Fn(usize, usize) -> String) -> u32 {
        for (i, k) in layout.kinds.iter().enumerate() {
            if k.len == 0 {
                continue;
            }
            if slice(k.at, k.len).trim() == k.value.trim() {
                return i as u32 + 1;
            }
        }
        0
    }

    let width_of = |kind: u32| total_width(layout.columns_of(kind));

    if !by_length {
        // 改行で区切るファイルは、行ごとに見分けるだけでよい
        let raw = split_lines(body);
        let lines: Vec<Line> = if unit == WidthUnit::Char {
            raw.iter()
                .map(|l| Line::Chars(enc.decode(l).0.chars().collect()))
                .collect()
        } else {
            raw.into_iter().map(Line::Bytes).collect()
        };
        kinds.extend(
            lines
                .iter()
                .map(|l| kind_of(layout, |at, len| l.slice(at, len, enc))),
        );
        return lines;
    }

    if unit == WidthUnit::Byte {
        let spans = spans_by_kind(
            body.len(),
            |at| {
                kind_of(layout, |ka, len| {
                    let from = (at + ka).min(body.len());
                    let to = (from + len).min(body.len());
                    enc.decode(&body[from..to]).0.into_owned()
                })
            },
            |kind| {
                if kind == 0 {
                    body_total
                } else {
                    width_of(kind)
                }
            },
        );
        kinds.extend(spans.iter().map(|(_, _, k)| *k));
        return spans
            .into_iter()
            .map(|(f, e, _)| Line::Bytes(&body[f..e]))
            .collect();
    }

    // 文字で数えるときは、文字に直してから切る
    let text = enc.decode(body).0.into_owned();
    let chars: Vec<char> = text.chars().collect();
    let spans = spans_by_kind(
        chars.len(),
        |at| {
            kind_of(layout, |ka, len| {
                let from = (at + ka).min(chars.len());
                let to = (from + len).min(chars.len());
                chars[from..to].iter().collect::<String>()
            })
        },
        |kind| {
            if kind == 0 {
                body_total
            } else {
                width_of(kind)
            }
        },
    );
    kinds.extend(spans.iter().map(|(_, _, k)| *k));
    spans
        .into_iter()
        .map(|(f, e, _)| Line::Chars(chars[f..e].to_vec()))
        .collect()
}

/// 1レコードを桁ごとに切って、文字に直す
fn split_cells(
    line: &Line,
    widths: &[usize],
    enc: &'static encoding_rs::Encoding,
) -> Vec<String> {
    cut(line, widths)
        .into_iter()
        .map(|(from, to)| match line {
            Line::Bytes(b) => enc.decode(&b[from..to]).0.into_owned(),
            Line::Chars(c) => c[from..to].iter().collect(),
        })
        .collect()
}

/// 1レコードぶんの値から埋め文字を落とす
fn unpad_row(cells: &mut [String], columns: &[FixedColumn]) {
    for (c, cell) in cells.iter_mut().enumerate() {
        if let Some(col) = columns.get(c) {
            *cell = unpad(cell, col);
        }
    }
}

/// 値のある場所 (ヘッダ・トレーラには行番号が無い)
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Spot {
    /// データ行 (0始まりの行位置)
    Row(usize),
    Header,
    Trailer,
}

impl Spot {
    /// 画面に出す場所の呼び名
    pub fn label(&self) -> String {
        match self {
            Spot::Row(n) => format!("{}行目", n + 1),
            Spot::Header => "ヘッダ".to_string(),
            Spot::Trailer => "トレーラ".to_string(),
        }
    }
}

/// 桁に収まらなかった値
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TooLong {
    /// どこの値か
    pub spot: Spot,
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
#[allow(clippy::too_many_arguments)]
pub fn dump(
    rows: &[Vec<String>],
    layout: &FixedLayout,
    enc: &'static encoding_rs::Encoding,
    newline: &str,
    head: &[String],
    tail: &[String],
    kinds: &[u32],
) -> Result<Vec<u8>, Vec<TooLong>> {
    let mut out: Vec<u8> = Vec::new();
    let mut bad: Vec<TooLong> = Vec::new();

    let mut write = |row: &[String], columns: &[FixedColumn], at: Spot, out: &mut Vec<u8>| {
        if columns.is_empty() {
            return;
        }
        for (c, col) in columns.iter().enumerate() {
            let value = row.get(c).map(String::as_str).unwrap_or("");
            match fit(value, col, layout.unit, enc) {
                Ok(cell) => out.extend_from_slice(&cell),
                Err(len) => {
                    // 見つけた分はまとめて返す (直す場所が一度に分かるように)
                    if bad.len() < 20 {
                        bad.push(TooLong {
                            spot: at,
                            col: c,
                            value: value.to_string(),
                            len,
                            width: col.width,
                        });
                    }
                }
            }
        }
        // 改行の無いファイルは、行の切れ目も書かない
        if layout.newline {
            out.extend_from_slice(newline.as_bytes());
        }
    };

    /*
     * ヘッダ・トレーラは、その値があるときだけ書く。
     *
     * 種別を見分けているときは、ヘッダ行も rows に入っているのでここでは書かない
     * (桁だけを見て書くと、空のレコードが1件よけいに出てしまう)
     */
    if !head.is_empty() {
        write(head, &layout.header, Spot::Header, &mut out);
    }
    for (r, row) in rows.iter().enumerate() {
        // 種別を見分けているときは、その行の種別の桁で書き戻す
        let columns = layout.columns_of(kinds.get(r).copied().unwrap_or(0));
        write(row, columns, Spot::Row(r), &mut out);
    }
    if !tail.is_empty() {
        write(tail, &layout.trailer, Spot::Trailer, &mut out);
    }

    if bad.is_empty() {
        Ok(out)
    } else {
        Err(bad)
    }
}

#[cfg(test)]
mod tests;
