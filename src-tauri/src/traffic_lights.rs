//! macOS の閉じる・最小化・拡大ボタン (信号機) の置き場所。
//!
//! ウィンドウはタイトルバーを画面に重ねて (Overlay) 使い、ボタンはタブの帯の中に置く。
//! Tauri に渡す位置は「ボタンの帯の高さ」と「左端」で、ボタンそのものの中心ではない。
//! そのため、macOS の版でボタンの大きさや間隔が変わると、同じ値でも置かれる場所が動く
//! (macOS 26 以降はボタンが小さく、間隔が広くなり、4pt 上・6pt 右へずれた)。
//!
//! 起動時に一度だけ本物のボタンを測り、どの版でも
//! 「中心がこの高さ・拡大ボタンの右端がここ」になる値を計算して渡す。
//! 画面側 (CSS) は、拡大ボタンの右端 + 余白 で中身を始めている (86px)。
//! macOS だけで使う (lib.rs で macOS のときだけ読み込む)

use std::sync::OnceLock;

/// 拡大ボタン (3つ目) の右端。画面側はここから 12pt 空けて中身を置いている
const RIGHT_EDGE: f64 = 74.0;

/// 測れなかったときの左端 (以前と同じ値)
const FALLBACK_X: f64 = 20.0;

/// ボタンの寸法 (その macOS の版で決まっている)
#[derive(Clone, Copy, Debug, PartialEq)]
struct Metrics {
    /// ボタンの高さ
    height: f64,
    /// ボタンの幅
    width: f64,
    /// 帯の下端からボタンの下端まで (Tauri が帯の高さを変えても、これは変わらない)
    bottom: f64,
    /// 隣のボタンまでの間隔 (左端どうしの距離)
    spacing: f64,
}

static METRICS: OnceLock<Option<Metrics>> = OnceLock::new();

/**
 * ボタンの中心を上から `center` pt に置くための、Tauri に渡す位置。
 *
 * 測れていなければ、以前の値 (macOS 15 までの寸法で合わせたもの) を返す
 */
pub fn position(center: f64) -> tauri::LogicalPosition<f64> {
    let (x, y) = match METRICS.get().copied().flatten() {
        Some(m) => place(m, center),
        // macOS 15 までは、帯の高さ = 中心 - 2 で中心がそこへ来ていた
        None => (FALLBACK_X, center - 2.0),
    };
    tauri::LogicalPosition::new(x, y)
}

/**
 * 寸法から位置を求める。
 *
 * Tauri (tao) はボタンの帯の高さを「ボタンの高さ + y」にし、ボタンは帯の下端から
 * `bottom` の所に残す。なので、ボタンの中心は上から `y + height / 2 - bottom` になる。
 * 左右は、1つ目の左端を x にして `spacing` ずつ並べる
 */
fn place(m: Metrics, center: f64) -> (f64, f64) {
    let y = center - m.height / 2.0 + m.bottom;
    let x = RIGHT_EDGE - 2.0 * m.spacing - m.width;
    // 測った値がおかしいときに、窓の外や角へ行かないようにする
    (x.clamp(8.0, 30.0), y.max(0.0))
}

/// 起動時に一度だけ測る (メインスレッドで呼ぶこと)
pub fn measure() {
    METRICS.get_or_init(probe);
}

/**
 * 画面に出さない窓を1つ作って、ボタンの寸法を読む。
 *
 * Tauri の窓と同じ形 (タイトルバーを重ねる・題を隠す) にしておく
 */
fn probe() -> Option<Metrics> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = MainThreadMarker::new()?;
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0)),
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // 手元で持っている間に閉じても消えないようにする (閉じずに捨てる)
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let mini = window.standardWindowButton(NSWindowButton::MiniaturizeButton)?;
    let c = close.frame();
    let m = mini.frame();
    let metrics = Metrics {
        height: c.size.height,
        width: c.size.width,
        bottom: c.origin.y,
        spacing: m.origin.x - c.origin.x,
    };
    // 寸法として明らかにおかしければ使わない (以前の値で置く)
    let sane = (8.0..=40.0).contains(&metrics.height)
        && (8.0..=40.0).contains(&metrics.width)
        && (0.0..=30.0).contains(&metrics.bottom)
        && (metrics.width..=50.0).contains(&metrics.spacing);
    sane.then_some(metrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos15までの寸法では以前の値になる() {
        // ボタン 14x16、帯の下端から 6pt、間隔 20pt
        let m = Metrics {
            height: 16.0,
            width: 14.0,
            bottom: 6.0,
            spacing: 20.0,
        };
        assert_eq!(place(m, 24.0), (20.0, 22.0));
        assert_eq!(place(m, 28.0), (20.0, 26.0));
    }

    #[test]
    fn macos26以降の寸法でも中心と右端がそろう() {
        // macOS 27.2 で測った値: ボタン 14x14、帯の下端から 9pt、間隔 23pt
        let m = Metrics {
            height: 14.0,
            width: 14.0,
            bottom: 9.0,
            spacing: 23.0,
        };
        let (x, y) = place(m, 24.0);
        // 中心は上から 24pt (= y + 高さ/2 - 下の余白)
        assert_eq!(y + m.height / 2.0 - m.bottom, 24.0);
        // 拡大ボタンの右端は 74pt
        assert_eq!(x + 2.0 * m.spacing + m.width, RIGHT_EDGE);
        assert_eq!((x, y), (14.0, 26.0));
    }

    #[test]
    fn 測れていなければ以前の値() {
        // テストでは測らないので、いつも以前の値になる
        let p = position(24.0);
        assert_eq!((p.x, p.y), (20.0, 22.0));
    }
}
