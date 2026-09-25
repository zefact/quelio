//! XML を書くときの小道具 (文字の逃がし・単位・色)

use super::model::Paint;

/// 1ピクセル (96dpi) の EMU。Excel の図形の座標は EMU で書く
const EMU_PER_PX: f64 = 9525.0;

/// ピクセルを EMU にする
pub fn emu(px: f64) -> i64 {
    (px * EMU_PER_PX).round() as i64
}

/// 文字の大きさ (px) を DrawingML の sz (1/100 pt) にする
pub fn font_sz(px: f64) -> i64 {
    // 1px = 0.75pt
    (px * 75.0).round().clamp(100.0, 400_000.0) as i64
}

/// XML の本文・属性に入れられる形にする。
/// XML 1.0 で使えない制御文字は捨てる (タブ・改行は残す)
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// "#RRGGBB" / "rrggbb" を "RRGGBB" にそろえる (読めなければ黒)
pub fn rgb(s: &str) -> String {
    let h = s.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        h.to_ascii_uppercase()
    } else {
        "000000".into()
    }
}

/// 不透明な単色の塗り
pub fn solid_rgb(s: &str) -> String {
    format!(
        r#"<a:solidFill><a:srgbClr val="{}"/></a:solidFill>"#,
        rgb(s)
    )
}

/// 半透明を含む単色の塗り
pub fn solid(p: &Paint) -> String {
    let a = (p.alpha.clamp(0.0, 1.0) * 100_000.0).round() as i64;
    if a >= 100_000 {
        return solid_rgb(&p.rgb);
    }
    format!(
        r#"<a:solidFill><a:srgbClr val="{}"><a:alpha val="{a}"/></a:srgbClr></a:solidFill>"#,
        rgb(&p.rgb)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_and_drops_control_chars() {
        assert_eq!(esc("a<b>&\"c\u{1}\td"), "a&lt;b&gt;&amp;&quot;c\td");
    }

    #[test]
    fn normalizes_colors() {
        assert_eq!(rgb("#4f46e5"), "4F46E5");
        assert_eq!(rgb("rgba(1,2,3,0.5)"), "000000");
        let p = Paint {
            rgb: "ffffff".into(),
            alpha: 0.25,
        };
        assert!(solid(&p).contains(r#"<a:alpha val="25000"/>"#));
        let p = Paint {
            rgb: "ffffff".into(),
            alpha: 1.0,
        };
        assert!(!solid(&p).contains("alpha"));
    }

    #[test]
    fn converts_units() {
        assert_eq!(emu(1.0), 9525);
        assert_eq!(font_sz(11.0), 825);
        assert_eq!(font_sz(12.0), 900);
    }
}
