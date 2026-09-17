//! CSV / TSV ファイルをテーブルへ取り込む。
//!
//! 「外部ツール無しで手元のファイルを入れたい」ための機能なので、
//! 日本語環境でよくある Shift_JIS も読めるようにしてある。
//!
//! 取り込みはトランザクションで包む。
//! 途中で失敗したら何も入っていない状態に戻す (半端に入るのが一番困るため)

use std::io::{Read, Seek};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 文字コードを見分けるために読む長さ
const SNIFF_BYTES: usize = 64 * 1024;

/// 1回のINSERTにまとめる行数の上限
const BATCH_ROWS: usize = 500;

/// 取り込みの上限行数 (誤って巨大なファイルを流し込まないための歯止め)。
///
/// 1行ずつ読んでバッチ単位でINSERTするので、行数が増えても使うメモリは変わらない。
/// ここは「桁を間違えたファイルを流し込んでしまった」ときに止めるための値
pub const MAX_ROWS: usize = 10_000_000;

/// プレビューで返す行数
const PREVIEW_ROWS: usize = 20;

/// 空行が続いたときに諦める本数 (終わらないファイルで固まらないための歯止め)
const MAX_BLANK_RUN: usize = 100_000;

/// 列ずれの下見で返す行の上限。
///
/// 全部返しても読み切れないので、先頭のいくつかだけを例として出す
pub const MAX_SHAPE_MISMATCHES: usize = 20;

/// 下見の途中で進捗と中止を見る間隔 (行)
const SCAN_CHECK_EVERY: usize = 2_000;

/// エラーに載せる値の長さ (文字数)
const VALUE_CLIP: usize = 40;

/// 読み取りの設定 (自動判定の結果を上書きできる)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    /// "," / "\t" など。未指定なら中身から推測する
    pub delimiter: Option<String>,
    /// "utf-8" / "shift_jis"。未指定なら中身から推測する
    pub encoding: Option<String>,
    /// 1行目を見出しとして扱うか
    pub has_header: bool,
}

/// 取り込み方法
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    /// そのまま追加する (重複キーがあればエラー)
    Append,
    /// 重複キーの行は飛ばす
    Skip,
    /// 重複キーの行は上書きする
    Replace,
}

/// 先頭だけ読んで見せる内容
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    /// 列の見出し (見出し行が無ければ "1列目" のような仮の名前)
    pub columns: Vec<String>,
    /// 先頭の数行 (見出し行は含まない)
    pub rows: Vec<Vec<String>>,
    /// 実際に使った区切り文字
    pub delimiter: String,
    /// 実際に使った文字コード
    pub encoding: String,
    /// 読み取り中に見つかった問題 (列数の不一致など)
    pub warning: Option<String>,
    /// 取り込める行の総数 (数え切れなかったときは None)
    pub total_rows: Option<usize>,
}

/// 列数が見出しと違う行1件
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeMismatch {
    /// ファイル上の行番号 (エディタで見た番号)
    pub line_no: u64,
    /// その行の列数
    pub width: usize,
}

/// ファイル全体を読み流して調べた「形」。
///
/// プレビューは先頭20行しか見ないので、途中で列がずれている行は見つからない。
/// 取り込む前に一度だけ全体を流して、行番号を出せるようにする
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeReport {
    /// 見出し (または1行目) の列数
    pub header_width: usize,
    /// 列数が違う行 (先頭 `MAX_SHAPE_MISMATCHES` 件まで)
    pub mismatches: Vec<ShapeMismatch>,
    /// 列数が違う行の総数 (例に出さなかった分も数える)
    pub mismatch_count: usize,
    /// 数えたデータ行数
    pub rows: usize,
    /// 上限に達して途中で打ち切ったか
    pub truncated: bool,
    /// 中止されたか (調べ切っていない)
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// 取り込みの結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// 取り込んだ行数
    pub rows: usize,
    /// 中止されたか (中止した場合は何も入っていない)
    pub cancelled: bool,
}

/// 文字コードを推測する。
/// UTF-8として読めればUTF-8、読めなければShift_JIS (日本語環境で多いため)
fn sniff_encoding(head: &[u8]) -> &'static encoding_rs::Encoding {
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return encoding_rs::UTF_8;
    }
    /*
     * UTF-16はBOMでしか見分けられない。
     * BOMを見ないと、ASCII主体のUTF-16は「間にNULが入ったUTF-8」として
     * 読めてしまい、値にNULが混ざったまま取り込まれる
     */
    // UTF-32LEのBOM (FF FE 00 00) をUTF-16LEと取り違えない
    if head.starts_with(&[0xFF, 0xFE]) && !head.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        return encoding_rs::UTF_16LE;
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE;
    }
    match std::str::from_utf8(head) {
        Ok(_) => encoding_rs::UTF_8,
        /*
         * 末尾で文字が切れているだけ (error_len が None) なら、
         * 途中まで読んだせいなのでUTF-8とみなす。
         * 本当に不正なバイトがあるときだけShift_JISと判断する
         */
        Err(e) if e.error_len().is_none() => encoding_rs::UTF_8,
        Err(_) => encoding_rs::SHIFT_JIS,
    }
}

/// 名前から文字コードを引く。
/// 知らない名前を黙ってUTF-8にすると、文字化けしたまま取り込まれるのでエラーにする
fn encoding_by_name(name: &str) -> Result<&'static encoding_rs::Encoding, String> {
    match name.to_ascii_lowercase().as_str() {
        "shift_jis" | "sjis" | "cp932" | "windows-31j" => Ok(encoding_rs::SHIFT_JIS),
        /*
         * for_label は utf-7 等に「中身を全部置換文字にする」特殊な指定を返す。
         * それでは文字化けしたまま取り込んでしまうので、返さない版を使う
         */
        other => encoding_rs::Encoding::for_label_no_replacement(other.as_bytes())
            .ok_or_else(|| format!("知らない文字コードです: {name}")),
    }
}

/// 区切り文字を推測する。1行目でカンマとタブのどちらが多いかで決める
fn sniff_delimiter(head: &str) -> u8 {
    let line = head.lines().next().unwrap_or("");
    let commas = line.matches(',').count();
    let tabs = line.matches('\t').count();
    if tabs > commas {
        b'\t'
    } else {
        b','
    }
}

/// 設定の区切り文字を1バイトにする (未指定・不正ならNone)
fn delimiter_byte(s: &str) -> Option<u8> {
    match s {
        "\\t" | "\t" => Some(b'\t'),
        _ => {
            let b = s.as_bytes();
            /*
             * 1バイトの記号だけ受け付ける (マルチバイトの区切りは扱わない)。
             * 引用符・改行を区切りにすると読み取り結果が意味を成さないので外す
             */
            (b.len() == 1
                && !b[0].is_ascii_alphanumeric()
                && !matches!(b[0], b'"' | b'\r' | b'\n' | 0))
            .then(|| b[0])
        }
    }
}

/// ファイルの改行の書き方。
///
/// `csv` クレートの行番号は「越えてきた `\n` の数」で数えているので、
/// 改行の書き方によってレコードの位置との関係が変わる。
/// 逆算するために、どれで書かれたファイルかを覚えておく
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Newline {
    /// `\n` (Unix)
    Lf,
    /// `\r\n` (Windows / Excel)
    CrLf,
    /// `\r` だけ (古いMac)
    Cr,
}

/// 先頭の中身から改行の書き方を見分ける。
///
/// 最初に見つかった改行で決める (混ざっているファイルは先頭に合わせる)
fn sniff_newline(head: &str) -> Newline {
    let Some(at) = head.find(['\r', '\n']) else {
        // 改行が1つも無いなら1行しかない。どれでも同じ
        return Newline::Lf;
    };
    let b = head.as_bytes();
    if b[at] == b'\n' {
        Newline::Lf
    } else if b.get(at + 1) == Some(&b'\n') {
        Newline::CrLf
    } else {
        Newline::Cr
    }
}

/// 読み込みながら `\r` を `\n` に置き換える。
///
/// `\r` だけで改行するファイルでは、`csv` の行番号がまったく動かない
/// (数えているのは `\n` だけ)。読み込む時点で書き換えてしまえば、
/// ほかの改行と同じ数え方で済む。
///
/// `\r\n` は `\n\n` にせず `\r` を捨てる。
/// この道は `\r` だけのファイルにしか通さないが、
/// 途中に `\r\n` が混ざっていても行数が増えないようにしておく。
///
/// 引用符の中の `\r` も `\n` になる。
/// そのファイルでは `\r` が改行なので、値の中の改行も改行として揃える
struct CrToLf<R> {
    inner: R,
    /// 読み込んだそのままの塊
    scratch: Vec<u8>,
    /// 置き換えたあとの、まだ渡していないぶん
    out: Vec<u8>,
    pos: usize,
    /// 直前の塊が `\r` で終わっていた。
    /// 次の塊の先頭が `\n` なら、その `\r` は `\r\n` の片割れ
    pending_cr: bool,
}

/// 一度に読み込む大きさ
const CR_CHUNK: usize = 8 * 1024;

impl<R: Read> CrToLf<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            scratch: vec![0; CR_CHUNK],
            out: Vec::with_capacity(CR_CHUNK + 1),
            pos: 0,
            pending_cr: false,
        }
    }

    /// 次の塊を読んで置き換える (渡せるものが無ければ `false`)
    fn fill(&mut self) -> std::io::Result<bool> {
        self.out.clear();
        self.pos = 0;
        let n = self.inner.read(&mut self.scratch)?;
        if n == 0 {
            // 末尾が `\r` で終わっていたら、最後の改行として出す
            if self.pending_cr {
                self.pending_cr = false;
                self.out.push(b'\n');
                return Ok(true);
            }
            return Ok(false);
        }
        let chunk = &self.scratch[..n];
        if self.pending_cr {
            self.pending_cr = false;
            // 次が `\n` なら `\r\n` だったので、持ち越した `\r` は捨てる
            if chunk[0] != b'\n' {
                self.out.push(b'\n');
            }
        }
        for (at, &b) in chunk.iter().enumerate() {
            if b != b'\r' {
                self.out.push(b);
                continue;
            }
            match chunk.get(at + 1) {
                // `\r\n` は `\r` を捨てて `\n` だけ通す
                Some(b'\n') => {}
                Some(_) => self.out.push(b'\n'),
                // 塊の最後。次を読むまで決められないので持ち越す
                None => self.pending_cr = true,
            }
        }
        Ok(true)
    }
}

impl<R: Read> Read for CrToLf<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // 置き換えた結果が空になる塊 (`\r` 1文字だけ等) もあるので繰り返す
        while self.pos >= self.out.len() {
            if !self.fill()? {
                return Ok(0);
            }
        }
        let n = buf.len().min(self.out.len() - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// 読み出し口と、実際に使った区切り文字・文字コード・改行
struct OpenedCsv {
    reader: csv::Reader<Box<dyn Read + Send>>,
    delimiter: String,
    encoding: String,
    newline: Newline,
}

/// ファイルを開いて、文字コードと区切り文字を決める
fn open_reader(path: &Path, opts: &CsvOptions) -> Result<OpenedCsv, String> {
    /*
     * 名前付きパイプやデバイスを渡されると終わりが来ず、画面が固まってしまう。
     * 普通のファイルだけを相手にする
     */
    let meta = std::fs::metadata(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    if !meta.is_file() {
        return Err("普通のファイルではありません".to_string());
    }

    let mut file = std::fs::File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    // read は1回で埋まる保証が無いので、読み切るまで繰り返す
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    file.by_ref()
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| format!("ファイルを読み込めません: {e}"))?;

    let enc = match opts.encoding.as_deref() {
        Some(name) if !name.is_empty() => encoding_by_name(name)?,
        _ => sniff_encoding(&head),
    };
    // 判定用に先頭だけ文字へ直す (区切り文字を数えるため)
    let (head_text, _, _) = enc.decode(&head);
    // 指定が読めない区切り文字なら、黙って自動判定に落とさずエラーにする
    let delim = match opts.delimiter.as_deref() {
        Some(s) if !s.is_empty() => {
            delimiter_byte(s).ok_or_else(|| format!("区切り文字として使えません: {s}"))?
        }
        _ => sniff_delimiter(&head_text),
    };

    // 判定のために読んだぶんを戻して、同じファイルを開き直さずに使う
    file.rewind()
        .map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    // BOMの除去と文字コードの変換をまとめて行う
    let decoded = encoding_rs_io::DecodeReaderBytesBuilder::new()
        .encoding(Some(enc))
        .build(file);
    /*
     * `\r` だけのファイルは、読み込む時点で `\n` に直してしまう。
     * `csv` の行番号は `\n` しか数えないので、そのままでは行が分からない
     */
    let newline = sniff_newline(&head_text);
    let source: Box<dyn Read + Send> = if newline == Newline::Cr {
        Box::new(CrToLf::new(decoded))
    } else {
        Box::new(decoded)
    };
    let reader = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        // 列数が揃っていない行があっても読み進める (警告として出す)
        .flexible(true)
        .from_reader(source);
    let delim_name = if delim == b'\t' {
        "\\t".to_string()
    } else {
        (delim as char).to_string()
    };
    Ok(OpenedCsv {
        reader,
        delimiter: delim_name,
        encoding: enc.name().to_ascii_lowercase(),
        // 置き換えて渡しているので、行の数え方は LF と同じでよい
        newline: if newline == Newline::Cr {
            Newline::Lf
        } else {
            newline
        },
    })
}

/// 見出しが無いときの仮の列名
fn placeholder_columns(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("{i}列目")).collect()
}

/**
 * 読んだ行が、ファイルの何行目から始まっていたかを数える。
 *
 * 空行は `csv` が黙って読み飛ばすのでこちらからは見えない。
 * そのため自前で数え上げるのではなく、`csv` が持っている行番号
 * (越えてきた `\n` の数 + 1) から逆算する。
 *
 * ずれ方は改行の書き方で変わる:
 *
 * - `\n`: 行末の `\n` はその行を読むときに越えるので、読み終えた位置は次の行を指す
 *   (最後の行に改行が無いときだけ越えていないので、1を引かない)
 * - `\r\n`: 行末の `\n` は **次の** レコードを読むときに越える。
 *   そのため読み終えた位置は、その行の最後の物理行をそのまま指す
 * - `\r` だけ: `csv` は `\n` しか数えないので行番号が動かない。
 *   読み込む時点で `\n` へ置き換えている (`CrToLf`) ので、`\n` と同じ扱いでよい
 */
struct LineCounter {
    newline: Newline,
}

impl LineCounter {
    fn new(newline: Newline) -> Self {
        Self { newline }
    }

    /// 1件読み終えるたびに呼ぶ。返すのはその行の開始行 (1始まり)
    fn line_of(&self, before: u64, after: u64, rec: &csv::StringRecord) -> u64 {
        // 引用符の中の改行も `csv` の行番号に入っている
        let inner: u64 = rec.iter().map(|f| f.matches('\n').count() as u64).sum();
        match self.newline {
            Newline::CrLf => after.saturating_sub(inner).max(1),
            // `\r` だけのファイルは読み込む時点で `\n` に直してあるので LF と同じ
            Newline::Lf | Newline::Cr => {
                // 値の中の改行より多く越えていれば、行末の改行も越えている
                let terminated = after.saturating_sub(before) > inner;
                after.saturating_sub(inner + u64::from(terminated)).max(1)
            }
        }
    }
}

/// 中身の無い行か (末尾の改行や空行)。
/// 列が2つ以上あって全部空の行 (",,") は中身のある行として扱う
fn is_blank(rec: &csv::StringRecord) -> bool {
    rec.len() <= 1 && rec.iter().all(|v| v.is_empty())
}

/// 文字コードの取り違えで置換文字 (U+FFFD) が出ていないか
fn has_garbled(rows: &[Vec<String>], columns: &[String]) -> bool {
    let garbled = |v: &String| v.contains('\u{FFFD}');
    columns.iter().any(garbled) || rows.iter().any(|r| r.iter().any(garbled))
}

/// 空行を飛ばして次の1件を返す。
/// 空行しか無いファイルで止まらないよう、続く本数に歯止めを置く
fn next_record<R: Read>(
    records: &mut csv::StringRecordsIter<'_, R>,
) -> Result<Option<csv::StringRecord>, String> {
    let mut blanks = 0usize;
    for r in records.by_ref() {
        let rec = r.map_err(|e| format!("CSVを読み取れません: {e}"))?;
        if is_blank(&rec) {
            blanks += 1;
            if blanks > MAX_BLANK_RUN {
                return Err("空行が続いています。ファイルを確かめてください".into());
            }
            continue;
        }
        return Ok(Some(rec));
    }
    Ok(None)
}

/// 先頭だけ読んで、列と数行を返す
pub fn preview(path: &Path, opts: &CsvOptions) -> Result<CsvPreview, String> {
    let OpenedCsv {
        mut reader,
        delimiter,
        encoding,
        ..
    } = open_reader(path, opts)?;
    let mut records = reader.records();

    let first = match next_record(&mut records)? {
        Some(r) => r,
        None => {
            return Ok(CsvPreview {
                columns: Vec::new(),
                rows: Vec::new(),
                delimiter,
                encoding,
                warning: Some("ファイルが空です".to_string()),
                total_rows: Some(0),
            })
        }
    };
    let width = first.len();
    let columns = if opts.has_header {
        first
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let v = v.trim();
                if v.is_empty() {
                    format!("{}列目", i + 1)
                } else {
                    v.to_string()
                }
            })
            .collect()
    } else {
        placeholder_columns(width)
    };

    let mut rows: Vec<Vec<String>> = Vec::new();
    if !opts.has_header {
        rows.push(first.iter().map(|v| v.to_string()).collect());
    }
    let mut mismatch = false;
    while rows.len() < PREVIEW_ROWS {
        let Some(r) = next_record(&mut records)? else {
            break;
        };
        if r.len() != width {
            mismatch = true;
        }
        rows.push(r.iter().map(|v| v.to_string()).collect());
    }

    let mut warnings: Vec<&str> = Vec::new();
    if mismatch {
        warnings.push("列の数が揃っていない行があります (足りない列は空として扱います)");
    }
    if has_garbled(&rows, &columns) {
        warnings.push("読めない文字があります (文字コードを指定してください)");
    }

    /*
     * 残りの行を数えて、全部で何行あるかを出す。
     * 進み具合の割合と「◯◯行」の表示に使う。
     * 読めない行があっても数えられたところで打ち切る
     * (取り込みのときに同じ所で止まるので、ここでは断らない)
     */
    let total_rows = count_rest(&mut records).map(|rest| rows.len() + rest);

    Ok(CsvPreview {
        columns,
        rows,
        delimiter,
        encoding,
        warning: (!warnings.is_empty()).then(|| warnings.join(" / ")),
        total_rows,
    })
}

/**
 * 残りのデータ行を数える。
 *
 * 読み取りでつまずいたら、その時点で諦めて None を返す。
 * 数えられなくても取り込みそのものはできるので、断らずに進める
 */
fn count_rest<R: Read>(records: &mut csv::StringRecordsIter<'_, R>) -> Option<usize> {
    let mut n = 0usize;
    loop {
        match next_record(records) {
            Ok(Some(_)) => n += 1,
            Ok(None) => return Some(n),
            Err(_) => return None,
        }
    }
}

/**
 * ファイル全体を読み流して、列数が見出しと違う行を探す。
 *
 * プレビューは先頭20行だけなので、2万行目で列がずれていても気づけない。
 * 値は持たずに1行ずつ数えるだけなので、使うメモリは行数に関係なく一定。
 *
 * 取り込みの前に一度だけ走らせる。大きいファイルでは時間がかかるので、
 * 進み具合を出して中止できるようにしてある
 */
pub fn scan_shape(
    path: &Path,
    opts: &CsvOptions,
    job: Option<&crate::csv_job::CsvJob>,
) -> Result<ShapeReport, String> {
    let started = std::time::Instant::now();
    if let Some(j) = job {
        j.set_phase(crate::csv_job::JobPhase::Scanning);
    }
    let OpenedCsv {
        mut reader,
        newline,
        ..
    } = open_reader(path, opts)?;
    let lines = LineCounter::new(newline);

    let mut header_width = 0usize;
    let mut seen_first = false;
    let mut rows = 0usize;
    let mut mismatches: Vec<ShapeMismatch> = Vec::new();
    let mut mismatch_count = 0usize;
    let mut truncated = false;
    let mut cancelled = false;
    let mut blanks = 0usize;

    loop {
        let before = reader.position().line();
        let mut rec = csv::StringRecord::new();
        let more = reader
            .read_record(&mut rec)
            .map_err(|e| format!("CSVを読み取れません: {e}"))?;
        if !more {
            break;
        }
        let line_no = lines.line_of(before, reader.position().line(), &rec);
        if is_blank(&rec) {
            blanks += 1;
            if blanks > MAX_BLANK_RUN {
                return Err("空行が続いています。ファイルを確かめてください".into());
            }
            continue;
        }
        if !seen_first {
            seen_first = true;
            header_width = rec.len();
            // 見出し行はデータではない
            if opts.has_header {
                continue;
            }
        }
        rows += 1;
        if rec.len() != header_width {
            mismatch_count += 1;
            if mismatches.len() < MAX_SHAPE_MISMATCHES {
                mismatches.push(ShapeMismatch {
                    line_no,
                    width: rec.len(),
                });
            }
        }
        if rows.is_multiple_of(SCAN_CHECK_EVERY) {
            if let Some(j) = job {
                j.set_rows(rows);
                if j.is_cancelled() {
                    cancelled = true;
                    break;
                }
            }
        }
        // 取り込みの上限を超えたら、そこで見るのをやめる (取り込み側でも断る)
        if rows >= MAX_ROWS {
            truncated = true;
            break;
        }
    }

    if let Some(j) = job {
        j.set_rows(rows);
        j.set_phase(crate::csv_job::JobPhase::Working);
    }
    Ok(ShapeReport {
        header_width,
        mismatches,
        mismatch_count,
        rows,
        truncated,
        cancelled,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 型として読めない値が入っていた列
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadColumn {
    /// 取り込み先のカラム名
    pub name: String,
    /// 利用者に見せる型の呼び方 (「日付」など)
    pub kind: &'static str,
    /// 実際に入っていた値
    pub value: String,
}

/// 型名から「利用者に見せる呼び方」を決める。
///
/// 見分けられない型 (文字列など) は None にして、確かめる対象から外す
/// (文字列列は何が入っていても妥当なので、推定の役に立たない)
fn type_kind(type_name: &str) -> Option<&'static str> {
    // "bigint(20) unsigned" / "timestamp without time zone" のような書き方をそろえる
    let base = type_name.split('(').next()?.trim().to_ascii_lowercase();
    let head = base.split_whitespace().next()?;
    match head {
        "date" => Some("日付"),
        "datetime" | "timestamp" | "timestamptz" => Some("日時"),
        "time" | "timetz" => Some("時刻"),
        "int" | "integer" | "bigint" | "smallint" | "tinyint" | "mediumint" | "int2" | "int4"
        | "int8" | "serial" | "bigserial" | "smallserial" => Some("整数"),
        "decimal" | "numeric" | "float" | "double" | "real" | "money" => Some("数値"),
        _ => None,
    }
}

/// ASCIIの数字だけでできているか (全角数字は通さない)
fn all_ascii_digits(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
}

/// `2024-01-02` / `2024/1/2` の形で始まるか。
///
/// 後ろに時刻が続いていてもよい (日時の列でも同じ判定を使う)
fn starts_with_date(v: &str) -> bool {
    let b = v.as_bytes();
    // 一番短い形が "2024-1-2" の8バイト
    if b.len() < 8 || !b[..4].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let mut at = 4;
    // 「区切り + 1〜2桁」を月と日で2回
    for _ in 0..2 {
        if !matches!(b.get(at), Some(b'-') | Some(b'/')) {
            return false;
        }
        at += 1;
        let start = at;
        while at < b.len() && at - start < 2 && b[at].is_ascii_digit() {
            at += 1;
        }
        if at == start {
            return false;
        }
    }
    true
}

/// 符号つきの整数か
fn looks_like_int(v: &str) -> bool {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    all_ascii_digits(body)
}

/// 小数・指数つきの数値か
fn looks_like_number(v: &str) -> bool {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    let ok_mantissa = match mantissa.split_once('.') {
        Some((a, b)) => {
            (all_ascii_digits(a) || a.is_empty())
                && (all_ascii_digits(b) || b.is_empty())
                && !(a.is_empty() && b.is_empty())
        }
        None => all_ascii_digits(mantissa),
    };
    let ok_exponent = match exponent {
        Some(e) => looks_like_int(e),
        None => true,
    };
    ok_mantissa && ok_exponent
}

/// `12:34` の形で始まるか
fn starts_with_time(v: &str) -> bool {
    let b = v.as_bytes();
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    (1..=2).contains(&digits) && b.get(digits) == Some(&b':')
}

/// その型として読めそうな値か (**緩い判定**)。
///
/// ここで通すことより、明らかに読めないもの (日付列に日本語など) を
/// 見つけることが目的。厳しくするとDBが受ける書き方まで弾いてしまう
pub fn looks_like(kind: &str, value: &str) -> bool {
    match kind {
        // MySQLは "20240102" のような区切り無しも受ける
        "日付" | "日時" => starts_with_date(value) || all_ascii_digits(value),
        "時刻" => starts_with_time(value) || all_ascii_digits(value),
        "整数" => looks_like_int(value),
        "数値" => looks_like_number(value),
        _ => true,
    }
}

/**
 * 型として読めない値が入っている列を、先頭から探す。
 *
 * 「どの列が原因か」はDBのエラー文からは分からないことが多い
 * (MySQLの照合順序のエラーは列名を言わない) ので、
 * 取り込み先の型と実際の値を見比べて推定する。
 *
 * あくまで推定なので、呼び出し側で元のエラー文も必ず併記すること
 */
pub fn guess_bad_column(
    columns: &[String],
    types: &[String],
    values: &[Option<String>],
) -> Option<BadColumn> {
    for (at, name) in columns.iter().enumerate() {
        // 見分けられない型 (文字列など) は飛ばす
        let Some(kind) = types.get(at).and_then(|t| type_kind(t)) else {
            continue;
        };
        // 空欄とNULLは候補にしない (型の問題ではなく必須かどうかの話になる)
        let Some(value) = values.get(at).and_then(|v| v.as_deref()) else {
            continue;
        };
        if value.is_empty() || looks_like(kind, value) {
            continue;
        }
        return Some(BadColumn {
            name: name.clone(),
            kind,
            value: value.to_string(),
        });
    }
    None
}

/// 長い値は途中で切る (エラー文が画面を埋めないように)
fn clip_value(v: &str) -> String {
    let mut out: String = v.chars().take(VALUE_CLIP).collect();
    if out.chars().count() < v.chars().count() {
        out.push('…');
    }
    out
}

/// 失敗した1行の情報 (言い換えの材料)
#[derive(Debug, Clone, Copy)]
pub struct FailedRow<'a> {
    pub meta: RowMeta,
    /// 見出しの列数 (分からなければ None)
    pub header_width: Option<usize>,
    /// 取り込み先のカラム名 (`values` と同じ並び)
    pub columns: &'a [String],
    /// 取り込み先の型名 (`columns` と同じ並び)
    pub types: &'a [String],
    pub values: &'a [Option<String>],
    /// DBが返した元のエラー文
    pub raw: &'a str,
}

/**
 * 失敗した行について、利用者が原因にたどり着ける文言を作る。
 *
 * MySQLの「Conversion from collation ... impossible for parameter」のような
 * 文言だけでは、日付列に文字が入ったことは読み取れない。
 * 行番号・列名・値まで言う。
 *
 * 推定した内容だけに置き換えず、元のエラー文も必ず残す
 * (推定が外れたときの手掛かりを消さないため)
 */
pub fn failure_message(row: &FailedRow, failure: &crate::db::DbFailure) -> String {
    use crate::db::DbFailure;

    let mut out = String::new();
    /*
     * 列がずれている行は、値にクォートされていないカンマや改行がある。
     * 型の話より先にこれを言えば、原因に一直線でたどり着ける
     */
    if let Some(width) = row.header_width {
        if width != row.meta.width {
            out.push_str(&format!(
                "この行は列の数が{}個で、見出し ({}個) と違います。\
値にカンマや改行が含まれていてクォートされていない可能性があります\n",
                row.meta.width, width
            ));
        }
    }
    let line = row.meta.line_no;
    match failure {
        DbFailure::Duplicate => out.push_str(&duplicate_text(line, row.raw)),
        DbFailure::NotNull {
            column: Some(column),
        } => out.push_str(&format!(
            "{line}行目: `{column}` は必須ですが空です ({})",
            row.raw
        )),
        DbFailure::NotNull { column: None } => {
            out.push_str(&format!("{line}行目: 必須の列が空です ({})", row.raw))
        }
        DbFailure::BadValue { column, .. } => {
            // DBが列名を言っているなら、それが正しい。推定より優先する
            let named = column
                .as_deref()
                .and_then(|name| named_bad_column(name, row.columns, row.types, row.values));
            match named.or_else(|| guess_bad_column(row.columns, row.types, row.values)) {
                Some(bad) => out.push_str(&format!(
                    "{line}行目: `{}` に{}として読めない値があります: `{}`\n{}",
                    bad.name,
                    bad.kind,
                    clip_value(&bad.value),
                    row.raw
                )),
                // 列を言い当てられないなら、せめて行だけは言う
                None => out.push_str(&format!("{line}行目で失敗しました: {}", row.raw)),
            }
        }
        DbFailure::Other => {
            out.push_str(&format!("{line}行目で失敗しました: {}", row.raw))
        }
    }
    out
}

/// 重複キーのときの文言 (行を特定できなかったときにも使う)
pub fn duplicate_text(line: u64, raw: &str) -> String {
    format!(
        "{line}行目: 主キーまたはユニークキーが既存の行と重複しています ({raw})\n\
{DUP_NOTE}"
    )
}

/// 重複キーのときだけ添える注記
pub const DUP_NOTE: &str = "(同じ主キーの行がファイルの中にある場合もこの形で失敗します)";

/// DBが名指しした列を、取り込み先の並びから引く。
///
/// 名前が一致しない (取り込んでいない列だった) ときは None にして、
/// 推定へ任せる
fn named_bad_column(
    name: &str,
    columns: &[String],
    types: &[String],
    values: &[Option<String>],
) -> Option<BadColumn> {
    let at = columns.iter().position(|c| c.eq_ignore_ascii_case(name))?;
    Some(BadColumn {
        name: columns[at].clone(),
        // 型が見分けられない列でも、DBが言うならその列を出す
        kind: types.get(at).and_then(|t| type_kind(t)).unwrap_or("その型"),
        value: values
            .get(at)
            .and_then(|v| v.clone())
            .unwrap_or_default(),
    })
}

/// 取り込み先の1列
#[derive(Debug, Clone)]
pub struct TargetColumn {
    /// テーブルのカラム名
    pub name: String,
    /// PostgreSQLで型を合わせるためのキャスト先 (他のDBでは使わない)
    pub cast_type: Option<String>,
}

/// INSERT文を組み立てる。
///
/// プレースホルダはDBごとに違う (MySQL/SQLiteは `?`、PostgreSQLは `$1`)。
/// PostgreSQLは文字列のまま渡すと型が合わないので、列の型へキャストする
pub fn build_insert(
    db: crate::models::DbType,
    table: &str,
    cols: &[TargetColumn],
    rows: usize,
    mode: ImportMode,
    conflict_keys: &[String],
) -> String {
    let quote = |s: &str| crate::ddl::quote(db, s);
    let names: Vec<String> = cols.iter().map(|c| quote(&c.name)).collect();
    let mut n = 0;
    let values: Vec<String> = (0..rows)
        .map(|_| {
            let cells: Vec<String> = cols
                .iter()
                .map(|c| {
                    n += 1;
                    match db {
                        crate::models::DbType::Postgresql => match &c.cast_type {
                            Some(t) => format!("CAST(${n} AS {t})"),
                            None => format!("${n}"),
                        },
                        _ => "?".to_string(),
                    }
                })
                .collect();
            format!("({})", cells.join(", "))
        })
        .collect();

    let mut sql = format!(
        "INSERT INTO {} ({}) VALUES {}",
        table,
        names.join(", "),
        values.join(", ")
    );
    sql.push_str(&conflict_clause(db, cols, &names, mode, conflict_keys));
    sql
}

/*
 * 重複したときの書き方はDBごとに違う。
 *
 * MySQLの INSERT IGNORE / SQLiteの INSERT OR IGNORE は重複以外の誤り
 * (NOT NULL違反や型の不一致) まで黙って握りつぶすので使わない。
 * SQLiteの INSERT OR REPLACE も「消してから入れ直す」動きで、
 * 選ばなかった列が既定値へ戻り、ON DELETE CASCADE が走ってしまうので使わない
 */
fn conflict_clause(
    db: crate::models::DbType,
    cols: &[TargetColumn],
    names: &[String],
    mode: ImportMode,
    conflict_keys: &[String],
) -> String {
    use crate::models::DbType;
    let quote = |s: &str| crate::ddl::quote(db, s);
    /*
     * 重複した行を更新する式。
     * 主キーは書き換えない。別のUNIQUEキーで重複したときに
     * 既存行の主キーを書き換えてしまい、参照が壊れるため
     */
    let sets = |source: &str| -> Vec<String> {
        cols.iter()
            .filter(|c| !conflict_keys.contains(&c.name))
            .map(|c| {
                let q = quote(&c.name);
                // MySQLは新しい値を VALUES(列) で参照する (5.7でも動く書き方)
                if source.is_empty() {
                    format!("{q} = VALUES({q})")
                } else {
                    format!("{q} = {source}.{q}")
                }
            })
            .collect()
    };

    match (db, mode) {
        (_, ImportMode::Append) => String::new(),

        // 何も更新しないUPDATEを書くことで「重複だけ飛ばす」意味にする
        (DbType::Mysql, ImportMode::Skip) => match names.first() {
            Some(first) => format!(" ON DUPLICATE KEY UPDATE {first} = {first}"),
            None => String::new(),
        },
        (DbType::Postgresql | DbType::Sqlite, ImportMode::Skip) => {
            " ON CONFLICT DO NOTHING".to_string()
        }

        (DbType::Mysql, ImportMode::Replace) => {
            let sets = sets("");
            match (sets.is_empty(), names.first()) {
                // 主キーしか無ければ書き換える列が無いので、飛ばすのと同じ
                (true, Some(first)) => {
                    format!(" ON DUPLICATE KEY UPDATE {first} = {first}")
                }
                (true, None) => String::new(),
                _ => format!(" ON DUPLICATE KEY UPDATE {}", sets.join(", ")),
            }
        }
        (DbType::Postgresql | DbType::Sqlite, ImportMode::Replace) => {
            let keys: Vec<String> = conflict_keys.iter().map(|k| quote(k)).collect();
            if keys.is_empty() {
                // 呼ぶ側で主キーの有無を確かめているので、ここへは来ない
                return " ON CONFLICT DO NOTHING".to_string();
            }
            // PostgreSQL・SQLiteとも excluded で新しい値を参照する
            let sets = sets("excluded");
            if sets.is_empty() {
                format!(" ON CONFLICT ({}) DO NOTHING", keys.join(", "))
            } else {
                format!(
                    " ON CONFLICT ({}) DO UPDATE SET {}",
                    keys.join(", "),
                    sets.join(", ")
                )
            }
        }
        (DbType::Valkey, _) => String::new(),
    }
}

/// PostgreSQLのキャスト先として使える型名か。
///
/// 型名はカタログ (`format_type`) から取るので本来は安全だが、
/// SQLへそのまま埋めるので念のため確かめる
pub fn safe_cast_type(t: &str) -> bool {
    if t.is_empty() || t.len() > 128 {
        return false;
    }
    // 配列の "[]" は先に外す
    let mut base = t.trim();
    while let Some(head) = base.strip_suffix("[]") {
        base = head.trim_end();
    }
    /*
     * "numeric(10,2)" や "timestamp(3) without time zone" のような桁指定は、
     * 括弧の中が数字とカンマだけのものに限る。
     * 括弧を外した残りを型名として確かめる
     */
    let name = match base.find('(') {
        Some(open) => {
            let Some(close) = base[open..].find(')').map(|at| open + at) else {
                return false;
            };
            let args = &base[open + 1..close];
            let ok_args = !args.is_empty()
                && args
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == ',' || c == ' ');
            let tail = &base[close + 1..];
            if !ok_args || tail.contains('(') || tail.contains(')') {
                return false;
            }
            format!("{}{}", &base[..open], tail)
        }
        None => base.to_string(),
    };
    simple_type_name(name.trim())
}

/// 括弧を外した型名として使えるか (`public."myEnum"` のような修飾も認める)
fn simple_type_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() <= 2 && parts.iter().all(|p| simple_ident(p))
}

/// 型名の1つぶんとして使える文字だけか
fn simple_ident(part: &str) -> bool {
    let part = part.trim();
    if part.is_empty() {
        return false;
    }
    // 引用符で囲んだ名前 ("My Type") は、中に引用符を含まないものだけ認める
    if let Some(inner) = part.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return !inner.is_empty() && !inner.contains('"');
    }
    part.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_')
}

/// 1行の出所。
///
/// 失敗したときに「ファイルの何行目か」「列が何個だったか」を言うために持つ。
/// 読んだ行数では、空行や見出しを飛ばした分だけエディタの行番号とずれる
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowMeta {
    /// ファイル上の行番号 (1始まり。引用符の中の改行も数える)
    pub line_no: u64,
    /// その行がCSVとして持っていた列の数 (取り込む列数とは別)
    pub width: usize,
}

/// 読み出した1行
#[derive(Debug, Clone)]
pub struct CsvRow {
    pub meta: RowMeta,
    /// 取り込み先の列順に並べた値
    pub values: Vec<Option<String>>,
}

/// CSVを1行ずつ読み出す。
///
/// 列の対応 (`mapping`) は「CSVの何列目を使うか」を取り込み先の列順で持つ。
/// 足りない列や空欄の扱いはここで揃える
pub struct RowReader {
    reader: csv::Reader<Box<dyn Read + Send>>,
    mapping: Vec<usize>,
    empty_as_null: bool,
    skipped_header: bool,
    /// 文字化けを見つけたら止めるか (文字コードを自分で選んだときは止めない)
    check_garbled: bool,
    /// 見出し (見出し行が無ければ1行目) の列数。まだ読んでいなければ None
    header_width: Option<usize>,
    /// 行番号の数え方 (改行の書き方でずれ方が違う)
    lines: LineCounter,
}

impl RowReader {
    pub fn new(
        path: &Path,
        opts: &CsvOptions,
        mapping: Vec<usize>,
        empty_as_null: bool,
    ) -> Result<Self, String> {
        let OpenedCsv {
            reader, newline, ..
        } = open_reader(path, opts)?;
        Ok(Self {
            reader,
            mapping,
            empty_as_null,
            skipped_header: !opts.has_header,
            /*
             * 自動判定に任せたときだけ止める。
             * 自分で文字コードを選んだ場合は、置換文字を含むファイルを
             * 承知で取り込みたいこともあるため通す
             */
            check_garbled: opts.encoding.as_deref().unwrap_or("").is_empty(),
            header_width: None,
            lines: LineCounter::new(newline),
        })
    }

    /// 見出しの列数 (1行でも読んでいれば分かる)
    pub fn header_width(&self) -> Option<usize> {
        self.header_width
    }

    /// 次の1行 (取り込み先の列順)。終わりなら None
    pub fn next_row(&mut self) -> Result<Option<CsvRow>, String> {
        let mut blanks = 0usize;
        loop {
            let before = self.reader.position().line();
            let mut rec = csv::StringRecord::new();
            let more = self
                .reader
                .read_record(&mut rec)
                .map_err(|e| format!("CSVを読み取れません: {e}"))?;
            if !more {
                return Ok(None);
            }
            let line_no = self
                .lines
                .line_of(before, self.reader.position().line(), &rec);
            /*
             * 何も無い行 (末尾の改行など) は飛ばす。
             * 列が2つ以上あるのに全部空の行 (",,") は、
             * 「全列が空」という中身のある行なので飛ばさない
             */
            if is_blank(&rec) {
                blanks += 1;
                if blanks > MAX_BLANK_RUN {
                    return Err("空行が続いています。ファイルを確かめてください".into());
                }
                continue;
            }
            // 見出しの列数は、見出し行が無い場合も1行目から取る
            if self.header_width.is_none() {
                self.header_width = Some(rec.len());
            }
            // 見出し行を飛ばすのは空行を除いたあと (先頭の空行に食われないように)
            if !self.skipped_header {
                self.skipped_header = true;
                continue;
            }
            /*
             * 文字コードを取り違えると、読めなかったところが置換文字になる。
             * 気づかないまま化けた値を入れてしまわないよう、ここで止める。
             * 見るのは取り込む列だけ (捨てる列の化けで止めない)
             */
            if self.check_garbled
                && self
                    .mapping
                    .iter()
                    .any(|&i| rec.get(i).is_some_and(|v| v.contains('\u{FFFD}')))
            {
                return Err(
                    "読めない文字があります。文字コードを指定してやり直してください".into(),
                );
            }
            let values = self
                .mapping
                .iter()
                .map(|&i| {
                    let v = rec.get(i).unwrap_or("");
                    if v.is_empty() && self.empty_as_null {
                        None
                    } else {
                        Some(v.to_string())
                    }
                })
                .collect();
            return Ok(Some(CsvRow {
                meta: RowMeta {
                    line_no,
                    width: rec.len(),
                },
                values,
            }));
        }
    }
}

/// 1文のSQLに渡せるプレースホルダの数の上限。
///
/// PostgreSQL/MySQLは65535、SQLiteは32766。少し余裕を見た値にしてある
pub fn max_params(db: crate::models::DbType) -> usize {
    match db {
        crate::models::DbType::Sqlite => 30_000,
        _ => 60_000,
    }
}

/// 1バッチの中でキーが**文字列として同じ**行を1つにまとめる (後の行を残す)。
///
/// PostgreSQLは1つのINSERTで同じ行を2回更新できず、
/// 同じキーの行が1つの文に2つ入るとその文ごと失敗してしまう。
///
/// 見比べるのはCSVの文字そのままなので、`1` と `01` のように
/// DBの型に直すと同じになる書き方までは揃えられない
pub fn dedupe_rows(
    params: &mut Vec<Option<String>>,
    metas: &mut Vec<RowMeta>,
    width: usize,
    key_idx: &[usize],
) -> usize {
    // 列が無ければ行も無い / まとめる手掛かりが無ければそのまま
    if width == 0 {
        params.clear();
        metas.clear();
        return 0;
    }
    let rows = params.len() / width;
    if key_idx.is_empty() {
        return rows;
    }
    let key_of = |row: usize| -> Vec<Option<String>> {
        key_idx
            .iter()
            .map(|&at| params[row * width + at].clone())
            .collect()
    };
    // まず、それぞれのキーが最後に出てくる位置を覚える
    let mut last: std::collections::HashMap<Vec<Option<String>>, usize> =
        std::collections::HashMap::with_capacity(rows);
    for row in 0..rows {
        last.insert(key_of(row), row);
    }
    if last.len() == rows {
        return rows;
    }
    // 最後の1つだけを、元の並びのまま残す
    let keep: Vec<usize> = (0..rows)
        .filter(|row| last.get(&key_of(*row)) == Some(row))
        .collect();
    let mut out: Vec<Option<String>> = Vec::with_capacity(keep.len() * width);
    for row in &keep {
        out.extend_from_slice(&params[row * width..(row + 1) * width]);
    }
    *params = out;
    // 行番号も同じ順で減らす (失敗した行を言えなくなるため)
    if metas.len() == rows {
        *metas = keep.iter().map(|&row| metas[row]).collect();
    }
    keep.len()
}

/// 桁を3つずつカンマで区切る (行数をメッセージに出すときに使う)
pub fn fmt_count(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (at, ch) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// 1回のINSERTにまとめる行数。
///
/// 列数が多いテーブルでは、行数×列数がプレースホルダの上限を超えて
/// 必ず失敗してしまうので、列数から逆算する
pub fn batch_rows(db: crate::models::DbType, columns: usize) -> usize {
    // SQLiteは多値VALUESの項数にも上限 (既定500) があるので更に抑える
    let cap = match db {
        crate::models::DbType::Sqlite => 400,
        _ => BATCH_ROWS,
    };
    if columns == 0 {
        return cap;
    }
    (max_params(db) / columns).clamp(1, cap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbType;

    fn cols(names: &[&str]) -> Vec<TargetColumn> {
        names
            .iter()
            .map(|n| TargetColumn {
                name: n.to_string(),
                cast_type: None,
            })
            .collect()
    }

    /// 一時ファイルへ書いてから読み取る (preview はパスを受け取るため)
    fn preview_text(body: &str, has_header: bool) -> CsvPreview {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "quelio_preview_{}_{}.csv",
            std::process::id(),
            body.len()
        ));
        std::fs::write(&path, body).unwrap();
        let got = preview(
            &path,
            &CsvOptions {
                has_header,
                ..Default::default()
            },
        );
        let _ = std::fs::remove_file(&path);
        got.unwrap()
    }

    #[test]
    fn 取り込める行数を数える() {
        // 見出しの下に3行
        let p = preview_text("a,b\n1,2\n3,4\n5,6\n", true);
        assert_eq!(p.total_rows, Some(3));
        assert_eq!(p.rows.len(), 3);

        // 見出し無しなら1行目も数える
        let p = preview_text("1,2\n3,4\n", false);
        assert_eq!(p.total_rows, Some(2));
    }

    #[test]
    fn 先頭に出す分より多くても全部数える() {
        let mut body = String::from("a,b\n");
        for i in 0..(PREVIEW_ROWS * 3) {
            body.push_str(&format!("{i},x\n"));
        }
        let p = preview_text(&body, true);
        assert_eq!(p.total_rows, Some(PREVIEW_ROWS * 3));
        // 画面に出すのは先頭だけ
        assert_eq!(p.rows.len(), PREVIEW_ROWS);
    }

    #[test]
    fn 空行は数に入れない() {
        let p = preview_text("a,b\n1,2\n\n\n3,4\n", true);
        assert_eq!(p.total_rows, Some(2));
    }

    #[test]
    fn 空のファイルは0行() {
        let p = preview_text("", true);
        assert_eq!(p.total_rows, Some(0));
    }

    #[test]
    fn 見出しだけのファイルは0行() {
        let p = preview_text("a,b\n", true);
        assert_eq!(p.total_rows, Some(0));
    }

    #[test]
    fn 文字コードを見分ける() {
        assert_eq!(sniff_encoding("あいう".as_bytes()), encoding_rs::UTF_8);
        assert_eq!(sniff_encoding(b"plain ascii"), encoding_rs::UTF_8);
        // BOM付きはUTF-8
        assert_eq!(
            sniff_encoding(&[0xEF, 0xBB, 0xBF, b'a']),
            encoding_rs::UTF_8
        );
        // Shift_JISの「あ」(0x82 0xA0) はUTF-8として読めない
        let sjis = [0x82u8, 0xA0, 0x82, 0xA2, 0x82, 0xA4, b'\n', b'x'];
        assert_eq!(sniff_encoding(&sjis), encoding_rs::SHIFT_JIS);
        // UTF-16はBOMで見分ける (中身はASCIIでもUTF-8として読めてしまうため)
        assert_eq!(
            sniff_encoding(&[0xFF, 0xFE, b'a', 0x00]),
            encoding_rs::UTF_16LE
        );
        assert_eq!(
            sniff_encoding(&[0xFE, 0xFF, 0x00, b'a']),
            encoding_rs::UTF_16BE
        );
    }

    #[test]
    fn 区切り文字を見分ける() {
        assert_eq!(sniff_delimiter("a,b,c\n1,2,3"), b',');
        assert_eq!(sniff_delimiter("a\tb\tc\n1\t2\t3"), b'\t');
        // どちらも無ければカンマ扱い
        assert_eq!(sniff_delimiter("abc"), b',');
        // 1行目だけで決める (2行目にタブが多くても影響しない)
        assert_eq!(sniff_delimiter("a,b\n1\t2\t3\t4"), b',');
    }

    #[test]
    fn 区切り文字の指定を受け取る() {
        assert_eq!(delimiter_byte(","), Some(b','));
        assert_eq!(delimiter_byte("\\t"), Some(b'\t'));
        assert_eq!(delimiter_byte(";"), Some(b';'));
        // 英数字と複数文字は受け付けない
        assert_eq!(delimiter_byte("a"), None);
        assert_eq!(delimiter_byte("::"), None);
        assert_eq!(delimiter_byte(""), None);
        // 引用符・改行を区切りにすると読み取りが壊れる
        assert_eq!(delimiter_byte("\""), None);
        assert_eq!(delimiter_byte("\n"), None);
    }

    #[test]
    fn mysqlのinsertを組み立てる() {
        let sql = build_insert(
            DbType::Mysql,
            "`t`",
            &cols(&["a", "b"]),
            2,
            ImportMode::Append,
            &[],
        );
        assert_eq!(sql, "INSERT INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)");
    }

    #[test]
    fn 重複時の書き方が接続の種類で変わる() {
        let c = cols(&["id", "name"]);
        let pk = ["id".to_string()];

        /*
         * INSERT IGNORE / INSERT OR IGNORE は重複以外の誤りまで握りつぶすので使わない。
         * INSERT OR REPLACE も「消して入れ直す」動きなので使わない
         */
        let skip_my = build_insert(DbType::Mysql, "`t`", &c, 1, ImportMode::Skip, &pk);
        assert!(skip_my.starts_with("INSERT INTO"));
        assert!(skip_my.ends_with("ON DUPLICATE KEY UPDATE `id` = `id`"));

        let rep_my = build_insert(DbType::Mysql, "`t`", &c, 1, ImportMode::Replace, &pk);
        assert!(rep_my.ends_with("ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)"));
        // 主キーは書き換えない (他のUNIQUEキーで重複したときに壊れるため)
        assert!(!rep_my.contains("`id` = VALUES(`id`)"));

        let skip_sq = build_insert(DbType::Sqlite, "\"t\"", &c, 1, ImportMode::Skip, &pk);
        assert!(skip_sq.starts_with("INSERT INTO"));
        assert!(skip_sq.ends_with("ON CONFLICT DO NOTHING"));

        let rep_sq = build_insert(DbType::Sqlite, "\"t\"", &c, 1, ImportMode::Replace, &pk);
        assert!(rep_sq.starts_with("INSERT INTO"));
        assert!(rep_sq.ends_with(r#"ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name""#));

        let skip_pg = build_insert(DbType::Postgresql, "\"t\"", &c, 1, ImportMode::Skip, &pk);
        assert!(skip_pg.ends_with("ON CONFLICT DO NOTHING"));
    }

    #[test]
    fn postgresqlは型へキャストする() {
        let c = vec![
            TargetColumn {
                name: "id".into(),
                cast_type: Some("integer".into()),
            },
            TargetColumn {
                name: "memo".into(),
                cast_type: None,
            },
        ];
        let sql = build_insert(
            DbType::Postgresql,
            "\"t\"",
            &c,
            2,
            ImportMode::Replace,
            &["id".to_string()],
        );
        assert!(sql.contains("(CAST($1 AS integer), $2), (CAST($3 AS integer), $4)"));
        // 主キーは更新対象から外す
        assert!(sql.contains(r#"ON CONFLICT ("id") DO UPDATE SET "memo" = excluded."memo""#));
        assert!(!sql.contains(r#""id" = excluded"#));
    }

    #[test]
    fn 主キーしか無ければ上書きせず飛ばす() {
        let c = cols(&["id"]);
        let sql = build_insert(
            DbType::Postgresql,
            "\"t\"",
            &c,
            1,
            ImportMode::Replace,
            &["id".to_string()],
        );
        assert!(sql.ends_with(r#"ON CONFLICT ("id") DO NOTHING"#));
    }

    #[test]
    fn キャスト先の型名を確かめる() {
        assert!(safe_cast_type("integer"));
        assert!(safe_cast_type("character varying(255)"));
        assert!(safe_cast_type("numeric(10,2)"));
        assert!(safe_cast_type("timestamp(3) without time zone"));
        assert!(safe_cast_type("text[]"));
        assert!(safe_cast_type("public.\"myEnum\""));
        // 危ないものは通さない
        assert!(!safe_cast_type("int; DROP TABLE x"));
        assert!(!safe_cast_type("int'--"));
        assert!(!safe_cast_type(""));
        // 括弧の中に数字以外を書けない (副問い合わせを紛れ込ませない)
        assert!(!safe_cast_type("int), (SELECT id FROM users"));
        assert!(!safe_cast_type("int(1) AS x(2)"));
    }

    #[test]
    fn 桁をカンマで区切る() {
        assert_eq!(fmt_count(0), "0");
        assert_eq!(fmt_count(999), "999");
        assert_eq!(fmt_count(1_000), "1,000");
        assert_eq!(fmt_count(10_000_000), "10,000,000");
    }

    #[test]
    fn 行数は列数に合わせて減らす() {
        // 列が少なければ上限いっぱい
        assert_eq!(batch_rows(DbType::Postgresql, 2), 500);
        // 列が多いときはプレースホルダの上限 (65535) を超えない
        let n = batch_rows(DbType::Postgresql, 200);
        assert!(n * 200 <= 65_535, "{n}");
        // SQLiteは上限が低い (32766)
        let n = batch_rows(DbType::Sqlite, 100);
        assert!(n * 100 <= 32_766, "{n}");
        // 列が極端に多くても1行は送る
        assert_eq!(batch_rows(DbType::Sqlite, 100_000), 1);
    }

    #[test]
    fn 中身の無い行だけを飛ばす() {
        let blank = csv::StringRecord::from(vec![""]);
        assert!(is_blank(&blank));
        // 列が2つ以上あって全部空なのは「全列が空の行」なので飛ばさない
        let empties = csv::StringRecord::from(vec!["", "", ""]);
        assert!(!is_blank(&empties));
        assert!(!is_blank(&csv::StringRecord::from(vec!["a"])));
    }

    fn metas(lines: &[u64]) -> Vec<RowMeta> {
        lines
            .iter()
            .map(|&line_no| RowMeta { line_no, width: 2 })
            .collect()
    }

    #[test]
    fn 同じキーの行は後のものを残す() {
        let cell = |v: &str| Some(v.to_string());
        // 2列 (キーは0列目)、id=1 が2回出てくる
        let mut params = vec![
            cell("1"),
            cell("あ"),
            cell("2"),
            cell("い"),
            cell("1"),
            cell("う"),
        ];
        let mut m = metas(&[10, 11, 12]);
        let rows = dedupe_rows(&mut params, &mut m, 2, &[0]);
        assert_eq!(rows, 2);
        assert_eq!(params, vec![cell("2"), cell("い"), cell("1"), cell("う")]);
        // 行番号も同じ順で減る (残ったのは2行目と3行目)
        assert_eq!(m.iter().map(|x| x.line_no).collect::<Vec<_>>(), vec![11, 12]);

        // 重複が無ければそのまま
        let mut params = vec![cell("1"), cell("あ"), cell("2"), cell("い")];
        let mut m = metas(&[1, 2]);
        assert_eq!(dedupe_rows(&mut params, &mut m, 2, &[0]), 2);
        assert_eq!(params.len(), 4);
        assert_eq!(m.len(), 2);
    }

    /// 一時ファイルへ書いて、パスを渡す
    fn temp_csv(tag: &str, body: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "quelio_csv_{tag}_{}_{}.csv",
            std::process::id(),
            body.len()
        ));
        std::fs::write(&path, body).unwrap();
        path
    }

    fn read_all(path: &Path, has_header: bool) -> (Vec<CsvRow>, Option<usize>) {
        let mut r = RowReader::new(
            path,
            &CsvOptions {
                has_header,
                ..Default::default()
            },
            vec![0, 1],
            false,
        )
        .unwrap();
        let mut rows = Vec::new();
        while let Some(row) = r.next_row().unwrap() {
            rows.push(row);
        }
        (rows, r.header_width())
    }

    /// 行番号の確認は改行の書き方ごとに見る (ここが本機能の核心)
    fn line_cases() -> Vec<(&'static str, &'static str, Vec<u64>)> {
        vec![
            // (名前, 中身, データ行の行番号)
            ("LF", "a,b\n1,2\n3,4\n", vec![2, 3]),
            ("CRLF", "a,b\r\n1,2\r\n3,4\r\n", vec![2, 3]),
            ("CR", "a,b\r1,2\r3,4\r", vec![2, 3]),
            ("CR-末尾改行なし", "a,b\r1,2\r3,4", vec![2, 3]),
            ("CR-先頭空行", "\r\ra,b\r1,2\r3,4\r", vec![4, 5]),
            ("CR-途中空行", "a,b\r1,2\r\r3,4\r", vec![2, 4]),
            ("CR-引用符内改行", "a,b\r\"x\ry\",2\r3,4\r", vec![2, 4]),
            ("LF-末尾改行なし", "a,b\n1,2\n3,4", vec![2, 3]),
            ("CRLF-末尾改行なし", "a,b\r\n1,2\r\n3,4", vec![2, 3]),
            ("LF-先頭空行", "\n\na,b\n1,2\n3,4\n", vec![4, 5]),
            ("CRLF-先頭空行", "\r\n\r\na,b\r\n1,2\r\n3,4\r\n", vec![4, 5]),
            ("LF-途中空行", "a,b\n1,2\n\n3,4\n", vec![2, 4]),
            ("CRLF-途中空行", "a,b\r\n1,2\r\n\r\n3,4\r\n", vec![2, 4]),
            // 値の中に改行がある行は、その行の先頭を指す
            ("LF-引用符内改行", "a,b\n\"x\ny\",2\n3,4\n", vec![2, 4]),
            (
                "CRLF-引用符内改行",
                "a,b\r\n\"x\r\ny\",2\r\n3,4\r\n",
                vec![2, 4],
            ),
        ]
    }

    /// 1バイトずつしか返さない読み手 (塊の境目をまたぐ置き換えを試す)
    struct OneByte<'a>(&'a [u8]);

    impl std::io::Read for OneByte<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() || buf.is_empty() {
                return Ok(0);
            }
            buf[0] = self.0[0];
            self.0 = &self.0[1..];
            Ok(1)
        }
    }

    fn cr_to_lf(body: &str) -> String {
        let mut out = String::new();
        CrToLf::new(OneByte(body.as_bytes()))
            .read_to_string(&mut out)
            .expect("読めること");
        // まとめて読んでも同じ結果になること (塊の切れ目で変わらない)
        let mut whole = String::new();
        CrToLf::new(body.as_bytes())
            .read_to_string(&mut whole)
            .expect("読めること");
        assert_eq!(out, whole, "塊の切れ目で結果が変わる: {body:?}");
        out
    }

    #[test]
    fn crをlfに置き換えて読む() {
        assert_eq!(cr_to_lf("a\rb\rc"), "a\nb\nc");
        // `\r\n` は `\n` 1つにする (行が倍にならない)
        assert_eq!(cr_to_lf("a\r\nb"), "a\nb");
        // 末尾の `\r` も改行として出す
        assert_eq!(cr_to_lf("a\r"), "a\n");
        assert_eq!(cr_to_lf("\r\r"), "\n\n");
        // `\r` が無ければそのまま
        assert_eq!(cr_to_lf("a\nb"), "a\nb");
        assert_eq!(cr_to_lf(""), "");
    }

    #[test]
    fn 改行の書き方を見分ける() {
        assert_eq!(sniff_newline("a,b\n1,2"), Newline::Lf);
        assert_eq!(sniff_newline("a,b\r\n1,2"), Newline::CrLf);
        assert_eq!(sniff_newline("a,b\r1,2"), Newline::Cr);
        // 改行が無ければどれでも同じ
        assert_eq!(sniff_newline("a,b"), Newline::Lf);
    }

    #[test]
    fn どの改行でも行番号はエディタと同じ() {
        for (name, body, want) in line_cases() {
            let path = temp_csv(&format!("nl{}", want.len()), body);
            let (rows, _) = read_all(&path, true);
            let _ = std::fs::remove_file(&path);
            assert_eq!(
                rows.iter().map(|r| r.meta.line_no).collect::<Vec<_>>(),
                want,
                "{name}"
            );
        }
    }

    #[test]
    fn どの改行でも列ずれの行番号はエディタと同じ() {
        for (name, body, want) in line_cases() {
            // 2行目のデータ (want[1] 行目) の列を1つ増やす
            let broken = body.replacen("3,4", "3,4,5", 1);
            let path = temp_csv("nlshape", &broken);
            let got = scan_shape(
                &path,
                &CsvOptions {
                    has_header: true,
                    ..Default::default()
                },
                None,
            )
            .unwrap();
            let _ = std::fs::remove_file(&path);
            assert_eq!(
                got.mismatches,
                vec![ShapeMismatch {
                    line_no: want[1],
                    width: 3
                }],
                "{name}"
            );
        }
    }

    #[test]
    fn 行番号はエディタで見た番号と同じ() {
        /*
         * 1行目: 空行
         * 2行目: 見出し
         * 3行目: データ
         * 4行目: 空行
         * 5行目: データ
         */
        let path = temp_csv("lineno", "\na,b\n1,2\n\n3,4\n");
        let (rows, width) = read_all(&path, true);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            rows.iter().map(|r| r.meta.line_no).collect::<Vec<_>>(),
            vec![3, 5]
        );
        assert_eq!(width, Some(2));
    }

    #[test]
    fn 引用符の中の改行も行番号に数える() {
        // 2行目のデータが3行目まで続く → 次のデータは4行目
        let path = temp_csv("quoted", "a,b\n\"x\ny\",2\n3,4\n");
        let (rows, _) = read_all(&path, true);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            rows.iter().map(|r| r.meta.line_no).collect::<Vec<_>>(),
            vec![2, 4]
        );
        assert_eq!(rows[0].values[0].as_deref(), Some("x\ny"));
    }

    #[test]
    fn 最後の行に改行が無くても行番号は合う() {
        let path = temp_csv("nonl", "a,b\n1,2\n3,4");
        let (rows, _) = read_all(&path, true);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            rows.iter().map(|r| r.meta.line_no).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn 先頭に空行が続いても行番号は合う() {
        let path = temp_csv("blanks", "\n\n\na,b\n1,2\n");
        let (rows, _) = read_all(&path, true);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            rows.iter().map(|r| r.meta.line_no).collect::<Vec<_>>(),
            vec![5]
        );
    }

    #[test]
    fn 行ごとの列数を持つ() {
        let path = temp_csv("width", "a,b\n1,2\n3,4,5\n");
        let (rows, width) = read_all(&path, true);
        let _ = std::fs::remove_file(&path);
        assert_eq!(width, Some(2));
        assert_eq!(rows.iter().map(|r| r.meta.width).collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn 列数の違う行を行番号つきで見つける() {
        // 3行目と5行目がずれている
        let path = temp_csv("shape", "a,b\n1,2\n3,4,5\n6,7\n8\n");
        let got = scan_shape(
            &path,
            &CsvOptions {
                has_header: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(got.header_width, 2);
        assert_eq!(got.rows, 4);
        assert_eq!(got.mismatch_count, 2);
        assert_eq!(
            got.mismatches,
            vec![
                ShapeMismatch {
                    line_no: 3,
                    width: 3
                },
                ShapeMismatch {
                    line_no: 5,
                    width: 1
                },
            ]
        );
        assert!(!got.truncated);
        assert!(!got.cancelled);
    }

    #[test]
    fn 列ずれの例は上限までしか返さない() {
        let mut body = String::from("a,b\n");
        for _ in 0..(MAX_SHAPE_MISMATCHES + 5) {
            body.push_str("1,2,3\n");
        }
        let path = temp_csv("shapecap", &body);
        let got = scan_shape(
            &path,
            &CsvOptions {
                has_header: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(got.mismatches.len(), MAX_SHAPE_MISMATCHES);
        // 例に出さなかった分も数える
        assert_eq!(got.mismatch_count, MAX_SHAPE_MISMATCHES + 5);
    }

    #[test]
    fn 列ずれが無ければ見つからない() {
        let path = temp_csv("shapeok", "a,b\n1,2\n3,4\n");
        let got = scan_shape(
            &path,
            &CsvOptions {
                has_header: true,
                ..Default::default()
            },
            None,
        )
        .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(got.mismatch_count, 0);
        assert!(got.mismatches.is_empty());
        assert_eq!(got.rows, 2);
    }

    #[test]
    fn 型の呼び方をそろえる() {
        assert_eq!(type_kind("date"), Some("日付"));
        assert_eq!(type_kind("DATE"), Some("日付"));
        assert_eq!(type_kind("datetime"), Some("日時"));
        assert_eq!(type_kind("timestamp without time zone"), Some("日時"));
        assert_eq!(type_kind("bigint(20) unsigned"), Some("整数"));
        assert_eq!(type_kind("numeric(10,2)"), Some("数値"));
        assert_eq!(type_kind("double precision"), Some("数値"));
        assert_eq!(type_kind("time without time zone"), Some("時刻"));
        // 文字列は何が入っていても妥当なので対象にしない
        assert_eq!(type_kind("character varying(255)"), None);
        assert_eq!(type_kind("text"), None);
    }

    #[test]
    fn 値が型として読めるかを緩く見る() {
        assert!(looks_like("日付", "2024-01-02"));
        assert!(looks_like("日付", "2024/1/2"));
        assert!(looks_like("日時", "2024-01-02 10:00:00"));
        // MySQLは区切り無しも受ける
        assert!(looks_like("日付", "20240102"));
        assert!(!looks_like("日付", "あいう"));
        assert!(!looks_like("日付", "2024-01"));
        assert!(!looks_like("日付", "01/02/2024"));

        assert!(looks_like("整数", "123"));
        assert!(looks_like("整数", "-7"));
        assert!(!looks_like("整数", "１２３"));
        assert!(!looks_like("整数", "1.5"));
        assert!(!looks_like("整数", "12a"));

        assert!(looks_like("数値", "1.5"));
        assert!(looks_like("数値", "-.5"));
        assert!(looks_like("数値", "1e10"));
        assert!(!looks_like("数値", "１.５"));
        assert!(!looks_like("数値", "1.2.3"));

        assert!(looks_like("時刻", "9:00"));
        assert!(!looks_like("時刻", "午前9時"));

        // 見分けない型は何でも通す
        assert!(looks_like("その他", "あいう"));
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn vals(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some(s.to_string())).collect()
    }

    #[test]
    fn 型として読めない列を先頭から探す() {
        let cols = names(&["id", "memo", "created_at"]);
        let types = names(&["int", "text", "date"]);

        // 日付列に日本語
        let got = guess_bad_column(&cols, &types, &vals(&["1", "あ", "あいう"]));
        assert_eq!(
            got,
            Some(BadColumn {
                name: "created_at".to_string(),
                kind: "日付",
                value: "あいう".to_string()
            })
        );

        // 整数列に全角数字
        let got = guess_bad_column(&cols, &types, &vals(&["１２３", "あ", "2024-01-02"]));
        assert_eq!(got.map(|b| b.name), Some("id".to_string()));

        // すべて妥当なら何も返さない
        assert_eq!(
            guess_bad_column(&cols, &types, &vals(&["1", "あ", "2024-01-02"])),
            None
        );

        // 空文字とNULLは候補にしない (必須かどうかの話になる)
        assert_eq!(
            guess_bad_column(&cols, &types, &vals(&["1", "あ", ""])),
            None
        );
        let mut v = vals(&["1", "あ", "x"]);
        v[2] = None;
        assert_eq!(guess_bad_column(&cols, &types, &v), None);
    }

    fn failed<'a>(
        cols: &'a [String],
        types: &'a [String],
        values: &'a [Option<String>],
        width: usize,
        header_width: Option<usize>,
        raw: &'a str,
    ) -> FailedRow<'a> {
        FailedRow {
            meta: RowMeta {
                line_no: 20131,
                width,
            },
            header_width,
            columns: cols,
            types,
            values,
            raw,
        }
    }

    #[test]
    fn 日付列の失敗は列名と値まで言う() {
        let cols = names(&["id", "wpos_create_date"]);
        let types = names(&["int", "date"]);
        let values = vals(&["1", "あいう"]);
        let got = failure_message(
            &failed(&cols, &types, &values, 2, Some(2), "DBエラー: 3988 (HY000): ..."),
            &crate::db::DbFailure::BadValue {
                column: None,
                row: None,
            },
        );
        assert!(
            got.starts_with("20131行目: `wpos_create_date` に日付として読めない値があります: `あいう`"),
            "{got}"
        );
        // 元のエラー文も残す (推定が外れたときの手掛かり)
        assert!(got.contains("3988"), "{got}");
        // 列がずれていないなら注記は付けない
        assert!(!got.contains("列の数が"), "{got}");
    }

    #[test]
    fn 列ずれは先頭で知らせる() {
        let cols = names(&["id", "wpos_create_date"]);
        let types = names(&["int", "date"]);
        let values = vals(&["1", "あいう"]);
        let got = failure_message(
            &failed(&cols, &types, &values, 41, Some(38), "DBエラー: 3988"),
            &crate::db::DbFailure::BadValue {
                column: None,
                row: None,
            },
        );
        assert!(got.starts_with("この行は列の数が41個で、見出し (38個) と違います"), "{got}");
        assert!(got.contains("クォートされていない可能性があります"), "{got}");
    }

    #[test]
    fn 値の長い部分は切る() {
        let cols = names(&["d"]);
        let types = names(&["date"]);
        let long = "あ".repeat(VALUE_CLIP + 10);
        let values = vec![Some(long.clone())];
        let got = failure_message(
            &failed(&cols, &types, &values, 1, Some(1), "DBエラー"),
            &crate::db::DbFailure::BadValue {
                column: None,
                row: None,
            },
        );
        assert!(got.contains(&"あ".repeat(VALUE_CLIP)), "{got}");
        assert!(got.contains('…'), "{got}");
        assert!(!got.contains(&long), "{got}");
    }

    #[test]
    fn 列を言い当てられなければ行だけ言う() {
        let cols = names(&["memo"]);
        let types = names(&["text"]);
        let values = vals(&["あ"]);
        let got = failure_message(
            &failed(&cols, &types, &values, 1, Some(1), "DBエラー: 何か"),
            &crate::db::DbFailure::BadValue {
                column: None,
                row: None,
            },
        );
        assert_eq!(got, "20131行目で失敗しました: DBエラー: 何か");
    }

    #[test]
    fn 同じ主キーの注記は重複キーのときだけ出す() {
        let cols = names(&["id"]);
        let types = names(&["int"]);
        let values = vals(&["1"]);
        let dup = failure_message(
            &failed(&cols, &types, &values, 1, Some(1), "DBエラー: 1062"),
            &crate::db::DbFailure::Duplicate,
        );
        assert!(dup.contains("重複しています"), "{dup}");
        assert!(dup.contains("同じ主キーの行がファイルの中にある場合"), "{dup}");

        for failure in [
            crate::db::DbFailure::BadValue {
                column: None,
                row: None,
            },
            crate::db::DbFailure::Other,
            crate::db::DbFailure::NotNull {
                column: Some("id".to_string()),
            },
            crate::db::DbFailure::NotNull { column: None },
        ] {
            let got = failure_message(
                &failed(&cols, &types, &values, 1, Some(1), "DBエラー"),
                &failure,
            );
            assert!(
                !got.contains("同じ主キーの行がファイルの中にある場合"),
                "{failure:?}: {got}"
            );
        }
    }

    #[test]
    fn dbが名指しした列を推定より優先する() {
        // 先頭の id も型に合っていないが、DBが created_at と言っているならそちら
        let cols = names(&["id", "created_at"]);
        let types = names(&["int", "date"]);
        let values = vals(&["１２３", "あいう"]);
        let got = failure_message(
            &failed(&cols, &types, &values, 2, Some(2), "DBエラー: 1292"),
            &crate::db::DbFailure::BadValue {
                column: Some("created_at".to_string()),
                row: Some(1),
            },
        );
        assert!(got.contains("`created_at` に日付として読めない値があります"), "{got}");
        assert!(got.contains("あいう"), "{got}");
    }

    #[test]
    fn 名指しの列が取り込み先に無ければ推定に戻す() {
        let cols = names(&["id", "created_at"]);
        let types = names(&["int", "date"]);
        let values = vals(&["1", "あいう"]);
        let got = failure_message(
            &failed(&cols, &types, &values, 2, Some(2), "DBエラー"),
            &crate::db::DbFailure::BadValue {
                // 取り込んでいない列を言われた場合
                column: Some("other".to_string()),
                row: None,
            },
        );
        assert!(got.contains("`created_at`"), "{got}");
    }

    #[test]
    fn 必須の列が空なら列名を言う() {
        let cols = names(&["memo"]);
        let types = names(&["text"]);
        let values = vec![None];
        let got = failure_message(
            &failed(&cols, &types, &values, 1, Some(1), "DBエラー: 1048"),
            &crate::db::DbFailure::NotNull {
                column: Some("memo".to_string()),
            },
        );
        assert!(got.contains("`memo` は必須ですが空です"), "{got}");
        assert!(got.contains("1048"), "{got}");
    }

    #[test]
    fn 文字コードの名前を確かめる() {
        assert_eq!(encoding_by_name("shift_jis"), Ok(encoding_rs::SHIFT_JIS));
        assert_eq!(encoding_by_name("CP932"), Ok(encoding_rs::SHIFT_JIS));
        assert_eq!(encoding_by_name("utf-8"), Ok(encoding_rs::UTF_8));
        assert_eq!(encoding_by_name("euc-jp"), Ok(encoding_rs::EUC_JP));
        // 知らない名前を黙ってUTF-8にしない
        assert!(encoding_by_name("nonsense").is_err());
    }
}
