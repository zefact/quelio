//! 折れ線を Excel のコネクタ (カギ線) に置き換える計算。
//!
//! Excel のカギ線コネクタは「横→縦→横…」と決まった形をしていて、
//! 曲がる位置を割合 (adj) で持つ。左右や上下が逆向きの線は反転 (flip) で表す。
//! この形に当てはまらない折れ線 (上下の辺から出る線など) は
//! フリーフォームで描く (つながりは保てないが見た目はそのまま)

/// EMU の点
pub type Pt = (i64, i64);

/// コネクタの形
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// 図形の種類 (straightConnector1 / bentConnector2〜5)
    pub prst: &'static str,
    pub off: Pt,
    pub ext: (i64, i64),
    pub flip_h: bool,
    pub flip_v: bool,
    /// 曲がる位置 (adj1, adj2, ... の値)
    pub adj: Vec<i64>,
}

/// 幅や高さが0だと曲がる位置を割合で表せないので、最低限この幅を持たせる (1px)
const MIN_SPAN: i64 = 9525;

/// 重なった点と一直線上の途中の点を除く
pub fn simplify(pts: &[Pt]) -> Vec<Pt> {
    let mut out: Vec<Pt> = Vec::with_capacity(pts.len());
    for &p in pts {
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    let mut i = 1;
    while i + 1 < out.len() {
        let (a, b, c) = (out[i - 1], out[i], out[i + 1]);
        if (a.0 == b.0 && b.0 == c.0) || (a.1 == b.1 && b.1 == c.1) {
            out.remove(i);
            i = i.saturating_sub(1).max(1);
        } else {
            i += 1;
        }
    }
    out
}

/// 横から始まって横・縦を交互に曲がる折れ線か
fn alternates_from_horizontal(p: &[Pt]) -> bool {
    p.windows(2).enumerate().all(|(i, w)| {
        if i % 2 == 0 {
            w[0].1 == w[1].1
        } else {
            w[0].0 == w[1].0
        }
    })
}

/// v が a→b のどの割合の位置か (100000 = b)
fn frac(v: i64, a: i64, b: i64) -> i64 {
    ((v - a) as f64 / (b - a) as f64 * 100_000.0).round() as i64
}

/// 折れ線をコネクタで表せるなら、その形を返す
pub fn plan(points: &[Pt]) -> Option<Plan> {
    let p = simplify(points);
    if p.len() < 2 {
        return None;
    }
    let start = p[0];
    let mut end = p[p.len() - 1];
    let prst = match p.len() {
        2 => "straightConnector1",
        3..=6 if alternates_from_horizontal(&p) => match p.len() {
            3 => "bentConnector2",
            4 => "bentConnector3",
            5 => "bentConnector4",
            _ => "bentConnector5",
        },
        _ => return None,
    };
    // 曲がる位置を割合で持つ向きに幅が無いときは、端を1pxずらして幅を作る
    if p.len() >= 4 && end.0 == start.0 {
        end.0 += MIN_SPAN;
    }
    if p.len() >= 5 && end.1 == start.1 {
        end.1 += MIN_SPAN;
    }
    let fx = |v: i64| frac(v, start.0, end.0);
    let fy = |v: i64| frac(v, start.1, end.1);
    let adj = match p.len() {
        4 => vec![fx(p[1].0)],
        5 => vec![fx(p[1].0), fy(p[2].1)],
        6 => vec![fx(p[1].0), fy(p[2].1), fx(p[3].0)],
        _ => vec![],
    };
    Some(Plan {
        prst,
        off: (start.0.min(end.0), start.1.min(end.1)),
        ext: ((end.0 - start.0).abs(), (end.1 - start.1).abs()),
        flip_h: end.0 < start.0,
        flip_v: end.1 < start.1,
        adj,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplifies_collinear_points() {
        let p = simplify(&[(0, 0), (5, 0), (5, 0), (10, 0), (10, 10)]);
        assert_eq!(p, vec![(0, 0), (10, 0), (10, 10)]);
    }

    #[test]
    fn elbow_left_to_right() {
        // 参照元の右端 → 真ん中で縦 → 参照先の左端
        let p = plan(&[(100, 50), (150, 50), (150, 200), (300, 200)]).unwrap();
        assert_eq!(p.prst, "bentConnector3");
        assert_eq!(p.off, (100, 50));
        assert_eq!(p.ext, (200, 150));
        assert!(!p.flip_h && !p.flip_v);
        assert_eq!(p.adj, vec![25_000]);
    }

    #[test]
    fn elbow_right_to_left_upwards_is_flipped() {
        let p = plan(&[(300, 200), (200, 200), (200, 50), (100, 50)]).unwrap();
        assert!(p.flip_h && p.flip_v);
        assert_eq!(p.off, (100, 50));
        assert_eq!(p.adj, vec![50_000]);
    }

    #[test]
    fn wrap_around_on_the_right_goes_past_the_end() {
        // 両端とも右辺から出て、さらに右を回り込む線
        let p = plan(&[(100, 0), (200, 0), (200, 100), (150, 100)]).unwrap();
        assert_eq!(p.prst, "bentConnector3");
        assert_eq!(p.adj, vec![200_000]);
    }

    #[test]
    fn same_x_ends_get_a_minimum_width() {
        // 左右の端が同じ位置 (右辺どうしを40px外で回り込む)
        let px = |v: i64| v * 9525;
        let p = plan(&[
            (px(100), 0),
            (px(140), 0),
            (px(140), px(100)),
            (px(100), px(100)),
        ])
        .unwrap();
        assert_eq!(p.ext.0, MIN_SPAN);
        assert_eq!(p.adj, vec![4_000_000]);
    }

    #[test]
    fn detour_uses_bent_connector5() {
        let p = plan(&[(0, 0), (20, 0), (20, 80), (60, 80), (60, 40), (100, 40)]).unwrap();
        assert_eq!(p.prst, "bentConnector5");
        assert_eq!(p.adj, vec![20_000, 200_000, 60_000]);
    }

    #[test]
    fn straight_and_vertical_start() {
        assert_eq!(plan(&[(0, 5), (50, 5)]).unwrap().prst, "straightConnector1");
        // 上の辺から出る線 (縦から始まる) はコネクタにしない
        assert!(plan(&[(0, 0), (0, 30), (50, 30)]).is_none());
    }
}
