//! Bit's pocket in a little window of its own, just over the desktop Bit the
//! person tapped (layers/bit_desk.rs): frameless, on top, out of the taskbar,
//! the size of the card. Before it the pocket opened alone in the Xenon menu's
//! big window: a small card in the middle of a grey screen.
//!
//! Like Spotlight (spotlight_window.rs) it is opaque (a transparent webview
//! renders blank across GPUs), built hidden and shown at once, and goes when
//! the focus leaves it. Its page is the pocket alone
//! (`/?panel=sheet&open=pocket&alone=pocket`, js/ai/sheet-page.js), which
//! sends `xenon-app:bit-pocket-fit?h=` with the card's height and
//! `xenon-app:bit-pocket-close` when the pocket closed. Hidden for a while the
//! window is closed: an occasional tap must not keep a webview alive.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "bit-pocket";
/// The card's width, logical (components/BitPocket/BitPocket.css).
const W: f64 = 360.0;
/// Its height until the page tells the real one.
const H_FIRST: f64 = 250.0;
const H_MIN: f64 = 80.0;
const H_MAX: f64 = 560.0;
/// Between the tap and the window, logical: Bit's head and its sign stay in sight.
const GAP: f64 = 52.0;
/// Kept free at the work area's edges, logical.
const MARGIN: f64 = 8.0;
/// After a show, a focus loss is the webview starting up, not the person leaving.
const SETTLE: Duration = Duration::from_millis(1500);
/// Hidden this long, the window is closed.
const CLOSE_AFTER: Duration = Duration::from_secs(90);

/// Where it opens: the tap, in physical pixels, and the work area of the screen
/// under it with that screen's scale.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Anchor {
    x: i32,
    y: i32,
    work: [i32; 4],
    scale: f64,
}

struct Shown {
    anchor: Anchor,
    h: f64,
    at: Instant,
}

static NOW: Mutex<Option<Shown>> = Mutex::new(None);
/// Bumped on every show and hide, so a late close from an older hide does nothing.
static TURN: AtomicU64 = AtomicU64::new(0);

/// The window's rectangle, physical: centred on the tap and above it, or below
/// it with no room above, always whole inside the work area.
fn rect(a: Anchor, h: f64) -> [i32; 4] {
    let px = |v: f64| (v * a.scale).round() as i32;
    let [wx, wy, ww, wh] = a.work;
    let margin = px(MARGIN);
    let w = px(W).min(ww - 2 * margin).max(1);
    let h = px(h.clamp(H_MIN, H_MAX)).min(wh - 2 * margin).max(1);
    let x = (a.x - w / 2).min(wx + ww - margin - w).max(wx + margin);
    let above = a.y - px(GAP) - h;
    let y = if above >= wy + margin { above } else { a.y + px(GAP / 2.0) };
    [x, y.min(wy + wh - margin - h).max(wy + margin), w, h]
}

/// The tap: the pointer is on Bit. No pointer to read (some Linux sessions):
/// the bottom middle of the main screen, where the desktop Bit lives.
fn anchor_now(app: &AppHandle) -> Option<Anchor> {
    let main = app.get_webview_window("main");
    if let Some((at, m)) = main.as_ref().and_then(crate::monitor::pointer) {
        let area = m.work_area();
        let work = [area.position.x, area.position.y, area.size.width as i32, area.size.height as i32];
        return Some(Anchor { x: at.x as i32, y: at.y as i32, work, scale: m.scale_factor() });
    }
    let m = crate::monitor::app_primary(app)?;
    let area = m.work_area();
    let work = [area.position.x, area.position.y, area.size.width as i32, area.size.height as i32];
    Some(Anchor { x: work[0] + work[2] / 2, y: work[1] + work[3], work, scale: m.scale_factor() })
}

fn page() -> Option<tauri::Url> {
    let port = crate::monitor::backend_port();
    tauri::Url::parse(&format!("http://127.0.0.1:{port}/?panel=sheet&open=pocket&alone=pocket")).ok()
}

/// Puts the window where the shown pocket wants it, at height `h` (logical).
fn put(win: &tauri::WebviewWindow, anchor: Anchor, h: f64) {
    let [x, y, w, h] = rect(anchor, h);
    // Position first: moved to a screen with another scale the system resizes
    // it, and the size set after that is the one that stays.
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// A tap on the desktop Bit: the pocket opens over it, or closes if it is open.
/// Plain thread: the pointer and the screens are read on the main one.
pub fn open(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        if win.is_visible().unwrap_or(false) {
            hide(app);
            return;
        }
    }
    let Some(anchor) = anchor_now(app) else { return };
    let h = NOW.lock().ok().and_then(|n| n.as_ref().map(|s| s.h)).unwrap_or(H_FIRST);
    if let Ok(mut now) = NOW.lock() {
        *now = Some(Shown { anchor, h, at: Instant::now() });
    }
    TURN.fetch_add(1, Ordering::SeqCst);
    let win = match app.get_webview_window(LABEL) {
        Some(win) => {
            // Still loaded from the last time: a fresh pocket, or the page again.
            let again = page().map(|u| format!(
                "if (window.XenonSheet && window.XenonSheet.again) window.XenonSheet.again(); else location.replace('{u}');"
            ));
            if let Some(js) = again {
                let _ = win.eval(js);
            }
            win
        }
        None => match build(app) {
            Some(win) => win,
            None => return,
        },
    };
    put(&win, anchor, h);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    // The tap reached a window that never takes the focus: Windows may refuse it.
    crate::layers::force_focus(app, &win);
}

fn build(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let url = page()?;
    let handle = app.clone();
    let nonce = crate::nav_policy::new_nonce();
    let nonce_js = crate::nav_policy::nonce_script(&nonce, crate::monitor::backend_port());
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Bit")
        .decorations(false)
        // The card's own surface until the page paints, never the webview's white.
        .background_color(tauri::window::Color(24, 26, 29, 255))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(W, H_FIRST)
        .visible(false)
        .focused(false)
        // Its own signal nonce (nav_policy.rs), and no page but Xenon's.
        .initialization_script(&nonce_js)
        .on_navigation(move |raw| navigate(&handle, &nonce, raw));
    // The main webview's own arguments: they share its profile (spotlight_window.rs).
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::browser_args(crate::gpu::applied()));
    match builder.build() {
        Ok(win) => {
            let (handle, own) = (app.clone(), win.clone());
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if !own.is_visible().unwrap_or(false) {
                        return;
                    }
                    let fresh = NOW.lock().ok().and_then(|n| n.as_ref().map(|s| s.at.elapsed() < SETTLE)).unwrap_or(false);
                    if fresh {
                        crate::layers::force_focus(&handle, &own);
                    } else {
                        hide(&handle);
                    }
                }
            });
            Some(win)
        }
        Err(e) => {
            crate::crash_log::note("bit-pocket", &format!("failed to open: {e}"));
            None
        }
    }
}

fn navigate(app: &AppHandle, nonce: &str, raw: &tauri::Url) -> bool {
    if !crate::nav_policy::is_signal(raw) {
        return crate::nav_policy::is_own_page(raw, crate::monitor::backend_port());
    }
    let Some(url) = crate::nav_policy::verified_signal(raw, nonce) else { return false };
    if url.scheme() != "xenon-app" {
        return false;
    }
    match url.path() {
        "bit-pocket-fit" => {
            let h = url.query_pairs().find(|(k, _)| k == "h").and_then(|(_, v)| v.parse::<f64>().ok());
            if let Some(h) = h.filter(|h| h.is_finite()) {
                fit(app, h);
            }
        }
        "bit-pocket-close" => hide(app),
        _ => {}
    }
    false
}

/// The card's height from the page: the window takes it, over the same tap.
fn fit(app: &AppHandle, h: f64) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let anchor = match NOW.lock() {
        Ok(mut now) => match now.as_mut() {
            Some(s) => {
                s.h = h.clamp(H_MIN, H_MAX);
                s.anchor
            }
            None => return,
        },
        Err(_) => return,
    };
    put(&win, anchor, h);
}

fn hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let _ = win.hide();
    // A pocket left open by a click elsewhere closes, so the next tap starts clean.
    let _ = win.eval("window.BitPocket && window.BitPocket.isOpen() && window.BitPocket.close();");
    let turn = TURN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_AFTER);
        if TURN.load(Ordering::SeqCst) == turn && !win.is_visible().unwrap_or(true) {
            let _ = win.close();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: [i32; 4] = [0, 0, 1920, 1032];

    #[test]
    fn it_opens_above_the_tap_centred_on_it() {
        let a = Anchor { x: 600, y: 1050, work: WORK, scale: 1.0 };
        assert_eq!(rect(a, 250.0), [420, 748, 360, 250]);
    }

    #[test]
    fn it_stays_whole_at_the_screens_edges() {
        let left = rect(Anchor { x: 10, y: 1050, work: WORK, scale: 1.0 }, 250.0);
        assert_eq!(left[0], 8);
        let right = rect(Anchor { x: 1915, y: 1050, work: WORK, scale: 1.0 }, 250.0);
        assert_eq!(right[0] + right[2], 1912);
    }

    #[test]
    fn with_no_room_above_it_opens_below() {
        let r = rect(Anchor { x: 600, y: 40, work: WORK, scale: 1.0 }, 250.0);
        assert_eq!(r[1], 66);
    }

    #[test]
    fn it_scales_and_keeps_to_a_second_screen() {
        let a = Anchor { x: 3000, y: 2150, work: [1920, 0, 2560, 2100], scale: 1.5 };
        let [x, y, w, h] = rect(a, 200.0);
        assert_eq!([w, h], [540, 300]);
        assert_eq!(x, 3000 - 270);
        assert_eq!(y, 2150 - 78 - 300);
    }

    #[test]
    fn a_wild_height_is_kept_to_the_screen() {
        let small = Anchor { x: 400, y: 600, work: [0, 0, 800, 600], scale: 1.0 };
        let [_, y, _, h] = rect(small, 10_000.0);
        assert_eq!(h, 560);
        assert!(y >= 8 && y + h <= 592);
        assert_eq!(rect(small, -5.0)[3], 80);
    }
}
