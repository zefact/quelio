use super::*;

fn cols(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn rows(v: &[&[&str]]) -> Vec<Vec<String>> {
    v.iter().map(|r| cols(r)).collect()
}

fn by_key(key: &[&str]) -> DiffOptions {
    DiffOptions {
        mode: DiffMode::Key,
        key: cols(key),
        ..Default::default()
    }
}

// ---------- 列の対応付け ----------

#[test]
fn 同じ名前の列どうしを対応させる() {
    let p = pair_columns(&cols(&["id", "name"]), &cols(&["name", "id"]));
    assert_eq!(p[0].left, Some(0));
    assert_eq!(p[0].right, Some(1));
    assert_eq!(p[1].left, Some(1));
    assert_eq!(p[1].right, Some(0));
}

#[test]
fn 片側にしか無い列は反対側が空になる() {
    let p = pair_columns(&cols(&["id", "old"]), &cols(&["id", "new"]));
    assert_eq!(p.len(), 3);
    assert_eq!(p[1].name, "old");
    assert_eq!(p[1].right, None);
    assert_eq!(p[2].name, "new");
    assert_eq!(p[2].left, None);
}

// ---------- キーでの突き合わせ ----------

#[test]
fn 変わった行と増えた行と消えた行を分ける() {
    let c = cols(&["id", "name", "price"]);
    let l = rows(&[
        &["1", "りんご", "100"],
        &["2", "みかん", "200"],
        &["3", "ぶどう", "300"],
    ]);
    let r = rows(&[
        &["1", "りんご", "100"],
        &["2", "みかん", "250"],
        &["4", "もも", "400"],
    ]);
    let d = compare(&c, &l, &c, &r, &by_key(&["id"])).unwrap();

    assert_eq!(d.summary.same, 1);
    assert_eq!(d.summary.changed, 1);
    assert_eq!(d.summary.only_left, 1);
    assert_eq!(d.summary.only_right, 1);

    assert_eq!(d.rows[0].status, RowStatus::Same);
    assert_eq!(d.rows[1].status, RowStatus::Changed);
    // 違ったのは price (3列目)
    assert_eq!(d.rows[1].changed, vec![2]);
    assert_eq!(d.rows[2].status, RowStatus::OnlyLeft);
    assert_eq!(d.rows[3].status, RowStatus::OnlyRight);
    assert_eq!(d.rows[3].left, None);
    assert_eq!(d.rows[3].right, Some(2));
}

#[test]
fn 並び順が違っても対応が付く() {
    let c = cols(&["id", "v"]);
    let l = rows(&[&["1", "a"], &["2", "b"]]);
    let r = rows(&[&["2", "b"], &["1", "a"]]);
    let d = compare(&c, &l, &c, &r, &by_key(&["id"])).unwrap();
    assert_eq!(d.summary.same, 2);
    assert_eq!(d.summary.changed, 0);
}

#[test]
fn 複数の列をキーにできる() {
    let c = cols(&["a", "b", "v"]);
    let l = rows(&[&["1", "x", "10"], &["1", "y", "20"]]);
    let r = rows(&[&["1", "y", "99"], &["1", "x", "10"]]);
    let d = compare(&c, &l, &c, &r, &by_key(&["a", "b"])).unwrap();
    assert_eq!(d.summary.same, 1);
    assert_eq!(d.summary.changed, 1);
    assert_eq!(d.rows[1].changed, vec![2]);
}

#[test]
fn 区切りを含む値でもキーを取り違えない() {
    let c = cols(&["a", "b", "v"]);
    // 「"1␟2" と "3"」と「"1" と "2␟3"」を同じキーにしない
    let l = rows(&[&["1\u{1f}2", "3", "x"]]);
    let r = rows(&[&["1", "2\u{1f}3", "y"]]);
    let d = compare(&c, &l, &c, &r, &by_key(&["a", "b"])).unwrap();
    assert_eq!(d.summary.only_left, 1);
    assert_eq!(d.summary.only_right, 1);
}

#[test]
fn キーの列が無ければエラーにする() {
    let c = cols(&["a"]);
    let l = rows(&[&["1"]]);
    assert!(compare(&c, &l, &c, &l, &by_key(&["missing"])).is_err());
    // キーを選んでいないときも、黙って全件一致にしない
    let none = DiffOptions {
        mode: DiffMode::Key,
        ..Default::default()
    };
    assert!(compare(&c, &l, &c, &l, &none).is_err());
}

#[test]
fn キーが重複していたら数える() {
    let c = cols(&["id", "v"]);
    let l = rows(&[&["1", "a"], &["1", "b"]]);
    let r = rows(&[&["1", "a"], &["1", "b"]]);
    let d = compare(&c, &l, &c, &r, &by_key(&["id"])).unwrap();
    assert!(d.duplicate_keys > 0);
    // 重複していても、出てきた順に1対1で対応させる
    assert_eq!(d.summary.same, 2);
}

// ---------- 比べ方のゆるめ方 ----------

#[test]
fn 前後の空白と大小を無視できる() {
    let c = cols(&["id", "v"]);
    let l = rows(&[&["1", " Apple "]]);
    let r = rows(&[&["1", "apple"]]);

    let strict = compare(&c, &l, &c, &r, &by_key(&["id"])).unwrap();
    assert_eq!(strict.summary.changed, 1);

    let loose = DiffOptions {
        mode: DiffMode::Key,
        key: cols(&["id"]),
        trim: true,
        ignore_case: true,
    };
    let d = compare(&c, &l, &c, &r, &loose).unwrap();
    assert_eq!(d.summary.same, 1);
}

// ---------- 集合モード ----------

#[test]
fn 集合モードは行まるごとで見る() {
    let c = cols(&["a", "b"]);
    let l = rows(&[&["1", "x"], &["2", "y"]]);
    let r = rows(&[&["2", "y"], &["3", "z"]]);
    let set = DiffOptions {
        mode: DiffMode::Set,
        ..Default::default()
    };
    let d = compare(&c, &l, &c, &r, &set).unwrap();
    assert_eq!(d.summary.same, 1);
    assert_eq!(d.summary.only_left, 1);
    assert_eq!(d.summary.only_right, 1);
    // 集合モードでは「変わった行」は出ない
    assert_eq!(d.summary.changed, 0);
}

// ---------- 列がずれている場合 ----------

#[test]
fn 片側にしか無い列は違いとして数えない() {
    let lc = cols(&["id", "v", "left_only"]);
    let rc = cols(&["id", "v"]);
    let l = rows(&[&["1", "a", "残る"]]);
    let r = rows(&[&["1", "a"]]);
    let d = compare(&lc, &l, &rc, &r, &by_key(&["id"])).unwrap();
    assert!(d.column_mismatch);
    assert_eq!(d.summary.same, 1);
}

// ---------- キーの推測 ----------

#[test]
fn キーらしい列を選ぶ() {
    let c = cols(&["name", "user_id", "memo"]);
    let r = rows(&[&["山田", "1", "a"], &["佐藤", "2", "b"]]);
    assert_eq!(guess_key(&c, &r, &c), cols(&["user_id"]));
}

#[test]
fn 重複する列はキーにしない() {
    let c = cols(&["id", "v"]);
    // id が重複しているので選ばない
    let r = rows(&[&["1", "a"], &["1", "b"]]);
    assert_eq!(guess_key(&c, &r, &c), cols(&["v"]));
}

#[test]
fn 対応する列が無ければ諦める() {
    let l = cols(&["a"]);
    let r = cols(&["b"]);
    assert!(guess_key(&l, &rows(&[&["1"]]), &r).is_empty());
}

// ---------- 空の表 ----------

#[test]
fn 空の表どうしでも壊れない() {
    let c = cols(&["id"]);
    let d = compare(&c, &[], &c, &[], &by_key(&["id"])).unwrap();
    assert!(d.rows.is_empty());
    assert_eq!(d.summary.same, 0);
}
