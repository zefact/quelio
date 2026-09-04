use super::edit::{CellEdit, Edit};
use super::format::{Newline, Quoting};
use super::*;

/// テスト用にUTF-8のCSVを開く
fn open(text: &str) -> CsvDoc {
    CsvDoc::from_bytes("t.csv", text.as_bytes(), None).unwrap()
}

/// 開いて、何も直さずに保存したバイト列
fn round_trip(bytes: &[u8]) -> Vec<u8> {
    let doc = CsvDoc::from_bytes("t.csv", bytes, None).unwrap();
    doc.to_bytes().unwrap()
}

// ---------- 形の見分け ----------

#[test]
fn utf8とshift_jisを見分ける() {
    let utf8 = "名前,住所\n山田,東京\n";
    let doc = open(utf8);
    assert_eq!(doc.format.encoding, "UTF-8");
    assert!(!doc.format.bom);

    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode(utf8);
    let doc = CsvDoc::from_bytes("t.csv", &sjis, None).unwrap();
    assert_eq!(doc.format.encoding, "Shift_JIS");
    assert_eq!(doc.header, vec!["名前", "住所"]);
    assert_eq!(doc.rows[0], vec!["山田", "東京"]);
}

#[test]
fn bomを見分けて覚えておく() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("a,b\n1,2\n".as_bytes());
    let doc = CsvDoc::from_bytes("t.csv", &bytes, None).unwrap();
    assert_eq!(doc.format.encoding, "UTF-8");
    assert!(doc.format.bom);
    // BOMは値に混ざらない
    assert_eq!(doc.header, vec!["a", "b"]);
}

#[test]
fn 改行コードを見分ける() {
    assert_eq!(open("a,b\n1,2\n").format.newline, Newline::Lf);
    assert_eq!(open("a,b\r\n1,2\r\n").format.newline, Newline::Crlf);
}

#[test]
fn 区切り文字を見分ける() {
    assert_eq!(open("a,b\n1,2\n").format.delimiter, ',');
    assert_eq!(open("a\tb\n1\t2\n").format.delimiter, '\t');
    assert_eq!(open("a;b;c\n1;2;3\n").format.delimiter, ';');
    assert_eq!(open("a|b|c\n1|2|3\n").format.delimiter, '|');
}

#[test]
fn 全部引用符付きのファイルを見分ける() {
    assert_eq!(open("\"a\",\"b\"\n\"1\",\"2\"\n").format.quoting, Quoting::Always);
    assert_eq!(open("a,b\n1,2\n").format.quoting, Quoting::Necessary);
    // 一部だけ引用符が付いているものは「必要なときだけ」にする
    assert_eq!(open("\"a\",b\n1,2\n").format.quoting, Quoting::Necessary);
}

// ---------- 開いて保存しても壊れない ----------

#[test]
fn 何も直さずに保存するとバイトが変わらない() {
    for text in [
        "a,b\n1,2\n",
        "a,b\r\n1,2\r\n",
        "\"a\",\"b\"\n\"1\",\"2\"\n",
        "名前,住所\n山田,東京\n",
        "a\tb\n1\t2\n",
    ] {
        assert_eq!(
            round_trip(text.as_bytes()),
            text.as_bytes(),
            "壊れた: {text:?}"
        );
    }
}

#[test]
fn shift_jisのまま保存し直せる() {
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("名前,住所\r\n山田,東京\r\n");
    assert_eq!(round_trip(&sjis), sjis.to_vec());
}

#[test]
fn bomは付けたまま保存する() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("a,b\n1,2\n".as_bytes());
    assert_eq!(round_trip(&bytes), bytes);
}

#[test]
fn 引用符や改行を含むセルが往復で壊れない() {
    let text = "a,b\n\"x,y\",\"1\n2\"\n\"he said \"\"hi\"\"\",z\n";
    let doc = open(text);
    assert_eq!(doc.rows[0][0], "x,y");
    assert_eq!(doc.rows[0][1], "1\n2");
    assert_eq!(doc.rows[1][0], "he said \"hi\"");
    assert_eq!(round_trip(text.as_bytes()), text.as_bytes());
}

#[test]
fn 前ゼロや日付風の文字はそのまま残る() {
    let text = "code,day,num\n00123,2026-09-03,1.50\n";
    let doc = open(text);
    assert_eq!(doc.rows[0], vec!["00123", "2026-09-03", "1.50"]);
    assert_eq!(round_trip(text.as_bytes()), text.as_bytes());
}

#[test]
fn 表せない文字はエラーにして黙って化けさせない() {
    let mut doc = open("a\n1\n");
    doc.format.encoding = "Shift_JIS".to_string();
    doc.rows[0][0] = "🙂".to_string();
    assert!(doc.to_bytes().is_err());
}

// ---------- 列数が揃っていないファイル ----------

#[test]
fn 列数が違う行は空欄で埋めて印を付ける() {
    let doc = open("a,b,c\n1,2\n3,4,5,6\n");
    assert!(doc.ragged);
    assert_eq!(doc.header.len(), 4);
    assert_eq!(doc.rows[0], vec!["1", "2", "", ""]);
    assert_eq!(doc.rows[1], vec!["3", "4", "5", "6"]);
}

// ---------- 編集と取り消し ----------

#[test]
fn セルを直して取り消せる() {
    let mut doc = open("a,b\n1,2\n");
    doc.apply(Edit::Cells(vec![CellEdit {
        row: 0,
        col: 1,
        before: "2".into(),
        after: "9".into(),
    }]))
    .unwrap();
    assert_eq!(doc.rows[0][1], "9");
    assert!(doc.dirty);

    assert_eq!(doc.undo().unwrap().as_deref(), Some("セルの編集"));
    assert_eq!(doc.rows[0][1], "2");
    assert_eq!(doc.redo().unwrap().as_deref(), Some("セルの編集"));
    assert_eq!(doc.rows[0][1], "9");
}

#[test]
fn 取り消すものが無ければ何も起きない() {
    let mut doc = open("a\n1\n");
    assert_eq!(doc.undo().unwrap(), None);
    assert_eq!(doc.redo().unwrap(), None);
    assert!(!doc.dirty);
}

#[test]
fn 行の追加と削除を往復できる() {
    let mut doc = open("a,b\n1,2\n3,4\n");
    let e = doc.sheet().insert_rows(1, 2).unwrap();
    doc.apply(e).unwrap();
    assert_eq!(doc.rows.len(), 4);
    assert_eq!(doc.rows[1], vec!["", ""]);

    doc.undo().unwrap();
    assert_eq!(doc.rows.len(), 2);
    assert_eq!(doc.rows[1], vec!["3", "4"]);

    let e = doc.sheet().delete_rows(0, 1).unwrap();
    doc.apply(e).unwrap();
    assert_eq!(doc.rows, vec![vec!["3", "4"]]);
    doc.undo().unwrap();
    assert_eq!(doc.rows[0], vec!["1", "2"]);
}

#[test]
fn 列の追加削除改名を往復できる() {
    let mut doc = open("a,b\n1,2\n");
    let e = doc.sheet().insert_col(1, "new").unwrap();
    doc.apply(e).unwrap();
    assert_eq!(doc.header, vec!["a", "new", "b"]);
    assert_eq!(doc.rows[0], vec!["1", "", "2"]);

    let e = doc.sheet().rename_col(1, "changed").unwrap();
    doc.apply(e).unwrap();
    assert_eq!(doc.header[1], "changed");
    doc.undo().unwrap();
    assert_eq!(doc.header[1], "new");

    let e = doc.sheet().delete_col(0).unwrap();
    doc.apply(e).unwrap();
    assert_eq!(doc.header, vec!["new", "b"]);
    assert_eq!(doc.rows[0], vec!["", "2"]);
    // 消した列は中身ごと戻る
    doc.undo().unwrap();
    assert_eq!(doc.header, vec!["a", "new", "b"]);
    assert_eq!(doc.rows[0], vec!["1", "", "2"]);
}

#[test]
fn 最後の1列は消せない() {
    let mut doc = open("a\n1\n");
    let e = doc.sheet().delete_col(0).unwrap();
    assert!(doc.apply(e).is_err());
    assert_eq!(doc.header, vec!["a"]);
}

#[test]
fn 範囲の外を指す操作は状態を変えない() {
    let mut doc = open("a,b\n1,2\n");
    let before = doc.rows.clone();
    assert!(doc
        .apply(Edit::Cells(vec![CellEdit {
            row: 9,
            col: 0,
            before: String::new(),
            after: "x".into(),
        }]))
        .is_err());
    assert_eq!(doc.rows, before);
    assert!(!doc.dirty);
    assert!(doc.sheet().delete_rows(0, 5).is_err());
    assert!(doc.sheet().delete_col(9).is_err());
}

#[test]
fn 新しく編集するとやり直しの先は消える() {
    let mut doc = open("a\n1\n2\n");
    let cell = |after: &str| {
        Edit::Cells(vec![CellEdit {
            row: 0,
            col: 0,
            before: "1".into(),
            after: after.into(),
        }])
    };
    doc.apply(cell("x")).unwrap();
    doc.undo().unwrap();
    doc.apply(cell("y")).unwrap();
    assert_eq!(doc.redo().unwrap(), None);
    assert_eq!(doc.rows[0][0], "y");
}

#[test]
fn 取り消しの履歴には上限がある() {
    let mut doc = open("a\n1\n");
    for i in 0..(UNDO_LIMIT + 10) {
        doc.apply(Edit::Cells(vec![CellEdit {
            row: 0,
            col: 0,
            before: i.to_string(),
            after: (i + 1).to_string(),
        }]))
        .unwrap();
    }
    assert_eq!(doc.undo.len(), UNDO_LIMIT);
}

// ---------- ヘッダの扱い ----------

#[test]
fn ヘッダとして扱うかを切り替えられる() {
    let mut doc = open("a,b\n1,2\n");
    assert_eq!(doc.columns(), vec!["a", "b"]);

    doc.set_has_header(false);
    assert_eq!(doc.columns(), vec!["1", "2"]);
    assert_eq!(doc.rows.len(), 2);
    assert_eq!(doc.rows[0], vec!["a", "b"]);

    doc.set_has_header(true);
    assert_eq!(doc.columns(), vec!["a", "b"]);
    assert_eq!(doc.rows.len(), 1);
}

#[test]
fn ヘッダ無しで保存すると1行目も本文として書かれる() {
    let mut doc = open("a,b\n1,2\n");
    doc.set_has_header(false);
    assert_eq!(doc.to_bytes().unwrap(), "a,b\n1,2\n".as_bytes());
}

// ---------- ページ取得 ----------

#[test]
fn ページは範囲の外でも壊れない() {
    let doc = open("a\n1\n2\n3\n");
    let p = doc.page(1, 2);
    assert_eq!(p.rows, vec![vec!["2"], vec!["3"]]);
    assert_eq!(p.total, 3);
    assert!(doc.page(99, 10).rows.is_empty());
    // 上限を大きく取っても最後で止まる
    assert_eq!(doc.page(0, usize::MAX).rows.len(), 3);
}

// ---------- 空のファイル ----------

#[test]
fn 空のファイルでも開ける() {
    let doc = open("");
    assert_eq!(doc.header, vec!["1"]);
    assert!(doc.rows.is_empty());
}

// ---------- クエリ結果から作る ----------

#[test]
fn 結果から作ると未保存の表になる() {
    let doc = CsvDoc::from_rows(
        "結果.csv",
        vec!["id".into(), "name".into()],
        vec![vec!["1".into(), "山田".into()]],
    );
    assert!(doc.dirty);
    assert!(doc.path.is_none());
    assert_eq!(doc.to_bytes().unwrap(), "id,name\n1,山田\n".as_bytes());
}

// ---------- 固定長 ----------

/// 固定長として開く (幅も詰め方も推測する)
fn open_fixed(text: &str) -> CsvDoc {
    CsvDoc::from_bytes_fixed(
        "t.txt",
        text.as_bytes(),
        None,
        fixed::WidthUnit::Char,
        fixed::Reading::Guess,
    )
    .unwrap()
}

#[test]
fn 固定長は1行目もデータとして扱う() {
    let doc = open_fixed("0001 山田     東京\n0002 佐藤     大阪\n");
    // 見出しの行が無いので、行が減らない
    assert_eq!(doc.rows.len(), 2);
    assert!(!doc.has_header);
    assert_eq!(doc.columns(), vec!["1", "2", "3"]);
}

#[test]
fn 固定長は開いて保存すると元に戻る() {
    let text = "0001 山田     東京\n0002 佐藤     大阪\n";
    let doc = open_fixed(text);
    assert_eq!(doc.to_bytes().unwrap(), text.as_bytes());
}

#[test]
fn 固定長のセルを直すと桁に合わせて埋め直す() {
    let text = "0001 山田     東京\n";
    let mut doc = open_fixed(text);
    doc.apply(Edit::Cells(vec![CellEdit {
        row: 0,
        col: 1,
        before: "山田".into(),
        after: "鈴木".into(),
    }]))
    .unwrap();
    assert_eq!(
        String::from_utf8(doc.to_bytes().unwrap()).unwrap(),
        "0001 鈴木     東京\n"
    );
}

#[test]
fn 固定長で桁からはみ出すと保存できない() {
    let mut doc = open_fixed("0001 山田     東京\n");
    doc.apply(Edit::Cells(vec![CellEdit {
        row: 0,
        col: 2,
        before: "東京".into(),
        after: "神奈川".into(),
    }]))
    .unwrap();
    let err = doc.to_bytes().unwrap_err();
    assert!(err.contains("桁に収まらない"), "{err}");
    assert!(err.contains("1行目の3列目"), "{err}");
}

#[test]
fn 固定長の項目名を列名に使う() {
    let mut layout = fixed::FixedLayout::from_widths(fixed::WidthUnit::Char, &[5, 9, 2]);
    layout.columns[0].name = "コード".into();
    layout.columns[1].name = "氏名".into();
    let doc = CsvDoc::from_bytes_fixed(
        "t.txt",
        "0001 山田     東京\n".as_bytes(),
        None,
        fixed::WidthUnit::Char,
        fixed::Reading::Layout(&layout),
    )
    .unwrap();
    // 名前を付けていない桁は番号のまま
    assert_eq!(doc.columns(), vec!["コード", "氏名", "3"]);
}

#[test]
fn 固定長はshift_jisのバイト数で数えられる() {
    let bytes = encoding_rs::SHIFT_JIS
        .encode("0001山田  東京\n0002佐藤  大阪\n")
        .0
        .into_owned();
    let layout = fixed::FixedLayout::from_widths(fixed::WidthUnit::Byte, &[4, 6, 4]);
    let doc = CsvDoc::from_bytes_fixed(
        "t.txt",
        &bytes,
        Some("Shift_JIS"),
        fixed::WidthUnit::Byte,
        fixed::Reading::Layout(&layout),
    )
    .unwrap();
    assert_eq!(doc.rows[0], vec!["0001", "山田", "東京"]);
    assert_eq!(doc.to_bytes().unwrap(), bytes);
}
