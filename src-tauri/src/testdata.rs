//! 日本語のテストデータを作る。
//!
//! カラムの「論理名 (日本語コメント)・カラム名・型」から中身の種類を推測し、
//! 氏名・住所・電話番号といった日本語として自然な値を組み立てる。
//! 海外製ツールのダミーデータは英語圏の値ばかりで、
//! 桁数や文字種が日本の画面・帳票に合わないため
//!
//! ここは値を作るところまでで、DBへ入れるのは `sessions::testdata` が行う

use serde::{Deserialize, Serialize};

/// 日本語の素材 (姓名・住所・会社名など)
pub mod japanese;

/// 乱数 (xorshift64*)。
///
/// 外部クレートを増やさず、種を決めれば同じ結果になるようにする
/// (テストで並びを確かめられる)
pub struct Rng(u64);

impl Rng {
    /// 種から作る (0は状態が進まないので別の値へ置き換える)
    pub fn new(seed: u64) -> Rng {
        Rng(if seed == 0 { 0x9e37_79b9_7f4a_7c15 } else { seed })
    }

    /// 次の乱数
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// 0以上 n 未満 (n が0なら0)
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }

    /// 一覧から1つ選ぶ (空なら None)
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            None
        } else {
            Some(&items[self.below(items.len())])
        }
    }

    /// low以上 high以下の整数 (low > high なら low)
    pub fn range(&mut self, low: i64, high: i64) -> i64 {
        if high <= low {
            return low;
        }
        low + (self.next() % ((high - low + 1) as u64)) as i64
    }
}

/// 作る値の種類
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    /// 姓
    LastName,
    /// 名
    FirstName,
    /// 氏名 (姓 + 名)
    FullName,
    /// 氏名カナ
    NameKana,
    /// 会社名
    Company,
    /// 部署名
    Department,
    /// 商品名
    Product,
    /// メールアドレス
    Email,
    /// 固定電話
    Phone,
    /// 携帯電話
    Mobile,
    /// 郵便番号
    PostalCode,
    /// 都道府県
    Prefecture,
    /// 市区町村
    City,
    /// 住所 (都道府県から番地まで)
    Address,
    /// URL
    Url,
    /// 短い語 (状態など)
    Word,
    /// 文章 (備考など)
    Sentence,
    /// 整数
    Integer,
    /// 小数
    Decimal,
    /// 金額 (100円単位の整数)
    Money,
    /// 真偽
    Bool,
    /// 日付
    Date,
    /// 日時
    DateTime,
    /// 時刻
    Time,
    /// UUID
    Uuid,
    /// 連番 (1から)
    Serial,
    /// 常にNULL
    Null,
}

/// 型の大分類 (推測とはみ出し防止に使う)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeClass {
    Text,
    Integer,
    Decimal,
    Bool,
    Date,
    DateTime,
    Time,
    Binary,
    Other,
}

/// 型名から大分類を見分ける (`varchar(100)` のような書き方をそのまま渡せる)
pub fn type_class(col_type: &str) -> TypeClass {
    let t = col_type.to_lowercase();
    let head = t.split(['(', ' ']).next().unwrap_or("").to_string();
    match head.as_str() {
        "bool" | "boolean" => TypeClass::Bool,
        "tinyint" if t.contains("(1)") => TypeClass::Bool,
        "bit" if t.contains("(1)") => TypeClass::Bool,
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "int2" | "int4"
        | "int8" | "serial" | "bigserial" | "smallserial" => TypeClass::Integer,
        "decimal" | "numeric" | "float" | "double" | "real" | "float4" | "float8" | "money" => {
            TypeClass::Decimal
        }
        "date" => TypeClass::Date,
        "datetime" | "timestamp" | "timestamptz" => TypeClass::DateTime,
        "time" | "timetz" => TypeClass::Time,
        "blob" | "bytea" | "binary" | "varbinary" | "longblob" | "mediumblob" | "tinyblob" => {
            TypeClass::Binary
        }
        "char" | "varchar" | "text" | "tinytext" | "mediumtext" | "longtext" | "nvarchar"
        | "nchar" | "bpchar" | "citext" | "uuid" | "json" | "jsonb" | "enum" | "set" => {
            TypeClass::Text
        }
        _ => TypeClass::Other,
    }
}

/// 文字列型の長さ制限 (`varchar(20)` → 20)。取れなければ None
pub fn type_len(col_type: &str) -> Option<usize> {
    let t = col_type.to_lowercase();
    let open = t.find('(')?;
    let close = t[open..].find(')')? + open;
    let inside = &t[open + 1..close];
    // decimal(10,2) のように2つ書けるので、前half だけ見る
    inside.split(',').next()?.trim().parse::<usize>().ok()
}

/// 名前に含まれていたら、その種類とみなす手掛かり。
///
/// 上から順に見て最初に当たったものを使うので、
/// 「氏名カナ」が「氏名」より先に来るように並べてある
const HINTS: &[(&[&str], FieldKind)] = &[
    (&["カナ", "かな", "ｶﾅ", "kana", "furigana", "フリガナ", "ふりがな"], FieldKind::NameKana),
    (&["郵便", "zip", "postal", "post_code", "postcode"], FieldKind::PostalCode),
    (&["都道府県", "県名", "pref"], FieldKind::Prefecture),
    (&["市区町村", "市町村", "city"], FieldKind::City),
    (&["住所", "所在地", "address", "addr"], FieldKind::Address),
    (&["携帯", "mobile", "cell"], FieldKind::Mobile),
    (&["電話", "tel", "phone", "fax"], FieldKind::Phone),
    (&["メール", "mail", "email"], FieldKind::Email),
    (&["url", "サイト", "ホームページ", "link", "リンク"], FieldKind::Url),
    (&["会社", "法人", "取引先", "顧客名", "company", "corp", "client"], FieldKind::Company),
    (&["部署", "部門", "department", "dept"], FieldKind::Department),
    (&["商品", "品名", "product", "item_name"], FieldKind::Product),
    (&["姓", "last_name", "family_name", "surname"], FieldKind::LastName),
    (&["名前", "氏名", "担当者", "name", "full_name"], FieldKind::FullName),
    (&["名", "first_name", "given_name"], FieldKind::FirstName),
    (&["金額", "価格", "単価", "料金", "price", "amount", "cost", "fee", "salary"], FieldKind::Money),
    (&["日時", "時刻", "datetime", "timestamp", "_at"], FieldKind::DateTime),
    (&["日付", "年月日", "date", "_on", "誕生日", "birth"], FieldKind::Date),
    (&["備考", "説明", "内容", "コメント", "note", "remark", "description", "comment", "memo"], FieldKind::Sentence),
    (&["状態", "区分", "種別", "ステータス", "status", "kind", "type", "category"], FieldKind::Word),
    (&["uuid", "guid"], FieldKind::Uuid),
    (&["フラグ", "flag", "flg", "is_", "has_", "有効", "削除済"], FieldKind::Bool),
];

/**
 * カラム名を語に分ける (`updated_user_cd` → ["updated", "user", "cd"])。
 *
 * 英字の手掛かりは語として突き合わせる。
 * 部分一致にすると `updated_user_cd` の中の "date" を拾ってしまい、
 * ユーザーコードの列に日付が入るような外し方をするため
 */
fn name_words(name: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            // camelCase の切れ目でも分ける (createdAt → created, at)
            if prev_lower && ch.is_ascii_uppercase() && !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
            cur.push(ch.to_ascii_lowercase());
        } else {
            prev_lower = false;
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    // 末尾の数字は落とす (address1 → address)
    words
        .into_iter()
        .map(|w| w.trim_end_matches(|c: char| c.is_ascii_digit()).to_string())
        .filter(|w| !w.is_empty())
        .collect()
}

/// 手掛かりの語が当たっているか。
///
/// 英字1語はカラム名の語と丸ごと一致したときだけ当たりとする。
/// 日本語と、`_at` のように区切りを含む書き方は部分一致で見る
fn hits(word: &str, text: &str, words: &[String]) -> bool {
    if word.contains('_') || !word.is_ascii() {
        text.contains(word)
    } else {
        words.iter().any(|w| w == word)
    }
}

/// 型だけで決める既定の種類
fn kind_of_type(class: TypeClass) -> FieldKind {
    match class {
        TypeClass::Integer => FieldKind::Integer,
        TypeClass::Decimal => FieldKind::Decimal,
        TypeClass::Bool => FieldKind::Bool,
        TypeClass::Date => FieldKind::Date,
        TypeClass::DateTime => FieldKind::DateTime,
        TypeClass::Time => FieldKind::Time,
        // 文字列と、見分けられない型は短い語にしておく (どの型にも入れやすい)
        _ => FieldKind::Word,
    }
}

/// 推測した種類が、その型に入れられるか
fn fits(kind: FieldKind, class: TypeClass, col_type: &str) -> bool {
    let text_ok = matches!(class, TypeClass::Text | TypeClass::Other);
    match kind {
        FieldKind::Integer | FieldKind::Money | FieldKind::Serial => {
            matches!(class, TypeClass::Integer | TypeClass::Decimal) || text_ok
        }
        FieldKind::Decimal => matches!(class, TypeClass::Decimal) || text_ok,
        FieldKind::Bool => matches!(class, TypeClass::Bool | TypeClass::Integer) || text_ok,
        FieldKind::Date => matches!(class, TypeClass::Date | TypeClass::DateTime) || text_ok,
        FieldKind::DateTime => matches!(class, TypeClass::DateTime | TypeClass::Date) || text_ok,
        FieldKind::Time => matches!(class, TypeClass::Time) || text_ok,
        FieldKind::Null => true,
        // 残りは文字列。短すぎる桁には入れない (切られるくらいなら短い語にする)
        _ => text_ok && type_len(col_type).is_none_or(|n| n >= min_len(kind)),
    }
}

/// その種類を入れるのに要る、おおよその桁数
fn min_len(kind: FieldKind) -> usize {
    match kind {
        FieldKind::Sentence => 20,
        FieldKind::Address => 20,
        FieldKind::Email | FieldKind::Url | FieldKind::Uuid => 20,
        FieldKind::Company | FieldKind::Product | FieldKind::NameKana => 8,
        FieldKind::Phone | FieldKind::Mobile => 12,
        FieldKind::PostalCode => 8,
        _ => 4,
    }
}

/// カラムの中身の種類を推測する。
///
/// 手掛かりは「論理名 (日本語コメント) → カラム名」の順に見て、
/// 当たった種類がその型に入らなければ型から決め直す
pub fn guess_kind(name: &str, logical: &str, col_type: &str) -> FieldKind {
    let class = type_class(col_type);
    let lname = name.to_lowercase();
    let llogical = logical.to_lowercase();
    let name_parts = name_words(name);
    let logical_parts = name_words(logical);
    for (words, kind) in HINTS {
        let hit = words.iter().any(|w| {
            hits(w, &llogical, &logical_parts) || hits(w, &lname, &name_parts)
        });
        if hit && fits(*kind, class, col_type) {
            return *kind;
        }
    }
    kind_of_type(class)
}

/// 生成のときに種類ごとに要る補足
#[derive(Debug, Clone, Copy)]
pub struct GenContext {
    /// 何行目か (連番と、重複を避ける番号に使う)
    pub row: usize,
    /// 同じ値を作ってはいけない列か (主キー・ユニーク)
    pub unique: bool,
    /// 文字列型の長さ制限
    pub max_len: Option<usize>,
    /// 小数の桁数 (decimal(10,2) の 2)
    pub scale: u32,
}

/// 姓名を1組作る (漢字, カナ)
fn person(rng: &mut Rng) -> ((&'static str, &'static str), (&'static str, &'static str)) {
    let last = *rng.pick(japanese::LAST_NAMES).expect("姓の一覧は空ではない");
    let first = *rng.pick(japanese::FIRST_NAMES).expect("名の一覧は空ではない");
    (last, first)
}

/// 種類に沿った値を1つ作る
pub fn gen_value(kind: FieldKind, rng: &mut Rng, ctx: GenContext) -> Option<String> {
    let value = match kind {
        FieldKind::Null => return None,
        FieldKind::LastName => person(rng).0 .0.to_string(),
        FieldKind::FirstName => person(rng).1 .0.to_string(),
        FieldKind::FullName => {
            let (last, first) = person(rng);
            format!("{} {}", last.0, first.0)
        }
        FieldKind::NameKana => {
            let (last, first) = person(rng);
            format!("{} {}", last.1, first.1)
        }
        FieldKind::Company => format!(
            "{}{}{}",
            rng.pick(japanese::COMPANY_SUFFIX).unwrap(),
            rng.pick(japanese::COMPANY_HEADS).unwrap(),
            rng.pick(japanese::COMPANY_KINDS).unwrap()
        ),
        FieldKind::Department => rng.pick(japanese::DEPARTMENTS).unwrap().to_string(),
        FieldKind::Product => format!(
            "{}{}",
            rng.pick(japanese::PRODUCT_HEADS).unwrap(),
            rng.pick(japanese::PRODUCT_KINDS).unwrap()
        ),
        FieldKind::Email => format!(
            "{}{}@{}",
            rng.pick(japanese::EMAIL_LOCALS).unwrap(),
            ctx.row + 1,
            rng.pick(japanese::EMAIL_DOMAINS).unwrap()
        ),
        // 電話番号は総務省が案内している「使われない番号」の形にする
        FieldKind::Phone => format!("0{}-{:04}-{:04}", rng.range(1, 9), rng.below(10000), rng.below(10000)),
        FieldKind::Mobile => format!("090-{:04}-{:04}", rng.below(10000), rng.below(10000)),
        FieldKind::PostalCode => {
            let (_, head) = rng.pick(japanese::PREFECTURES).unwrap();
            format!("{head}-{:04}", rng.below(10000))
        }
        FieldKind::Prefecture => rng.pick(japanese::PREFECTURES).unwrap().0.to_string(),
        FieldKind::City => rng.pick(japanese::CITIES).unwrap().to_string(),
        FieldKind::Address => format!(
            "{}{}{}{}-{}-{}",
            rng.pick(japanese::PREFECTURES).unwrap().0,
            rng.pick(japanese::CITIES).unwrap(),
            rng.pick(japanese::TOWNS).unwrap(),
            rng.range(1, 9),
            rng.range(1, 30),
            rng.range(1, 30)
        ),
        FieldKind::Url => format!(
            "https://{}/{}",
            rng.pick(japanese::EMAIL_DOMAINS).unwrap(),
            rng.pick(japanese::EMAIL_LOCALS).unwrap()
        ),
        FieldKind::Word => rng.pick(japanese::WORDS).unwrap().to_string(),
        FieldKind::Sentence => rng.pick(japanese::SENTENCES).unwrap().to_string(),
        FieldKind::Integer => rng.range(1, 9999).to_string(),
        FieldKind::Decimal => {
            let scale = ctx.scale.clamp(1, 6);
            let unit = 10i64.pow(scale);
            let v = rng.range(1, 9999 * unit);
            format!(
                "{}.{:0width$}",
                v / unit,
                v % unit,
                width = scale as usize
            )
        }
        FieldKind::Money => (rng.range(1, 2000) * 100).to_string(),
        FieldKind::Bool => if rng.below(2) == 0 { "0" } else { "1" }.to_string(),
        FieldKind::Date => date_string(rng),
        FieldKind::DateTime => format!(
            "{} {:02}:{:02}:{:02}",
            date_string(rng),
            rng.below(24),
            rng.below(60),
            rng.below(60)
        ),
        FieldKind::Time => format!(
            "{:02}:{:02}:{:02}",
            rng.below(24),
            rng.below(60),
            rng.below(60)
        ),
        FieldKind::Uuid => uuid::Uuid::new_v4().to_string(),
        FieldKind::Serial => (ctx.row + 1).to_string(),
    };
    Some(unique_fit(value, kind, ctx))
}

/// ここ2年ぶんの日付 (YYYY-MM-DD)
fn date_string(rng: &mut Rng) -> String {
    let year = 2024 + rng.below(2) as i64;
    let month = rng.range(1, 12);
    // 月末の違いを気にしなくて済むよう28日までにする
    let day = rng.range(1, 28);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 重複を避け、桁に収める。
///
/// ユニーク制約のある列は、そのままだと同じ値がぶつかって
/// 取り込み全体が失敗するので、末尾に行番号を足して分ける
fn unique_fit(value: String, kind: FieldKind, ctx: GenContext) -> String {
    let numeric = matches!(
        kind,
        FieldKind::Integer | FieldKind::Money | FieldKind::Decimal | FieldKind::Serial
    );
    let mut out = if !ctx.unique || matches!(kind, FieldKind::Uuid | FieldKind::Serial) {
        value
    } else if numeric {
        // 数値は桁を足せないので、行番号そのものにする (必ず重ならない)
        (ctx.row + 1).to_string()
    } else if matches!(kind, FieldKind::Email) {
        // メールはローカル部に既に番号が入っている
        value
    } else {
        format!("{value}{}", ctx.row + 1)
    };
    if let Some(max) = ctx.max_len {
        if out.chars().count() > max {
            out = out.chars().take(max).collect();
        }
    }
    out
}

#[cfg(test)]
mod tests;
