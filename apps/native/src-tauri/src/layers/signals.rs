// What the dashboard asks of the layer windows: a sync, a dashboard brought forward, the glow on the edges, the menu and the screensaver.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use super::{APP, close, desks, Live, LIVE, menu_aside, menu_window, pad, SAVER_DONE, saver_held, spec};
#[cfg(not(windows))]
use super::place;
#[cfg(target_os = "linux")]
use super::{linux, linux as backend, plan};
#[cfg(target_os = "macos")]
use super::{macos as backend, plan};
#[cfg(windows)]
use super::{plan, repaint_desktop_soon, scene, win32 as backend};
use super::spec::{Kind, Surface};
use super::window::open;
/// How the edge glow is drawn on this OS: the same `Screen::of`, `Plan` and `apply`.
#[cfg(target_os = "linux")]
use super::glow_linux as glow_backend;
#[cfg(target_os = "macos")]
use super::glow_macos as glow_backend;
#[cfg(windows)]
use super::glow_win32 as glow_backend;
// Only Windows asks for the window handle here (force_focus).
#[cfg(windows)]
use super::native_handle;
// Only the file named glow, not the function of the same name defined below.
use super::glow::{self};

/// Which screensavers of a sync may open now. None after the user ended one,
/// until the sync drops them; none while an app keeps the screen on or a
/// window is in full screen (they are asked for again on the next sync).
fn allow_savers(surfaces: &mut Vec<Surface>, live: &[Live]) {
    let asked = surfaces.iter().any(|s| s.kind == Kind::Saver);
    if !asked {
        SAVER_DONE.store(false, Ordering::Relaxed);
        return;
    }
    let open = live.iter().any(|l| l.surface.kind == Kind::Saver);
    let blocked = SAVER_DONE.load(Ordering::Relaxed)
        || (!open && saver_held());
    if blocked {
        surfaces.retain(|s| s.kind != Kind::Saver);
    }
}

/// The query value `d` of a signal URL, decoded.
pub(super) fn query(url: &tauri::Url, name: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

fn payload(url: &tauri::Url) -> Option<String> {
    query(url, "d")
}

/// `xenon-app:layers-sync` from the main dashboard. Call on a plain thread.
pub fn sync(app: &AppHandle, url: &tauri::Url) {
    let Some(mut spec) = payload(url).as_deref().and_then(spec::parse) else { return };
    let _ = APP.set(app.clone());
    desks::want(app, spec.desks);
    pad::want(app, spec.pad);
    let Ok(mut live) = LIVE.lock() else { return };
    #[cfg(not(windows))]
    spec.surfaces.retain(|s| backend::draws(s.kind));
    // Windows draws on the screen with the capture engine's own sheet.
    #[cfg(windows)]
    spec.surfaces.retain(|s| s.kind != Kind::Draw);
    allow_savers(&mut spec.surfaces, &live);
    let staying = live
        .iter()
        .filter(|l| l.surface.kind == Kind::Menu && spec.surfaces.iter().any(|s| s.key == l.surface.key))
        .find_map(|l| app.get_webview_window(&l.label));
    menu_window::follow(staying.as_ref(), spec.top, spec.front);
    // A Wayland session without layer-shell (GNOME) gets no layer windows:
    // they would sit wherever the compositor puts a normal window. The
    // dashboard already sends none there.
    #[cfg(target_os = "linux")]
    if !linux::usable() {
        spec.surfaces.clear();
    }
    // A surface whose kind changed gets a fresh window: the behaviours differ.
    // A window that is gone (a wallpaper goes with Explorer) is opened again.
    live.retain(|l| {
        let alive = app.get_webview_window(&l.label).is_some();
        let keep = alive && spec.surfaces.iter().any(|s| s.key == l.surface.key && s.kind == l.surface.kind);
        if !keep {
            if let Some(win) = app.get_webview_window(&l.label).filter(|_| l.surface.kind == Kind::Menu) {
                menu_window::remember(app, &win);
            }
            close(app, &l.label);
            #[cfg(windows)]
            if l.surface.kind == Kind::Wallpaper {
                repaint_desktop_soon();
            }
        }
        keep
    });
    for s in &spec.surfaces {
        match live.iter_mut().find(|l| l.surface.key == s.key) {
            Some(l) => l.surface = s.clone(),
            None => live.extend(open(app, s)),
        }
    }
    let mut plans = Vec::with_capacity(live.len());
    for l in live.iter_mut() {
        let aside = l.surface.kind == Kind::Menu && menu_aside();
        if let Some(out) = l.shield.want(spec::out_of_captures(&l.surface.key, &spec), aside) {
            tell_captures(app, l, out);
        }
        plans.push(plan(app, l));
    }
    let _ = app.run_on_main_thread(move || backend::apply(plans));
    // Moved onto the screen only after `apply` is queued: a new window must
    // not sit full size, taking clicks and focus, before it is set up.
    #[cfg(not(windows))]
    for l in live.iter() {
        if let Some(win) = app.get_webview_window(&l.label) {
            place(app, &win, &l.surface);
        }
    }
}

/// Bring a window forward over the app in use when the key that asked for it
/// reached the helper and not this process (scene::force_focus). On macOS and
/// Linux the window's own `set_focus` is enough.
pub fn force_focus(app: &AppHandle, win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Some(h) = native_handle(win) {
        let _ = app.run_on_main_thread(move || scene::force_focus(h));
    }
    #[cfg(not(windows))]
    let _ = (app, win);
}

/// `xenon-app:open-dashboard`: the dashboard, on what spec::dashboard_page allows.
pub fn open_asked_dashboard(app: &AppHandle, url: &tauri::Url, menu: bool) {
    let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (open, cat) = (query("open"), query("cat"));
    if let Some((page, cat)) = spec::dashboard_page(url.path(), open.as_deref(), cat.as_deref(), menu) {
        crate::monitor::open_dashboard(app, page, cat);
    }
}

/// A dashboard is coming up: the window the menu or a saver took the focus from
/// must not get it back over it.
pub fn keep_focus_here(app: &AppHandle) {
    let _ = app.run_on_main_thread(backend::forget_return_focus);
}

/// The main window left the "widgets only" driver for the dashboard. Only the
/// driver asks for the alerts window, and a dashboard with nothing placed sends
/// no sync at all (layers-shell.js), so the window would stay. Plain thread:
/// `sync` can hold LIVE while it waits on the main thread.
pub fn driver_left(app: &AppHandle) {
    let Ok(mut live) = LIVE.lock() else { return };
    let before = live.len();
    live.retain(|l| {
        let alerts = spec::is_alerts(&l.surface.key);
        if alerts {
            close(app, &l.label);
        }
        !alerts
    });
    if live.len() == before {
        return;
    }
    let plans: Vec<backend::Plan> = live.iter().map(|l| plan(app, l)).collect();
    let _ = app.run_on_main_thread(move || backend::apply(plans));
}

/// Keep a window out of captures, or let it in (shield.rs says when). LIVE held.
fn tell_captures(app: &AppHandle, l: &mut Live, out: bool) {
    let Some(win) = app.get_webview_window(&l.label) else { return };
    if win.set_content_protected(out).is_ok() {
        l.shield.told(out);
    }
}

/// The menu is back from aside: it hears what a sync kept from it. Plain
/// thread: `sync` can hold LIVE while it waits on the main thread.
pub(super) fn menu_back(app: &AppHandle, label: &str) {
    let Ok(mut live) = LIVE.lock() else { return };
    let Some(l) = live.iter_mut().find(|l| l.label == label) else { return };
    if let Some(out) = l.shield.due(false) {
        tell_captures(app, l, out);
    }
}

/// `xenon-app:saver-done` from a screensaver page: the user is back. Close
/// every screensaver now rather than wait for the server's next status.
/// Plain thread, like `sync`.
pub(super) fn saver_done(app: &AppHandle) {
    SAVER_DONE.store(true, Ordering::Relaxed);
    let Ok(mut live) = LIVE.lock() else { return };
    live.retain(|l| {
        let saver = l.surface.kind == Kind::Saver;
        if saver {
            close(app, &l.label);
        }
        !saver
    });
    let plans: Vec<backend::Plan> = live.iter().map(|l| plan(app, l)).collect();
    let _ = app.run_on_main_thread(move || backend::apply(plans));
}

/// `xenon-app:ai-glow` from the main dashboard: light the edges of the chosen
/// screens while Xenon AI listens, thinks or speaks (glow.rs). Call on a plain
/// thread: the monitor lookup goes through the event loop.
pub fn glow(app: &AppHandle, url: &tauri::Url) {
    let Some(spec) = payload(url).as_deref().and_then(glow::parse) else { return };
    // A monitor that is gone resolves to the main one; the same screen twice
    // is drawn once (glow_backend::apply).
    let monitors = spec.monitors.iter().filter_map(|id| crate::monitor::layer_monitor(app, id)).collect();
    paint_glow(app, spec.state, spec.rgb, spec.still, monitors);
}

/// The same from the on-screen alerts window, where Bit answers in "widgets
/// only" (server/js/screen-bit.js). It names the screens setting, not the
/// screens: only the main webview gets the display list. Plain thread.
pub(super) fn glow_from_alerts(app: &AppHandle, url: &tauri::Url) {
    let Some(spec) = payload(url).as_deref().and_then(glow::parse_screens) else { return };
    let mut monitors = Vec::new();
    if spec.state != glow::State::Off {
        let all = crate::monitor::monitors_with_primary(app);
        let primary: Vec<bool> = all.iter().map(|(_, p)| *p).collect();
        let picked = glow::pick(spec.screens, &primary);
        monitors = all.into_iter().enumerate().filter(|(i, _)| picked.contains(i)).map(|(_, (m, _))| m).collect();
    }
    paint_glow(app, spec.state, spec.rgb, spec.still, monitors);
}

fn paint_glow(app: &AppHandle, state: glow::State, rgb: [u8; 3], still: bool, monitors: Vec<tauri::Monitor>) {
    let screens = monitors.iter().map(glow_backend::Screen::of).collect();
    let plan = glow_backend::Plan { state, rgb, still, screens };
    let _ = app.run_on_main_thread(move || glow_backend::apply(plan));
}
