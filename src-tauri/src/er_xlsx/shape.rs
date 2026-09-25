//! DrawingML の図形 (四角・グループ・コネクタ・フリーフォーム) を書く

use super::connector::{Plan, Pt};
use super::model::{LineStyle, Paint};
use super::xml::{emu, esc, solid};

/// 四角形 (px)
#[derive(Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn xfrm(&self) -> String {
        format!(
            r#"<a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>"#,
            emu(self.x),
            emu(self.y),
            emu(self.w.max(0.0)),
            emu(self.h.max(0.0)),
        )
    }
}

/// 四角形の形
pub enum Geom {
    Rect,
    /// 角丸 (半径 px)
    Round(f64),
    /// 上の2つの角だけ丸める (半径 px)
    RoundTop(f64),
}

impl Geom {
    fn xml(&self, r: &Rect) -> String {
        // 半径は短い辺に対する割合で持つ (上限は半分)
        let ratio = |rad: f64| {
            let short = r.w.min(r.h);
            if short <= 0.0 {
                0
            } else {
                ((rad / short) * 100_000.0).round().clamp(0.0, 50_000.0) as i64
            }
        };
        match self {
            Geom::Rect => r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#.into(),
            Geom::Round(rad) => format!(
                r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {}"/></a:avLst></a:prstGeom>"#,
                ratio(*rad)
            ),
            Geom::RoundTop(rad) => format!(
                r#"<a:prstGeom prst="round2SameRect"><a:avLst><a:gd name="adj1" fmla="val {}"/><a:gd name="adj2" fmla="val 0"/></a:avLst></a:prstGeom>"#,
                ratio(*rad)
            ),
        }
    }
}

/// 線の書式
pub struct Line<'a> {
    pub paint: &'a Paint,
    pub width_px: f64,
    pub dash: LineStyle,
    /// 両端に丸を付けるか (リレーションの接続点)
    pub dots: bool,
}

impl Line<'_> {
    pub fn xml(&self) -> String {
        let dash = match self.dash {
            LineStyle::Solid => "",
            LineStyle::Dash => r#"<a:prstDash val="dash"/>"#,
            LineStyle::Dot => r#"<a:prstDash val="sysDot"/>"#,
        };
        let ends = if self.dots {
            r#"<a:headEnd type="oval" w="sm" len="sm"/><a:tailEnd type="oval" w="sm" len="sm"/>"#
        } else {
            ""
        };
        format!(
            r#"<a:ln w="{}">{}{dash}<a:round/>{ends}</a:ln>"#,
            emu(self.width_px),
            solid(self.paint)
        )
    }
}

/// 線なし
pub fn no_line() -> String {
    "<a:ln><a:noFill/></a:ln>".into()
}

/// 塗り (None = 塗りなし)
pub fn fill(p: Option<&Paint>) -> String {
    p.map(solid).unwrap_or_else(|| "<a:noFill/>".into())
}

/// 図形1つ (sp)
pub struct Sp<'a> {
    pub id: u32,
    pub name: &'a str,
    pub rect: Rect,
    pub geom: Geom,
    pub fill: String,
    pub line: String,
    /// txBody (無ければ空)
    pub text: String,
    /// テキストボックスとして作るか
    pub text_box: bool,
}

impl Sp<'_> {
    pub fn xml(&self) -> String {
        let tb = if self.text_box { r#" txBox="1""# } else { "" };
        format!(
            concat!(
                r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="{id}" name="{name}"/>"#,
                r#"<xdr:cNvSpPr{tb}/></xdr:nvSpPr><xdr:spPr>{xfrm}{geom}{fill}{line}</xdr:spPr>{text}</xdr:sp>"#
            ),
            id = self.id,
            name = esc(self.name),
            tb = tb,
            xfrm = self.rect.xfrm(),
            geom = self.geom.xml(&self.rect),
            fill = self.fill,
            line = self.line,
            text = self.text,
        )
    }
}

/// グループ (子の座標はそのまま使う: 外側と内側の座標系を一致させる)
pub fn group(id: u32, name: &str, r: &Rect, children: &str) -> String {
    let (x, y, w, h) = (emu(r.x), emu(r.y), emu(r.w.max(0.0)), emu(r.h.max(0.0)));
    format!(
        concat!(
            r#"<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="{id}" name="{name}"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>"#,
            r#"<xdr:grpSpPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/>"#,
            r#"<a:chOff x="{x}" y="{y}"/><a:chExt cx="{w}" cy="{h}"/></a:xfrm></xdr:grpSpPr>"#,
            "{children}</xdr:grpSp>"
        ),
        id = id,
        name = esc(name),
        x = x,
        y = y,
        w = w,
        h = h,
        children = children,
    )
}

/// 図形の接続点 (図形のID・接続点の番号)
pub type Site = Option<(u32, u32)>;

/// コネクタ (図形に吸着する線)
pub fn connector(id: u32, name: &str, p: &Plan, from: Site, to: Site, line: &Line) -> String {
    let st = from
        .map(|(i, s)| format!(r#"<a:stCxn id="{i}" idx="{s}"/>"#))
        .unwrap_or_default();
    let en = to
        .map(|(i, s)| format!(r#"<a:endCxn id="{i}" idx="{s}"/>"#))
        .unwrap_or_default();
    let flip = match (p.flip_h, p.flip_v) {
        (false, false) => "",
        (true, false) => r#" flipH="1""#,
        (false, true) => r#" flipV="1""#,
        (true, true) => r#" flipH="1" flipV="1""#,
    };
    let av: String = p
        .adj
        .iter()
        .enumerate()
        .map(|(i, v)| format!(r#"<a:gd name="adj{}" fmla="val {v}"/>"#, i + 1))
        .collect();
    format!(
        concat!(
            r#"<xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="{id}" name="{name}"/>"#,
            r#"<xdr:cNvCxnSpPr>{st}{en}</xdr:cNvCxnSpPr></xdr:nvCxnSpPr><xdr:spPr>"#,
            r#"<a:xfrm{flip}><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>"#,
            r#"<a:prstGeom prst="{prst}"><a:avLst>{av}</a:avLst></a:prstGeom><a:noFill/>{ln}</xdr:spPr></xdr:cxnSp>"#
        ),
        id = id,
        name = esc(name),
        st = st,
        en = en,
        flip = flip,
        x = p.off.0,
        y = p.off.1,
        w = p.ext.0,
        h = p.ext.1,
        prst = p.prst,
        av = av,
        ln = line.xml(),
    )
}

/// フリーフォームの折れ線 (コネクタで表せない線)
pub fn polyline(id: u32, name: &str, pts: &[Pt], line: &Line) -> String {
    let min_x = pts.iter().map(|p| p.0).min().unwrap_or(0);
    let min_y = pts.iter().map(|p| p.1).min().unwrap_or(0);
    let w = (pts.iter().map(|p| p.0).max().unwrap_or(0) - min_x).max(1);
    let h = (pts.iter().map(|p| p.1).max().unwrap_or(0) - min_y).max(1);
    let path: String = pts
        .iter()
        .enumerate()
        .map(|(i, (x, y))| {
            let tag = if i == 0 { "moveTo" } else { "lnTo" };
            format!(
                r#"<a:{tag}><a:pt x="{}" y="{}"/></a:{tag}>"#,
                x - min_x,
                y - min_y
            )
        })
        .collect();
    format!(
        concat!(
            r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="{id}" name="{name}"/><xdr:cNvSpPr/></xdr:nvSpPr>"#,
            r#"<xdr:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>"#,
            r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>"#,
            r#"<a:pathLst><a:path w="{w}" h="{h}" fill="none">{path}</a:path></a:pathLst></a:custGeom>"#,
            r#"<a:noFill/>{ln}</xdr:spPr></xdr:sp>"#
        ),
        id = id,
        name = esc(name),
        x = min_x,
        y = min_y,
        w = w,
        h = h,
        path = path,
        ln = line.xml(),
    )
}
