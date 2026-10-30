//! The steps recorder's pure parts: the ring drawn where the user clicked,
//! file names, the words that say what was clicked, and which clicks count.
//! The Win32 side (hooks, capture, UI Automation) lives in `win::steps`;
//! X11's in `linux::steps`, the Mac's in `mac::steps`.

/// A recording stops by itself after this many steps.
pub const MAX_STEPS: usize = 100;
/// A picture wider than this is scaled down: readable, and a document of a
/// hundred steps stays small enough to share.
pub const IMAGE_WIDTH: u32 = 1600;
/// The longest name kept for the thing that was clicked.
pub const NAME_MAX: usize = 80;

/// Ring sizes at 100% scale, in pixels.
const RING_RADIUS: f32 = 22.0;
const RING_WIDTH: f32 = 4.0;
/// A dark edge on each side of the red, so the ring shows on any background.
const RING_EDGE: f32 = 1.5;
const RED: [u8; 3] = [232, 64, 64];
const EDGE: [u8; 3] = [20, 20, 20];

/// A second press this close in time and place is the end of a double click.
const DOUBLE_MS: u64 = 500;
const DOUBLE_PX: i32 = 8;

/// "step-007.jpg": sorts in order in any file list.
pub fn file_name(n: usize) -> String {
    format!("step-{n:03}.jpg")
}

/// True when the press at (`x`, `y`) `ms` after the previous one at
/// `prev` only finishes a double click on the same spot.
pub fn is_double(prev: Option<(i32, i32, u64)>, x: i32, y: i32, ms: u64) -> bool {
    prev.is_some_and(|(px, py, pt)| {
        ms.saturating_sub(pt) <= DOUBLE_MS
            && (x - px).abs() <= DOUBLE_PX
            && (y - py).abs() <= DOUBLE_PX
    })
}

/// One line, no control characters, at most NAME_MAX characters.
pub fn clean_name(raw: &str) -> String {
    let words: Vec<&str> = raw
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect();
    let line = words.join(" ");
    if line.chars().count() <= NAME_MAX {
        return line;
    }
    let mut cut: String = line.chars().take(NAME_MAX - 1).collect();
    cut.push('…');
    cut
}

/// The kind of thing clicked, from its UI Automation control type, in the
/// few words the document uses; "" when the kind says nothing useful.
pub fn role(control_type: i32) -> &'static str {
    match control_type {
        50000 | 50031 => "button",
        50002 => "checkbox",
        50003 => "dropdown",
        50004 => "field",
        50005 => "link",
        50007 | 50024 | 50029 => "item",
        50009..=50011 => "menu",
        50013 => "option",
        50015 => "slider",
        50018 | 50019 => "tab",
        _ => "",
    }
}

/// False when the element under the click is a whole window, pane, title bar
/// or document: its name is the window's title or the file's, not the thing
/// clicked, so the step says "the circled spot" instead.
pub fn names_the_click(control_type: i32) -> bool {
    !matches!(control_type, 50030 | 50032 | 50033 | 50037)
}

/// The saved picture's size: at most IMAGE_WIDTH wide, the shape kept, both
/// sides even (the JPEG's colour is stored at half size). Windows sizes its
/// pictures in `win::steps`.
#[cfg_attr(windows, allow(dead_code))]
pub fn picture_size(width: u32, height: u32) -> (u32, u32) {
    let even = |v: u32| (v.max(2)) & !1;
    if width <= IMAGE_WIDTH {
        return (even(width), even(height));
    }
    let h = (u64::from(height) * u64::from(IMAGE_WIDTH) / u64::from(width.max(1))) as u32;
    (IMAGE_WIDTH, even(h))
}

/// Draws the click ring centred on (`cx`, `cy`) into a picture of tight
/// 24-bit BGR rows, `scale` times its 100% size.
pub fn ring(bgr: &mut [u8], width: u32, height: u32, cx: i32, cy: i32, scale: f32) {
    let s = scale.max(0.5);
    let radius = RING_RADIUS * s;
    let half = RING_WIDTH * s / 2.0;
    let edge = RING_EDGE * s;
    let reach = (radius + half + edge + 1.0).ceil() as i32;
    let (w, h) = (width as i32, height as i32);
    if bgr.len() < (width * height * 3) as usize {
        return;
    }
    for y in (cy - reach).max(0)..(cy + reach + 1).min(h) {
        for x in (cx - reach).max(0)..(cx + reach + 1).min(w) {
            let dx = x as f32 + 0.5 - (cx as f32 + 0.5);
            let dy = y as f32 + 0.5 - (cy as f32 + 0.5);
            let off = ((dx * dx + dy * dy).sqrt() - radius).abs();
            let red = (half + 0.5 - off).clamp(0.0, 1.0);
            let dark = (half + edge + 0.5 - off).clamp(0.0, 1.0) - red;
            if red <= 0.0 && dark <= 0.0 {
                continue;
            }
            let i = ((y * w + x) * 3) as usize;
            for (c, slot) in bgr[i..i + 3].iter_mut().enumerate() {
                // BGR in the picture, RGB in the colours.
                let base = *slot as f32;
                let with_edge = base + (EDGE[2 - c] as f32 - base) * dark;
                *slot = (with_edge + (RED[2 - c] as f32 - with_edge) * red).round() as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_sort_in_order() {
        assert_eq!(file_name(7), "step-007.jpg");
        assert_eq!(file_name(100), "step-100.jpg");
    }

    #[test]
    fn a_double_click_counts_once() {
        assert!(!is_double(None, 10, 10, 0));
        assert!(is_double(Some((10, 10, 1000)), 13, 8, 1300));
        assert!(!is_double(Some((10, 10, 1000)), 13, 8, 1600), "too late");
        assert!(!is_double(Some((10, 10, 1000)), 40, 10, 1100), "too far");
    }

    #[test]
    fn names_are_one_short_line() {
        assert_eq!(clean_name("  Save\n as…\t"), "Save as…");
        assert_eq!(clean_name("a\u{7}b"), "a b");
        let long = clean_name(&"x".repeat(200));
        assert_eq!(long.chars().count(), NAME_MAX);
        assert!(long.ends_with('…'));
        assert_eq!(clean_name(""), "");
    }

    #[test]
    fn roles_say_only_what_helps() {
        assert_eq!(role(50000), "button");
        assert_eq!(role(50011), "menu");
        assert_eq!(role(50004), "field");
        assert_eq!(role(50033), "", "a pane says nothing");
        assert!(names_the_click(50000), "a button keeps its name");
        for whole in [50030, 50032, 50033, 50037] {
            assert!(
                !names_the_click(whole),
                "a window title is not what was clicked"
            );
        }
        assert_eq!(role(0), "");
    }

    #[test]
    fn the_ring_is_red_on_its_line_and_leaves_the_centre_alone() {
        let (w, h) = (100u32, 100u32);
        let mut bgr = vec![255u8; (w * h * 3) as usize];
        ring(&mut bgr, w, h, 50, 50, 1.0);
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 3) as usize;
            [bgr[i + 2], bgr[i + 1], bgr[i]]
        };
        assert_eq!(
            at(50, 50),
            [255, 255, 255],
            "the clicked spot stays visible"
        );
        assert_eq!(at(72, 50), RED, "on the ring");
        assert_eq!(at(0, 0), [255, 255, 255], "far away untouched");
        let edge = at(75, 50);
        assert!(
            edge[0] < 200 && edge[1] < 200,
            "a dark edge outside the red: {edge:?}"
        );
    }

    #[test]
    fn a_ring_at_the_edge_or_on_a_short_buffer_is_safe() {
        let mut bgr = vec![0u8; 30 * 30 * 3];
        ring(&mut bgr, 30, 30, 0, 29, 2.0);
        ring(&mut bgr, 30, 30, -500, 900, 1.0);
        let mut short = vec![0u8; 10];
        ring(&mut short, 30, 30, 5, 5, 1.0);
    }
}
