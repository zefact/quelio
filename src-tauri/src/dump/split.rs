//! SQLファイルを、読みながら1文ずつに分ける。
//!
//! 何十GBのファイルでも、全体を読み込まずに先頭から順に取り出す。
//! 文の区切り (;) は、文字列・識別子・コメントの中では区切りとみなさない。
//!
//! DBごとの書き方の違い:
//! - MySQL: `DELIMITER //` で区切りを変える (mysql コマンドと同じ)。文字列の中は \ で逃がす。
//!   `#` と `-- ` で始まる行コメント。`/*! … */` は実行されるので文の一部として扱う
//! - PostgreSQL: `$tag$ … $tag$` の文字列、`E'…'` の \ の逃がし、入れ子のブロックコメント。
//!   `COPY … FROM stdin;` の後ろは `\.` の行までデータとして渡す (pg_dump の形)。
//!   `\connect` のような psql の命令の行は、文にせず別に知らせる
//! - SQLite: `CREATE TRIGGER … BEGIN …; …; END;` の中の ; では区切らない

use std::io::Read;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavor {
    Mysql,
    Pg,
    Sqlite,
}

/// 取り出したもの。`end` はファイルの先頭から数えた、そこまでのバイト数
#[derive(Debug, PartialEq, Eq)]
pub enum Item {
    /// 1つの文 (区切りは含まない)。`custom` は DELIMITER で変えた区切りで終わった文
    Sql { text: Vec<u8>, line: u64, end: u64, custom: bool },
    /// `COPY … FROM stdin` の文。この後に CopyData が続き、CopyEnd で終わる
    CopyStart { text: Vec<u8>, line: u64, end: u64 },
    CopyData { data: Vec<u8>, end: u64 },
    CopyEnd { end: u64 },
    /// psql の命令の行 (`\connect` など)
    Meta { text: String, line: u64, end: u64 },
}

const READ_SIZE: usize = 1024 * 1024;
/// COPY のデータを、このくらいずつまとめて渡す
const COPY_CHUNK: usize = 1024 * 1024;

pub struct Splitter<R: Read> {
    src: R,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
    /// buf[0] がファイルの何バイト目か
    base: u64,
    line: u64,
    flavor: Flavor,
    delim: Vec<u8>,
    in_copy: bool,
    /// COPY のデータを渡し終え、次に終わりの印を渡す
    pending_end: bool,
    started: bool,
}

/// 識別子に使える文字か
fn ident_byte(b: u8, flavor: Flavor) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80 || (b == b'$' && flavor != Flavor::Pg)
}

impl<R: Read> Splitter<R> {
    pub fn new(src: R, flavor: Flavor) -> Self {
        Splitter {
            src,
            buf: Vec::with_capacity(READ_SIZE * 2),
            pos: 0,
            eof: false,
            base: 0,
            line: 1,
            flavor,
            delim: b";".to_vec(),
            in_copy: false,
            pending_end: false,
            started: false,
        }
    }

    /// ファイルの何バイト目まで読み終えたか
    fn offset(&self) -> u64 {
        self.base + self.pos as u64
    }

    /// pos から n バイト先まで読み込んでおく (足りなければ false)
    fn fill(&mut self, n: usize) -> std::io::Result<bool> {
        while self.buf.len() - self.pos < n {
            if self.eof {
                return Ok(false);
            }
            // 読み終えたところを捨てる
            if self.pos > 0 {
                self.buf.drain(..self.pos);
                self.base += self.pos as u64;
                self.pos = 0;
            }
            let old = self.buf.len();
            self.buf.resize(old + READ_SIZE, 0);
            let got = loop {
                match self.src.read(&mut self.buf[old..]) {
                    Ok(n) => break n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        self.buf.truncate(old);
                        return Err(e);
                    }
                }
            };
            self.buf.truncate(old + got);
            if got == 0 {
                self.eof = true;
            }
        }
        Ok(true)
    }

    fn peek(&mut self, k: usize) -> std::io::Result<Option<u8>> {
        if self.fill(k + 1)? {
            Ok(Some(self.buf[self.pos + k]))
        } else {
            Ok(None)
        }
    }

    /// 1バイト進めて cur に足す
    fn take(&mut self, cur: &mut Vec<u8>) {
        let b = self.buf[self.pos];
        if b == b'\n' {
            self.line += 1;
        }
        cur.push(b);
        self.pos += 1;
    }

    /// stops のどれかが来るまで cur に足す (その文字は残す)。来ないまま終われば None
    fn take_until(&mut self, cur: &mut Vec<u8>, stops: &[u8]) -> std::io::Result<Option<u8>> {
        loop {
            if !self.fill(1)? {
                return Ok(None);
            }
            let slice = &self.buf[self.pos..];
            let found = slice.iter().position(|b| stops.contains(b));
            let n = found.unwrap_or(slice.len());
            let part = &slice[..n];
            self.line += part.iter().filter(|b| **b == b'\n').count() as u64;
            cur.extend_from_slice(part);
            self.pos += n;
            if let Some(i) = found {
                return Ok(Some(slice[i]));
            }
        }
    }

    /// 改行まで (改行を含む) を取り出す
    fn read_line(&mut self) -> std::io::Result<Vec<u8>> {
        let mut line = Vec::new();
        if self.take_until(&mut line, b"\n")?.is_some() {
            self.take(&mut line);
        }
        Ok(line)
    }

    /// pos から始まる1行の先頭 (最大 limit バイト) を見る (進めない)
    fn peek_line(&mut self, limit: usize) -> std::io::Result<Vec<u8>> {
        let _ = self.fill(limit)?;
        let slice = &self.buf[self.pos..];
        let end = slice
            .iter()
            .take(limit)
            .position(|b| *b == b'\n')
            .unwrap_or(slice.len().min(limit));
        Ok(slice[..end].to_vec())
    }

    fn at_delim(&mut self) -> std::io::Result<bool> {
        let n = self.delim.len();
        if !self.fill(n)? {
            return Ok(false);
        }
        Ok(self.buf[self.pos..self.pos + n] == self.delim[..])
    }

    /// 次のものを取り出す (ファイルの終わりなら None)
    pub fn next_item(&mut self) -> std::io::Result<Option<Item>> {
        if !self.started {
            self.started = true;
            // UTF-8 の BOM は飛ばす
            if self.fill(3)? && self.buf[self.pos..self.pos + 3] == [0xEF, 0xBB, 0xBF] {
                self.pos += 3;
            }
        }
        if self.pending_end {
            self.pending_end = false;
            return Ok(Some(Item::CopyEnd { end: self.offset() }));
        }
        if self.in_copy {
            return self.copy_data().map(Some);
        }
        self.statement()
    }

    /// COPY のデータを `\.` の行まで渡す
    fn copy_data(&mut self) -> std::io::Result<Item> {
        let mut data = Vec::with_capacity(COPY_CHUNK + 4096);
        loop {
            if !self.fill(1)? {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "COPY のデータが途中で終わっています (\\. の行がありません)",
                ));
            }
            let line = self.read_line()?;
            let body = line.strip_suffix(b"\n").unwrap_or(&line);
            let body = body.strip_suffix(b"\r").unwrap_or(body);
            if body == b"\\." {
                self.in_copy = false;
                if data.is_empty() {
                    return Ok(Item::CopyEnd { end: self.offset() });
                }
                // データを先に渡し、終わりの印は次に渡す
                self.pending_end = true;
                return Ok(Item::CopyData { data, end: self.offset() });
            }
            data.extend_from_slice(&line);
            if data.len() >= COPY_CHUNK {
                return Ok(Item::CopyData { data, end: self.offset() });
            }
        }
    }
}

/// 文の頭の数語 (大文字) と、BEGIN … END の深さを見る
#[derive(Default)]
struct Words {
    head: Vec<String>,
    prev: String,
    depth: i32,
}

impl Words {
    fn push(&mut self, w: &str, flavor: Flavor) {
        let up = w.to_ascii_uppercase();
        if self.head.len() < 6 {
            self.head.push(up.clone());
        }
        match flavor {
            // SQLite のトリガ本体 (BEGIN … END)。CASE … END も数える
            Flavor::Sqlite if self.is_trigger() => match up.as_str() {
                "BEGIN" | "CASE" => self.depth += 1,
                "END" if self.depth > 0 => self.depth -= 1,
                _ => {}
            },
            // PostgreSQL の BEGIN ATOMIC … END (SQL標準の関数本体)
            Flavor::Pg if self.is_routine() => match up.as_str() {
                "ATOMIC" if self.prev == "BEGIN" => self.depth += 1,
                "CASE" if self.depth > 0 => self.depth += 1,
                "END" if self.depth > 0 => self.depth -= 1,
                _ => {}
            },
            _ => {}
        }
        self.prev = up;
    }

    fn is_trigger(&self) -> bool {
        let h: Vec<&str> = self.head.iter().map(String::as_str).collect();
        matches!(h.as_slice(), ["CREATE", "TRIGGER", ..] | ["CREATE", "TEMP" | "TEMPORARY", "TRIGGER", ..])
    }

    fn is_routine(&self) -> bool {
        self.head.first().is_some_and(|w| w == "CREATE")
            && self.head.iter().any(|w| w == "FUNCTION" || w == "PROCEDURE")
    }
}

/// `COPY … FROM STDIN` か
fn is_copy_stdin(text: &[u8], words: &Words) -> bool {
    if words.head.first().map(String::as_str) != Some("COPY") {
        return false;
    }
    static RE: std::sync::OnceLock<regex::bytes::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::bytes::Regex::new(r"(?i)\bFROM\s+STDIN\b").expect("正規表現"))
        .is_match(text)
}

impl<R: Read> Splitter<R> {
    fn statement(&mut self) -> std::io::Result<Option<Item>> {
        let flavor = self.flavor;
        let mut cur: Vec<u8> = Vec::new();
        let mut content = false;
        let mut line = self.line;
        let mut words = Words::default();
        loop {
            let Some(c) = self.peek(0)? else {
                if content {
                    let end = self.offset();
                    return Ok(Some(Item::Sql { text: cur, line, end, custom: self.delim != b";" }));
                }
                return Ok(None);
            };

            // 文の頭でだけ意味を持つ行
            if !content && !c.is_ascii_whitespace() {
                if flavor == Flavor::Mysql && (c == b'D' || c == b'd') {
                    let head = self.peek_line(512)?;
                    if let Some(d) = delimiter_command(&head) {
                        self.read_line()?;
                        self.delim = d;
                        cur.clear();
                        continue;
                    }
                }
                if flavor == Flavor::Pg && c == b'\\' {
                    let at = self.line;
                    let raw = self.read_line()?;
                    let text = String::from_utf8_lossy(&raw).trim().to_string();
                    return Ok(Some(Item::Meta { text, line: at, end: self.offset() }));
                }
            }

            // 区切り
            let delim_hit = if self.delim.len() == 1 {
                c == self.delim[0]
            } else {
                c == self.delim[0] && self.at_delim()?
            };
            if delim_hit && words.depth == 0 {
                self.pos += self.delim.len();
                if !content {
                    cur.clear();
                    words = Words::default();
                    continue;
                }
                let custom = self.delim != b";";
                if flavor == Flavor::Pg && is_copy_stdin(&cur, &words) {
                    // 同じ行の残り (ふつうは改行だけ) を飛ばすと、そこからがデータ
                    self.read_line()?;
                    self.in_copy = true;
                    return Ok(Some(Item::CopyStart { text: cur, line, end: self.offset() }));
                }
                return Ok(Some(Item::Sql { text: cur, line, end: self.offset(), custom }));
            }

            match c {
                b' ' | b'\t' | b'\r' | b'\n' => self.take(&mut cur),
                b'\'' => {
                    self.mark(&mut content, &mut line);
                    // 直前が E (PostgreSQL の E'…') なら \ で逃がす
                    let bs = match flavor {
                        Flavor::Mysql => true,
                        Flavor::Pg => words_ends_with_e(&cur),
                        Flavor::Sqlite => false,
                    };
                    self.quoted(&mut cur, b'\'', bs)?;
                }
                b'"' => {
                    self.mark(&mut content, &mut line);
                    self.quoted(&mut cur, b'"', flavor == Flavor::Mysql)?;
                }
                b'`' if flavor != Flavor::Pg => {
                    self.mark(&mut content, &mut line);
                    self.quoted(&mut cur, b'`', false)?;
                }
                b'[' if flavor == Flavor::Sqlite => {
                    self.mark(&mut content, &mut line);
                    self.take(&mut cur);
                    if self.take_until(&mut cur, b"]")?.is_some() {
                        self.take(&mut cur);
                    }
                }
                b'#' if flavor == Flavor::Mysql => self.line_comment(&mut cur)?,
                b'-' => {
                    let next = self.peek(1)?;
                    let comment = next == Some(b'-')
                        && (flavor != Flavor::Mysql
                            || self.peek(2)?.is_none_or(|b| b.is_ascii_whitespace() || b < 0x20));
                    if comment {
                        self.line_comment(&mut cur)?;
                    } else {
                        self.mark(&mut content, &mut line);
                        self.take(&mut cur);
                    }
                }
                b'/' if self.peek(1)? == Some(b'*') => {
                    // MySQL の /*! … */ は実行される
                    if flavor == Flavor::Mysql && self.peek(2)? == Some(b'!') {
                        self.mark(&mut content, &mut line);
                    }
                    self.block_comment(&mut cur)?;
                }
                b'$' if flavor == Flavor::Pg && !cur.last().is_some_and(|b| ident_byte(*b, flavor)) => {
                    self.mark(&mut content, &mut line);
                    self.dollar(&mut cur)?;
                }
                _ if (c.is_ascii_alphabetic() || c == b'_')
                    && !cur.last().is_some_and(|b| ident_byte(*b, flavor)) =>
                {
                    self.mark(&mut content, &mut line);
                    let start = cur.len();
                    while let Some(b) = self.peek(0)? {
                        if !ident_byte(b, flavor) {
                            break;
                        }
                        self.take(&mut cur);
                    }
                    let w = String::from_utf8_lossy(&cur[start..]).to_string();
                    words.push(&w, flavor);
                }
                _ => {
                    self.mark(&mut content, &mut line);
                    self.take(&mut cur);
                }
            }
        }
    }

    /// 文の中身が始まった
    fn mark(&self, content: &mut bool, line: &mut u64) {
        if !*content {
            *content = true;
            *line = self.line;
        }
    }

    /// 引用符で囲まれた部分 (同じ引用符を2つ重ねると1つ。bs なら \ で逃がす)
    fn quoted(&mut self, cur: &mut Vec<u8>, q: u8, bs: bool) -> std::io::Result<()> {
        self.take(cur);
        let stops: &[u8] = if bs { &[q, b'\\'] } else { std::slice::from_ref(&q) };
        loop {
            match self.take_until(cur, stops)? {
                None => return Ok(()),
                Some(b'\\') => {
                    self.take(cur);
                    if self.peek(0)?.is_some() {
                        self.take(cur);
                    }
                }
                Some(_) => {
                    self.take(cur);
                    if self.peek(0)? == Some(q) {
                        self.take(cur);
                    } else {
                        return Ok(());
                    }
                }
            }
        }
    }

    fn line_comment(&mut self, cur: &mut Vec<u8>) -> std::io::Result<()> {
        if self.take_until(cur, b"\n")?.is_some() {
            self.take(cur);
        }
        Ok(())
    }

    /// /* … */ (PostgreSQL は入れ子にできる)
    fn block_comment(&mut self, cur: &mut Vec<u8>) -> std::io::Result<()> {
        self.take(cur);
        self.take(cur);
        let mut depth = 1;
        loop {
            match self.take_until(cur, b"*/")? {
                None => return Ok(()),
                Some(b'*') => {
                    self.take(cur);
                    if self.peek(0)? == Some(b'/') {
                        self.take(cur);
                        depth -= 1;
                        if depth == 0 {
                            return Ok(());
                        }
                    }
                }
                Some(_) => {
                    self.take(cur);
                    if self.flavor == Flavor::Pg && self.peek(0)? == Some(b'*') {
                        self.take(cur);
                        depth += 1;
                    }
                }
            }
        }
    }

    /// $tag$ … $tag$ (ドル記号の引用)。$1 のようなパラメータはそのまま
    fn dollar(&mut self, cur: &mut Vec<u8>) -> std::io::Result<()> {
        // 閉じの $ までを読んで、引用の印かを確かめる
        let mut k = 1;
        loop {
            match self.peek(k)? {
                Some(b'$') => break,
                Some(b) if b.is_ascii_alphabetic() || b == b'_' || b >= 0x80 => k += 1,
                Some(b) if b.is_ascii_digit() && k > 1 => k += 1,
                _ => {
                    // 引用ではない ($1 など)
                    self.take(cur);
                    return Ok(());
                }
            }
        }
        let tag: Vec<u8> = self.buf[self.pos..self.pos + k + 1].to_vec();
        for _ in 0..tag.len() {
            self.take(cur);
        }
        loop {
            match self.take_until(cur, b"$")? {
                None => return Ok(()),
                Some(_) => {
                    let n = tag.len();
                    if self.fill(n)? && self.buf[self.pos..self.pos + n] == tag[..] {
                        for _ in 0..n {
                            self.take(cur);
                        }
                        return Ok(());
                    }
                    self.take(cur);
                }
            }
        }
    }
}

/// 直前の語が E だけか (PostgreSQL の E'…')
fn words_ends_with_e(cur: &[u8]) -> bool {
    match cur.len() {
        0 => false,
        1 => cur[0] == b'E' || cur[0] == b'e',
        n => {
            (cur[n - 1] == b'E' || cur[n - 1] == b'e') && !ident_byte(cur[n - 2], Flavor::Pg)
        }
    }
}

/// `DELIMITER xx` の行なら、新しい区切り
fn delimiter_command(line: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(line).ok()?.trim();
    let (word, rest) = text.split_at(text.find(char::is_whitespace)?);
    if !word.eq_ignore_ascii_case("DELIMITER") {
        return None;
    }
    let d = rest.split_whitespace().next()?;
    Some(d.as_bytes().to_vec())
}
