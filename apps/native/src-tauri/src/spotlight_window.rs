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

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "spotlight";
const URL: &str = "http://127.0.0.1:3030/spotlight?frameless=1";
const W: f64 = 680.0;
const W_EXPANDED: f64 = 780.0;
const H_COMPACT: f64 = 64.0;
const H_EXPANDED: f64 = 620.0;

/// Top-left logical position that centers the pill horizontally on the primary
/// monitor, a Spotlight-like quarter down from its top.
fn place(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let mw = mon.size().width as f64 / scale;
        let mx = mon.position().x as f64 / scale;
        let my = mon.position().y as f64 / scale;
        let mh = mon.size().height as f64 / scale;
        return (mx + (mw - W) / 2.0, my + mh * 0.22);
    }
    (200.0, 200.0)
}

pub fn open(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let (x, y) = place(app);
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(W, H_COMPACT));
        // Self-heal: the window is created ONCE — if its first navigation
        // failed (e.g. the backend was still booting), hide/show would keep a
        // blank webview forever. Reload our page whenever it is not there.
        let _ = win.eval(&format!(
            "if (!document.querySelector('.spotlight')) location.replace('{URL}');"
        ));
        let _ = win.show();
        // Re-assert on every open: cheap, and it survives anything that
        // dropped the topmost bit while the window was hidden.
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
        return;
    }
    let (x, y) = place(app);
    let handle = app.clone();
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
        .visible(true)
        .focused(true)
        .on_navigation(move |url| {
            if url.scheme() == "xenon-app" {
                match url.path() {
                    "spotlight-close" => hide(&handle),
                    "spotlight-expand" => resize(&handle, H_EXPANDED),
                    "spotlight-collapse" => resize(&handle, H_COMPACT),
                    _ => {}
                }
                return false;
            }
            true
        });
    // SAME browser args as the main webview — WebView2 rejects (silently,
    // asynchronously) a second webview whose environment options differ from
    // the ones the shared user-data folder was opened with. See
    // `crate::browser_args`.
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::browser_args(crate::gpu::webview_gpu_flag()));
    let built = builder.build();
    match built {
        Ok(win) => {
            // Transient surface: clicking elsewhere dismisses it, like Spotlight.
            let handle = app.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    hide(&handle);
                }
            });
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

fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
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
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x - (w - W) / 2.0, y));
    }
}
