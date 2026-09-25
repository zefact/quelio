//! 図形の中の文字 (txBody) を組み立てる

use super::xml::{emu, esc, font_sz, rgb};

/// 等幅の文字 (テーブル名・カラム名・型)
const FONT_MONO: &str = "Consolas";
/// 日本語を含む文字 (論理名・注釈)
const FONT_UI: &str = "Yu Gothic";

/// 文字の一続き
pub struct Run<'a> {
    pub text: &'a str,
    pub size_px: f64,
    pub color: &'a str,
    pub bold: bool,
    pub mono: bool,
}

impl Run<'_> {
    fn xml(&self) -> String {
        let latin = if self.mono { FONT_MONO } else { FONT_UI };
        let b = if self.bold { r#" b="1""# } else { "" };
        format!(
            concat!(
                r#"<a:r><a:rPr lang="ja-JP" altLang="en-US" sz="{sz}"{b}>"#,
                r#"<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>"#,
                r#"<a:latin typeface="{latin}"/><a:ea typeface="{ea}"/><a:cs typeface="{latin}"/>"#,
                r#"</a:rPr><a:t>{text}</a:t></a:r>"#
            ),
            sz = font_sz(self.size_px),
            b = b,
            color = rgb(self.color),
            latin = latin,
            ea = FONT_UI,
            text = esc(self.text),
        )
    }
}

/// 縦位置
#[derive(Clone, Copy)]
pub enum Anchor {
    Top,
    Middle,
}

/// 文字の余白 (px)
pub struct Insets {
    pub left: f64,
    pub top: f64,
}

/// 1段落だけの txBody を作る。
/// tabs は区切り (タブ) の位置 (px、文字の書き始めから)。
/// runs の間に None を挟むとそこでタブを入れる
pub fn body(
    runs: &[Option<Run>],
    tabs: &[f64],
    anchor: Anchor,
    insets: Insets,
    size_px: f64,
) -> String {
    let anchor = match anchor {
        Anchor::Top => "t",
        Anchor::Middle => "ctr",
    };
    let tab_lst = if tabs.is_empty() {
        String::new()
    } else {
        let t: String = tabs
            .iter()
            .map(|p| format!(r#"<a:tab pos="{}" algn="l"/>"#, emu(*p)))
            .collect();
        format!("<a:tabLst>{t}</a:tabLst>")
    };
    // タブは直前の文字と同じ書式の一続きとして入れる
    let mut last_font: Option<&Run> = None;
    let mut body = String::new();
    for r in runs {
        match r {
            Some(r) => {
                if !r.text.is_empty() {
                    body.push_str(&r.xml());
                }
                last_font = Some(r);
            }
            None => {
                let base = last_font.map(|r| (r.size_px, r.color, r.mono));
                let (size_px, color, mono) = base.unwrap_or((size_px, "000000", false));
                let tab = Run {
                    text: "\t",
                    size_px,
                    color,
                    bold: false,
                    mono,
                };
                body.push_str(&tab.xml());
            }
        }
    }
    format!(
        concat!(
            r#"<xdr:txBody><a:bodyPr vertOverflow="overflow" horzOverflow="overflow" wrap="none" "#,
            r#"lIns="{l}" tIns="{t}" rIns="0" bIns="0" anchor="{anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr>"#,
            r#"<a:lstStyle/><a:p><a:pPr algn="l">{tabs}</a:pPr>{body}"#,
            r#"<a:endParaRPr lang="ja-JP" altLang="en-US" sz="{sz}"/></a:p></xdr:txBody>"#
        ),
        l = emu(insets.left),
        t = emu(insets.top),
        anchor = anchor,
        tabs = tab_lst,
        body = body,
        sz = font_sz(size_px),
    )
}
