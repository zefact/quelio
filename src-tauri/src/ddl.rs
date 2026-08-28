//! カラム変更 (DDL) のSQL生成。
//!
//! 生成したSQLは画面でプレビューしてから実行する。
//! DB種別ごとに書き方が違うため、ここで吸収する

use serde::Deserialize;

use crate::models::DbType;

/// 変更後 (または追加する) カラムの内容
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,
    /// 型 (例: varchar(100), int, timestamp)
    #[serde(default)]
    pub col_type: String,
    /// NULLを許可するか
    #[serde(default)]
    pub nullable: bool,
    /// デフォルト値の式 (未指定・空文字なら指定なし)。値はそのままSQLへ埋め込む
    #[serde(default)]
    pub default: Option<String>,
    /// カラムコメント (MySQL / PostgreSQLのみ)
    #[serde(default)]
    pub comment: Option<String>,
    /// 照合順序 (MySQL / PostgreSQLのみ。空ならDBの既定)
    #[serde(default)]
    pub collation: Option<String>,
    /// MySQLのみ: 追加/変更時の位置。"FIRST" で先頭、カラム名ならその直後
    #[serde(default)]
    pub after: Option<String>,
    /// MySQLのみ: information_schemaのEXTRA (AUTO_INCREMENT等)。
    /// CHANGE COLUMNは定義を丸ごと置き換えるため、これを引き継がないと属性が消える
    #[serde(default)]
    pub extra: Option<String>,
}

/// MySQLのEXTRAからDDLに書ける属性だけを取り出す。
/// DEFAULT_GENERATED / VIRTUAL GENERATED などはそのまま書けないので除く
fn mysql_extra(spec: &ColumnSpec) -> String {
    let Some(extra) = some_trimmed(&spec.extra) else {
        return String::new();
    };
    let upper = extra.to_uppercase();
    let mut out = String::new();
    if upper.contains("ON UPDATE CURRENT_TIMESTAMP") {
        out.push_str(" ON UPDATE CURRENT_TIMESTAMP");
    }
    if upper.contains("AUTO_INCREMENT") {
        out.push_str(" AUTO_INCREMENT");
    }
    out
}

/// カラムに対する変更内容
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColumnChange {
    /// カラム追加
    Add { column: ColumnSpec },
    /// カラム削除
    Drop { name: String },
    /// カラム変更 (beforeは変更前の内容。差分のあるものだけSQLにする)
    Modify {
        before: ColumnSpec,
        column: ColumnSpec,
    },
}

/// 識別子をDB種別に応じてクォートする
pub fn quote(db: DbType, ident: &str) -> String {
    if db == DbType::Mysql {
        format!("`{}`", ident.replace('`', "``"))
    } else {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }
}

/// スキーマ付きのテーブル名
pub fn quote_table(db: DbType, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}.{}", quote(db, s), quote(db, table)),
        None => quote(db, table),
    }
}

/// 文字列リテラル ('...' 内のシングルクォートは '' にする)
pub(crate) fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 空文字をNoneにする
pub(crate) fn some_trimmed(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// MySQLの位置指定 (" FIRST" / " AFTER `col`")
fn mysql_position(spec: &ColumnSpec) -> String {
    match some_trimmed(&spec.after) {
        Some(pos) if pos.eq_ignore_ascii_case("FIRST") => " FIRST".to_string(),
        Some(col) => format!(" AFTER {}", quote(DbType::Mysql, &col)),
        None => String::new(),
    }
}

/// MySQLのカラム定義部 (名前 + 型 + 制約 + コメント + 位置)
pub(crate) fn mysql_column_def(spec: &ColumnSpec) -> String {
    let mut sql = format!("{} {}", quote(DbType::Mysql, &spec.name), spec.col_type);
    // 照合順序は型のすぐ後ろに書く (MySQLは識別子をそのまま並べる)
    if let Some(c) = some_trimmed(&spec.collation) {
        sql.push_str(&format!(" COLLATE {c}"));
    }
    sql.push_str(if spec.nullable { " NULL" } else { " NOT NULL" });
    if let Some(d) = some_trimmed(&spec.default) {
        sql.push_str(&format!(" DEFAULT {d}"));
    }
    sql.push_str(&mysql_extra(spec));
    // CHANGE COLUMN は定義を丸ごと置き換えるので、空ならCOMMENT自体を書かない (=クリア)
    if let Some(c) = some_trimmed(&spec.comment) {
        sql.push_str(&format!(" COMMENT {}", literal(&c)));
    }
    sql.push_str(&mysql_position(spec));
    sql
}

/// PostgreSQLの照合順序の指定 (" COLLATE \"ja-x-icu\"")。
/// 照合順序名は識別子なのでクォートする
pub(crate) fn pg_collate(spec: &ColumnSpec) -> String {
    match some_trimmed(&spec.collation) {
        Some(c) => format!(" COLLATE {}", quote(DbType::Postgresql, &c)),
        None => String::new(),
    }
}

/// MySQLで使えるカラム型名 (型名だけ。サイズや unsigned などの修飾は別に扱う)。
///
/// MySQLは information_schema に型の一覧を持たないため固定の表にしている。
/// バージョンによって使える型が違う (JSONは5.7.8以降、VECTORは9.0以降、
/// UUID/INET4/INET6はMariaDBのみ) ので、ここは全バージョンの和集合にしておき、
/// そのサーバーに無い型はDB側のエラーに任せる。
/// アプリが正しい型を誤って弾くほうが困るため
pub const MYSQL_TYPES: &[&str] = &[
    // 数値
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "decimal",
    "dec",
    "numeric",
    "fixed",
    "float",
    "double",
    "double precision",
    "real",
    "bit",
    "bool",
    "boolean",
    "serial",
    // 日付・時刻
    "date",
    "datetime",
    "timestamp",
    "time",
    "year",
    // 文字列・バイナリ
    "char",
    "varchar",
    "binary",
    "varbinary",
    "tinyblob",
    "blob",
    "mediumblob",
    "longblob",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "nchar",
    "nvarchar",
    "enum",
    "set",
    // その他
    "json",
    // MySQL 9.0以降
    "vector",
    // MariaDBのみ
    "uuid",
    "inet4",
    "inet6",
    // 空間データ型
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
];

/// PostgreSQLでよく使う型 (候補の先頭に出す順番)。
/// pg_typeから取れる正式名と、SQLで書ける別名の両方を含める
pub const PG_COMMON_TYPES: &[&str] = &[
    "integer",
    "bigint",
    "smallint",
    "serial",
    "bigserial",
    "smallserial",
    "boolean",
    "numeric",
    "decimal",
    "real",
    "double precision",
    "character varying",
    "varchar",
    "character",
    "char",
    "text",
    "date",
    "timestamp without time zone",
    "timestamp with time zone",
    "timestamptz",
    "time without time zone",
    "time with time zone",
    "timetz",
    "interval",
    "uuid",
    "json",
    "jsonb",
    "bytea",
    "inet",
    "cidr",
    "macaddr",
    "money",
];

/// PostgreSQLの型の別名。
/// pg_typeのformat_typeは正式名しか返さないが、SQLではこちらも書けるので候補に足す
/// (int4 / float8 のような内部名や、serialのような構文糖)
pub const PG_TYPE_ALIASES: &[&str] = &[
    "int", "int2", "int4", "int8", "float4", "float8", "bool", "varbit",
    "serial2", "serial4", "serial8", "bpchar",
];

/// SQLiteで使えるカラム型名。
/// SQLiteは動的型付けで未知の型名も通してしまう (NUMERICアフィニティ扱いになる) ため、
/// 打ち間違いに気づけるようアプリ側で絞り込む
pub const SQLITE_TYPES: &[&str] = &[
    // 推奨の5種
    "integer",
    "real",
    "text",
    "blob",
    "numeric",
    // INTEGERアフィニティ
    "int",
    "tinyint",
    "smallint",
    "mediumint",
    "bigint",
    "unsigned big int",
    "int2",
    "int8",
    // TEXTアフィニティ
    "character",
    "varchar",
    "varying character",
    "nchar",
    "native character",
    "nvarchar",
    "clob",
    // REALアフィニティ
    "double",
    "double precision",
    "float",
    // NUMERICアフィニティ
    "decimal",
    "boolean",
    "date",
    "datetime",
    "timestamp",
];

/// MySQLで型名の後ろに付けられる修飾語 (型名の判定からは外す)
const MYSQL_TYPE_MODIFIERS: &[&str] = &["unsigned", "signed", "zerofill"];

/// 型の指定を分解したもの。
/// 形は「名前 [ (引数) ] [修飾語...]」に限る (例: varchar(255) / int unsigned / numeric(10,2)[])
struct TypeSpec<'a> {
    /// 括弧の前の部分 (例: "character varying")
    name: &'a str,
    /// 括弧の後ろの部分 (例: " unsigned" / "[]")
    tail: &'a str,
}

/// 型名・修飾語として使える文字だけか (SQLへそのまま書くため厳しく絞る)
fn type_word_chars(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '[' | ']'))
}

/// 括弧の中身が「数値の並び」か (長さ・精度。例: 255 / 10,2)
fn numeric_args(inner: &str) -> bool {
    inner.split(',').all(|p| {
        let p = p.trim();
        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())
    })
}

/// 括弧の中身が「文字列の並び」か (MySQLのENUM/SET。例: 'a','b')。
/// MySQLはENUMの値をバックスラッシュでエスケープして返すため、
/// `\'` は1文字として読み飛ばす (`''` も同じく ' の表現)
fn quoted_args(inner: &str) -> bool {
    let b = inner.as_bytes();
    let mut i = 0;
    loop {
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        if i >= b.len() || b[i] != b'\'' {
            return false;
        }
        i += 1;
        // 閉じクォートまで進む
        loop {
            if i >= b.len() {
                return false;
            }
            match b[i] {
                // エスケープされた1文字ぶんを飛ばす
                b'\\' if i + 1 < b.len() => i += 2,
                b'\\' => return false,
                b'\'' if i + 1 < b.len() && b[i + 1] == b'\'' => i += 2,
                b'\'' => {
                    i += 1;
                    break;
                }
                _ => i += 1,
            }
        }
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        if i >= b.len() {
            return true;
        }
        if b[i] != b',' {
            return false;
        }
        i += 1;
    }
}

/// 型の指定を分解する。想定していない形ならNone。
///
/// 型はクォートできずSQLへそのまま書くため、
/// 「括弧の前後に余計なものが無いこと」までここで確かめる
/// (`varchar(100)) NOT NULL, ADD COLUMN ...` のような入力を通さない)
fn parse_type(col_type: &str) -> Option<TypeSpec<'_>> {
    let s = col_type.trim();
    if s.is_empty() || s.chars().any(|c| c.is_control()) {
        return None;
    }
    let (name, tail) = match s.find('(') {
        None => (s, ""),
        Some(open) => {
            let close = s.rfind(')')?;
            if close < open {
                return None;
            }
            let inner = &s[open + 1..close];
            let tail = &s[close + 1..];
            // 括弧は1組だけ。中身は数値の並びか文字列の並びのみ
            if inner.contains('(') || inner.contains(')') {
                return None;
            }
            if tail.contains('(') || tail.contains(')') {
                return None;
            }
            if !numeric_args(inner) && !quoted_args(inner) {
                return None;
            }
            (&s[..open], tail)
        }
    };
    if name.trim().is_empty() || !type_word_chars(name) || !type_word_chars(tail) {
        return None;
    }
    Some(TypeSpec { name, tail })
}

/// 型の指定を「型名だけ」に正規化する。
/// サイズの括弧・配列の [] ・MySQLの修飾語を落として小文字にそろえる
fn normalize_type(db: DbType, spec: &TypeSpec) -> String {
    // 配列の [] は型名から外す (integer[] → integer)
    let name = spec.name.replace("[]", " ");
    let tail = spec.tail.replace("[]", " ");
    let mut words: Vec<String> = name
        .split_whitespace()
        .chain(tail.split_whitespace())
        .map(|w| w.to_lowercase())
        .collect();
    if db == DbType::Mysql {
        words.retain(|w| !MYSQL_TYPE_MODIFIERS.contains(&w.as_str()));
    }
    words.join(" ")
}

/// 型名が使えるものか調べる。
/// allowedは接続先から取得した型の一覧 (MySQL/SQLiteは固定、PostgreSQLはpg_typeから)
pub(crate) fn validate_type(db: DbType, col_type: &str, allowed: &[String]) -> Result<(), String> {
    if col_type.trim().is_empty() {
        return Err("型を入力してください".into());
    }
    let Some(spec) = parse_type(col_type) else {
        return Err(format!(
            "型の書き方が正しくありません: {}\n(例: varchar(255) / int unsigned / numeric(10,2))",
            col_type.trim()
        ));
    };
    let name = normalize_type(db, &spec);
    if name.is_empty() {
        return Err("型を入力してください".into());
    }
    if allowed.is_empty() {
        // 一覧を取得できなかったときは、型名の照合まではしない
        return Ok(());
    }
    if allowed.iter().any(|t| t.to_lowercase() == name) {
        return Ok(());
    }
    Err(format!(
        "このDBでは使えない型名です: {}\n(型欄の候補から選んでください)",
        col_type.trim()
    ))
}

/// 入力内容の基本チェック
pub(crate) fn validate(db: DbType, spec: &ColumnSpec, need_type: bool) -> Result<(), String> {
    if spec.name.trim().is_empty() {
        return Err("カラム名を入力してください".into());
    }
    if need_type && spec.col_type.trim().is_empty() {
        return Err("型を入力してください".into());
    }
    // 型と同じ行に書かれる指定も、クォートできずSQLへそのまま入る
    if let Some(c) = some_trimmed(&spec.collation) {
        validate_collation(&c)?;
    }
    if let Some(d) = some_trimmed(&spec.default) {
        validate_default(db, &d)?;
    }
    Ok(())
}

/// 照合順序の名前として使える形か。
///
/// MySQLはクォートせずにそのまま書くため (`COLLATE utf8mb4_ja_0900_as_cs`)、
/// 名前に見えないものは通さない。
/// PostgreSQLはクォートするが、判定はDBによらず同じにしておく
pub(crate) fn validate_collation(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "照合順序の名前が正しくありません: {name}\n(候補から選んでください)"
        ))
    }
}

/// デフォルト値の式として書けるか。
///
/// DEFAULT は値ではなく式なのでクォートできず、SQLへそのまま入る。
/// 「1つの式で終わっていること」だけをここで確かめ、
/// `0, ADD COLUMN evil int` のように定義を書き足せないようにする
/// (式の中身が正しいかはDBに任せる)
fn validate_default(db: DbType, expr: &str) -> Result<(), String> {
    let bad = |reason: &str| Err(format!("デフォルト値に使えない書き方です ({reason})"));
    if expr.chars().any(|c| c.is_control()) {
        return bad("改行や制御文字は使えません");
    }
    // MySQLだけは文字列の中のバックスラッシュがエスケープ、`#` が行コメント
    let mysql = db == DbType::Mysql;
    let chars: Vec<char> = expr.chars().collect();
    let mut depth = 0i32;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\'' | '"' | '`' => {
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == '\\' && mysql && c != '`' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == c {
                        // '' は文字としての ' なので、まだ閉じていない
                        if chars.get(i + 1) == Some(&c) {
                            i += 2;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    return bad("引用符が閉じていません");
                }
            }
            ';' => return bad("`;` は書けません"),
            // 括弧の外のカンマは、次の定義の始まりになってしまう
            //  (`0, ADD COLUMN evil int`)
            ',' if depth == 0 => {
                return bad("括弧の外に `,` は書けません")
            }
            '-' if next == Some('-') => return bad("コメントは書けません"),
            '/' if next == Some('*') => return bad("コメントは書けません"),
            '#' if mysql => return bad("コメントは書けません"),
            // PostgreSQLの ARRAY[1, 2] もひとつの式なので、[] も数える。
            // 他のDBでは [] に文法上の意味が無いので数えない
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return bad("括弧が対応していません");
                }
            }
            '[' if db == DbType::Postgresql => depth += 1,
            ']' if db == DbType::Postgresql => {
                depth -= 1;
                if depth < 0 {
                    return bad("括弧が対応していません");
                }
            }
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return bad("括弧が閉じていません");
    }
    Ok(())
}

/// テーブル名として受け付けない文字 (クォートで囲むので大半は通せるが、
/// 改行やクォート自体が入るのは打ち間違いの可能性が高いので弾く)
pub(crate) fn validate_table_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("テーブル名を入力してください".into());
    }
    if n.chars().any(|c| c.is_control()) {
        return Err("テーブル名に改行などの制御文字は使えません".into());
    }
    if n.contains('`') || n.contains('"') || n.contains('\'') {
        return Err("テーブル名にクォート記号 ` \" ' は使えません".into());
    }
    Ok(())
}

/// 一覧のtable_typeに対応する DROP の対象種別
fn drop_kind(table_type: &str) -> &'static str {
    let t = table_type.to_uppercase();
    if t.contains("MATERIALIZED") {
        "MATERIALIZED VIEW"
    } else if t.contains("VIEW") {
        "VIEW"
    } else if t.contains("FOREIGN") {
        "FOREIGN TABLE"
    } else {
        "TABLE"
    }
}

/// テーブル (ビュー) を削除するSQL
pub fn build_drop_table(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    table_type: &str,
) -> Result<Vec<String>, String> {
    validate_table_name(table)?;
    if db == DbType::Valkey {
        return Err("Valkey接続ではテーブルを削除できません".into());
    }
    // SQLiteはスキーマの概念が無いのでテーブル名だけを使う
    let target = if db == DbType::Sqlite {
        quote(db, table.trim())
    } else {
        quote_table(db, schema, table.trim())
    };
    Ok(vec![format!("DROP {} {target}", drop_kind(table_type))])
}

/// テーブルのコメント (日本語名・論理名) を設定するSQL。
/// 空文字を渡すとコメントを消す
pub fn build_set_table_comment(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    comment: &str,
) -> Result<Vec<String>, String> {
    validate_table_name(table)?;
    let c = comment.trim();
    match db {
        DbType::Mysql => Ok(vec![format!(
            "ALTER TABLE {} COMMENT = {}",
            quote_table(db, schema, table.trim()),
            literal(c)
        )]),
        DbType::Postgresql => Ok(vec![format!(
            "COMMENT ON TABLE {} IS {}",
            quote_table(db, schema, table.trim()),
            if c.is_empty() {
                "NULL".to_string()
            } else {
                literal(c)
            }
        )]),
        DbType::Sqlite => {
            Err("SQLiteにはテーブルコメントの仕組みがありません".into())
        }
        DbType::Valkey => {
            Err("Valkey接続ではテーブルコメントを設定できません".into())
        }
    }
}

/// テーブル名を変更するALTER TABLE文。
/// 新しい名前はスキーマを跨げないため、修飾なしの名前だけを使う
pub fn build_rename_table(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    new_name: &str,
) -> Result<Vec<String>, String> {
    validate_table_name(table)?;
    validate_table_name(new_name)?;
    let (old, new) = (table.trim(), new_name.trim());
    if old == new {
        return Err("テーブル名が変わっていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続ではテーブル名を変更できません".into());
    }
    // SQLiteはスキーマの概念が無いのでテーブル名だけを使う
    let target = if db == DbType::Sqlite {
        quote(db, old)
    } else {
        quote_table(db, schema, old)
    };
    Ok(vec![format!(
        "ALTER TABLE {target} RENAME TO {}",
        quote(db, new)
    )])
}

// ---------- インデックス ----------

/// 追加・変更するインデックスの内容
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpec {
    pub name: String,
    #[serde(default)]
    pub unique: bool,
    /// 対象カラム (並び順どおり)
    #[serde(default)]
    pub columns: Vec<String>,
    /// インデックスの種別 (空ならDBの既定)。
    /// MySQL: BTREE / HASH / FULLTEXT / SPATIAL
    /// PostgreSQL: btree / hash / gist / gin / spgist / brin
    #[serde(default)]
    pub index_type: Option<String>,
}

/// DB種別ごとに受け付けるインデックスの種別。
/// 生成SQLへそのまま埋め込むので、必ずこの一覧で照合してから使う
const MYSQL_INDEX_TYPES: &[&str] = &["BTREE", "HASH", "FULLTEXT", "SPATIAL"];
const PG_INDEX_TYPES: &[&str] = &["BTREE", "HASH", "GIST", "GIN", "SPGIST", "BRIN"];

/// 入力された種別を大文字に正規化して検証する (空ならNone)
fn index_kind(db: DbType, spec: &IndexSpec) -> Result<Option<String>, String> {
    let Some(raw) = some_trimmed(&spec.index_type) else {
        return Ok(None);
    };
    let up = raw.to_uppercase();
    let allowed = match db {
        DbType::Mysql => MYSQL_INDEX_TYPES,
        DbType::Postgresql => PG_INDEX_TYPES,
        // SQLiteに種別の指定は無いので黙って無視する
        _ => return Ok(None),
    };
    if allowed.contains(&up.as_str()) {
        Ok(Some(up))
    } else {
        Err(format!(
            "このDBでは使えないインデックス種別です: {raw}\n(使えるのは {})",
            allowed.join(" / ")
        ))
    }
}

/// インデックスに対する変更内容
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IndexChange {
    /// 追加
    Add { index: IndexSpec },
    /// 削除
    Drop { name: String },
    /// 変更 (どのDBも定義を書き換えられないため、作り直しになる)
    Modify { before: String, index: IndexSpec },
}

/// インデックス名・カラムの基本チェック
fn validate_index(spec: &IndexSpec) -> Result<(), String> {
    if spec.name.trim().is_empty() {
        return Err("インデックス名を入力してください".into());
    }
    if spec.name.chars().any(|c| c.is_control()) {
        return Err("インデックス名に改行などの制御文字は使えません".into());
    }
    if spec.columns.iter().all(|c| c.trim().is_empty()) {
        return Err("対象カラムを1つ以上指定してください".into());
    }
    Ok(())
}

/// インデックスを作るCREATE INDEX文
fn create_index(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    spec: &IndexSpec,
) -> Result<String, String> {
    validate_index(spec)?;
    let cols = spec
        .columns
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(|c| quote(db, c))
        .collect::<Vec<_>>()
        .join(", ");
    // SQLiteはスキーマの概念が無いのでテーブル名だけを使う
    let target = if db == DbType::Sqlite {
        quote(db, table.trim())
    } else {
        quote_table(db, schema, table.trim())
    };
    let name = quote(db, spec.name.trim());
    let unique = if spec.unique { "UNIQUE " } else { "" };
    let kind = index_kind(db, spec)?;
    Ok(match (db, kind.as_deref()) {
        // MySQLの全文・空間インデックスは UNIQUE や USING と併用できない
        (DbType::Mysql, Some("FULLTEXT")) => {
            format!("CREATE FULLTEXT INDEX {name} ON {target} ({cols})")
        }
        (DbType::Mysql, Some("SPATIAL")) => {
            format!("CREATE SPATIAL INDEX {name} ON {target} ({cols})")
        }
        (DbType::Mysql, Some(k)) => {
            format!("CREATE {unique}INDEX {name} ON {target} ({cols}) USING {k}")
        }
        // PostgreSQLは USING をカラム一覧の前に書く
        (DbType::Postgresql, Some(k)) => format!(
            "CREATE {unique}INDEX {name} ON {target} USING {} ({cols})",
            k.to_lowercase()
        ),
        _ => format!("CREATE {unique}INDEX {name} ON {target} ({cols})"),
    })
}

/// インデックスを消すDROP INDEX文 (書き方がDBごとに違う)
fn drop_index(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    name: &str,
) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("インデックス名を指定してください".into());
    }
    Ok(match db {
        // MySQLは対象テーブルの指定が必要
        DbType::Mysql => format!(
            "DROP INDEX {} ON {}",
            quote(db, n),
            quote_table(db, schema, table.trim())
        ),
        // PostgreSQLはインデックス自体がスキーマに属する
        DbType::Postgresql => format!("DROP INDEX {}", quote_table(db, schema, n)),
        DbType::Sqlite => format!("DROP INDEX {}", quote(db, n)),
        DbType::Valkey => {
            return Err("Valkey接続ではインデックスを操作できません".into())
        }
    })
}

/// 追加する外部キーの内容
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeySpec {
    /// 制約名 (空ならDBに任せる)
    #[serde(default)]
    pub name: String,
    /// このテーブル側のカラム
    pub columns: Vec<String>,
    /// 参照先のスキーマ (空なら同じスキーマ)
    #[serde(default)]
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// ON DELETE の動作 (空なら指定しない)
    #[serde(default)]
    pub on_delete: String,
    /// ON UPDATE の動作 (空なら指定しない)
    #[serde(default)]
    pub on_update: String,
}

/// 外部キーに対する変更内容
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForeignKeyChange {
    /// 追加
    Add { fk: ForeignKeySpec },
    /// 削除
    Drop { name: String },
}

/// 外部キーに指定できる動作
const FK_ACTIONS: &[&str] = &[
    "CASCADE",
    "RESTRICT",
    "SET NULL",
    "NO ACTION",
    "SET DEFAULT",
];

/// 動作の指定を大文字にそろえて確かめる (空ならNone = 指定しない)
fn fk_action(raw: &str) -> Result<Option<String>, String> {
    let up = raw.trim().to_uppercase();
    if up.is_empty() {
        return Ok(None);
    }
    if FK_ACTIONS.contains(&up.as_str()) {
        Ok(Some(up))
    } else {
        Err(format!(
            "外部キーの動作が正しくありません: {raw}\n(使えるのは {})",
            FK_ACTIONS.join(" / ")
        ))
    }
}

/// 外部キーの変更内容から実行するSQL文を組み立てる
pub fn build_foreign_key(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    change: &ForeignKeyChange,
) -> Result<Vec<String>, String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続では外部キーを操作できません".into());
    }
    if db == DbType::Sqlite {
        return Err(
            "SQLiteは後から外部キーを追加・削除できません\n(テーブルを作り直す必要があります)"
                .into(),
        );
    }
    let t = quote_table(db, schema, table.trim());
    match change {
        ForeignKeyChange::Drop { name } => {
            if name.trim().is_empty() {
                return Err("削除する外部キーが指定されていません".into());
            }
            let n = quote(db, name.trim());
            Ok(vec![match db {
                // MySQLは制約ではなく「外部キー」として消す
                DbType::Mysql => format!("ALTER TABLE {t} DROP FOREIGN KEY {n}"),
                _ => format!("ALTER TABLE {t} DROP CONSTRAINT {n}"),
            }])
        }
        ForeignKeyChange::Add { fk } => {
            let cols: Vec<&str> = fk
                .columns
                .iter()
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .collect();
            let refs: Vec<&str> = fk
                .ref_columns
                .iter()
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .collect();
            if cols.is_empty() {
                return Err("このテーブル側のカラムを指定してください".into());
            }
            if fk.ref_table.trim().is_empty() {
                return Err("参照先のテーブルを指定してください".into());
            }
            if refs.is_empty() {
                return Err("参照先のカラムを指定してください".into());
            }
            if cols.len() != refs.len() {
                return Err(format!(
                    "カラムの数が合っていません (このテーブル: {} / 参照先: {})",
                    cols.len(),
                    refs.len()
                ));
            }
            let mut sql = format!("ALTER TABLE {t} ADD ");
            if !fk.name.trim().is_empty() {
                if fk.name.chars().any(|c| c.is_control()) {
                    return Err("制約名に改行などの制御文字は使えません".into());
                }
                sql.push_str(&format!("CONSTRAINT {} ", quote(db, fk.name.trim())));
            }
            // 参照先のスキーマ指定が無ければ、このテーブルと同じスキーマとみなす
            let ref_schema = if fk.ref_schema.trim().is_empty() {
                schema
            } else {
                Some(fk.ref_schema.trim())
            };
            sql.push_str(&format!(
                "FOREIGN KEY ({}) REFERENCES {} ({})",
                cols.iter()
                    .map(|c| quote(db, c))
                    .collect::<Vec<_>>()
                    .join(", "),
                quote_table(db, ref_schema, fk.ref_table.trim()),
                refs.iter()
                    .map(|c| quote(db, c))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            if let Some(a) = fk_action(&fk.on_delete)? {
                sql.push_str(&format!(" ON DELETE {a}"));
            }
            if let Some(a) = fk_action(&fk.on_update)? {
                sql.push_str(&format!(" ON UPDATE {a}"));
            }
            Ok(vec![sql])
        }
    }
}

/// インデックスの変更内容から実行するSQL文の一覧を組み立てる
pub fn build_index(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    change: &IndexChange,
) -> Result<Vec<String>, String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    if db == DbType::Valkey {
        return Err("Valkey接続ではインデックスを操作できません".into());
    }
    match change {
        IndexChange::Add { index } => Ok(vec![create_index(db, schema, table, index)?]),
        IndexChange::Drop { name } => Ok(vec![drop_index(db, schema, table, name)?]),
        IndexChange::Modify { before, index } => {
            // ALTER INDEXで定義は変えられないので、消してから作り直す
            validate_index(index)?;
            Ok(vec![
                drop_index(db, schema, table, before)?,
                create_index(db, schema, table, index)?,
            ])
        }
    }
}

/// 変更内容から実行するSQL文の一覧を組み立てる
pub fn build(
    db: DbType,
    schema: Option<&str>,
    table: &str,
    change: &ColumnChange,
    types: &[String],
) -> Result<Vec<String>, String> {
    if table.trim().is_empty() {
        return Err("テーブルが選択されていません".into());
    }
    // 型を指定する変更は、使える型かどうかをここでまとめて確かめる
    match change {
        ColumnChange::Add { column } => validate_type(db, &column.col_type, types)?,
        ColumnChange::Modify { column, .. } => {
            validate_type(db, &column.col_type, types)?
        }
        ColumnChange::Drop { .. } => {}
    }
    match db {
        DbType::Mysql => build_mysql(schema, table, change),
        DbType::Postgresql => build_pg(schema, table, change),
        DbType::Sqlite => build_sqlite(table, change),
        DbType::Valkey => Err("Valkey接続ではテーブル定義を変更できません".into()),
    }
}

fn build_mysql(
    schema: Option<&str>,
    table: &str,
    change: &ColumnChange,
) -> Result<Vec<String>, String> {
    let t = quote_table(DbType::Mysql, schema, table);
    match change {
        ColumnChange::Add { column } => {
            validate(DbType::Mysql, column, true)?;
            Ok(vec![format!(
                "ALTER TABLE {t} ADD COLUMN {}",
                mysql_column_def(column)
            )])
        }
        ColumnChange::Drop { name } => Ok(vec![format!(
            "ALTER TABLE {t} DROP COLUMN {}",
            quote(DbType::Mysql, name)
        )]),
        ColumnChange::Modify { before, column } => {
            validate(DbType::Mysql, column, true)?;
            // CHANGE COLUMN は定義を丸ごと書き直すため、生成カラムは式が消えてしまう。
            // (DEFAULT_GENERATED は「DEFAULTに式を使った」印なので対象外)
            let before_extra = before.extra.clone().unwrap_or_default().to_uppercase();
            if before_extra.contains("GENERATED")
                && !before_extra.contains("DEFAULT_GENERATED")
            {
                return Err("生成カラム (GENERATED) の変更には対応していません".into());
            }
            // CHANGE COLUMN は名前と定義をまとめて変更できる
            Ok(vec![format!(
                "ALTER TABLE {t} CHANGE COLUMN {} {}",
                quote(DbType::Mysql, &before.name),
                mysql_column_def(column)
            )])
        }
    }
}

fn build_pg(
    schema: Option<&str>,
    table: &str,
    change: &ColumnChange,
) -> Result<Vec<String>, String> {
    let db = DbType::Postgresql;
    let t = quote_table(db, schema, table);
    match change {
        ColumnChange::Add { column } => {
            validate(db, column, true)?;
            let mut sql = format!(
                "ALTER TABLE {t} ADD COLUMN {} {}{}",
                quote(db, &column.name),
                column.col_type,
                pg_collate(column)
            );
            if let Some(d) = some_trimmed(&column.default) {
                sql.push_str(&format!(" DEFAULT {d}"));
            }
            if !column.nullable {
                sql.push_str(" NOT NULL");
            }
            let mut out = vec![sql];
            if let Some(c) = some_trimmed(&column.comment) {
                out.push(format!(
                    "COMMENT ON COLUMN {t}.{} IS {}",
                    quote(db, &column.name),
                    literal(&c)
                ));
            }
            Ok(out)
        }
        ColumnChange::Drop { name } => Ok(vec![format!(
            "ALTER TABLE {t} DROP COLUMN {}",
            quote(db, name)
        )]),
        ColumnChange::Modify { before, column } => {
            validate(db, column, true)?;
            let mut out = Vec::new();
            // 名前の変更は最初に行い、以降は新しい名前で操作する
            if before.name != column.name {
                out.push(format!(
                    "ALTER TABLE {t} RENAME COLUMN {} TO {}",
                    quote(db, &before.name),
                    quote(db, &column.name)
                ));
            }
            let col = quote(db, &column.name);
            // 照合順序だけを変える構文が無いため、型の指定とまとめて出す
            if before.col_type.trim() != column.col_type.trim()
                || some_trimmed(&before.collation) != some_trimmed(&column.collation)
            {
                out.push(format!(
                    "ALTER TABLE {t} ALTER COLUMN {col} TYPE {}{}",
                    column.col_type,
                    pg_collate(column)
                ));
            }
            if before.nullable != column.nullable {
                out.push(format!(
                    "ALTER TABLE {t} ALTER COLUMN {col} {}",
                    if column.nullable {
                        "DROP NOT NULL"
                    } else {
                        "SET NOT NULL"
                    }
                ));
            }
            let (old_default, new_default) =
                (some_trimmed(&before.default), some_trimmed(&column.default));
            if old_default != new_default {
                out.push(match new_default {
                    Some(d) => format!("ALTER TABLE {t} ALTER COLUMN {col} SET DEFAULT {d}"),
                    None => format!("ALTER TABLE {t} ALTER COLUMN {col} DROP DEFAULT"),
                });
            }
            if some_trimmed(&before.comment) != some_trimmed(&column.comment) {
                let value = match some_trimmed(&column.comment) {
                    Some(c) => literal(&c),
                    None => "NULL".to_string(),
                };
                out.push(format!("COMMENT ON COLUMN {t}.{col} IS {value}"));
            }
            if out.is_empty() {
                return Err("変更点がありません".into());
            }
            Ok(out)
        }
    }
}

fn build_sqlite(table: &str, change: &ColumnChange) -> Result<Vec<String>, String> {
    let db = DbType::Sqlite;
    let t = quote(db, table);
    match change {
        ColumnChange::Add { column } => {
            validate(db, column, true)?;
            let mut sql = format!(
                "ALTER TABLE {t} ADD COLUMN {} {}",
                quote(db, &column.name),
                column.col_type
            );
            let default = some_trimmed(&column.default);
            if !column.nullable && default.is_none() {
                return Err(
                    "SQLiteでNOT NULLのカラムを追加するには、デフォルト値の指定が必要です".into(),
                );
            }
            if let Some(d) = default {
                sql.push_str(&format!(" DEFAULT {d}"));
            }
            if !column.nullable {
                sql.push_str(" NOT NULL");
            }
            Ok(vec![sql])
        }
        ColumnChange::Drop { name } => Ok(vec![format!(
            "ALTER TABLE {t} DROP COLUMN {}",
            quote(db, name)
        )]),
        ColumnChange::Modify { before, column } => {
            validate(db, column, false)?;
            // SQLiteのALTER TABLEはカラム名の変更しかできない
            if before.col_type.trim() != column.col_type.trim()
                || before.nullable != column.nullable
                || some_trimmed(&before.default) != some_trimmed(&column.default)
            {
                return Err(
                    "SQLiteでは型・NOT NULL・デフォルトの変更に対応していません\n\
                     (テーブルを作り直してデータを移し替える必要があります)"
                        .into(),
                );
            }
            if before.name == column.name {
                return Err("変更点がありません".into());
            }
            Ok(vec![format!(
                "ALTER TABLE {t} RENAME COLUMN {} TO {}",
                quote(db, &before.name),
                quote(db, &column.name)
            )])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mysql_types() -> Vec<String> {
        MYSQL_TYPES.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn 外部キーのsqlを組み立てる() {
        let fk = ForeignKeySpec {
            name: "fk_order_user".into(),
            columns: vec!["user_id".into()],
            ref_table: "users".into(),
            ref_columns: vec!["id".into()],
            on_delete: "cascade".into(),
            ..Default::default()
        };
        let sql = build_foreign_key(
            DbType::Mysql,
            None,
            "orders",
            &ForeignKeyChange::Add { fk },
        )
        .unwrap();
        assert_eq!(
            sql[0],
            "ALTER TABLE `orders` ADD CONSTRAINT `fk_order_user` \
             FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE"
        );
        let drop = build_foreign_key(
            DbType::Mysql,
            None,
            "orders",
            &ForeignKeyChange::Drop {
                name: "fk_order_user".into(),
            },
        )
        .unwrap();
        assert_eq!(drop[0], "ALTER TABLE `orders` DROP FOREIGN KEY `fk_order_user`");
    }

    #[test]
    fn 外部キーの入力を確かめる() {
        let bad = ForeignKeySpec {
            columns: vec!["a".into(), "b".into()],
            ref_table: "t".into(),
            ref_columns: vec!["x".into()],
            ..Default::default()
        };
        assert!(build_foreign_key(
            DbType::Postgresql,
            Some("public"),
            "orders",
            &ForeignKeyChange::Add { fk: bad }
        )
        .is_err());
        let bad_action = ForeignKeySpec {
            columns: vec!["a".into()],
            ref_table: "t".into(),
            ref_columns: vec!["x".into()],
            on_update: "DROP TABLE t".into(),
            ..Default::default()
        };
        assert!(build_foreign_key(
            DbType::Postgresql,
            Some("public"),
            "orders",
            &ForeignKeyChange::Add { fk: bad_action }
        )
        .is_err());
    }

    #[test]
    fn デフォルト値に定義を書き足せない() {
        for v in [
            "0, ADD COLUMN evil int",
            "0; DROP TABLE t",
            "0 -- x",
            "0 /* x */",
            "0 # x",
            "'abc",
            "now())",
        ] {
            assert!(validate_default(DbType::Mysql, v).is_err(), "{v}");
        }
    }

    #[test]
    fn 普通のデフォルト値は通る() {
        for v in [
            "0",
            "-1",
            "'abc'",
            "'it''s'",
            "CURRENT_TIMESTAMP",
            "now()",
            "(JSON_ARRAY())",
            "'a, b'",
        ] {
            assert!(validate_default(DbType::Mysql, v).is_ok(), "{v}");
        }
        // [] の中のカンマを許すのはPostgreSQLだけ
        assert!(validate_default(DbType::Postgresql, "ARRAY[1, 2]").is_ok());
        assert!(validate_default(DbType::Postgresql, "'{1,2}'::int[]").is_ok());
        assert!(validate_default(DbType::Mysql, "0[, ADD COLUMN evil int]").is_err());
        assert!(validate_default(DbType::Postgresql, "'{}'::jsonb").is_ok());
        // PostgreSQLでは # は演算子なのでコメント扱いしない
        assert!(validate_default(DbType::Postgresql, "(a # b)").is_ok());
    }

    #[test]
    fn 照合順序は名前だけを受け付ける() {
        assert!(validate_collation("utf8mb4_ja_0900_as_cs").is_ok());
        assert!(validate_collation("ja-x-icu").is_ok());
        assert!(validate_collation("en_US.utf8").is_ok());
        assert!(validate_collation("x, ADD COLUMN evil int").is_err());
        assert!(validate_collation("").is_err());
    }

    #[test]
    fn 正しい型は通る() {
        let allowed = mysql_types();
        for t in [
            "varchar(255)",
            "VARCHAR(255)",
            "int",
            "int unsigned",
            "int(11) unsigned",
            "decimal(10,2)",
            "double precision",
            "enum('a','b')",
            "enum('a,b','c')",
            "set('x')",
            "datetime(6)",
        ] {
            assert!(
                validate_type(DbType::Mysql, t, &allowed).is_ok(),
                "通るはず: {t}"
            );
        }
    }

    #[test]
    fn 括弧の後ろにsqlを足せない() {
        let allowed = mysql_types();
        for t in [
            "varchar(100)) NOT NULL, ADD COLUMN evil int -- ",
            "int, DROP COLUMN id",
            "varchar(10) COMMENT 'x'",
            "int; DROP TABLE t",
            "enum('a'), ADD COLUMN evil int",
            "varchar(10)(20)",
            "varchar('a' || 'b')",
            "int\nunsigned",
        ] {
            assert!(
                validate_type(DbType::Mysql, t, &allowed).is_err(),
                "弾くはず: {t}"
            );
        }
    }

    #[test]
    fn postgresqlの配列と時刻型() {
        let allowed: Vec<String> = PG_COMMON_TYPES.iter().map(|t| t.to_string()).collect();
        assert!(validate_type(DbType::Postgresql, "integer[]", &allowed).is_ok());
        assert!(
            validate_type(DbType::Postgresql, "timestamp(3) with time zone", &allowed).is_ok()
        );
        assert!(validate_type(DbType::Postgresql, "integer[]; DROP", &allowed).is_err());
    }

    #[test]
    fn 一覧が空でも書き方は見る() {
        assert!(validate_type(DbType::Mysql, "varchar(255)", &[]).is_ok());
        assert!(validate_type(DbType::Mysql, "varchar(255)) , x int", &[]).is_err());
    }
}
