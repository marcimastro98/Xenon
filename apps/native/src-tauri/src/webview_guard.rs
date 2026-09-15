//! Survive the render process dying (Linux / WebKitGTK).
//!
//! WebKit renders the page in a process of its own. When that process dies the
//! shell does not: the window stays up, still showing the last frame it was
//! handed, and every timer inside the page stops because the engine running them
//! is gone. Nothing looks broken until something forces a repaint — a click —
//! and then the window turns WHITE and stays that way until the app is
//! restarted by hand.
//!
//! That is not a hypothetical. Reported from Bazzite (Fedora-family, AppImage):
//! "the clock display keeps freezing", then the weather stopped refreshing too,
//! then "when I click on Xenon, the screen goes white and I have to restart the
//! app". Two independent timers stopping together was the tell — the clock is a
//! one-second interval, the weather a separate wall-clock chain, and they share
//! no code. Both stop only if the thing that runs them is gone.
//!
//! Two things were missing, and this is both of them:
//!
//! 1. **Nobody wrote it down.** The crash diary (tray → Open crash log) records
//!    panics in THIS process. A dead web process is not our panic, so the one
//!    event that explains everything the user sees left no trace. WebKit reports
//!    a reason; it goes in the diary now.
//! 2. **Nobody did anything about it.** There was no handler at all, which is
//!    why restarting the app by hand was the only way out.
//!
//! Windows and macOS have their own recovery for this (WebView2 reloads itself,
//! WKWebView calls `webViewWebContentProcessDidTerminate`), so this is Linux
//! only — and it is deliberately the whole file rather than a branch inside
//! `lib.rs`, in the same shape as `cursor_guard` and `focus_guard`.

#![cfg(target_os = "linux")]

use std::cell::Cell;
use std::time::{Duration, Instant};

use crate::crash_log;

/// Give up after this many automatic reloads inside [`WINDOW`].
///
/// A render process that dies once is an accident worth papering over. One that
/// dies immediately on every reload is a loop, and reloading it forever would
/// spin the CPU, fill the diary and hide the real fault behind a flickering
/// window. After the cap we stop and leave the last line in the diary, which is
/// the state the user was in before this file existed — only now with the reason
/// written down.
const MAX_RELOADS: u32 = 3;
const WINDOW: Duration = Duration::from_secs(10 * 60);

/// Let the process actually finish dying before asking for a new one. Reloading
/// from inside the signal handler re-enters WebKit while it is tearing the old
/// process down; a turn of the GTK main loop is enough to be clear of it.
const RELOAD_DELAY: Duration = Duration::from_millis(600);

thread_local! {
    /// Reload bookkeeping. Thread-local, not a global: every one of these runs
    /// on the GTK main thread, so there is nothing to synchronise and no lock to
    /// take inside a signal handler.
    static RELOADS: Cell<u32> = const { Cell::new(0) };
    static FIRST_RELOAD_AT: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Watch `window`'s web process and bring the page back when it dies.
///
/// Best-effort by construction: if the webview handle cannot be reached the app
/// is exactly as it was, which is why nothing here returns an error to a caller
/// that could not act on one anyway.
pub fn start(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // This crate re-exports its traits at the root; there is no `prelude`.
        use webkit2gtk::{glib, WebView, WebViewExt};

        let view = webview.inner();
        // The closure parameter is annotated because the signal is declared over
        // `&Self` on a trait every WebView subclass implements, so nothing in the
        // body pins it down on its own.
        view.connect_web_process_terminated(move |view: &WebView, reason| {
            // WebKit's own words for it: Crashed, ExceededMemoryLimit,
            // TerminatedByApi. Which one it is decides whether this is a driver
            // fault, a leak, or us — so it is recorded verbatim rather than
            // flattened into "it died".
            let reason = format!("{reason:?}");

            if !allow_reload() {
                crash_log::web_process_died(&reason, "gave up after repeated restarts");
                return;
            }
            crash_log::web_process_died(&reason, "reloading");

            // A GObject clone is a reference-count bump, and the timeout runs on
            // this same thread, so the view outlives the handler safely without
            // anything being Send.
            let view = view.clone();
            glib::timeout_add_local_once(RELOAD_DELAY, move || {
                view.reload();
            });
        });
    });
}

/// Whether this death is still worth reloading through. Counts inside a moving
/// [`WINDOW`]: an app left running for days may legitimately hit this a few
/// times, far apart, and each of those deserves recovering from.
fn allow_reload() -> bool {
    let now = Instant::now();
    let expired = FIRST_RELOAD_AT
        .with(|at| at.get())
        .is_none_or(|first| now.duration_since(first) > WINDOW);
    if expired {
        FIRST_RELOAD_AT.with(|at| at.set(Some(now)));
        RELOADS.with(|n| n.set(0));
    }
    RELOADS.with(|n| {
        if n.get() >= MAX_RELOADS {
            return false;
        }
        n.set(n.get() + 1);
        true
    })
}
