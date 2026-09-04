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
    let back = dump(&got.rows, &got.layout, utf8(), "\n").unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), text);
}

#[test]
fn shift_jisでもそのまま戻る() {
    let bytes = to_sjis("0001山田  東京\n0002佐藤  大阪\n");
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[4, 6, 4]);
    let got = load(&bytes, sjis(), WidthUnit::Byte, Reading::Layout(&layout));
    let back = dump(&got.rows, &got.layout, sjis(), "\n").unwrap();
    assert_eq!(back, bytes);
}

#[test]
fn crlfのまま戻せる() {
    let text = "ab  12\ncd  34\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Guess);
    let back = dump(&got.rows, &got.layout, utf8(), "\r\n").unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "ab  12\r\ncd  34\r\n");
}

#[test]
fn 書き換えた値は桁に合わせて埋め直す() {
    let text = "山田      001\n";
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[8, 3]);
    let mut got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Layout(&layout));
    got.rows[0][0] = "鈴木".into();
    let back = dump(&got.rows, &got.layout, utf8(), "\n").unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "鈴木      001\n");
}

#[test]
fn ゼロ埋めの桁も埋め直す() {
    let text = "0001あ\n0025い\n";
    let got = load(text.as_bytes(), utf8(), WidthUnit::Char, Reading::Widths(&[4, 1]));
    let mut rows = got.rows.clone();
    rows[0][0] = "7".into();
    let back = dump(&rows, &got.layout, utf8(), "\n").unwrap();
    assert_eq!(String::from_utf8(back).unwrap(), "0007あ\n0025い\n");
}

#[test]
fn 桁からはみ出したら書かずに場所を返す() {
    let layout = FixedLayout::from_widths(WidthUnit::Char, &[4, 3]);
    let rows = vec![
        vec!["ok".to_string(), "123".to_string()],
        vec!["ながすぎる".to_string(), "1".to_string()],
    ];
    let bad = dump(&rows, &layout, utf8(), "\n").unwrap_err();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].row, 1);
    assert_eq!(bad[0].col, 0);
    assert_eq!(bad[0].len, 5);
    assert_eq!(bad[0].width, 4);
}

#[test]
fn バイトで数えるとはみ出しもバイトで見る() {
    // Shift_JISの「山田」は4バイトなので、幅3には入らない
    let layout = FixedLayout::from_widths(WidthUnit::Byte, &[3]);
    let rows = vec![vec!["山田".to_string()]];
    let bad = dump(&rows, &layout, sjis(), "\n").unwrap_err();
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
