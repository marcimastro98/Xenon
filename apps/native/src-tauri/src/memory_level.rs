//! Let WebView2 hand back the memory of a webview nobody can see.
//!
//! A hidden window keeps everything it drew and everything its page holds: a
//! dashboard hidden for phone mode or behind the tray still sat on ~1.5 GB of
//! RAM (working set, measured 27 Oct 2026 on a hidden dashboard pinned to an
//! AMD iGPU, where video memory IS system RAM). With the memory target level at
//! `Low` the same webview dropped to 0.1-0.3 GB, and back at `Normal` it grew
//! again on its own.
//!
//! The level changes how tightly WebView2 holds memory, not what the page does:
//! timers, SSE and the widgets-only driver keep running. That is why this is used
//! rather than hiding the WebView2 controller, which would throttle the page.
//! Windows only: WKWebView and WebKitGTK have no such switch.

use tauri::WebviewWindow;

/// Best-effort: an old WebView2 runtime without the switch, or a webview that is
/// gone, simply keeps its memory as before.
pub fn set_low(window: &WebviewWindow, low: bool) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(move |webview| apply(&webview, low));
    }
    #[cfg(not(windows))]
    let _ = (window, low);
}

/// Hide or show the webview itself, which stops its page (rAF, CSS animation,
/// `document.hidden`). Only for a window that must not animate unseen: the
/// animated wallpaper behind a full-screen app (layers/scene.rs). Never for
/// the dashboard or the driver, whose timers must keep running. Windows only:
/// the other backends pause the page themselves (`set_paused`).
#[cfg(windows)]
pub fn set_visible(window: &WebviewWindow, visible: bool) {
    // SAFETY: as in `apply`, on the UI thread wry runs us on.
    let _ = window.with_webview(move |webview| unsafe {
        let _ = webview.controller().SetIsVisible(visible);
    });
}

#[cfg(windows)]
fn apply(webview: &tauri::webview::PlatformWebview, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    // SAFETY: plain COM calls on the controller wry owns, made on the thread
    // `with_webview` runs us on (the UI thread that created it).
    unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(core) = core.cast::<ICoreWebView2_19>() else { return };
        let _ = core.SetMemoryUsageTargetLevel(level);
    }
}
