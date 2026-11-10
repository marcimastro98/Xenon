//! The Spotlight window — the global-hotkey search as a real native surface:
//! frameless, always-on-top, centered on the PRIMARY monitor (deliberately
//! not the Edge: the hotkey is pressed while working there). It loads the
//! same `/spotlight` page the Edge-popup fallback uses, with `?frameless=1`.
//!
//! Deliberately OPAQUE, PowerToys-Run-style: the window is sized exactly to
//! the pill and the page fills it with the theme surface; Windows rounds the
//! corners of undecorated windows on its own. A transparent window was tried
//! and rendered BLANK on hybrid-GPU machines: gpu.rs pins every WebView2 in
//! this process to the adapter driving the Edge (the iGPU), while this window
//! sits on the primary monitor (the dGPU) — cross-adapter composition of a
//! transparent webview produces no pixels. Do not switch transparency back on
//! without testing exactly that configuration.
//!
//! Choreography is scheme-driven like everything else in this shell (see
//! lib.rs `on_navigation`): the MAIN webview requests `xenon-app:spotlight-open`
//! when the server broadcasts the hotkey; the spotlight page itself navigates
//! `xenon-app:spotlight-close|expand|collapse` for Esc/✕ and the grow/shrink
//! that follows typing. Losing focus hides the window (Apple behavior) — it is
//! a transient surface, never a resident one.
//!
//! Except with Bit's chat open in it (`xenon-app:spotlight-chat`, js/spotlight-chat.js):
//! then it is an ordinary window at the expanded size that stays when focus goes
//! elsewhere, so you can copy from another app and come back with the hotkey. It
//! stays out of captures, or "look at my screen" would photograph the chat itself.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "spotlight";
const URL: &str = "http://127.0.0.1:3030/spotlight?frameless=1";
const W: f64 = 680.0;
const W_EXPANDED: f64 = 780.0;
const H_COMPACT: f64 = 64.0;
const H_EXPANDED: f64 = 620.0;
/// After the first show, a focus loss is the webview starting up, not the user leaving.
const SETTLE: Duration = Duration::from_millis(1500);
/// Kept free at the screen's edges, taskbar included.
const EDGE: f64 = 48.0;

static CHAT: AtomicBool = AtomicBool::new(false);

/// Top-left logical position that centers the pill horizontally on the primary
/// monitor, a Spotlight-like quarter down from its top.
fn place(app: &AppHandle) -> (f64, f64) {
    if let Some(mon) = crate::monitor::app_primary(app) {
        let scale = mon.scale_factor();
        let mw = mon.size().width as f64 / scale;
        let mx = mon.position().x as f64 / scale;
        let my = mon.position().y as f64 / scale;
        let mh = mon.size().height as f64 / scale;
        return (mx + (mw - W) / 2.0, my + mh * 0.22);
    }
    (200.0, 200.0)
}

/// Top and height of the primary monitor, logical.
fn span(app: &AppHandle) -> Option<(f64, f64)> {
    let mon = crate::monitor::app_primary(app)?;
    let scale = mon.scale_factor();
    Some((mon.position().y as f64 / scale, mon.size().height as f64 / scale))
}

/// Top and height for a window that wants to start at `wanted`, kept on a monitor
/// that may be too short for it: it moves up first, then shrinks.
fn fit(wanted: f64, h: f64, top: f64, tall: f64) -> (f64, f64) {
    let h = h.min(tall - 2.0 * EDGE);
    let bottom = top + tall - EDGE;
    (if wanted + h <= bottom { wanted } else { bottom - h }, h)
}

/// Show the window with the keyboard in it. The first open comes through here too,
/// and is built hidden: built visible, it took the foreground before its webview
/// was ready, and the first press after launch showed nothing.
fn reveal(app: &AppHandle, win: &tauri::WebviewWindow, chat: bool) {
    crate::memory_level::set_low(win, false);
    let _ = win.show();
    // Re-assert on every open: cheap, and it survives anything that
    // dropped the topmost bit while the window was hidden.
    if !chat {
        let _ = win.set_always_on_top(true);
    }
    let _ = win.set_focus();
    // The hotkey reached the helper, not this process, so Windows can refuse.
    crate::layers::force_focus(app, win);
}

pub fn open(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let chat = CHAT.load(Ordering::Relaxed);
        if !chat {
            let (x, y) = place(app);
            let _ = win.set_position(LogicalPosition::new(x, y));
            let _ = win.set_size(LogicalSize::new(W, H_COMPACT));
        }
        // Self-heal: the window is created ONCE — if its first navigation
        // failed (e.g. the backend was still booting), hide/show would keep a
        // blank webview forever. Reload our page whenever it is not there.
        let _ = win.eval(format!(
            "if (!document.querySelector('.spotlight')) location.replace('{URL}'); \
             else if (window.__spotlightShown) window.__spotlightShown();"
        ));
        reveal(app, &win, chat);
        return;
    }
    let (x, y) = place(app);
    let handle = app.clone();
    let nonce = crate::nav_policy::new_nonce();
    let nonce_js = crate::nav_policy::nonce_script(&nonce, spotlight_port());
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(URL.parse().unwrap()))
        .title("Xenon Search")
        .decorations(false)
        // Neutral dark until the page paints its theme surface — never the
        // WebView2 white default.
        .background_color(tauri::window::Color(15, 16, 18, 255))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(W, H_COMPACT)
        .position(x, y)
        .visible(false)
        .focused(false)
        // Its own signal nonce (nav_policy.rs), and no page but Xenon's.
        .initialization_script(&nonce_js)
        .on_navigation(move |raw| {
            if crate::nav_policy::is_signal(raw) {
                let Some(url) = crate::nav_policy::verified_signal(raw, &nonce) else { return false };
                if url.scheme() != "xenon-app" { return false; }
                match url.path() {
                    "spotlight-close" => hide(&handle),
                    // The page sends these two only with the chat closed: they
                    // also stand in for a `spotlight-search` the next signal replaced.
                    "spotlight-expand" => { leave_chat(&handle); resize(&handle, H_EXPANDED) }
                    "spotlight-collapse" | "spotlight-search" => { leave_chat(&handle); resize(&handle, H_COMPACT) }
                    "spotlight-chat" => enter_chat(&handle),
                    // The chat's way to Settings and the Sparks shop.
                    "open-dashboard" => crate::layers::open_asked_dashboard(&handle, &url, true),
                    _ => {}
                }
                return false;
            }
            crate::nav_policy::is_own_page(raw, spotlight_port())
        });
    // SAME browser args as the main webview — WebView2 rejects (silently,
    // asynchronously) a second webview whose environment options differ from
    // the ones the shared user-data folder was opened with. See
    // `crate::browser_args`.
    // `applied()`, never a fresh decision: the flag is read back from the one the
    // process launched with. Recomputing it here meant that plugging the Edge in
    // after launch changed the answer, so these options no longer matched the ones
    // the shared user-data folder was opened with — and WebView2's refusal is
    // silent, so Spotlight simply stopped opening with nothing in any log.
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::browser_args(crate::gpu::applied()));
    let built = builder.build();
    match built {
        Ok(win) => {
            // Transient surface: clicking elsewhere dismisses it, like Spotlight.
            let (handle, own, shown) = (app.clone(), win.clone(), Instant::now());
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if shown.elapsed() < SETTLE {
                        crate::layers::force_focus(&handle, &own);
                    } else if !CHAT.load(Ordering::Relaxed) {
                        hide(&handle);
                    }
                }
            });
            reveal(app, &win, false);
        }
        Err(e) => {
            // A failed build can leave a naked OS window (the "black bar") with
            // no webview inside — and the error was invisible. Breadcrumb it.
            let _ = std::fs::write(
                std::env::temp_dir().join("xenon-spotlight-error.txt"),
                format!("{e:?}"),
            );
        }
    }
}

fn enter_chat(app: &AppHandle) {
    CHAT.store(true, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_always_on_top(false);
        let _ = win.set_content_protected(true);
    }
    resize(app, H_EXPANDED);
}

fn leave_chat(app: &AppHandle) {
    if !CHAT.swap(false, Ordering::Relaxed) {
        return;
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_content_protected(false);
        let _ = win.set_always_on_top(true);
    }
}

fn hide(app: &AppHandle) {
    leave_chat(app);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
        // Hidden between searches, often for hours: give its memory back.
        crate::memory_level::set_low(&win, true);
        // Back to the compact pill so the NEXT open never flashes tall.
        let _ = win.set_size(LogicalSize::new(W, H_COMPACT));
    }
}

fn resize(app: &AppHandle, h: f64) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let w = if h > 200.0 { W_EXPANDED } else { W };
        // place() centers for the compact width — shift by the delta so the
        // pill stays optically centered when the window widens for results.
        let (x, y) = place(app);
        let (y, h) = span(app).map_or((y, h), |(top, tall)| fit(y, h, top, tall));
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x - (w - W) / 2.0, y));
    }
}

/// The backend's port (XENON_PORT, 3030 by default), as the main window reads it.
fn spotlight_port() -> u16 {
    std::env::var("XENON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3030)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_that_fits_stays_where_it_wants() {
        assert_eq!(fit(238.0, H_EXPANDED, 0.0, 1080.0), (238.0, H_EXPANDED));
        assert_eq!(fit(238.0, H_COMPACT, 0.0, 1080.0), (238.0, H_COMPACT));
    }

    #[test]
    fn a_short_screen_moves_it_up_first() {
        assert_eq!(fit(169.0, H_EXPANDED, 0.0, 768.0), (100.0, H_EXPANDED));
    }

    #[test]
    fn a_screen_too_short_shrinks_it_inside_the_edges() {
        assert_eq!(fit(132.0, H_EXPANDED, 0.0, 600.0), (EDGE, 504.0));
    }

    #[test]
    fn the_monitor_top_counts_on_a_screen_above_the_primary() {
        assert_eq!(fit(-400.0, H_EXPANDED, -700.0, 768.0), (-600.0, H_EXPANDED));
    }
}
