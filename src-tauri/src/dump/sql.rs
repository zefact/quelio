//! ダンプに書く値と名前の書き方。
//!
//! 値はバイト列のまま扱う (文字コードの変換で値が変わらないように)

/// MySQL の識別子 (`名前`)
pub fn my_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// PostgreSQL / SQLite の識別子 ("名前")
pub fn dq_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// PostgreSQL の「スキーマ.名前」
pub fn pg_name(schema: &str, name: &str) -> String {
    format!("{}.{}", dq_ident(schema), dq_ident(name))
}

/// 標準の文字列リテラル ('は重ねる)。PostgreSQL / SQLite 向け
pub fn std_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/**
 * MySQL の文字列リテラルを足す。
 *
 * mysqldump と同じ書き方にする (バックスラッシュで逃がす)。
 * 流し込むときは、ファイルの先頭で sql_mode から NO_BACKSLASH_ESCAPES を外してある
 */
pub fn push_my_str(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.reserve(bytes.len() + 2);
    buf.push(b'\'');
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let esc: &[u8] = match b {
            0 => b"\\0",
            b'\'' => b"\\'",
            b'"' => b"\\\"",
            0x08 => b"\\b",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0x1A => b"\\Z",
            b'\\' => b"\\\\",
            _ => continue,
        };
        buf.extend_from_slice(&bytes[start..i]);
        buf.extend_from_slice(esc);
        start = i + 1;
    }
    buf.extend_from_slice(&bytes[start..]);
    buf.push(b'\'');
}

/// 標準の文字列リテラル ('は重ねる) をバイト列のまま足す
pub fn push_std_str(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.reserve(bytes.len() + 2);
    buf.push(b'\'');
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\'' {
            buf.extend_from_slice(&bytes[start..=i]);
            buf.push(b'\'');
            start = i + 1;
        }
    }
    buf.extend_from_slice(&bytes[start..]);
    buf.push(b'\'');
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// 16進の並びを足す (前後の印は呼ぶ側で付ける)
pub fn push_hex(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.reserve(bytes.len() * 2);
    for &b in bytes {
        buf.push(HEX[(b >> 4) as usize]);
        buf.push(HEX[(b & 15) as usize]);
    }
}

/// MySQL のバイナリ値 (0xABCD。空なら '')
pub fn push_my_hex(buf: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.is_empty() {
        buf.extend_from_slice(b"''");
    } else {
        buf.extend_from_slice(b"0x");
        push_hex(buf, bytes);
    }
}

/// SQLite のBLOB値 (X'ABCD')
pub fn push_sqlite_blob(buf: &mut Vec<u8>, bytes: &[u8]) {
    buf.extend_from_slice(b"X'");
    push_hex(buf, bytes);
    buf.push(b'\'');
}

/**
 * 小数を、読み直して同じ値に戻る形で書く。
 *
 * Rustの表示は「同じ値に戻る最短の桁」なので、桁は落ちない。
 * とても大きい・小さい値は指数で書く (そのままだと何百桁にもなる)
 */
pub fn float_text(v: f64) -> String {
    if v.is_nan() {
        return "NULL".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "1e999".into() } else { "-1e999".into() };
    }
    let a = v.abs();
    if a != 0.0 && !(1e-5..1e15).contains(&a) {
        format!("{v:e}")
    } else {
        let s = format!("{v}");
        // 整数に見える値も小数として残す (SQLiteで INTEGER に変わらないように)
        if s.contains('.') || s.contains('e') {
            s
        } else {
            format!("{s}.0")
        }
    }
}

/// バイト数の目安 (1.2 GB のような形)
pub fn size_label(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/**
 * 依存の順に並べる (参照される側を先に)。
 *
 * `deps[i]` は i が参照している番号。輪になっている分は元の順のまま後ろに置く
 */
pub fn topo_order(n: usize, deps: &[Vec<usize>]) -> Vec<usize> {
    let mut out = Vec::with_capacity(n);
    let mut state = vec![0u8; n]; // 0: まだ, 1: 見ている途中, 2: 済み
    fn visit(i: usize, deps: &[Vec<usize>], state: &mut [u8], out: &mut Vec<usize>) {
        if state[i] != 0 {
            return;
        }
        state[i] = 1;
        for &d in &deps[i] {
            if d != i && state[d] == 0 {
                visit(d, deps, state, out);
            }
        }
        state[i] = 2;
        out.push(i);
    }
    for i in 0..n {
        visit(i, deps, &mut state, &mut out);
    }
    out
}

/// DEFINER=`user`@`host` を外す (流し込む人が作り手になるように)
pub fn strip_definer(ddl: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"DEFINER\s*=\s*(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s]+)\s*")
            .expect("正規表現")
    });
    re.replacen(ddl, 1, "").to_string()
}
