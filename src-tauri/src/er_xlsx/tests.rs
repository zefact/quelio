//! 組み立てた図の中身を確かめる

use super::model::*;
use super::{build, drawing};

fn paint(rgb: &str, alpha: f64) -> Paint {
    Paint {
        rgb: rgb.into(),
        alpha,
    }
}

fn cell(text: &str, mono: bool) -> Cell {
    Cell {
        text: text.into(),
        color: "5b6478".into(),
        mono,
    }
}

fn table(name: &str, x: f64, y: f64, cols: &[&str]) -> Table {
    Table {
        name: name.into(),
        logical: "利用者".into(),
        x,
        y,
        w: 180.0,
        h: 26.0 + cols.len() as f64 * 17.0 + 6.0,
        tabs: vec![60.0, 120.0],
        rows: cols
            .iter()
            .map(|c| {
                vec![
                    cell(&format!("● {c}"), true),
                    cell("bigint", true),
                    cell("番号", false),
                ]
            })
            .collect(),
    }
}

/// users.id ← orders.user_id の2テーブルの図
pub fn sample() -> ErSheet {
    ErSheet {
        name: "shop".into(),
        palette: Palette {
            text: "1f2430".into(),
            dim: "5b6478".into(),
            node_fill: paint("ffffff", 1.0),
            node_stroke: paint("111827", 0.2),
            head_fill: paint("6366f1", 0.12),
        },
        head_h: 26.0,
        row_h: 17.0,
        pad_x: 9.0,
        tables: vec![
            table("users", 20.0, 70.0, &["id", "name"]),
            table("orders", 320.0, 150.0, &["id", "user_id"]),
        ],
        frames: vec![Frame {
            label: "会員 <core>".into(),
            x: 10.0,
            y: 50.0,
            w: 220.0,
            h: 120.0,
            rounded: true,
            stroke: Some(paint("5b6478", 0.55)),
            dash: LineStyle::Dash,
            fill: Some(paint("22c55e", 0.25)),
            label_color: "5b6478".into(),
            front: false,
        }],
        edges: vec![
            // orders.user_id (左辺) → users.id (右辺)
            Edge {
                name: "orders.user_id → users.id".into(),
                points: vec![
                    [320.0, 223.5],
                    [260.0, 223.5],
                    [260.0, 104.5],
                    [200.0, 104.5],
                ],
                color: paint("6366f1", 0.85),
                dash: LineStyle::Dash,
                from: Some(Glue {
                    table: 1,
                    target: Target::Row { index: 1 },
                    side: Side::Left,
                }),
                to: Some(Glue {
                    table: 0,
                    target: Target::Row { index: 0 },
                    side: Side::Right,
                }),
            },
            // 上の辺から出る線 (フリーフォームになる)
            Edge {
                name: "manual".into(),
                points: vec![
                    [400.0, 150.0],
                    [400.0, 120.0],
                    [110.0, 120.0],
                    [110.0, 70.0],
                ],
                color: paint("ef4444", 1.0),
                dash: LineStyle::Solid,
                from: Some(Glue {
                    table: 1,
                    target: Target::Body,
                    side: Side::Top,
                }),
                to: None,
            },
        ],
        labels: vec![Label {
            text: "Quelio ER図 — shop".into(),
            x: 20.0,
            y: 6.0,
            w: 200.0,
            h: 24.0,
            size: 14.0,
            color: "4f46e5".into(),
            bold: true,
            mono: false,
        }],
    }
}

/// 属性の値を全部抜き出す (name="value" の value)
fn attr_values<'a>(xml: &'a str, attr: &str) -> Vec<&'a str> {
    let key = format!(" {attr}=\"");
    xml.match_indices(&key)
        .map(|(i, _)| {
            let rest = &xml[i + key.len()..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect()
}

#[test]
fn shape_ids_are_unique_and_glue_points_exist() {
    let xml = drawing::render(&sample());
    let ids: Vec<&str> = xml
        .match_indices("<xdr:cNvPr id=\"")
        .map(|(i, _)| {
            let rest = &xml[i + 15..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect();
    let mut uniq = ids.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(ids.len(), uniq.len(), "IDが重複しています");
    // 線の両端は実在する図形につながる
    let st = attr_values(&xml, "id")
        .into_iter()
        .filter(|v| !ids.contains(v))
        .count();
    assert_eq!(st, 0);
    assert!(xml.contains("<a:stCxn id="));
    assert!(xml.contains(r#"idx="1"/><a:endCxn"#));
    assert!(xml.contains(r#"idx="3"/></xdr:cNvCxnSpPr>"#));
}

#[test]
fn draws_connectors_tables_and_escaped_labels() {
    let xml = drawing::render(&sample());
    assert!(xml.contains(r#"prst="bentConnector3""#));
    assert!(xml.contains("<a:custGeom>"), "縦から出る線はフリーフォーム");
    assert!(xml.contains(r#"name="users.id""#));
    assert!(xml.contains(r#"name="orders.user_id""#));
    assert!(xml.contains("会員 &lt;core&gt;"));
    assert!(xml.contains("<a:tab pos=\"571500\" algn=\"l\"/>"));
    // 線はテーブルより背面 (先に書く)
    let edge = xml.find("<xdr:cxnSp").unwrap();
    let first_table = xml.find(r#"name="users 枠""#).unwrap();
    assert!(edge < first_table);
    // 枠 (背面) は線よりさらに背面
    assert!(xml.find("枠 会員").unwrap() < edge);
}

#[test]
fn out_of_range_glue_is_dropped() {
    let mut s = sample();
    s.edges[0].to = Some(Glue {
        table: 9,
        target: Target::Head,
        side: Side::Right,
    });
    let xml = drawing::render(&s);
    assert!(!xml.contains("<a:endCxn"));
}

#[test]
fn builds_a_zip_and_rejects_bad_numbers() {
    let bytes = build(&sample()).unwrap();
    assert_eq!(&bytes[..2], b"PK");
    // 目視確認用 (ER_XLSX_OUT=ファイル名 を付けて走らせると書き出す)
    if let Ok(p) = std::env::var("ER_XLSX_OUT") {
        std::fs::write(p, &bytes).unwrap();
    }
    let mut s = sample();
    s.tables[0].x = f64::NAN;
    assert!(build(&s).is_err());
}
