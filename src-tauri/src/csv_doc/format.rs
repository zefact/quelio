//! CSVファイルの「形」を見分ける。
//!
//! 文字コード・BOM・改行コード・区切り文字・引用符の付け方を推測し、
//! 保存のときに元のファイルと同じ形へ戻せるようにする。
//!
//! 取り込み (`csv_import`) にも似た判定があるが、あちらは
//! 「DBへ入れるために読めればよい」ので、保存して戻すための情報 (改行・引用符) を持たない。
//! 取り込み側の挙動を変えないよう、ここは独立させている

/// 改行コード
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Newline {
    Lf,
    Crlf,
}

impl Newline {
    pub fn as_str(self) -> &'static str {
        match self {
            Newline::Lf => "\n",
            Newline::Crlf => "\r\n",
        }
    }

    /// 画面から来る指定を読む (serdeが返す "lf" / "crlf" もそのまま通る)
    pub fn from_label(s: &str) -> Option<Newline> {
        match s.to_ascii_uppercase().as_str() {
            "LF" => Some(Newline::Lf),
            "CRLF" => Some(Newline::Crlf),
            _ => None,
        }
    }
}

/// 引用符の付け方
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quoting {
    /// 区切りや改行を含むなど、必要なときだけ囲む
    Necessary,
    /// 全部の項目を囲む
    Always,
}

impl Quoting {
    /// 画面から来る指定を読む (serdeが返す名前と同じ綴り)
    pub fn from_label(s: &str) -> Option<Quoting> {
        match s {
            "necessary" => Some(Quoting::Necessary),
            "always" => Some(Quoting::Always),
            _ => None,
        }
    }
}

/// ファイルの形 (開いたときの状態。保存の既定にもなる)
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvFormat {
    /// 文字コードの名前 ("UTF-8" / "Shift_JIS" など)
    pub encoding: String,
    /// BOMが付いていたか
    pub bom: bool,
    pub newline: Newline,
    /// 区切り文字 (1文字)。固定長のときは使わない
    pub delimiter: char,
    pub quoting: Quoting,
    /**
     * 固定長の桁 (区切り文字が無いファイル)。
     *
     * ここが入っていれば固定長として読み書きし、
     * 区切り文字と引用符の指定は使わない
     */
    #[serde(default)]
    pub fixed: Option<super::fixed::FixedLayout>,
}

/// 区切り文字の候補 (この中から一番多いものを選ぶ)
const DELIMITERS: [char; 4] = [',', '\t', ';', '|'];

/// 形を見分けるために読む先頭のバイト数。
/// 全部を見ても判定は変わらないので、大きいファイルで無駄に舐めない
const SNIFF_BYTES: usize = 64 * 1024;

/// 引用符の付け方を見るときに読む行数
const SNIFF_LINES: usize = 20;

/// 名前から文字コードを引く。
/// 知らない名前を黙ってUTF-8にすると、文字化けしたまま開いてしまうのでエラーにする
pub fn encoding_by_name(name: &str) -> Result<&'static encoding_rs::Encoding, String> {
    match name.to_ascii_lowercase().as_str() {
        "shift_jis" | "sjis" | "cp932" | "windows-31j" => Ok(encoding_rs::SHIFT_JIS),
        /*
         * for_label は utf-7 等に「中身を全部置換文字にする」特殊な指定を返す。
         * それでは文字化けしたまま開いてしまうので、返さない版を使う
         */
        other => encoding_rs::Encoding::for_label_no_replacement(other.as_bytes())
            .ok_or_else(|| format!("知らない文字コードです: {name}")),
    }
}

/// 画面に出す文字コードの名前 (encoding_rs の名前をそのまま使う)
pub fn encoding_label(enc: &'static encoding_rs::Encoding) -> String {
    enc.name().to_string()
}

/// 文字コードを推測する。
///
/// BOMがあればそれに従い、無ければUTF-8として読めるかで決める。
/// 読めなければ Shift_JIS とみなす (日本語環境で多いため)
pub fn sniff_encoding(bytes: &[u8]) -> (&'static encoding_rs::Encoding, bool) {
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (encoding_rs::UTF_8, true);
    }
    /*
     * UTF-16はBOMでしか見分けられない。
     * BOMを見ないと、ASCII主体のUTF-16は「間にNULが入ったUTF-8」として
     * 読めてしまい、値にNULが混ざったまま開いてしまう
     */
    // UTF-32LEのBOM (FF FE 00 00) をUTF-16LEと取り違えない
    if head.starts_with(&[0xFF, 0xFE]) && !head.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        return (encoding_rs::UTF_16LE, true);
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return (encoding_rs::UTF_16BE, true);
    }
    match std::str::from_utf8(head) {
        Ok(_) => (encoding_rs::UTF_8, false),
        /*
         * 末尾で文字が切れているだけ (error_len が None) なら、
         * 途中まで読んだせいなのでUTF-8とみなす。
         * 本当に不正なバイトがあるときだけShift_JISと判断する
         */
        Err(e) if e.error_len().is_none() => (encoding_rs::UTF_8, false),
        Err(_) => (encoding_rs::SHIFT_JIS, false),
    }
}

/// 改行コードを推測する。CRLFとLFの多いほうを採る (混在していたら多数決)
pub fn sniff_newline(text: &str) -> Newline {
    let head = head_of(text);
    let crlf = head.matches("\r\n").count();
    // CRLF に含まれる LF は数えない
    let lf = head.matches('\n').count() - crlf;
    if crlf >= lf && crlf > 0 {
        Newline::Crlf
    } else {
        Newline::Lf
    }
}

/// 区切り文字を推測する。1行目に一番多く出てくるものを選ぶ
pub fn sniff_delimiter(text: &str) -> char {
    let line = text.lines().next().unwrap_or("");
    let mut best = ',';
    let mut best_n = 0;
    for d in DELIMITERS {
        let n = line.matches(d).count();
        if n > best_n {
            best_n = n;
            best = d;
        }
    }
    best
}

/**
 * 全部の項目が引用符で囲まれているファイルかを見る。
 *
 * 先頭の数行が「行頭と行末が `"` で、区切りがすべて `","` の形」なら
 * 「全部囲む」とみなす。
 *
 * 値の中に区切り文字が入っている行 (`"a,b","c"`) は、この見方では
 * 「全部囲む」と判定されない。そのときは必要なときだけ囲む形で保存するので、
 * 囲まなくてよい項目の引用符が外れる。値そのものは変わらない
 */
pub fn sniff_quoting(text: &str, delimiter: char) -> Quoting {
    let mut seen = 0;
    for line in head_of(text).lines().take(SNIFF_LINES) {
        if line.trim().is_empty() {
            continue;
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !(line.starts_with('"') && line.ends_with('"') && line.len() >= 2) {
            return Quoting::Necessary;
        }
        // 区切りがすべて `","` の形で現れているか
        let pair = format!("\"{delimiter}\"");
        if line.matches(delimiter).count() != line.matches(&pair).count() {
            return Quoting::Necessary;
        }
        seen += 1;
    }
    if seen > 0 {
        Quoting::Always
    } else {
        Quoting::Necessary
    }
}

/// 判定に使う先頭部分 (文字の途中で切らない)
fn head_of(text: &str) -> &str {
    if text.len() <= SNIFF_BYTES {
        return text;
    }
    let mut end = SNIFF_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
