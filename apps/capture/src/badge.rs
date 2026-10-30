//! The recording badge: a small pill "● 0:42 ■" shown while a recording runs,
//! clicked to stop it (the steps recorder shows its count the same way). Layout and pixels live here, away from Win32, so they
//! can be tested: the window draws the time with the system font into a BGRA
//! buffer, then `shade` gives it its shape, the dot and the stop square.

/// Sizes at 100% scale, in pixels.
const HEIGHT: f32 = 30.0;
const PAD: f32 = 12.0;
const DOT: f32 = 10.0;
const GAP: f32 = 8.0;
const STOP: f32 = 10.0;
const STOP_GAP: f32 = 12.0;
/// The text size the window uses, at 100% scale.
pub const TEXT: f32 = 13.0;
/// Distance from the top of the work area.
pub const TOP: f32 = 10.0;

pub const BACK: [u8; 3] = [30, 30, 30];
pub const BACK_HOVER: [u8; 3] = [56, 56, 56];
pub const INK: [u8; 3] = [240, 240, 240];
const RED: [u8; 3] = [232, 64, 64];
/// The pill is slightly see-through; what it holds is not.
const BACK_ALPHA: f32 = 0.92;

/// Where everything goes, in window pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
    /// Centre and radius of the red dot.
    pub dot: (f32, f32, f32),
    /// Left edge of the time text, and its width.
    pub text: (i32, i32),
    /// Left, top and side of the stop square.
    pub stop: (f32, f32, f32),
}

/// The layout for a time `text_width` pixels wide at `scale` (1.0 = 96 dpi).
pub fn layout(text_width: i32, scale: f32) -> Layout {
    let s = scale.max(0.5);
    let h = (HEIGHT * s).round();
    let pad = PAD * s;
    let dot_r = DOT * s / 2.0;
    let text_x = pad + DOT * s + GAP * s;
    let stop_x = text_x + text_width.max(0) as f32 + STOP_GAP * s;
    let side = STOP * s;
    let width = (stop_x + side + pad).ceil();
    Layout {
        width: width as u32,
        height: h as u32,
        dot: (pad + dot_r, h / 2.0, dot_r),
        text: (text_x.round() as i32, text_width.max(0)),
        stop: (stop_x, (h - side) / 2.0, side),
    }
}

/// "0:42", "12:05", "1:02:05": the same clock the dashboard toasts use.
pub fn clock(seconds: u64) -> String {
    let (h, m, s) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// The steps recorder's label: `template` with its `{n}` replaced by `n`
/// ("Steps: {n}" → "Steps: 3"); a template without `{n}` gets the number after it.
pub fn count(template: &str, n: usize) -> String {
    let t = template.trim();
    if t.is_empty() {
        n.to_string()
    } else if t.contains("{n}") {
        t.replace("{n}", &n.to_string())
    } else {
        format!("{t} {n}")
    }
}

/// How much of the pixel at (x, y) (its centre at +0.5) a shape whose signed
/// distance is `d` covers: 1 inside, 0 outside, a one-pixel ramp at the edge.
fn cover(d: f32) -> f32 {
    (0.5 - d).clamp(0.0, 1.0)
}

/// Signed distance to a rounded rectangle (negative inside).
fn rounded_rect(px: f32, py: f32, x: f32, y: f32, w: f32, h: f32, r: f32) -> f32 {
    let (cx, cy) = (x + w / 2.0, y + h / 2.0);
    let qx = (px - cx).abs() - (w / 2.0 - r);
    let qy = (py - cy).abs() - (h / 2.0 - r);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - r
}

fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [f32; 3] {
    let m = |i: usize| a[i] as f32 + (b[i] as f32 - a[i] as f32) * t;
    [m(0), m(1), m(2)]
}

/// Turns the buffer the window drew its text into (top-down BGRA, `back`
/// everywhere but the text) into the finished pill: premultiplied alpha, a
/// rounded outline, the red dot and the stop square.
pub fn shade(bgra: &mut [u8], l: &Layout, hover: bool) {
    let back = if hover { BACK_HOVER } else { BACK };
    let (w, h) = (l.width as f32, l.height as f32);
    let (dx, dy, dr) = l.dot;
    let (sx, sy, side) = l.stop;
    for (i, p) in bgra.chunks_exact_mut(4).enumerate() {
        let x = (i as u32 % l.width) as f32 + 0.5;
        let y = (i as u32 / l.width) as f32 + 0.5;
        let shape = cover(rounded_rect(x, y, 0.0, 0.0, w, h, h / 2.0));
        if shape <= 0.0 {
            p.copy_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        // BGRA in, RGB to work with.
        let mut rgb = [p[2] as f32, p[1] as f32, p[0] as f32];
        let mut alpha = BACK_ALPHA;
        let dot = cover(((x - dx).powi(2) + (y - dy).powi(2)).sqrt() - dr);
        let stop = cover(rounded_rect(x, y, sx, sy, side, side, side * 0.2));
        for (amount, ink) in [(dot, RED), (stop, INK)] {
            if amount > 0.0 {
                rgb = mix(back, ink, amount);
                alpha = BACK_ALPHA + (1.0 - BACK_ALPHA) * amount;
            }
        }
        // Text pixels differ from the background: they are fully opaque.
        if [p[2], p[1], p[0]] != back && dot == 0.0 && stop == 0.0 {
            alpha = 1.0;
        }
        let a = alpha * shape;
        p[0] = (rgb[2] * a).round() as u8;
        p[1] = (rgb[1] * a).round() as u8;
        p[2] = (rgb[0] * a).round() as u8;
        p[3] = (a * 255.0).round() as u8;
    }
}

/// Where the pill goes: centred at the top of the work area `work`
/// (left, top, right, bottom), `TOP` below its edge.
pub fn place(work: (i32, i32, i32, i32), l: &Layout, scale: f32) -> (i32, i32) {
    let (left, top, right, _) = work;
    let x = left + (right - left - l.width as i32) / 2;
    (x, top + (TOP * scale).round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_fills_the_template() {
        assert_eq!(count("Passi: {n}", 3), "Passi: 3");
        assert_eq!(count("{n} étapes", 12), "12 étapes");
        assert_eq!(count("Steps", 2), "Steps 2");
        assert_eq!(count("  ", 7), "7");
    }

    fn painted(text_width: i32, scale: f32, hover: bool) -> (Layout, Vec<u8>) {
        let l = layout(text_width, scale);
        let back = if hover { BACK_HOVER } else { BACK };
        let mut buf = Vec::new();
        for _ in 0..l.width * l.height {
            buf.extend_from_slice(&[back[2], back[1], back[0], 0]);
        }
        shade(&mut buf, &l, hover);
        (l, buf)
    }

    fn at(buf: &[u8], l: &Layout, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * l.width + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn clock_matches_the_dashboard() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(42), "0:42");
        assert_eq!(clock(725), "12:05");
        assert_eq!(clock(3725), "1:02:05");
    }

    #[test]
    fn layout_grows_with_the_text_and_the_scale() {
        let a = layout(30, 1.0);
        assert_eq!(a.height, 30);
        assert!(
            layout(60, 1.0).width > a.width,
            "a longer time widens the pill"
        );
        let b = layout(45, 1.5);
        assert_eq!(b.height, 45);
        assert!(b.width > a.width);
        // Nothing overlaps: dot, then the text, then the stop square.
        assert!(a.dot.0 + a.dot.2 <= a.text.0 as f32);
        assert!((a.text.0 + a.text.1) as f32 <= a.stop.0);
        assert!(a.stop.0 + a.stop.2 <= a.width as f32);
    }

    #[test]
    fn the_corners_are_clear_and_the_middle_is_the_pill() {
        let (l, buf) = painted(30, 1.0, false);
        assert_eq!(at(&buf, &l, 0, 0), [0, 0, 0, 0], "outside the rounded end");
        assert_eq!(at(&buf, &l, l.width - 1, 0), [0, 0, 0, 0]);
        let mid = at(&buf, &l, (l.text.0 + 2) as u32, l.height / 2);
        assert_eq!(mid[3], (BACK_ALPHA * 255.0).round() as u8);
        // Premultiplied: no channel above alpha.
        for p in buf.chunks_exact(4) {
            assert!(p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
        }
    }

    #[test]
    fn the_dot_is_red_and_the_stop_square_light() {
        let (l, buf) = painted(30, 1.0, false);
        let dot = at(&buf, &l, l.dot.0 as u32, l.dot.1 as u32);
        assert_eq!(dot[3], 255);
        assert!(dot[2] > 200 && dot[1] < 90 && dot[0] < 90, "{dot:?}");
        let (sx, sy, side) = l.stop;
        let stop = at(&buf, &l, (sx + side / 2.0) as u32, (sy + side / 2.0) as u32);
        assert_eq!(stop, [240, 240, 240, 255]);
    }

    #[test]
    fn text_drawn_by_the_window_stays_opaque() {
        let l = layout(30, 1.0);
        let mut buf = Vec::new();
        for _ in 0..l.width * l.height {
            buf.extend_from_slice(&[BACK[2], BACK[1], BACK[0], 0]);
        }
        let (x, y) = ((l.text.0 + 5) as u32, l.height / 2);
        let i = ((y * l.width + x) * 4) as usize;
        buf[i..i + 3].copy_from_slice(&[200, 200, 200]);
        shade(&mut buf, &l, false);
        assert_eq!(at(&buf, &l, x, y), [200, 200, 200, 255]);
    }

    #[test]
    fn hover_lightens_the_pill() {
        let (l, plain) = painted(30, 1.0, false);
        let (_, hover) = painted(30, 1.0, true);
        let x = (l.text.0 + 2) as u32;
        assert!(at(&hover, &l, x, l.height / 2)[0] > at(&plain, &l, x, l.height / 2)[0]);
    }

    #[test]
    fn placed_centred_below_the_top_of_the_work_area() {
        let l = layout(30, 1.0);
        let (x, y) = place((0, 0, 1920, 1040), &l, 1.0);
        assert_eq!(x, (1920 - l.width as i32) / 2);
        assert_eq!(y, 10);
        let (x2, y2) = place((-2560, 40, 0, 1440), &l, 2.0);
        assert_eq!(x2, -2560 + (2560 - l.width as i32) / 2);
        assert_eq!(y2, 60);
    }
}
