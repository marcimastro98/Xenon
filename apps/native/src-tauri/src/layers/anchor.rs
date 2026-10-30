//! Where an anchored widget goes, the same on every OS: which window of the
//! chosen app it follows and the rectangle next to that window. Pure, so the
//! three backends (win32.rs, anchor_macos.rs, anchor_x11.rs) share one rule
//! and it is tested here, off any screen.

use super::spec::{Anchor, Corner};

/// The app name lowercased, without a trailing ".exe".
fn stem(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => lower,
    }
}

/// `want` is the app the person picked from the open apps (server
/// capabilities/layer-anchor.js): the executable on Windows ("krita.exe"),
/// the app's name on macOS ("Microsoft Excel"), the window class on Linux
/// ("krita"). Case and ".exe" do not matter; a part of a name never matches.
pub fn app_matches(want: &str, name: &str) -> bool {
    let want = stem(want);
    !want.is_empty() && want == stem(name)
}

/// The widget's rectangle `[left, top, width, height]` at `corner` of `frame`
/// (`[left, top, right, bottom]`), in the frame's units. `scale` turns the
/// anchor's pixels at 100 % into those units; each length is rounded on its
/// own, so whole-pixel frames give whole-pixel widgets.
pub fn rect_for(frame: [f64; 4], a: &Anchor, scale: f64) -> [f64; 4] {
    let px = |v: i32| (f64::from(v) * scale).round();
    let (w, h, dx, dy) = (px(a.w), px(a.h), px(a.dx), px(a.dy));
    let [l, t, r, b] = frame;
    let (left, top) = match a.corner() {
        Corner::TopLeft => (l + dx, t + dy),
        Corner::TopRight => (r - w - dx, t + dy),
        Corner::BottomLeft => (l + dx, b - h - dy),
        Corner::BottomRight => (r - w - dx, b - h - dy),
    };
    [left, top, w, h]
}

/// A window as an OS lists it, front to back.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub id: u64,
    pub app: String,
    /// `[left, top, right, bottom]`.
    pub frame: [f64; 4],
}

/// Where a widget must be: over `target`, at `rect`; `above` says it already
/// sits right over it, so only a move is needed.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Clone, Debug, PartialEq)]
pub struct Spot {
    pub target: u64,
    pub rect: [f64; 4],
    pub above: bool,
}

/// The front window of the anchor's app in a front-to-back list (the one used
/// last, as on Windows), and the widget's place over it. `own` is the widget's
/// own window, skipped as a target. None = no window of the app on the screen
/// (closed, minimized, hidden, on another desktop): the widget hides.
#[cfg_attr(windows, allow(dead_code))]
pub fn spot(list: &[Seen], a: &Anchor, own: u64, scale: f64) -> Option<Spot> {
    let i = list.iter().position(|w| w.id != own && app_matches(&a.app, &w.app))?;
    let target = &list[i];
    let above = i > 0 && list[i - 1].id == own;
    Some(Spot { target: target.id, rect: rect_for(target.frame, a, scale), above })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(corner: &str) -> Anchor {
        serde_json::from_str(&format!(r#"{{"app":"Krita","corner":"{corner}","dx":16,"dy":16,"w":320,"h":240}}"#)).unwrap()
    }

    fn seen(id: u64, app: &str, frame: [f64; 4]) -> Seen {
        Seen { id, app: app.into(), frame }
    }

    #[test]
    fn an_app_matches_with_or_without_its_extension_and_case() {
        assert!(app_matches("krita.exe", "krita.exe"));
        assert!(app_matches("Krita", "krita.exe"));
        assert!(app_matches("EXCEL.EXE", "excel.exe"));
        assert!(app_matches("Microsoft Excel", "microsoft excel"));
        assert!(app_matches("firefox", "Firefox"));
        assert!(!app_matches("krita", "kritarunner.exe"));
        assert!(!app_matches("", ""));
        assert!(!app_matches("Code", "Visual Studio Code"));
    }

    #[test]
    fn each_corner_keeps_its_margin_inside_the_window() {
        let frame = [100.0, 50.0, 1100.0, 850.0];
        assert_eq!(rect_for(frame, &anchor("tr"), 1.0), [764.0, 66.0, 320.0, 240.0]);
        assert_eq!(rect_for(frame, &anchor("tl"), 1.0), [116.0, 66.0, 320.0, 240.0]);
        assert_eq!(rect_for(frame, &anchor("bl"), 1.0), [116.0, 594.0, 320.0, 240.0]);
        assert_eq!(rect_for(frame, &anchor("br"), 1.0), [764.0, 594.0, 320.0, 240.0]);
    }

    #[test]
    fn the_size_follows_the_screen_scale() {
        let r = rect_for([0.0, 0.0, 2000.0, 1000.0], &anchor("tr"), 1.5);
        assert_eq!(r, [2000.0 - 480.0 - 24.0, 24.0, 480.0, 360.0]);
    }

    #[test]
    fn the_front_window_of_the_app_is_followed() {
        let list = [
            seen(7, "Firefox", [0.0, 0.0, 800.0, 600.0]),
            seen(3, "krita", [100.0, 50.0, 1100.0, 850.0]),
            seen(4, "krita", [0.0, 0.0, 500.0, 500.0]),
        ];
        let s = spot(&list, &anchor("tr"), 99, 1.0).unwrap();
        assert_eq!(s.target, 3);
        assert_eq!(s.rect, [764.0, 66.0, 320.0, 240.0]);
        assert!(!s.above);
    }

    #[test]
    fn the_widget_right_over_its_window_needs_no_restacking() {
        let list = [
            seen(7, "Firefox", [0.0, 0.0, 800.0, 600.0]),
            seen(99, "Xenon", [764.0, 66.0, 1084.0, 306.0]),
            seen(3, "krita", [100.0, 50.0, 1100.0, 850.0]),
        ];
        let s = spot(&list, &anchor("tr"), 99, 1.0).unwrap();
        assert!(s.above);
        // Another window between them: it must be put back over its app.
        let list = [list[1].clone(), list[0].clone(), list[2].clone()];
        assert!(!spot(&list, &anchor("tr"), 99, 1.0).unwrap().above);
    }

    #[test]
    fn no_window_of_the_app_means_the_widget_hides() {
        let list = [seen(7, "Firefox", [0.0, 0.0, 800.0, 600.0])];
        assert_eq!(spot(&list, &anchor("tr"), 99, 1.0), None);
        assert_eq!(spot(&[], &anchor("tr"), 99, 1.0), None);
    }

    #[test]
    fn the_widget_never_follows_itself() {
        let a: Anchor = serde_json::from_str(r#"{"app":"Xenon"}"#).unwrap();
        let list = [seen(99, "Xenon", [0.0, 0.0, 10.0, 10.0])];
        assert_eq!(spot(&list, &a, 99, 1.0), None);
    }
}
