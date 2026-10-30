//! What the dashboard asks the shell to draw, validated at the boundary: the
//! `xenon-app:layers-sync?d=<json>` payload and the `xenon-app:layer-rects`
//! report of a layer page. Both arrive from our own loopback page, but they are
//! still wire data: keys follow the same rule as `server/js/layer-host.js`,
//! numbers are clamped like `server/js/layers-model.js`, and anything else is
//! dropped rather than guessed.

use serde::Deserialize;

/// layers-model.js caps placements at 24, so there can never be more widget
/// surfaces; one more for the on-screen alerts window, one for the drawing
/// sheet, and a wallpaper and a screensaver for up to 8 screens.
pub const MAX_SURFACES: usize = 26 + 2 * 8;
const MAX_RECTS: usize = 24;
const MAX_PAYLOAD: usize = 16 * 1024;
const MAX_COORD: i32 = 20_000;
const ANCHOR_MIN_PX: i32 = 80;
const ANCHOR_MAX_PX: i32 = 2000;
const ANCHOR_MAX_OFFSET: i32 = 4000;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Desktop,
    Overlay,
    Anchor,
    /// The Ambient scene behind the desktop icons (scene.rs).
    Wallpaper,
    /// The Ambient scene over everything after the PC sat idle.
    Saver,
    /// The see-through drawing sheet over the whole screen, off Windows
    /// (server/js/screen-draw-page.js); Windows draws with the capture engine.
    Draw,
    /// The Xenon menu over the whole main screen (server/js/screen-menu-page.js):
    /// over everything, takes the keyboard, gives it back when it closes.
    Menu,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
pub struct Anchor {
    pub app: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    corner: String,
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
    #[serde(default)]
    pub w: i32,
    #[serde(default)]
    pub h: i32,
}

impl Anchor {
    pub fn corner(&self) -> Corner {
        match self.corner.as_str() {
            "tl" => Corner::TopLeft,
            "bl" => Corner::BottomLeft,
            "br" => Corner::BottomRight,
            _ => Corner::TopRight,
        }
    }
}

#[derive(Deserialize, Clone, PartialEq, Debug)]
pub struct Surface {
    pub key: String,
    pub kind: Kind,
    #[serde(default)]
    pub monitor: String,
    #[serde(default)]
    pub anchor: Option<Anchor>,
}

#[derive(Deserialize, Default, Debug)]
pub struct Spec {
    /// Keep every layer window out of screenshots and recordings.
    #[serde(default)]
    pub exclude: bool,
    #[serde(default)]
    pub surfaces: Vec<Surface>,
    /// Some page is tied to a virtual desktop: say which one is shown (desks.rs).
    #[serde(default)]
    pub desks: bool,
    /// Holding View + Menu on a controller opens the Xenon menu (pad.rs).
    #[serde(default)]
    pub pad: bool,
}

fn printable(s: &str, max: usize) -> bool {
    s.len() <= max && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// The same rule as KEY_RE in layer-host.js.
pub fn valid_key(key: &str) -> bool {
    if let Some(id) = key.strip_prefix("anchor:lw_") {
        return (4..=24).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    }
    match key.split_once(':') {
        // `alerts:` is the on-screen alerts window of "widgets only";
        // `wallpaper:`/`saver:` the Ambient scene (js/screen-scene-model.js);
        // `draw:` the drawing sheet, `menu:` the Xenon menu (js/layers-shell.js).
        Some(("desktop" | "overlay" | "alerts" | "wallpaper" | "saver" | "draw" | "menu", monitor)) => printable(monitor, 64),
        _ => false,
    }
}

/// The on-screen alerts window (server/js/screen-alerts.js), not a widget layer.
pub fn is_alerts(key: &str) -> bool {
    key.starts_with("alerts:")
}

/// The Ambient scene's windows, which load /scene instead of a layer page.
pub fn is_scene(key: &str) -> bool {
    key.starts_with("wallpaper:") || key.starts_with("saver:")
}

/// The drawing sheet's window, which loads /draw.
pub fn is_draw(key: &str) -> bool {
    key.starts_with("draw:")
}

/// The Xenon menu's window, which loads /menu.
pub fn is_menu(key: &str) -> bool {
    key.starts_with("menu:")
}

/// Settings categories the Xenon menu opens (server/xenon-menu.js), the same
/// list as SETTINGS_CATS in server/js/dashboard-open.js.
const SETTINGS_CATS: [&str; 10] = [
    "appearance", "capture", "general", "notifications", "ai", "smarthome", "spotify", "streaming", "unifi",
    "slideshow",
];

/// A dashboard screen a window may ask for, `(open, cat)`: the alerts window's
/// update card (`xenon-app:open-dashboard?open=update`), the Xenon menu's
/// gallery, Settings category or plain dashboard (`menu`). Anything else asks
/// nothing; an unknown category opens Settings as it was.
pub fn dashboard_page(path: &str, open: Option<&str>, cat: Option<&str>, menu: bool) -> Option<(&'static str, Option<&'static str>)> {
    if path != "open-dashboard" {
        return None;
    }
    match open {
        Some("update") if !menu => Some(("update", None)),
        Some("gallery") if menu => Some(("gallery", None)),
        Some("dashboard") if menu => Some(("dashboard", None)),
        Some("settings") if menu => Some(("settings", SETTINGS_CATS.iter().find(|c| Some(**c) == cat).copied())),
        _ => None,
    }
}

/// A tile's Set up button on a widget on the screen (utils.js
/// openSettingsCategory): Settings on a known category of the dashboard, and
/// nothing else, so a layer page cannot ask for the update or gallery screens.
pub fn tile_settings(path: &str, open: Option<&str>, cat: Option<&str>) -> Option<(&'static str, Option<&'static str>)> {
    if path != "open-dashboard" || open != Some("settings") {
        return None;
    }
    Some(("settings", SETTINGS_CATS.iter().find(|c| Some(**c) == cat).copied()))
}

/// An executable name (Windows) or app name, never a path: the same rule as
/// APP_RE in layers-model.js.
fn valid_app(app: &str) -> bool {
    !app.is_empty()
        && app.chars().count() <= 128
        && !app.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
}

fn clean_anchor(mut a: Anchor) -> Option<Anchor> {
    if !valid_app(&a.app) {
        return None;
    }
    a.title = a.title.chars().filter(|c| !c.is_control()).take(128).collect();
    a.dx = a.dx.clamp(-ANCHOR_MAX_OFFSET, ANCHOR_MAX_OFFSET);
    a.dy = a.dy.clamp(-ANCHOR_MAX_OFFSET, ANCHOR_MAX_OFFSET);
    a.w = a.w.clamp(ANCHOR_MIN_PX, ANCHOR_MAX_PX);
    a.h = a.h.clamp(ANCHOR_MIN_PX, ANCHOR_MAX_PX);
    Some(a)
}

/// A surface whose key, kind and monitor agree, or None. The monitor is taken
/// from the key, so the two can never point at different screens.
fn clean_surface(mut s: Surface) -> Option<Surface> {
    if !valid_key(&s.key) {
        return None;
    }
    let (prefix, rest) = s.key.split_once(':')?;
    match (prefix, s.kind) {
        ("desktop", Kind::Desktop)
        | ("overlay" | "alerts", Kind::Overlay)
        | ("wallpaper", Kind::Wallpaper)
        | ("saver", Kind::Saver)
        | ("draw", Kind::Draw)
        | ("menu", Kind::Menu) => {
            s.monitor = rest.to_string();
            s.anchor = None;
            Some(s)
        }
        ("anchor", Kind::Anchor) => {
            s.monitor.clear();
            s.anchor = Some(clean_anchor(s.anchor.take()?)?);
            Some(s)
        }
        _ => None,
    }
}

/// The sync payload, or None when it is not JSON at all. Invalid surfaces and
/// repeated keys are dropped one by one; an empty list closes every layer.
pub fn parse(json: &str) -> Option<Spec> {
    if json.len() > MAX_PAYLOAD {
        return None;
    }
    let raw: Spec = serde_json::from_str(json).ok()?;
    let mut surfaces: Vec<Surface> = Vec::new();
    for s in raw.surfaces.into_iter().filter_map(clean_surface) {
        if surfaces.len() >= MAX_SURFACES {
            break;
        }
        if !surfaces.iter().any(|x| x.key == s.key) {
            surfaces.push(s);
        }
    }
    Some(Spec { exclude: raw.exclude, surfaces, desks: raw.desks, pad: raw.pad })
}

/// A layer page's tile rectangles, in device pixels of its own window:
/// `x,y,w,h;x,y,w,h`. Malformed entries are skipped, empty ones too.
pub fn parse_rects(s: &str) -> Vec<[i32; 4]> {
    s.split(';')
        .filter_map(|part| {
            let n: Vec<i32> = part.split(',').filter_map(|v| v.trim().parse().ok()).collect();
            let [x, y, w, h] = <[i32; 4]>::try_from(n).ok()?;
            let r = [
                x.clamp(-MAX_COORD, MAX_COORD),
                y.clamp(-MAX_COORD, MAX_COORD),
                w.clamp(0, MAX_COORD),
                h.clamp(0, MAX_COORD),
            ];
            (r[2] > 0 && r[3] > 0).then_some(r)
        })
        .take(MAX_RECTS)
        .collect()
}

/// Whether a point, in the same device pixels as the rectangles, is on one of
/// them: macOS has no window regions, so its windows let the mouse through
/// everywhere else (macos.rs). Edges: left and top in, right and bottom out.
#[cfg(any(target_os = "macos", test))]
pub fn hit(rects: &[[i32; 4]], x: f64, y: f64) -> bool {
    rects.iter().any(|r| {
        let (l, t) = (f64::from(r[0]), f64::from(r[1]));
        x >= l && y >= t && x < l + f64::from(r[2]) && y < t + f64::from(r[3])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_is_inside_a_tile_only() {
        let rects = [[100, 50, 200, 100], [400, 400, 10, 10]];
        assert!(hit(&rects, 100.0, 50.0));
        assert!(hit(&rects, 299.9, 149.9));
        assert!(!hit(&rects, 300.0, 100.0));
        assert!(!hit(&rects, 99.9, 60.0));
        assert!(hit(&rects, 405.0, 405.0));
        assert!(!hit(&[], 0.0, 0.0));
        // A cursor off the window (negative, or past its edge) is on nothing.
        assert!(!hit(&rects, -5.0, -5.0));
    }

    #[test]
    fn the_alerts_window_may_open_only_the_update_screen() {
        assert_eq!(dashboard_page("open-dashboard", Some("update"), None, false), Some(("update", None)));
        for (path, open) in [
            ("open-dashboard", None),
            ("open-dashboard", Some("settings")),
            ("open-dashboard", Some("update ")),
            ("open-dashboard", Some("gallery")),
            ("layer-rects", Some("update")),
        ] {
            assert_eq!(dashboard_page(path, open, None, false), None, "{path} {open:?}");
        }
    }

    #[test]
    fn the_menu_opens_the_gallery_the_dashboard_or_a_known_settings_category() {
        let page = |open, cat| dashboard_page("open-dashboard", open, cat, true);
        assert_eq!(page(Some("gallery"), None), Some(("gallery", None)));
        assert_eq!(page(Some("dashboard"), Some("capture")), Some(("dashboard", None)));
        assert_eq!(page(Some("settings"), Some("capture")), Some(("settings", Some("capture"))));
        assert_eq!(page(Some("settings"), Some("../x")), Some(("settings", None)));
        assert_eq!(page(Some("update"), None), None, "the update screen is the alerts card's");
        assert_eq!(page(Some("chat"), None), None);
        assert_eq!(dashboard_page("ai-glow", Some("gallery"), None, true), None);
    }

    #[test]
    fn a_widget_on_the_screen_may_open_only_settings() {
        let page = |open, cat| tile_settings("open-dashboard", open, cat);
        assert_eq!(page(Some("settings"), Some("streaming")), Some(("settings", Some("streaming"))));
        assert_eq!(page(Some("settings"), Some("../x")), Some(("settings", None)));
        for open in [None, Some("update"), Some("gallery"), Some("dashboard"), Some("settings ")] {
            assert_eq!(page(open, Some("ai")), None, "{open:?}");
        }
        assert_eq!(tile_settings("layer-rects", Some("settings"), None), None);
    }

    #[test]
    fn the_menu_surface_is_its_own_kind() {
        let s = parse(r#"{"surfaces":[{"key":"menu:","kind":"menu"},{"key":"menu:x","kind":"overlay"},{"key":"overlay:y","kind":"menu"}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Menu, ""));
        assert!(is_menu("menu:") && !is_menu("draw:") && !is_draw("menu:") && !is_scene("menu:"));
    }

    #[test]
    fn keys_follow_the_page_rule() {
        assert!(valid_key("desktop:"));
        assert!(valid_key("overlay:\\\\.\\DISPLAY2"));
        assert!(valid_key("anchor:lw_ab12"));
        assert!(valid_key("alerts:"));
        for bad in ["desk:", "anchor:../x", "anchor:lw_AB12", "desktop:\u{1}", "overlay", "alerts:\u{1}"] {
            assert!(!valid_key(bad), "{bad}");
        }
        assert!(!valid_key(&format!("desktop:{}", "x".repeat(65))));
    }

    #[test]
    fn the_alerts_window_is_an_overlay_and_nothing_else() {
        let s = parse(r#"{"surfaces":[{"key":"alerts:","kind":"overlay"},{"key":"alerts:x","kind":"desktop"},{"key":"alerts:y","kind":"anchor","anchor":{"app":"a.exe"}}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Overlay, ""));
        assert!(is_alerts(&s.surfaces[0].key));
        assert!(!is_alerts("overlay:"));
    }

    #[test]
    fn the_scene_windows_match_their_kind() {
        let s = parse(r#"{"surfaces":[
            {"key":"wallpaper:DISPLAY2","kind":"wallpaper"},
            {"key":"saver:DISPLAY2","kind":"saver","monitor":"DISPLAY9"},
            {"key":"saver:x","kind":"overlay"},
            {"key":"wallpaper:y","kind":"saver"},
            {"key":"overlay:z","kind":"wallpaper"}
        ]}"#).unwrap();
        let got: Vec<(&str, Kind, &str)> = s.surfaces.iter().map(|x| (x.key.as_str(), x.kind, x.monitor.as_str())).collect();
        assert_eq!(got, vec![("wallpaper:DISPLAY2", Kind::Wallpaper, "DISPLAY2"), ("saver:DISPLAY2", Kind::Saver, "DISPLAY2")]);
        assert!(is_scene("wallpaper:") && is_scene("saver:A"));
        assert!(!is_scene("overlay:") && !is_scene("alerts:"));
        assert!(!valid_key("saver:\u{1}") && !valid_key(&format!("wallpaper:{}", "x".repeat(65))));
    }

    #[test]
    fn a_full_widget_set_leaves_room_for_the_scenes() {
        let widgets: Vec<String> = (0..24).map(|i| format!(r#"{{"key":"anchor:lw_{i:04}","kind":"anchor","anchor":{{"app":"a.exe"}}}}"#)).collect();
        let scenes: Vec<String> = (0..8)
            .flat_map(|i| [format!(r#"{{"key":"wallpaper:D{i}","kind":"wallpaper"}}"#), format!(r#"{{"key":"saver:D{i}","kind":"saver"}}"#)])
            .collect();
        let json = format!(
            r#"{{"surfaces":[{{"key":"draw:","kind":"draw"}},{{"key":"alerts:","kind":"overlay"}},{},{}]}}"#,
            widgets.join(","),
            scenes.join(",")
        );
        assert_eq!(parse(&json).unwrap().surfaces.len(), MAX_SURFACES);
    }

    #[test]
    fn the_drawing_sheet_is_a_draw_window_and_nothing_else() {
        let s = parse(r#"{"surfaces":[{"key":"draw:","kind":"draw"},{"key":"draw:x","kind":"overlay"},{"key":"overlay:y","kind":"draw"}]}"#).unwrap();
        assert_eq!(s.surfaces.len(), 1);
        assert_eq!((s.surfaces[0].kind, s.surfaces[0].monitor.as_str()), (Kind::Draw, ""));
        assert!(is_draw("draw:") && !is_draw("overlay:") && !is_scene("draw:"));
    }

    #[test]
    fn a_surface_takes_its_monitor_from_its_key() {
        let s = parse(r#"{"surfaces":[{"key":"desktop:DISPLAY2","kind":"desktop","monitor":"DISPLAY9"}]}"#).unwrap();
        assert_eq!(s.surfaces[0].monitor, "DISPLAY2");
    }

    #[test]
    fn a_kind_that_contradicts_its_key_is_dropped() {
        let s = parse(r#"{"surfaces":[{"key":"desktop:","kind":"overlay"},{"key":"anchor:lw_ab12","kind":"desktop"}]}"#).unwrap();
        assert!(s.surfaces.is_empty());
    }

    #[test]
    fn an_anchor_needs_an_app_name_and_gets_clamped() {
        let s = parse(r#"{"exclude":true,"surfaces":[
            {"key":"anchor:lw_ab12","kind":"anchor","anchor":{"app":"krita.exe","corner":"bl","w":5,"h":99999,"dx":-99999}},
            {"key":"anchor:lw_cd34","kind":"anchor","anchor":{"app":"C:\\x\\evil.exe"}},
            {"key":"anchor:lw_ef56","kind":"anchor"}
        ]}"#).unwrap();
        assert!(s.exclude);
        assert_eq!(s.surfaces.len(), 1);
        let a = s.surfaces[0].anchor.as_ref().unwrap();
        assert_eq!((a.w, a.h, a.dx), (ANCHOR_MIN_PX, ANCHOR_MAX_PX, -ANCHOR_MAX_OFFSET));
        assert_eq!(a.corner(), Corner::BottomLeft);
    }

    #[test]
    fn desks_is_off_unless_the_dashboard_asks() {
        assert!(!parse(r#"{"surfaces":[]}"#).unwrap().desks);
        assert!(parse(r#"{"desks":true,"surfaces":[]}"#).unwrap().desks);
        assert!(!parse(r#"{"surfaces":[]}"#).unwrap().pad, "the controller is read only when asked");
        assert!(parse(r#"{"pad":true,"surfaces":[]}"#).unwrap().pad);
    }

    #[test]
    fn repeated_keys_and_extra_surfaces_are_dropped() {
        let many: Vec<String> = (0..50).map(|i| format!(r#"{{"key":"anchor:lw_{i:04}","kind":"anchor","anchor":{{"app":"a.exe"}}}}"#)).collect();
        let json = format!(r#"{{"surfaces":[{{"key":"desktop:","kind":"desktop"}},{{"key":"desktop:","kind":"desktop"}},{}]}}"#, many.join(","));
        let s = parse(&json).unwrap();
        assert_eq!(s.surfaces.len(), MAX_SURFACES);
        assert_eq!(s.surfaces.iter().filter(|x| x.key == "desktop:").count(), 1);
    }

    #[test]
    fn junk_is_refused_not_guessed() {
        assert!(parse("not json").is_none());
        assert!(parse(&"x".repeat(MAX_PAYLOAD + 1)).is_none());
        assert!(parse("{}").unwrap().surfaces.is_empty());
    }

    #[test]
    fn rects_skip_malformed_and_empty_entries() {
        assert_eq!(parse_rects("10,20,300,200;bad;1,2,0,5;5,6,7"), vec![[10, 20, 300, 200]]);
        assert_eq!(parse_rects("0,0,99999999,4"), vec![[0, 0, MAX_COORD, 4]]);
        assert!(parse_rects("").is_empty());
        let many = vec!["1,1,1,1"; 100].join(";");
        assert_eq!(parse_rects(&many).len(), MAX_RECTS);
    }
}
