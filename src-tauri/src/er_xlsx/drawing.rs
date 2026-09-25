//! ER図を1枚の DrawingML (xl/drawings/drawing1.xml) にする。
//!
//! 図全体を1つのグループにまとめて A1 に置く。
//! セルの幅は環境 (フォント) で変わるため、図形ごとにセルへ
//! 固定すると Mac と Windows で線とテーブルがずれてしまう。
//! グループの中は EMU の絶対座標なので、どこで開いても同じ配置になる

use super::connector::{self, Pt};
use super::model::{ErSheet, Frame, Glue, Label, LineStyle, Table, Target};
use super::shape::{self, fill, group, no_line, Geom, Line, Rect, Site, Sp};
use super::text::{self, Anchor, Insets, Run};
use super::xml::emu;

/// テーブルの角の丸み・枠の角の丸み (px。画面と同じ)
const NODE_RADIUS: f64 = 8.0;
const FRAME_RADIUS: f64 = 10.0;
const FRAME_RADIUS_SQUARE: f64 = 3.0;
/// 文字の大きさ (px。画面と同じ)
const HEAD_SIZE: f64 = 12.0;
const HEAD_LOGICAL_SIZE: f64 = 10.5;
const COL_SIZE: f64 = 11.0;
const FRAME_LABEL_SIZE: f64 = 12.0;
/// 線の太さ (px)
const EDGE_W: f64 = 1.2;
const FRAME_W: f64 = 1.5;

/// 図形IDの払い出し (図の中で重ならないこと)
struct Ids(u32);

impl Ids {
    fn next(&mut self) -> u32 {
        self.0 += 1;
        self.0
    }
}

/// テーブル1つぶんの図形ID (線をつなぐ先)
struct TableIds {
    group: u32,
    body: u32,
    head: u32,
    rows: Vec<u32>,
}

/// 図全体の XML
pub fn render(s: &ErSheet) -> String {
    let mut ids = Ids(1);
    let top = ids.next();
    // 線はテーブルより先 (背面) に描くが、つなぐ先のIDが要るので先に払い出す
    let tids: Vec<TableIds> = s
        .tables
        .iter()
        .map(|t| TableIds {
            group: ids.next(),
            body: ids.next(),
            head: ids.next(),
            rows: t.rows.iter().map(|_| ids.next()).collect(),
        })
        .collect();

    let mut out = String::new();
    for f in s.frames.iter().filter(|f| !f.front) {
        out.push_str(&frame(ids.next(), f));
    }
    for e in &s.edges {
        let pts: Vec<Pt> = e.points.iter().map(|p| (emu(p[0]), emu(p[1]))).collect();
        let line = Line {
            paint: &e.color,
            width_px: EDGE_W,
            dash: e.dash,
            dots: true,
        };
        let id = ids.next();
        match connector::plan(&pts) {
            Some(p) => {
                let from = site(&tids, e.from.as_ref());
                let to = site(&tids, e.to.as_ref());
                out.push_str(&shape::connector(id, &e.name, &p, from, to, &line));
            }
            None if pts.len() >= 2 => {
                out.push_str(&shape::polyline(
                    id,
                    &e.name,
                    &connector::simplify(&pts),
                    &line,
                ));
            }
            None => {}
        }
    }
    for (t, ti) in s.tables.iter().zip(&tids) {
        out.push_str(&table(s, t, ti));
    }
    for f in s.frames.iter().filter(|f| f.front) {
        out.push_str(&frame(ids.next(), f));
    }
    for l in &s.labels {
        out.push_str(&label(ids.next(), l));
    }

    let (w, h) = extent(s);
    let all = group(
        top,
        &format!("ER図 {}", s.name),
        &Rect {
            x: 0.0,
            y: 0.0,
            w,
            h,
        },
        &out,
    );
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" "#,
            r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">"#,
            r#"<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>"#,
            r#"<xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="{cx}" cy="{cy}"/>"#,
            "{all}<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>"
        ),
        cx = emu(w),
        cy = emu(h),
        all = all,
    )
}

/// 図の右下の位置 (左上は原点)
fn extent(s: &ErSheet) -> (f64, f64) {
    let mut w: f64 = 1.0;
    let mut h: f64 = 1.0;
    let mut grow = |x: f64, y: f64| {
        w = w.max(x);
        h = h.max(y);
    };
    for t in &s.tables {
        grow(t.x + t.w, t.y + t.h);
    }
    for f in &s.frames {
        grow(f.x + f.w, f.y + f.h);
    }
    for l in &s.labels {
        grow(l.x + l.w, l.y + l.h);
    }
    for p in s.edges.iter().flat_map(|e| &e.points) {
        grow(p[0], p[1]);
    }
    (w, h)
}

/// 線の端をつなぐ図形と接続点 (範囲外の指定はつながない)
fn site(tids: &[TableIds], g: Option<&Glue>) -> Site {
    let g = g?;
    let t = tids.get(g.table)?;
    let id = match g.target {
        Target::Row { index } => *t.rows.get(index)?,
        Target::Head => t.head,
        Target::Body => t.body,
    };
    Some((id, g.side.site()))
}

/// テーブル1つ (外枠・見出し・カラム行のグループ)
fn table(s: &ErSheet, t: &Table, ti: &TableIds) -> String {
    let p = &s.palette;
    let rect = Rect {
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
    };
    let mut kids = Sp {
        id: ti.body,
        name: &format!("{} 枠", t.name),
        rect,
        geom: Geom::Round(NODE_RADIUS),
        fill: fill(Some(&p.node_fill)),
        line: shape_line(&p.node_stroke, 1.0, LineStyle::Solid),
        text: String::new(),
        text_box: false,
    }
    .xml();

    let logical = if t.logical.is_empty() {
        String::new()
    } else {
        format!("  {}", t.logical)
    };
    let head_text = text::body(
        &[
            Some(Run {
                text: &t.name,
                size_px: HEAD_SIZE,
                color: &p.text,
                bold: true,
                mono: true,
            }),
            Some(Run {
                text: &logical,
                size_px: HEAD_LOGICAL_SIZE,
                color: &p.dim,
                bold: false,
                mono: false,
            }),
        ],
        &[],
        Anchor::Middle,
        Insets {
            left: s.pad_x,
            top: 0.0,
        },
        HEAD_SIZE,
    );
    kids.push_str(
        &Sp {
            id: ti.head,
            name: &format!("{} 見出し", t.name),
            rect: Rect {
                h: s.head_h,
                ..rect
            },
            geom: Geom::RoundTop(NODE_RADIUS),
            fill: fill(Some(&p.head_fill)),
            line: no_line(),
            text: head_text,
            text_box: false,
        }
        .xml(),
    );

    for (i, (cells, id)) in t.rows.iter().zip(&ti.rows).enumerate() {
        let mut runs: Vec<Option<Run>> = Vec::new();
        for (k, c) in cells.iter().enumerate() {
            if k > 0 {
                runs.push(None);
            }
            runs.push(Some(Run {
                text: &c.text,
                size_px: COL_SIZE,
                color: &c.color,
                bold: false,
                mono: c.mono,
            }));
        }
        let col = cells
            .first()
            .map(|c| c.text.trim_start_matches(['●', '○', ' ']))
            .unwrap_or("");
        kids.push_str(
            &Sp {
                id: *id,
                name: &format!("{}.{}", t.name, col),
                rect: Rect {
                    y: t.y + s.head_h + i as f64 * s.row_h,
                    h: s.row_h,
                    ..rect
                },
                geom: Geom::Rect,
                fill: fill(None),
                line: no_line(),
                text: text::body(
                    &runs,
                    &t.tabs,
                    Anchor::Middle,
                    Insets {
                        left: s.pad_x,
                        top: 0.0,
                    },
                    COL_SIZE,
                ),
                text_box: false,
            }
            .xml(),
        );
    }
    group(ti.group, &t.name, &rect, &kids)
}

fn shape_line(paint: &super::model::Paint, w: f64, dash: LineStyle) -> String {
    Line {
        paint,
        width_px: w,
        dash,
        dots: false,
    }
    .xml()
}

/// 注釈の枠
fn frame(id: u32, f: &Frame) -> String {
    let text = text::body(
        &[Some(Run {
            text: &f.label,
            size_px: FRAME_LABEL_SIZE,
            color: &f.label_color,
            bold: false,
            mono: false,
        })],
        &[],
        Anchor::Top,
        Insets {
            left: 10.0,
            top: 6.0,
        },
        FRAME_LABEL_SIZE,
    );
    Sp {
        id,
        name: &format!("枠 {}", f.label),
        rect: Rect {
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
        },
        geom: Geom::Round(if f.rounded {
            FRAME_RADIUS
        } else {
            FRAME_RADIUS_SQUARE
        }),
        fill: fill(f.fill.as_ref()),
        line: f
            .stroke
            .as_ref()
            .map(|p| shape_line(p, FRAME_W, f.dash))
            .unwrap_or_else(no_line),
        text,
        text_box: false,
    }
    .xml()
}

/// 文字だけの図形
fn label(id: u32, l: &Label) -> String {
    let text = text::body(
        &[Some(Run {
            text: &l.text,
            size_px: l.size,
            color: &l.color,
            bold: l.bold,
            mono: l.mono,
        })],
        &[],
        Anchor::Middle,
        Insets {
            left: 0.0,
            top: 0.0,
        },
        l.size,
    );
    Sp {
        id,
        name: &format!("文字 {}", l.text),
        rect: Rect {
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
        },
        geom: Geom::Rect,
        fill: fill(None),
        line: no_line(),
        text,
        text_box: true,
    }
    .xml()
}
