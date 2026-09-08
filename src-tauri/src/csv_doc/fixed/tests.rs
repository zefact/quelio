//! 固定長の読み書きの確かめ。
//!
//! 「開いて保存したら元と同じバイトに戻る」ことを軸に見ている

use super::*;

fn sjis() -> &'static encoding_rs::Encoding {
    encoding_rs::SHIFT_JIS
}

fn utf8() -> &'static encoding_rs::Encoding {
    encoding_rs::UTF_8
}

/// Shift_JISのバイト列を作る
fn to_sjis(text: &str) -> Vec<u8> {
    sjis().encode(text).0.into_owned()
}

#[test]
fn 桁の区切りを空白から見分ける() {
    // 全行で空白になっている位置が切れ目になる
    let text = "0001 山田     東京\n0002 佐藤     大阪\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    let widths: Vec<usize> = got.layout.columns.iter().map(|c| c.width).collect();
    // 区切りの空白は手前の桁に含める (幅の合計を変えないため)
    assert_eq!(widths, vec![5, 7, 2]);
    assert_eq!(got.rows[0], vec!["0001", "山田", "東京"]);
}

#[test]
fn 空白で区切られていない桁は見分けられない() {
    // 隣り合う項目のあいだに空白が無いと、切れ目が見つからず1つになる。
    // 推測はあくまで手掛かりで、違っていれば桁を手で直してもらう
    let text = "0001山田      東京\n0002佐藤      大阪\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    let widths: Vec<usize> = got.layout.columns.iter().map(|c| c.width).collect();
    assert_eq!(widths, vec![12, 2]);
}

#[test]
fn バイトで数えると漢字は2桁ぶん() {
    // 「山田」はShift_JISで4バイト。幅6の桁なら空白2つで埋まる
    let bytes = to_sjis("0001山田  東京\n0002佐藤  大阪\n");
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.rows[0], vec!["0001", "山田", "東京"]);
    assert_eq!(got.rows[1], vec!["0002", "佐藤", "大阪"]);
}

#[test]
fn 文字で数えると漢字も1桁ぶん() {
    let text = "0001山田    東京\n";
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[4, 6, 2]);
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    assert_eq!(got.rows[0], vec!["0001", "山田", "東京"]);
}

#[test]
fn ゼロ埋めの桁は右寄せと見分ける() {
    let text = "0001あ\n0025い\n0300う\n";
    // 区切りの空白が無いので、幅だけ渡して詰め方は見分けてもらう
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Widths(&[4, 1]));
    let code = &got.layout.columns[0];
    assert_eq!(code.align, Align::Right);
    assert_eq!(code.pad, '0');
    // 埋めた0は落として見せる
    assert_eq!(got.rows[0][0], "1");
    assert_eq!(got.rows[2][0], "300");
}

#[test]
fn 右寄せの空白埋めを見分ける() {
    let text = "  1あ\n 25い\n300う\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Widths(&[3, 1]));
    assert_eq!(got.layout.columns[0].align, Align::Right);
    assert_eq!(got.layout.columns[0].pad, ' ');
    assert_eq!(got.rows[0][0], "1");
}

#[test]
fn 左寄せの桁は末尾の空白を落とす() {
    let text = "山田      001\n佐藤太郎    001\n";
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[8, 3]);
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    assert_eq!(got.rows[0][0], "山田");
    assert_eq!(got.rows[1][0], "佐藤太郎");
}

#[test]
fn 触っていない行はそのまま戻る() {
    let text = "0001山田      東京\n0002佐藤      大阪\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    let back = dump(&got.rows, &got.layout, utf8(), "\n", &[], &[], &[]).unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), text);
}

#[test]
fn shift_jisでもそのまま戻る() {
    let bytes = to_sjis("0001山田  東京\n0002佐藤  大阪\n");
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(&got.rows, &got.layout, sjis(), "\n", &[], &[], &[]).unwrap();
    assert_eq!(back, bytes);
}

#[test]
fn crlfのまま戻せる() {
    let text = "ab  12\ncd  34\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    let back = dump(&got.rows, &got.layout, utf8(), "\r\n", &[], &[], &[]).unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "ab  12\r\ncd  34\r\n");
}

#[test]
fn 書き換えた値は桁に合わせて埋め直す() {
    let text = "山田      001\n";
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[8, 3]);
    let mut got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    got.rows[0][0] = "鈴木".into();
    let back = dump(&got.rows, &got.layout, utf8(), "\n", &[], &[], &[]).unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "鈴木      001\n");
}

#[test]
fn ゼロ埋めの桁も埋め直す() {
    let text = "0001あ\n0025い\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Widths(&[4, 1]));
    let mut rows = got.rows.clone();
    rows[0][0] = "7".into();
    let back = dump(&rows, &got.layout, utf8(), "\n", &[], &[], &[]).unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "0007あ\n0025い\n");
}

#[test]
fn 桁からはみ出したら書かずに場所を返す() {
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[4, 3]);
    let rows = vec![
        vec!["ok".to_string(), "123".to_string()],
        vec!["ながすぎる".to_string(), "1".to_string()],
    ];
    let bad = dump(&rows, &layout, utf8(), "\n", &[], &[], &[]).unwrap_err();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].spot, Spot::Row(1));
    assert_eq!(bad[0].col, 0);
    assert_eq!(bad[0].len, 5);
    assert_eq!(bad[0].width, 4);
}

#[test]
fn バイトで数えるとはみ出しもバイトで見る() {
    // Shift_JISの「山田」は4バイトなので、幅3には入らない
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[3]);
    let rows = vec![vec!["山田".to_string()]];
    let bad = dump(&rows, &layout, sjis(), "\n", &[], &[], &[]).unwrap_err();
    assert_eq!(bad[0].len, 4);
}

#[test]
fn 短い行は空欄で埋める() {
    let text = "0001山田      東京\n0002\n";
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[4, 10, 2]);
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    assert_eq!(got.rows[1], vec!["0002", "", ""]);
    assert!(got.ragged);
}

#[test]
fn 空のファイルでも落ちない() {
    let got = load(b"", utf8(), WidthUnit::Char, Reading::Guess);
    assert!(got.rows.is_empty());
    assert!(got.layout.columns.is_empty());
}

#[test]
fn 区切りが見つからなければ1桁にする() {
    let text = "abcd\nefgh\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    assert_eq!(got.layout.columns.len(), 1);
    assert_eq!(got.layout.columns[0].width, 4);
    assert_eq!(got.rows[0], vec!["abcd"]);
}

#[test]
fn 項目名を出せる() {
    let mut layout = FixedLayout::from_widths(WidthUnit::Byte, &[4, 6, 4]);
    layout.columns[0].name = "コード".into();
    assert_eq!(layout.names(), vec!["コード", "", ""]);
}

#[test]
fn 埋め文字を落とさない指定もできる() {
    let text = "山田      001\n";
    let mut layout = FixedLayout::from_widths(WidthUnit::Char, &[8, 3]);
    layout.trim = false;
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    assert_eq!(got.rows[0][0], "山田      ");
}

// ---------- 改行の無いファイル ----------

/// 改行で区切らないレイアウトを作る
fn no_newline(unit: WidthUnit, widths: &[usize]) -> FixedLayout {
    FixedLayout {
        newline: false,
        ..FixedLayout::from_widths(unit, widths)
    }
}

#[test]
fn 改行が無くても桁の合計で行に分ける() {
    // 1行 = 4+6+4 = 14バイト。改行はどこにも入っていない
    let bytes = to_sjis("0001山田  東京0002佐藤  大阪");
    let layout = no_newline(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.rows.len(), 2);
    assert_eq!(got.rows[0], vec!["0001", "山田", "東京"]);
    assert_eq!(got.rows[1], vec!["0002", "佐藤", "大阪"]);
    assert!(!got.ragged, "ちょうど割り切れるので端数は無い");
}

#[test]
fn 改行が無いファイルの末尾に改行が1つあっても余分な行を作らない() {
    // 出力側の都合で最後だけ改行が付くファイルがある
    let bytes = to_sjis("0001山田  東京0002佐藤  大阪\r\n");
    let layout = no_newline(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.rows.len(), 2);
    assert!(!got.ragged);
}

#[test]
fn 改行が無いファイルは長さが合わないと端数として知らせる() {
    // 14バイトで割り切れない (最後が半端)
    let bytes = to_sjis("0001山田  東京0002");
    let layout = no_newline(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.rows.len(), 2);
    assert!(got.ragged, "半端な行があることを知らせる");
}

#[test]
fn 改行が無いファイルも文字数で切れる() {
    // 文字で数えるときは、文字に直してから10文字ずつに切る
    let text = "0001山田    東京0002佐藤    大阪";
    let layout = no_newline(WidthUnit::Char, &[4, 6, 2]);
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    assert_eq!(got.rows.len(), 2);
    assert_eq!(got.rows[0], vec!["0001", "山田", "東京"]);
    assert_eq!(got.rows[1], vec!["0002", "佐藤", "大阪"]);
}

#[test]
fn 改行が無いファイルは書き出しにも改行を入れない() {
    let bytes = to_sjis("0001山田  東京0002佐藤  大阪");
    let layout = no_newline(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(&got.rows, &got.layout, sjis(), "\r\n", &[], &[], &[]).expect("書けること");
    assert_eq!(back, bytes, "開いて保存すると元と同じバイトに戻る");
}

#[test]
fn 改行で区切る指定なら今までどおり改行で分ける() {
    // 同じ桁でも、改行ありのレイアウトなら行の切れ目は改行になる
    let bytes = to_sjis("0001山田  東京\n0002佐藤  大阪\n");
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.rows.len(), 2);
    assert!(got.layout.newline);
}

#[test]
fn 改行の無い指定でも桁が空なら改行で分ける() {
    // 桁の合計が分からないまま長さで切ると、全体が1行になってしまう
    let layout = FixedLayout {
        newline: false,
        ..FixedLayout::from_widths(WidthUnit::Byte, &[])
    };
    let bytes = to_sjis("0001\n0002\n");
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert!(got.rows.is_empty(), "桁が無ければ読み取る中身も無い");
}

// ---------- ヘッダ・トレーラ ----------

#[test]
fn 長さで切る位置を先頭と末尾から取り分ける() {
    // 全体30、ヘッダ8・データ6・トレーラ4 → 8 + 6*3 + 4
    let (h, b, t) = spans(30, 8, 6, 4);
    assert_eq!(h, Some((0, 8)));
    assert_eq!(b, vec![(8, 14), (14, 20), (20, 26)]);
    assert_eq!(t, Some((26, 30)));
}

#[test]
fn ヘッダもトレーラも無ければ先頭から順に切る() {
    let (h, b, t) = spans(10, 0, 5, 0);
    assert_eq!(h, None);
    assert_eq!(t, None);
    assert_eq!(b, vec![(0, 5), (5, 10)]);
}

#[test]
fn 長さが足りなければ取り分けない() {
    // ヘッダ8バイトぶんも無いファイル
    let (h, b, t) = spans(5, 8, 4, 0);
    assert_eq!(h, None);
    assert_eq!(t, None);
    assert_eq!(b, vec![(0, 4), (4, 5)]);
}

#[test]
fn 半端に余ったぶんも最後の1つとして残す() {
    let (_, b, _) = spans(7, 0, 3, 0);
    assert_eq!(b, vec![(0, 3), (3, 6), (6, 7)]);
}

/// ヘッダ・トレーラ付きの、改行の無いレイアウト
fn with_edges(widths: &[usize], head: &[usize], tail: &[usize]) -> FixedLayout {
    FixedLayout {
        newline: false,
        header: head.iter().map(|w| FixedColumn::new(*w)).collect(),
        trailer: tail.iter().map(|w| FixedColumn::new(*w)).collect(),
        ..FixedLayout::from_widths(WidthUnit::Byte, widths)
    }
}

#[test]
fn 改行が無いファイルの先頭と末尾を別の桁で切る() {
    // ヘッダ "H20260907" (9) / データ "0001山田  " (10) ×2 / トレーラ "T002" (4)
    let bytes = to_sjis("H202609070001山田  0002佐藤  T002");
    let layout = with_edges(&[4, 6], &[1, 8], &[1, 3]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.head, vec!["H", "20260907"]);
    assert_eq!(got.rows.len(), 2);
    assert_eq!(got.rows[0], vec!["0001", "山田"]);
    assert_eq!(got.rows[1], vec!["0002", "佐藤"]);
    assert_eq!(got.tail, vec!["T", "002"]);
}

#[test]
fn ヘッダとトレーラを付けても元のバイトに戻る() {
    let bytes = to_sjis("H202609070001山田  0002佐藤  T002");
    let layout = with_edges(&[4, 6], &[1, 8], &[1, 3]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(
        &got.rows,
        &got.layout,
        sjis(),
        "\r\n",
        &got.head,
        &got.tail,
        &[],
    )
    .expect("書けること");
    assert_eq!(back, bytes);
}

#[test]
fn 改行で区切るファイルでも先頭と末尾を別の桁にできる() {
    let bytes = to_sjis("H20260907\n0001山田  \n0002佐藤  \nT002\n");
    let layout = FixedLayout {
        header: vec![FixedColumn::new(1), FixedColumn::new(8)],
        trailer: vec![FixedColumn::new(1), FixedColumn::new(3)],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[4, 6])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.head, vec!["H", "20260907"]);
    assert_eq!(got.tail, vec!["T", "002"]);
    assert_eq!(got.rows.len(), 2, "ヘッダとトレーラはデータ行に混ぜない");
    let back = dump(&got.rows, &got.layout, sjis(), "\n", &got.head, &got.tail, &[])
        .expect("書けること");
    assert_eq!(back, bytes);
}

#[test]
fn ヘッダを決めていなければ1行目もデータとして読む() {
    let bytes = to_sjis("0001山田  0002佐藤  ");
    let layout = with_edges(&[4, 6], &[], &[]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert!(got.head.is_empty());
    assert!(got.tail.is_empty());
    assert_eq!(got.rows.len(), 2);
}

#[test]
fn ヘッダの桁に収まらない値は場所が分かる形で返す() {
    let layout = with_edges(&[4], &[2], &[]);
    let bad = dump(
        &[vec!["0001".to_string()]],
        &layout,
        sjis(),
        "\n",
        &["あいう".to_string()],
        &[],
        &[],
    )
    .unwrap_err();
    assert_eq!(bad[0].spot, Spot::Header);
    assert_eq!(bad[0].spot.label(), "ヘッダ");
}

// ---------- 種別が混ざるファイル ----------

/// 種別を値で見分けるレイアウト (改行なし)
fn keyed(body: &[usize], head: &[usize], at: usize, len: usize, mark: &str) -> FixedLayout {
    FixedLayout {
        newline: false,
        header: head.iter().map(|w| FixedColumn::new(*w)).collect(),
        key: Some(FixedKey {
            at,
            len,
            header: mark.to_string(),
        }),
        ..FixedLayout::from_widths(WidthUnit::Byte, body)
    }
}

#[test]
fn 種別を見ながら長さの違うレコードに切る() {
    // 種別1は6、種別なし (ボディ) は4。並びは H B B H B
    let marks = "HBBHB";
    let got = spans_by_kind(
        6 + 4 + 4 + 6 + 4,
        |at| {
            // 位置から何番目のレコードかを数え直す (試すためだけの単純な作り)
            let mut i = 0;
            let mut p = 0;
            while p < at {
                p += if marks.as_bytes()[i] == b'H' { 6 } else { 4 };
                i += 1;
            }
            if marks.as_bytes()[i] == b'H' {
                1
            } else {
                0
            }
        },
        |kind| if kind == 1 { 6 } else { 4 },
    );
    assert_eq!(
        got,
        vec![(0, 6, 1), (6, 10, 0), (10, 14, 0), (14, 20, 1), (20, 24, 0)]
    );
}

#[test]
fn 桁が決まっていなければ切る位置を出さない() {
    // 長さ0の種別で止まる (先へ進めないため)
    assert!(spans_by_kind(10, |_| 0, |_| 0).is_empty());
    assert!(spans_by_kind(10, |_| 1, |k| if k == 1 { 0 } else { 4 }).is_empty());
}

#[test]
fn ヘッダ行とボディ行が交互に来るファイルを読む() {
    // ヘッダ "A" + 伝票番号8 = 9バイト / ボディ "B" + 商品4 + 数量3 = 8バイト
    let bytes = to_sjis("A20260001B0001010B0002020A20260002B0003005");
    let layout = keyed(&[1, 4, 3], &[1, 8], 0, 1, "A");
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 0, 0, 1, 0]);
    assert_eq!(got.rows[0], vec!["A", "20260001", ""], "ヘッダ行は空欄で埋める");
    assert_eq!(got.rows[1], vec!["B", "0001", "010"]);
    assert_eq!(got.rows[2], vec!["B", "0002", "020"]);
    assert_eq!(got.rows[3], vec!["A", "20260002", ""]);
    assert_eq!(got.rows[4], vec!["B", "0003", "005"]);
}

#[test]
fn 種別が混ざっても元のバイトに戻る() {
    let bytes = to_sjis("A20260001B0001010B0002020A20260002B0003005");
    let layout = keyed(&[1, 4, 3], &[1, 8], 0, 1, "A");
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(
        &got.rows,
        &got.layout,
        sjis(),
        "\n",
        &[],
        &[],
        &got.kinds,
    )
    .expect("書けること");
    assert_eq!(back, bytes);
}

#[test]
fn 見分ける位置は先頭でなくてもよい() {
    // 3バイト目からの2バイトで種別を見る (ヘッダ10バイト・ボディ9バイト)
    let bytes = to_sjis("01HD20260002BD0001003BD00020");
    let layout = keyed(&[2, 2, 5], &[2, 2, 6], 2, 2, "HD");
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 0, 0]);
    assert_eq!(got.rows[0], vec!["01", "HD", "202600"]);
    assert_eq!(got.rows[1], vec!["02", "BD", "00010"]);
    assert_eq!(got.rows[2], vec!["03", "BD", "00020"]);
}

#[test]
fn 改行のあるファイルでも種別を見分けられる() {
    let bytes = to_sjis("A20260001\nB0001010\nB0002020\n");
    let layout = FixedLayout {
        header: vec![FixedColumn::new(1), FixedColumn::new(8)],
        key: Some(FixedKey {
            at: 0,
            len: 1,
            header: "A".to_string(),
        }),
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 4, 3])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 0, 0]);
    assert_eq!(got.rows[0], vec!["A", "20260001", ""]);
    assert_eq!(got.rows[2], vec!["B", "0002", "020"]);
}

#[test]
fn ヘッダの桁を決めていなければ種別は見分けない() {
    // 見分ける決まりだけあっても、ヘッダの桁が無ければ今までどおり
    let bytes = to_sjis("A2026B0001");
    let layout = FixedLayout {
        newline: false,
        key: Some(FixedKey {
            at: 0,
            len: 1,
            header: "A".to_string(),
        }),
        ..FixedLayout::from_widths(WidthUnit::Byte, &[5])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert!(got.kinds.is_empty());
    assert_eq!(got.rows.len(), 2);
}

// ---------- 種別が3つ以上あるファイル ----------

/// 種別を1つ作る
fn kind(name: &str, at: usize, len: usize, value: &str, widths: &[usize]) -> FixedKind {
    FixedKind {
        name: name.to_string(),
        at,
        len,
        value: value.to_string(),
        columns: widths.iter().map(|w| FixedColumn::new(*w)).collect(),
    }
}

#[test]
fn ヘッダが2種類あるファイルを読む() {
    /*
     * H1 (先頭が A): "A" + 伝票番号8 = 9バイト
     * H2 (先頭が C): "C" + 得意先4 + 名前6 = 11バイト
     * ボディ (それ以外): "B" + 商品4 + 数量3 = 8バイト
     */
    let bytes = to_sjis("A20260001C0001あいうB0001010A20260002B0002020");
    let layout = FixedLayout {
        newline: false,
        kinds: vec![
            kind("伝票ヘッダ", 0, 1, "A", &[1, 8]),
            kind("得意先ヘッダ", 0, 1, "C", &[1, 4, 6]),
        ],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 4, 3])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 2, 0, 1, 0]);
    assert_eq!(got.rows[0], vec!["A", "20260001", ""]);
    assert_eq!(got.rows[1], vec!["C", "0001", "あいう"]);
    assert_eq!(got.rows[2], vec!["B", "0001", "010"]);
    assert_eq!(got.rows[3], vec!["A", "20260002", ""]);
}

#[test]
fn 種別ごとに見る位置が違ってもよい() {
    /*
     * H1: 先頭1バイトが "A" (長さ5)
     * H2: 3バイト目からの2バイトが "ZZ" (長さ8)
     * ボディ: それ以外 (長さ4)
     */
    let bytes = to_sjis("A1234B0ZZ9999C123");
    let layout = FixedLayout {
        newline: false,
        kinds: vec![
            kind("種別A", 0, 1, "A", &[1, 4]),
            kind("種別Z", 2, 2, "ZZ", &[2, 2, 4]),
        ],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 3])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 2, 0]);
    assert_eq!(got.rows[0], vec!["A", "1234", ""]);
    assert_eq!(got.rows[1], vec!["B0", "ZZ", "9999"]);
    assert_eq!(got.rows[2], vec!["C", "123", ""]);
}

#[test]
fn 種別が3つでも元のバイトに戻る() {
    let bytes = to_sjis("A20260001C0001あいうB0001010A20260002B0002020");
    let layout = FixedLayout {
        newline: false,
        kinds: vec![
            kind("伝票ヘッダ", 0, 1, "A", &[1, 8]),
            kind("得意先ヘッダ", 0, 1, "C", &[1, 4, 6]),
        ],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 4, 3])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(&got.rows, &got.layout, sjis(), "\n", &[], &[], &got.kinds)
        .expect("書けること");
    assert_eq!(back, bytes);
}

#[test]
fn 改行のあるファイルでも種別を2つ見分けられる() {
    let bytes = to_sjis("A20260001\nC0001あいう\nB0001010\n");
    let layout = FixedLayout {
        kinds: vec![
            kind("伝票ヘッダ", 0, 1, "A", &[1, 8]),
            kind("得意先ヘッダ", 0, 1, "C", &[1, 4, 6]),
        ],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 4, 3])
    };
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    assert_eq!(got.kinds, vec![1, 2, 0]);
    assert_eq!(got.rows[1], vec!["C", "0001", "あいう"]);
}

#[test]
fn 古い形の設定は種別の一覧に直して読む() {
    let old = keyed(&[1, 4, 3], &[1, 8], 0, 1, "A");
    let now = old.migrated();
    assert!(now.key.is_none());
    assert_eq!(now.kinds.len(), 1);
    assert_eq!(now.kinds[0].value, "A");
    assert_eq!(now.kinds[0].columns.len(), 2);
    // 直したあとは、ヘッダの桁は種別のほうが持つ
    assert!(now.header.is_empty());
}

#[test]
fn 表に要る列の数は種別の中でいちばん多いものに合わせる() {
    let layout = FixedLayout {
        kinds: vec![kind("A", 0, 1, "A", &[1, 2, 3, 4])],
        ..FixedLayout::from_widths(WidthUnit::Byte, &[1, 2])
    };
    assert_eq!(layout.width(), 4);
}
