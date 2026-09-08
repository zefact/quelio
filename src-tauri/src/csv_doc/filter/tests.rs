use super::*;

/// 名前・数・区分の3列
fn rows() -> Vec<Vec<String>> {
    let data = [
        ["Apple", "100", "赤"],
        ["banana", "20", "黄"],
        ["cherry", "300", "赤"],
        ["date", "", "黄"],
        ["Apple", "40", "青"],
    ];
    data.iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect()
}

fn by_values(col: usize, picked: &[&str]) -> ColumnFilter {
    ColumnFilter {
        col,
        values: Some(picked.iter().map(|s| s.to_string()).collect()),
        rules: Vec::new(),
        all: true,
    }
}

fn by_rule(col: usize, kind: Kind, value: &str) -> ColumnFilter {
    ColumnFilter {
        col,
        values: None,
        rules: vec![Rule {
            kind,
            value: value.to_string(),
        }],
        all: true,
    }
}

// ---------- 条件 ----------

#[test]
fn 含むは英字の大小を区別しない() {
    assert!(hits(
        "Apple",
        &Rule {
            kind: Kind::Contains,
            value: "app".into()
        }
    ));
    assert!(!hits(
        "banana",
        &Rule {
            kind: Kind::Contains,
            value: "app".into()
        }
    ));
}

#[test]
fn 数として読めるものは数として比べる() {
    let ge = Rule {
        kind: Kind::Ge,
        value: "100".into(),
    };
    assert!(hits("300", &ge));
    // 文字として比べると "20" は "100" より後ろになってしまう
    assert!(!hits("20", &ge));
}

#[test]
fn 数として読めないものは文字として比べる() {
    let lt = Rule {
        kind: Kind::Lt,
        value: "banana".into(),
    };
    assert!(hits("Apple", &lt));
    assert!(!hits("cherry", &lt));
}

#[test]
fn 空白だけのセルも空とみなす() {
    let empty = Rule {
        kind: Kind::Empty,
        value: String::new(),
    };
    assert!(hits("   ", &empty));
    assert!(!hits("a", &empty));
}

// ---------- 絞り込み ----------

#[test]
fn 絞り込みが無ければ全行そのまま() {
    assert_eq!(apply(&rows(), &[]), None);
    // 中身の無い絞り込みも同じ扱いにする
    let blank = ColumnFilter {
        col: 0,
        values: None,
        rules: Vec::new(),
        all: true,
    };
    assert_eq!(apply(&rows(), &[blank]), None);
}

#[test]
fn 選んだ値の行だけが残る() {
    let got = apply(&rows(), &[by_values(2, &["赤"])]);
    assert_eq!(got, Some(vec![0, 2]));
}

#[test]
fn 値を1つも選ばなければ何も残らない() {
    let got = apply(&rows(), &[by_values(2, &[])]);
    assert_eq!(got, Some(Vec::new()));
}

#[test]
fn 条件で絞れる() {
    let got = apply(&rows(), &[by_rule(1, Kind::Ge, "100")]);
    assert_eq!(got, Some(vec![0, 2]));
}

#[test]
fn 列をまたぐと両方を満たす行だけが残る() {
    let got = apply(&rows(), &[by_values(2, &["赤"]), by_rule(1, Kind::Ge, "300")]);
    assert_eq!(got, Some(vec![2]));
}

#[test]
fn 同じ列の条件はかつでもまたはでも指定できる() {
    let both = ColumnFilter {
        col: 0,
        values: None,
        rules: vec![
            Rule {
                kind: Kind::Contains,
                value: "a".into(),
            },
            Rule {
                kind: Kind::EndsWith,
                value: "e".into(),
            },
        ],
        all: true,
    };
    // かつ: a を含み、かつ e で終わる
    assert_eq!(apply(&rows(), &[both.clone()]), Some(vec![0, 3, 4]));
    let either = ColumnFilter { all: false, ..both };
    // または: a を含むだけの banana も入る (どちらでもない cherry は残らない)
    assert_eq!(apply(&rows(), &[either]), Some(vec![0, 1, 3, 4]));
}

#[test]
fn 値と条件は同じ列で重ねられる() {
    let mut f = by_values(0, &["Apple"]);
    f.rules = vec![Rule {
        kind: Kind::Contains,
        value: "app".into(),
    }];
    assert_eq!(apply(&rows(), &[f]), Some(vec![0, 4]));
}

#[test]
fn 列が足りない行は空として扱う() {
    let short = vec![vec!["x".to_string()]];
    let got = apply(
        &short,
        &[ColumnFilter {
            col: 2,
            values: None,
            rules: vec![Rule {
                kind: Kind::Empty,
                value: String::new(),
            }],
            all: true,
        }],
    );
    assert_eq!(got, Some(vec![0]));
}

// ---------- 値の一覧 ----------

#[test]
fn 値の一覧は重複をまとめて数える() {
    let got = values(&rows(), &[], 0);
    let names: Vec<&str> = got.values.iter().map(|v| v.text.as_str()).collect();
    assert_eq!(names, vec!["Apple", "banana", "cherry", "date"]);
    assert_eq!(got.values[0].count, 2);
    assert!(!got.truncated);
}

#[test]
fn 値の一覧は数を先に小さい順で並べる() {
    let got = values(&rows(), &[], 1);
    let texts: Vec<&str> = got.values.iter().map(|v| v.text.as_str()).collect();
    assert_eq!(texts, vec!["20", "40", "100", "300", ""]);
}

#[test]
fn 値の一覧は他の列の絞り込みを掛けたあとで数える() {
    let got = values(&rows(), &[by_values(2, &["赤"])], 0);
    let texts: Vec<&str> = got.values.iter().map(|v| v.text.as_str()).collect();
    assert_eq!(texts, vec!["Apple", "cherry"]);
}

#[test]
fn 値の一覧は自分の列の絞り込みでは減らさない() {
    // 「Apple だけ」に絞っていても、選び直せるよう他の値も出す
    let got = values(&rows(), &[by_values(0, &["Apple"])], 0);
    assert_eq!(got.values.len(), 4);
}
