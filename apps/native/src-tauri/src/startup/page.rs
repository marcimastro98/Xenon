// What the app does each time a page loads in one of its windows.

#[cfg(desktop)]
use crate::*;

/// The page-load hook of `run`. Only loads of the dashboard itself do anything.
pub(crate) fn on_page_load(_webview: &tauri::webview::Webview, _payload: &tauri::webview::PageLoadPayload<'_>) {
    #[cfg(desktop)]
    {
        use std::sync::atomic::Ordering;
        // A cancelled `xenon-app:` signal also ends in a page-load event
        // (src/page_load.rs): none of the work below is for it.
        let started = matches!(_payload.event(), tauri::webview::PageLoadEvent::Started);
        let is_dashboard = matches!(
            _payload.url().host_str(),
            Some("127.0.0.1") | Some("localhost")
        ) && page_load::real(_webview.label(), started);
        // "Widgets only" (server/js/usage-mode.js): the server sends the
        // main window to the driver page instead of the dashboard. The
        // URL alone says which one loaded, so the window hides before the
        // driver paints and comes back when the dashboard loads. Only the
        // main webview's loads count: this hook also fires for every
        // widget-layer window, whose page is `/` too. Nor does the splash:
        // it is not the dashboard leaving the driver.
        if is_dashboard
            && _webview.label() == "main"
            && nav_policy::is_backend_page(_payload.url(), monitor::backend_port())
        {
            if let Some(win) = _webview.app_handle().get_webview_window("main") {
                let url = _payload.url();
                let full = url.query_pairs().any(|(k, v)| k == "full" && v == "1");
                let on_driver = url.path() == monitor::DRIVER_PATH;
                if monitor::set_driver(&win, on_driver, full) {
                    let app = _webview.app_handle().clone();
                    std::thread::spawn(move || layers::driver_left(&app));
                }
                // Not on `Started`: that one still has the address before
                // the server's redirect to the driver.
                if !started && monitor::opened_to_nothing(on_driver) {
                    let app = _webview.app_handle().clone();
                    std::thread::spawn(move || monitor::show_now(&app));
                }
                // A window that starts hidden (phone mode, a login
                // start) never passed through `hide_window`.
                if !win.is_visible().unwrap_or(true) {
                    memory_level::set_low(&win, true);
                }
            }
        }
        if is_dashboard && !UPDATE_CHECK_STARTED.swap(true, Ordering::SeqCst) {
            spawn_update_check(_webview.app_handle().clone());
        }
        // First accurate display state: the init-script snapshot is built
        // before the window exists, so it carries no `active` screen.
        if is_dashboard {
            monitor::push_display_state(_webview.app_handle());
        }
        // Old dashboards can't update their own backend — offer it from
        // here (no-op on new dashboards; see legacy_rescue_js). Delayed
        // so the dashboard's scripts (XenonToast, t()) have settled.
        if is_dashboard && !LEGACY_RESCUE_STARTED.swap(true, Ordering::SeqCst) {
            let app = _webview.app_handle().clone();
            let ver = app.package_info().version.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval(legacy_rescue_js(&ver));
                }
            });
        }
    }
}
