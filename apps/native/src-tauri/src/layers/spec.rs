//! What the dashboard asks the shell to draw, validated at the boundary: the
//! `xenon-app:layers-sync?d=<json>` payload and the `xenon-app:layer-rects`
//! report of a layer page. Both arrive from our own loopback page, but they are
//! still wire data: keys follow the same rule as `server/js/layer-host.js`,
//! numbers are clamped like `server/js/layers-model.js`, and anything else is
//! dropped rather than guessed.

use serde::Deserialize;

mod pages;
#[cfg(test)]
mod unit_tests;

use pages::valid_app;
pub use pages::{dashboard_page, is_alerts, is_draw, is_menu, is_scene, menu_caps_script, out_of_captures, tile_settings};

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
    /// The Xenon menu (server/js/screen-menu-page.js): a normal window with a
    /// title bar, on top only of a game, that the user moves and resizes (menu_window.rs).
    /// Takes the keyboard when it opens, gives it back when it closes.
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
    /// Xenon was recording when the menu opened (server/screen-menu.js).
    #[serde(default)]
    pub capturing: bool,
    /// A game is on: the menu stays on top of it (menu_window.rs).
    #[serde(default)]
    pub top: bool,
    /// Counts the times the server asked the open menu to come forward.
    #[serde(default)]
    pub front: u32,
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
    Some(Spec { surfaces, ..raw })
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
