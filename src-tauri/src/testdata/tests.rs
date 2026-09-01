use super::*;

fn ctx(row: usize) -> GenContext {
    GenContext {
        row,
        unique: false,
        max_len: None,
        scale: 2,
    }
}

#[test]
fn 同じ種から同じ並びが出る() {
    let a: Vec<u64> = (0..5).map(|_| Rng::new(7).next()).collect();
    let mut rng = Rng::new(7);
    let b: Vec<u64> = (0..5).map(|_| rng.next()).collect();
    // 種が同じなら1つ目は必ず同じ (テストの結果が揺れない)
    assert_eq!(a[0], b[0]);
    // 進めれば別の値になる
    assert_ne!(b[0], b[1]);
}

#[test]
fn 範囲の中に収まる() {
    let mut rng = Rng::new(1);
    for _ in 0..200 {
        let v = rng.range(3, 5);
        assert!((3..=5).contains(&v), "{v}");
        assert!(rng.below(4) < 4);
    }
    // 上下が逆でも下限を返す (0除算やパニックにしない)
    assert_eq!(rng.range(5, 3), 5);
    assert_eq!(rng.below(0), 0);
}

#[test]
fn 型の大分類を見分ける() {
    assert_eq!(type_class("varchar(100)"), TypeClass::Text);
    assert_eq!(type_class("INT UNSIGNED"), TypeClass::Integer);
    assert_eq!(type_class("bigint"), TypeClass::Integer);
    assert_eq!(type_class("decimal(12,2)"), TypeClass::Decimal);
    assert_eq!(type_class("tinyint(1)"), TypeClass::Bool);
    assert_eq!(type_class("boolean"), TypeClass::Bool);
    assert_eq!(type_class("timestamp with time zone"), TypeClass::DateTime);
    assert_eq!(type_class("date"), TypeClass::Date);
    assert_eq!(type_class("bytea"), TypeClass::Binary);
}

#[test]
fn 文字列の桁を読む() {
    assert_eq!(type_len("varchar(20)"), Some(20));
    assert_eq!(type_len("decimal(10,2)"), Some(10));
    assert_eq!(type_len("text"), None);
}

#[test]
fn 論理名から種類を当てる() {
    assert_eq!(
        guess_kind("col1", "氏名", "varchar(50)"),
        FieldKind::FullName
    );
    assert_eq!(
        guess_kind("col2", "氏名カナ", "varchar(50)"),
        FieldKind::NameKana
    );
    assert_eq!(
        guess_kind("col3", "郵便番号", "varchar(8)"),
        FieldKind::PostalCode
    );
    assert_eq!(guess_kind("col4", "備考", "text"), FieldKind::Sentence);
}

#[test]
fn カラム名からも当てる() {
    assert_eq!(guess_kind("email", "", "varchar(255)"), FieldKind::Email);
    assert_eq!(guess_kind("tel", "", "varchar(20)"), FieldKind::Phone);
    assert_eq!(guess_kind("mobile", "", "varchar(20)"), FieldKind::Mobile);
    assert_eq!(guess_kind("address1", "", "varchar(255)"), FieldKind::Address);
    assert_eq!(guess_kind("created_at", "", "datetime"), FieldKind::DateTime);
    assert_eq!(guess_kind("price", "", "decimal(10,0)"), FieldKind::Money);
}

#[test]
fn 型に入らない推測は型で決め直す() {
    // 「住所」でも桁が足りなければ短い語にする (切られるより収まる方を選ぶ)
    assert_eq!(guess_kind("address", "住所", "varchar(4)"), FieldKind::Word);
    // 名前が name でも数値型なら整数
    assert_eq!(guess_kind("name", "", "int"), FieldKind::Integer);
    // 日付の列に「備考」と書いてあっても日付
    assert_eq!(guess_kind("memo", "備考", "date"), FieldKind::Date);
}

#[test]
fn カラム名は語で突き合わせる() {
    // "updated" の中の "date" を拾わない (ユーザーコードの列)
    assert_eq!(
        guess_kind("updated_user_cd", "", "varchar(10)"),
        FieldKind::Word
    );
    assert_eq!(guess_kind("created_user_cd", "", "varchar(10)"), FieldKind::Word);
    // 区切りを含む手掛かりは今までどおり部分一致で見る
    assert_eq!(guess_kind("created_at", "", "datetime"), FieldKind::DateTime);
    // camelCase も語に分ける
    assert_eq!(guess_kind("birthDate", "", "date"), FieldKind::Date);
    // 末尾の数字は落として見る
    assert_eq!(guess_kind("address2", "", "varchar(255)"), FieldKind::Address);
    // 削除フラグは真偽 (flg の書き方も拾う)
    assert_eq!(guess_kind("del_flg", "", "varchar(1)"), FieldKind::Bool);
}

#[test]
fn 語の分け方() {
    assert_eq!(name_words("updated_user_cd"), ["updated", "user", "cd"]);
    assert_eq!(name_words("createdAt"), ["created", "at"]);
    assert_eq!(name_words("address1"), ["address"]);
    assert_eq!(name_words(""), [] as [String; 0]);
}

#[test]
fn 手掛かりが無ければ型で決める() {
    assert_eq!(guess_kind("c1", "", "int"), FieldKind::Integer);
    assert_eq!(guess_kind("c2", "", "decimal(8,2)"), FieldKind::Decimal);
    assert_eq!(guess_kind("c3", "", "boolean"), FieldKind::Bool);
    assert_eq!(guess_kind("c4", "", "time"), FieldKind::Time);
    assert_eq!(guess_kind("c5", "", "varchar(30)"), FieldKind::Word);
}

#[test]
fn 値の形を確かめる() {
    let mut rng = Rng::new(42);
    for row in 0..50 {
        let mail = gen_value(FieldKind::Email, &mut rng, ctx(row)).unwrap();
        assert!(mail.contains('@'), "{mail}");
        assert!(mail.split('@').nth(1).unwrap().starts_with("example."));

        let zip = gen_value(FieldKind::PostalCode, &mut rng, ctx(row)).unwrap();
        assert_eq!(zip.len(), 8, "{zip}");

        let date = gen_value(FieldKind::Date, &mut rng, ctx(row)).unwrap();
        assert_eq!(date.len(), 10, "{date}");

        let dt = gen_value(FieldKind::DateTime, &mut rng, ctx(row)).unwrap();
        assert_eq!(dt.len(), 19, "{dt}");

        let b = gen_value(FieldKind::Bool, &mut rng, ctx(row)).unwrap();
        assert!(b == "0" || b == "1");

        let money = gen_value(FieldKind::Money, &mut rng, ctx(row)).unwrap();
        assert_eq!(money.parse::<i64>().unwrap() % 100, 0);
    }
}

#[test]
fn 小数は桁数どおりに作る() {
    let mut rng = Rng::new(3);
    let v = gen_value(
        FieldKind::Decimal,
        &mut rng,
        GenContext {
            row: 0,
            unique: false,
            max_len: None,
            scale: 3,
        },
    )
    .unwrap();
    let frac = v.split('.').nth(1).expect("小数点以下がある");
    assert_eq!(frac.len(), 3, "{v}");
}

#[test]
fn nullの種類は値を作らない() {
    let mut rng = Rng::new(1);
    assert!(gen_value(FieldKind::Null, &mut rng, ctx(0)).is_none());
}

#[test]
fn 連番は行番号になる() {
    let mut rng = Rng::new(1);
    assert_eq!(
        gen_value(FieldKind::Serial, &mut rng, ctx(0)).unwrap(),
        "1"
    );
    assert_eq!(
        gen_value(FieldKind::Serial, &mut rng, ctx(41)).unwrap(),
        "42"
    );
}

#[test]
fn ユニークな列は重ならない() {
    let mut rng = Rng::new(5);
    let mut seen = std::collections::HashSet::new();
    for row in 0..300 {
        let c = GenContext {
            row,
            unique: true,
            max_len: None,
            scale: 2,
        };
        // 文字列も数値も、同じ値が2回出てはいけない
        assert!(seen.insert(gen_value(FieldKind::FullName, &mut rng, c).unwrap()));
        assert!(seen.insert(gen_value(FieldKind::Integer, &mut rng, c).unwrap()));
    }
}

#[test]
fn 桁からはみ出さない() {
    let mut rng = Rng::new(9);
    for row in 0..100 {
        let c = GenContext {
            row,
            unique: true,
            max_len: Some(6),
            scale: 2,
        };
        let v = gen_value(FieldKind::Address, &mut rng, c).unwrap();
        assert!(v.chars().count() <= 6, "{v}");
    }
}
