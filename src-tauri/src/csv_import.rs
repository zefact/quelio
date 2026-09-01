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

/// 読み出し口と、実際に使った (区切り文字, 文字コード)
type OpenedCsv = (csv::Reader<Box<dyn Read + Send>>, String, String);

/// ファイルを開いて、文字コードと区切り文字を決める
fn open_reader(path: &Path, opts: &CsvOptions) -> Result<OpenedCsv, String> {
    /*
     * 名前付きパイプやデバイスを渡されると終わりが来ず、画面が固まってしまう。
     * 普通のファイルだけを相手にする
     */
    let meta =
        std::fs::metadata(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    if !meta.is_file() {
        return Err("普通のファイルではありません".to_string());
    }

    let mut file =
        std::fs::File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
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
        Some(s) if !s.is_empty() => delimiter_byte(s)
            .ok_or_else(|| format!("区切り文字として使えません: {s}"))?,
        _ => sniff_delimiter(&head_text),
    };

    // 判定のために読んだぶんを戻して、同じファイルを開き直さずに使う
    file.rewind()
        .map_err(|e| format!("ファイルを読み込めません: {e}"))?;
    // BOMの除去と文字コードの変換をまとめて行う
    let decoded = encoding_rs_io::DecodeReaderBytesBuilder::new()
        .encoding(Some(enc))
        .build(file);
    let reader = csv::ReaderBuilder::new()
        .delimiter(delim)
        .has_headers(false)
        // 列数が揃っていない行があっても読み進める (警告として出す)
        .flexible(true)
        .from_reader(Box::new(decoded) as Box<dyn Read + Send>);
    let delim_name = if delim == b'\t' {
        "\\t".to_string()
    } else {
        (delim as char).to_string()
    };
    Ok((reader, delim_name, enc.name().to_ascii_lowercase()))
}

/// 見出しが無いときの仮の列名
fn placeholder_columns(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("{i}列目")).collect()
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
    let (mut reader, delimiter, encoding) = open_reader(path, opts)?;
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

    Ok(CsvPreview {
        columns,
        rows,
        delimiter,
        encoding,
        warning: (!warnings.is_empty()).then(|| warnings.join(" / ")),
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
}

impl RowReader {
    pub fn new(
        path: &Path,
        opts: &CsvOptions,
        mapping: Vec<usize>,
        empty_as_null: bool,
    ) -> Result<Self, String> {
        let (reader, _, _) = open_reader(path, opts)?;
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
        })
    }

    /// 次の1行 (取り込み先の列順)。終わりなら None
    pub fn next_row(&mut self) -> Result<Option<Vec<Option<String>>>, String> {
        let mut blanks = 0usize;
        loop {
            let mut rec = csv::StringRecord::new();
            let more = self
                .reader
                .read_record(&mut rec)
                .map_err(|e| format!("CSVを読み取れません: {e}"))?;
            if !more {
                return Ok(None);
            }
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
            let row = self
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
            return Ok(Some(row));
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
    width: usize,
    key_idx: &[usize],
) -> usize {
    // 列が無ければ行も無い / まとめる手掛かりが無ければそのまま
    if width == 0 {
        params.clear();
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

    #[test]
    fn 文字コードを見分ける() {
        assert_eq!(sniff_encoding("あいう".as_bytes()), encoding_rs::UTF_8);
        assert_eq!(sniff_encoding(b"plain ascii"), encoding_rs::UTF_8);
        // BOM付きはUTF-8
        assert_eq!(sniff_encoding(&[0xEF, 0xBB, 0xBF, b'a']), encoding_rs::UTF_8);
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
        assert_eq!(
            sql,
            "INSERT INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)"
        );
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

        let rep_sq =
            build_insert(DbType::Sqlite, "\"t\"", &c, 1, ImportMode::Replace, &pk);
        assert!(rep_sq.starts_with("INSERT INTO"));
        assert!(
            rep_sq.ends_with(r#"ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name""#)
        );

        let skip_pg =
            build_insert(DbType::Postgresql, "\"t\"", &c, 1, ImportMode::Skip, &pk);
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
        let rows = dedupe_rows(&mut params, 2, &[0]);
        assert_eq!(rows, 2);
        assert_eq!(params, vec![cell("2"), cell("い"), cell("1"), cell("う")]);

        // 重複が無ければそのまま
        let mut params = vec![cell("1"), cell("あ"), cell("2"), cell("い")];
        assert_eq!(dedupe_rows(&mut params, 2, &[0]), 2);
        assert_eq!(params.len(), 4);
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
