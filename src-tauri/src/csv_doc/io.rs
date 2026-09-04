//! CSVファイルの読み込みと保存。
//!
//! 保存は `json_store` と同じ「一時ファイルへ書き切る → fsync → rename」で行う。
//! 途中で失敗しても元のファイルは無傷のまま残る

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::format::{self, CsvFormat, Newline, Quoting};
use super::fixed;

/// 開けるファイルの大きさの上限。
///
/// 全行をメモリに載せる作りなので、際限なく開かせない。
/// これを超えるものは、DBへ取り込んでからSQLで扱うほうが速い
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;

/// 読み込んだ結果
pub struct Loaded {
    pub format: CsvFormat,
    /// 1行目 (ヘッダとして扱うかは呼び出し側が決める)
    pub rows: Vec<Vec<String>>,
    /// 行によって列数が違ったか (足りない分は空欄で埋めてある)
    pub ragged: bool,
    /// 文字コードの変換で置き換えが起きたか (文字化けの疑い)
    pub replaced: bool,
}

/// バイト列をCSVとして読む。
///
/// `forced` に文字コードの名前を渡すと、推測せずにその文字コードで読む
/// (自動判定を外したいときに使う)
pub fn load(bytes: &[u8], forced: Option<&str>) -> Result<Loaded, String> {
    let (enc, bom) = match forced {
        Some(name) => (format::encoding_by_name(name)?, has_bom(bytes)),
        None => format::sniff_encoding(bytes),
    };
    // BOMは encoding_rs が読み飛ばしてくれる
    let (text, _, replaced) = enc.decode(bytes);
    let newline = format::sniff_newline(&text);
    let delimiter = format::sniff_delimiter(&text);
    let quoting = format::sniff_quoting(&text, delimiter);

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        // 1行目もデータとして受け取る (ヘッダにするかは上の層で決める)
        .has_headers(false)
        // 行ごとに列数が違うファイルも開く (足りない分はあとで空欄にする)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut width = 0usize;
    let mut ragged = false;
    for rec in reader.records() {
        let rec = rec.map_err(|e| format!("CSVを読み取れません: {e}"))?;
        let cells: Vec<String> = rec.iter().map(|s| s.to_string()).collect();
        if width == 0 {
            width = cells.len();
        } else if cells.len() != width {
            ragged = true;
            width = width.max(cells.len());
        }
        rows.push(cells);
    }
    // 列数を揃える (足りない行は空欄で埋める)
    for r in &mut rows {
        r.resize(width, String::new());
    }

    Ok(Loaded {
        format: CsvFormat {
            encoding: format::encoding_label(enc),
            bom,
            newline,
            delimiter,
            quoting,
            fixed: None,
        },
        rows,
        ragged,
        replaced,
    })
}

/**
 * バイト列を固定長として読む。
 *
 * 区切り文字と引用符は使わないが、文字コード・BOM・改行は
 * 区切り文字のCSVと同じように見分ける (保存で元の形へ戻すため)
 */
pub fn load_fixed(
    bytes: &[u8],
    forced: Option<&str>,
    unit: fixed::WidthUnit,
    reading: fixed::Reading,
) -> Result<Loaded, String> {
    let (enc, bom) = match forced {
        Some(name) => (format::encoding_by_name(name)?, has_bom(bytes)),
        None => format::sniff_encoding(bytes),
    };
    // 改行の見分けだけは文字に直してから行う
    let (text, _, replaced) = enc.decode(bytes);
    let newline = format::sniff_newline(&text);
    drop(text);

    let got = fixed::load(bytes, enc, unit, reading);
    Ok(Loaded {
        format: CsvFormat {
            encoding: format::encoding_label(enc),
            bom,
            newline,
            // 固定長では使わないが、区切りに戻したときの既定として持っておく
            delimiter: ',',
            quoting: Quoting::Necessary,
            fixed: Some(got.layout),
        },
        rows: got.rows,
        ragged: got.ragged,
        replaced,
    })
}

/**
 * 固定長として書き出す。
 *
 * 桁からはみ出す値があれば、書かずにどこが入り切らないかを知らせる。
 * 固定長は桁がずれると後ろの工程が丸ごと壊れるので、黙って切り詰めない
 */
fn dump_fixed(
    rows: &[Vec<String>],
    f: &CsvFormat,
    layout: &fixed::FixedLayout,
) -> Result<Vec<u8>, String> {
    let enc = format::encoding_by_name(&f.encoding)?;
    let body = fixed::dump(rows, layout, enc, f.newline.as_str()).map_err(too_long_message)?;
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if f.bom && enc == encoding_rs::UTF_8 {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

/// 桁に収まらなかった場所を、直せるだけの言葉にする
fn too_long_message(bad: Vec<fixed::TooLong>) -> String {
    let head: Vec<String> = bad
        .iter()
        .take(5)
        .map(|b| {
            format!(
                "{}行目の{}列目「{}」({}→桁は{})",
                b.row + 1,
                b.col + 1,
                b.value,
                b.len,
                b.width
            )
        })
        .collect();
    let more = if bad.len() > head.len() {
        format!(" ほか{}件", bad.len() - head.len())
    } else {
        String::new()
    };
    format!("桁に収まらない値があります: {}{}", head.join("、"), more)
}

fn has_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
}

/// 行をCSVのバイト列にする (指定の文字コード・改行・区切り・引用符で)
pub fn dump(rows: &[Vec<String>], f: &CsvFormat) -> Result<Vec<u8>, String> {
    if let Some(layout) = &f.fixed {
        return dump_fixed(rows, f, layout);
    }
    let mut w = csv::WriterBuilder::new()
        .delimiter(f.delimiter as u8)
        .quote_style(match f.quoting {
            Quoting::Always => csv::QuoteStyle::Always,
            Quoting::Necessary => csv::QuoteStyle::Necessary,
        })
        // 改行は自分で入れる (csv crate は終端の改行も含めて書くため)
        .terminator(csv::Terminator::Any(b'\n'))
        .from_writer(Vec::new());
    for r in rows {
        w.write_record(r)
            .map_err(|e| format!("CSVを組み立てられません: {e}"))?;
    }
    let text = w
        .into_inner()
        .map_err(|e| format!("CSVを組み立てられません: {e}"))?;
    let mut text = String::from_utf8(text).map_err(|e| format!("CSVを組み立てられません: {e}"))?;
    if f.newline != Newline::Lf {
        text = text.replace('\n', f.newline.as_str());
    }

    let enc = format::encoding_by_name(&f.encoding)?;
    let (out, _, unmappable) = enc.encode(&text);
    if unmappable {
        return Err(format!(
            "{} では表せない文字があります。文字コードを UTF-8 にして保存してください",
            f.encoding
        ));
    }
    let mut bytes = Vec::with_capacity(out.len() + 3);
    // BOMは UTF-8 のときだけ付ける (Excelで開くために付ける需要がある)
    if f.bom && enc == encoding_rs::UTF_8 {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(&out);
    Ok(bytes)
}

/// 一時ファイルに書き切ってから置き換える。
///
/// 元のファイルの権限は引き継ぐ (利用者のファイルなので、勝手に狭めない)
pub fn save_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = tmp_path(path);
    let err = |e: std::io::Error| format!("保存できません: {e}");

    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    // 上書きのときは、元のファイルと同じ権限にしてから置き換える
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    // 置き換えたことをフォルダにも反映させる (unixのみ)
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// 同じフォルダに作る一時ファイルの名前 (renameが同じディスク内で済むように)
fn tmp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "csv".to_string());
    let pid = std::process::id();
    path.with_file_name(format!(".{name}.{pid}.tmp"))
}

/// ファイルを読む (大きすぎるものは開かない)
pub fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    if !meta.is_file() {
        return Err("ファイルではありません".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "ファイルが大きすぎます ({} MB)。{} MB までのファイルを開けます",
            meta.len() / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    fs::read(path).map_err(|e| format!("ファイルを読み込めません: {e}"))
}

/// 最終更新時刻 (外部で書き換えられていないかの確認に使う)
pub fn mtime(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let t = meta.modified().ok()?;
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
