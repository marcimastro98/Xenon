//! Bit on the desktop: the person's own Bit standing on the taskbar of one
//! screen, drawn by one plain native window rather than a webview, so it costs
//! a few MB and no browser process: a layered window on Windows (win32.rs), a
//! non-activating panel on macOS (macos.rs, on top of the Dock), a GTK window
//! or layer surface on Linux (linux.rs). macOS and Linux are Beta: built here
//! and checked to compile, not yet run on a real Mac or Linux PC.
//!
//! The dashboard keeps the brain (js/bit-companion/desk.js): it renders the
//! clips with the person's own look into cells and sends them, a whole clip at
//! a time, as `xenon-app:bit-desk?d=<json>`; the shell plays the frames on its
//! own timer and moves the window only while Bit walks. This file holds the
//! message rule and the pixels (the lane on the taskbar is ground.rs, what Bit
//! does with them state.rs): plain functions with tests, the same on every OS.

use serde::Deserialize;
use tauri::Manager;

pub use ground::{along, lane, place, rise_of, spot, step, Area, Lane};

mod ground;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod state;
#[cfg(test)]
mod unit_tests;
#[cfg(windows)]
mod win32;
#[cfg(windows)]
mod window_win32;
#[cfg(target_os = "linux")]
mod window_linux;

/// How Bit's window is drawn on this OS: the same `apply(Plan)`.
#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(windows)]
use win32 as backend;

const MAX_PAYLOAD: usize = 64 * 1024;
/// Cells on a side, at most: Bit's stage is 18 x 17, with room for what it holds.
pub const MAX_SIDE: usize = 24;
const MAX_FRAMES: usize = 24;
const MAX_COLOURS: usize = 16;
const FRAME_MS: (u32, u32) = (40, 5000);
/// Logical pixels per cell: 3 makes a Bit about 36 px tall at 100%.
const CELL: (u32, u32) = (2, 6);
const DEFAULT_CELL: u32 = 3;
/// Walking speed in logical pixels a second.
const PXS: (f64, f64) = (4.0, 400.0);

#[derive(Deserialize)]
struct WireFrame {
    ms: u32,
    rows: Vec<String>,
}

#[derive(Deserialize)]
struct WireOnce {
    seq: u32,
    frames: Vec<WireFrame>,
}

#[derive(Deserialize)]
struct WireWalk {
    seq: u32,
    to: f64,
    pxs: f64,
}

#[derive(Deserialize)]
struct Wire {
    on: bool,
    #[serde(default)]
    monitor: String,
    #[serde(default)]
    cell: u32,
    #[serde(default)]
    pal: Vec<String>,
    #[serde(default, rename = "loop")]
    looped: Vec<WireFrame>,
    once: Option<WireOnce>,
    #[serde(default)]
    home: f64,
    rise: Option<f64>,
    #[serde(default)]
    body: u32,
    walk: Option<WireWalk>,
}

/// One frame: `w * h` cells, 0 empty, else 1 + its palette index.
#[derive(Clone, PartialEq, Debug)]
pub struct Frame {
    pub ms: u32,
    pub cells: Vec<u8>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Once {
    pub seq: u32,
    pub frames: Vec<Frame>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Walk {
    pub seq: u32,
    /// Where it goes along the lane, 0 (left end) to 1 (right end).
    pub to: f64,
    pub pxs: f64,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct Spec {
    pub on: bool,
    /// A display id as the shell reports them; '' is the main screen.
    pub monitor: String,
    pub cell: u32,
    pub pal: Vec<[u8; 3]>,
    pub w: usize,
    pub h: usize,
    /// The bottom rows that are Bit itself (the rest is room for what it holds up): what has to fit in the taskbar.
    pub body: usize,
    /// The mood, played in a loop.
    pub looped: Vec<Frame>,
    /// A clip played once, then the loop again; a new `seq` plays it.
    pub once: Option<Once>,
    /// Where it lives along the lane, 0 to 1.
    pub home: f64,
    /// Left away from the bar: how high, 0 (top of the desktop) to 1 (on the lane); None on the bar.
    pub rise: Option<f64>,
    /// A walk from where it stands; a new `seq` starts it.
    pub walk: Option<Walk>,
}

fn printable(s: &str) -> bool {
    s.len() <= 64 && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn colour(s: &str) -> Option<[u8; 3]> {
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(s, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

fn fraction(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

/// Frames that share one grid of `w` x `h`, or None.
fn frames(wire: &[WireFrame], colours: usize, size: &mut Option<(usize, usize)>) -> Option<Vec<Frame>> {
    if wire.is_empty() || wire.len() > MAX_FRAMES {
        return None;
    }
    let mut out = Vec::with_capacity(wire.len());
    for f in wire {
        let h = f.rows.len();
        let w = f.rows.first()?.len();
        if h == 0 || w == 0 || h > MAX_SIDE || w > MAX_SIDE || size.is_some_and(|s| s != (w, h)) {
            return None;
        }
        *size = Some((w, h));
        let mut cells = Vec::with_capacity(w * h);
        for row in &f.rows {
            if row.len() != w {
                return None;
            }
            for b in row.bytes() {
                cells.push(match b {
                    b'.' => 0,
                    b'A'..=b'P' if usize::from(b - b'A') < colours => b - b'A' + 1,
                    _ => return None,
                });
            }
        }
        out.push(Frame { ms: f.ms.clamp(FRAME_MS.0, FRAME_MS.1), cells });
    }
    Some(out)
}

/// The message, or None when it breaks the rule. Off needs nothing else.
pub fn parse(json: &str) -> Option<Spec> {
    if json.len() > MAX_PAYLOAD {
        return None;
    }
    let wire: Wire = serde_json::from_str(json).ok()?;
    if !wire.on {
        return Some(Spec::default());
    }
    if !printable(&wire.monitor) || wire.pal.is_empty() || wire.pal.len() > MAX_COLOURS {
        return None;
    }
    let pal = wire.pal.iter().map(|c| colour(c)).collect::<Option<Vec<_>>>()?;
    let mut size = None;
    let looped = frames(&wire.looped, pal.len(), &mut size)?;
    let once = match wire.once {
        Some(o) => Some(Once { seq: o.seq, frames: frames(&o.frames, pal.len(), &mut size)? }),
        None => None,
    };
    let (w, h) = size?;
    let walk = wire.walk.filter(|w| w.to.is_finite() && w.pxs.is_finite()).map(|w| Walk {
        seq: w.seq,
        to: fraction(w.to),
        pxs: w.pxs.clamp(PXS.0, PXS.1),
    });
    let body = if wire.body == 0 { h } else { (wire.body as usize).min(h) };
    let cell = if wire.cell == 0 { DEFAULT_CELL } else { wire.cell.clamp(CELL.0, CELL.1) };
    let rise = wire.rise.filter(|r| r.is_finite()).map(fraction);
    Some(Spec { on: true, monitor: wire.monitor, cell, pal, w, h, body, looped, once, home: fraction(wire.home), rise, walk })
}

/// A frame as premultiplied BGRA rows, top-down, `cell` pixels a cell, mirrored
/// when Bit faces left. Every cell is opaque: the gaps stay at alpha 0.
pub fn paint(frame: &Frame, w: usize, h: usize, pal: &[[u8; 3]], cell: usize, mirror: bool) -> Vec<u8> {
    let (pw, ph) = (w * cell, h * cell);
    let mut px = vec![0u8; pw * ph * 4];
    for cy in 0..h {
        for cx in 0..w {
            let k = frame.cells.get(cy * w + cx).copied().unwrap_or(0);
            let Some([r, g, b]) = k.checked_sub(1).and_then(|i| pal.get(usize::from(i))).copied() else { continue };
            let col = if mirror { w - 1 - cx } else { cx };
            for y in cy * cell..(cy + 1) * cell {
                for x in col * cell..(col + 1) * cell {
                    let i = (y * pw + x) * 4;
                    px[i..i + 4].copy_from_slice(&[b, g, r, 255]);
                }
            }
        }
    }
    px
}

/// Where Bit is drawn: what the page asked, on which screen, at which scale.
pub struct Plan {
    pub spec: Spec,
    pub mon: Area,
    pub work: Area,
    pub scale: f64,
}

impl Plan {
    fn of(spec: Spec, m: Option<&tauri::Monitor>) -> Self {
        let Some(m) = m else { return Plan { spec, mon: Area::default(), work: Area::default(), scale: 1.0 } };
        let (p, s) = (m.position(), m.size());
        let w = m.work_area();
        Plan {
            spec,
            mon: Area { l: p.x, t: p.y, r: p.x + s.width as i32, b: p.y + s.height as i32 },
            work: Area { l: w.position.x, t: w.position.y, r: w.position.x + w.size.width as i32, b: w.position.y + w.size.height as i32 },
            scale: m.scale_factor(),
        }
    }
}

/// Where the shell can draw it (the caps' `bitDesk`, which also needs the
/// layer windows: on Linux not on GNOME Wayland or X11 without a compositor).
pub fn supported() -> bool {
    cfg!(any(windows, target_os = "macos", target_os = "linux"))
}

/// The wheel over Bit: one size up (away from the person) or down, for the page to
/// choose and keep (desk.js `resize`). Nothing for a still wheel.
pub(super) fn wheel_call(up: f64) -> Option<String> {
    if !up.is_finite() || up == 0.0 {
        return None;
    }
    Some(format!("resize({})", if up > 0.0 { 1 } else { -1 }))
}

/// The page's `window.BitDesk`, told with numbers only.
fn tell(call: String) {
    let Some(app) = super::APP.get() else { return };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("try{{window.BitDesk&&window.BitDesk.{call}}}catch(e){{}}"));
    }
}

/// `xenon-app:bit-desk` from the main dashboard. Call on a plain thread.
pub fn signal(app: &tauri::AppHandle, url: &tauri::Url) {
    let Some(spec) = super::signals::query(url, "d").as_deref().and_then(parse) else { return };
    let _ = super::APP.set(app.clone());
    // A screen that is gone resolves to the main one (layer_monitor).
    let monitor = if spec.on { crate::monitor::layer_monitor(app, &spec.monitor) } else { None };
    if spec.on && monitor.is_none() {
        return;
    }
    let plan = Plan::of(spec, monitor.as_ref());
    let _ = app.run_on_main_thread(move || backend::apply(plan));
}
