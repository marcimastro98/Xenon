//! Which virtual desktop is shown, for a widget page tied to one
//! (server/layer-pages.js `deskPageSwitch`). Watched only while some page is
//! tied to a desktop (the dashboard puts `desks` in the spec, js/layers-shell.js),
//! and pushed to the main webview only when it changes, as
//! `LayersShell.onDesk({ current, count })`. Desktops count from 1; 0 is a
//! desktop with no number (a full-screen Space on the Mac).
//!
//! Windows: Explorer writes the current desktop's id to the registry and a
//! thread waits on the change notification, so nothing runs between switches
//! (desks_win32.rs). macOS: the window server's Space list, read every 500 ms
//! on a thread (desks_macos.rs, Beta, no grant asked). Linux on X11: the root
//! window's `_NET_CURRENT_DESKTOP`, on a GTK timer (desks_x11.rs). A Wayland
//! session gives no app the workspace in a common way, and the shell says so.
#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The most desktops the server takes (POST /layers/desk).
const MAX: u32 = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Desk {
    pub current: u32,
    pub count: u32,
}

impl Desk {
    fn new(current: u32, count: u32) -> Desk {
        Desk { current: current.min(MAX), count: count.min(MAX) }
    }
}

static WANTED: AtomicBool = AtomicBool::new(false);
/// Bumped on every start and stop: a watcher whose generation is gone ends.
static GEN: AtomicU32 = AtomicU32::new(0);
static LAST: Mutex<Option<Desk>> = Mutex::new(None);

/// Whether this OS can say which desktop is shown (lib.rs native caps `desks`).
pub fn supported() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(target_os = "macos")]
    return super::desks_macos::supported();
    #[cfg(target_os = "linux")]
    return super::linux::usable() && !super::linux::layer_shell();
}

/// From `sync` (plain thread): start or stop watching. Asked again while it
/// runs, it says the last desktop once more: the dashboard that asked may be a
/// fresh page that never heard it.
pub fn want(app: &AppHandle, on: bool) {
    let on = on && supported();
    let was = WANTED.swap(on, Ordering::SeqCst);
    if on == was {
        if on {
            let last = LAST.lock().ok().and_then(|l| *l);
            if let Some(d) = last {
                push(app, d);
            }
        }
        return;
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut l) = LAST.lock() {
        *l = None;
    }
    if on {
        start(app, gen);
    } else {
        stop();
    }
}

#[cfg(windows)]
fn start(app: &AppHandle, gen: u32) {
    super::desks_win32::start(app.clone(), gen);
}
#[cfg(windows)]
fn stop() {
    super::desks_win32::wake();
}

#[cfg(target_os = "macos")]
fn start(app: &AppHandle, gen: u32) {
    super::desks_macos::start(app.clone(), gen);
}
#[cfg(target_os = "macos")]
fn stop() {}

#[cfg(target_os = "linux")]
fn start(app: &AppHandle, gen: u32) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || super::desks_x11::start(handle, gen));
}
#[cfg(target_os = "linux")]
fn stop() {}

/// Whether the watcher of generation `gen` should go on.
pub(super) fn live(gen: u32) -> bool {
    WANTED.load(Ordering::SeqCst) && GEN.load(Ordering::SeqCst) == gen
}

/// A watcher read the desktop: pushed when it changed.
pub(super) fn seen(app: &AppHandle, gen: u32, desk: Desk) {
    if !live(gen) {
        return;
    }
    let changed = match LAST.lock() {
        Ok(mut l) if *l != Some(desk) => {
            *l = Some(desk);
            true
        }
        _ => false,
    };
    if changed {
        push(app, desk);
    }
}

fn push(app: &AppHandle, d: Desk) {
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.eval(format!(
        "try{{window.LayersShell&&window.LayersShell.onDesk&&window.LayersShell.onDesk({{current:{},count:{}}})}}catch(e){{}}",
        d.current, d.count
    ));
}

/// Windows: the current desktop's 16-byte id among the ids of all of them.
/// With one desktop Explorer may keep no list at all. An id missing from the
/// list (read between two writes) says nothing.
#[cfg(any(test, windows))]
pub fn from_ids(current: &[u8], ids: &[u8]) -> Option<Desk> {
    let count = (ids.len() / 16) as u32;
    if count <= 1 {
        return Some(Desk::new(1, 1));
    }
    if current.len() != 16 {
        return None;
    }
    let at = ids.chunks_exact(16).position(|id| id == current)?;
    Some(Desk::new(at as u32 + 1, count))
}

/// X11: `_NET_CURRENT_DESKTOP` counts from 0; a window manager without
/// workspaces sets neither property.
#[cfg(any(test, target_os = "linux"))]
pub fn from_x11(current: Option<u64>, count: Option<u64>) -> Option<Desk> {
    let count = count.filter(|&n| n > 0)? as u32;
    let current = current? as u32;
    (current < count).then(|| Desk::new(current + 1, count))
}

/// One display's Spaces in Mission Control order: (id, type), type 0 being a
/// desktop and 4 a full-screen app.
#[cfg(any(test, target_os = "macos"))]
pub type Spaces = Vec<(u64, i64)>;

/// macOS: the active Space among the desktops of the display that shows it.
/// A full-screen app's Space has no number: 0.
#[cfg(any(test, target_os = "macos"))]
pub fn from_spaces(active: u64, displays: &[Spaces]) -> Option<Desk> {
    let shown = displays.iter().find(|d| d.iter().any(|&(id, _)| id == active))?;
    let desktops: Vec<u64> = shown.iter().filter(|&&(_, t)| t == 0).map(|&(id, _)| id).collect();
    let count = desktops.len() as u32;
    let current = desktops.iter().position(|&id| id == active).map_or(0, |i| i as u32 + 1);
    Some(Desk::new(current, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> [u8; 16] {
        [n; 16]
    }

    #[test]
    fn windows_finds_the_desktop_by_its_id_and_one_desktop_needs_no_list() {
        let ids: Vec<u8> = [id(1), id(2), id(3)].concat();
        assert_eq!(from_ids(&id(2), &ids), Some(Desk { current: 2, count: 3 }));
        assert_eq!(from_ids(&id(9), &ids), None, "an id read mid-write says nothing");
        assert_eq!(from_ids(&[1, 2], &ids), None);
        assert_eq!(from_ids(&[], &[]), Some(Desk { current: 1, count: 1 }));
        assert_eq!(from_ids(&id(1), &id(1)), Some(Desk { current: 1, count: 1 }));
        let many: Vec<u8> = (0..100u8).flat_map(id).collect();
        assert_eq!(from_ids(&id(99), &many), Some(Desk { current: 64, count: 64 }), "capped for the server");
    }

    #[test]
    fn x11_counts_from_one_and_needs_both_properties() {
        assert_eq!(from_x11(Some(0), Some(4)), Some(Desk { current: 1, count: 4 }));
        assert_eq!(from_x11(Some(3), Some(4)), Some(Desk { current: 4, count: 4 }));
        assert_eq!(from_x11(Some(4), Some(4)), None);
        assert_eq!(from_x11(None, Some(4)), None);
        assert_eq!(from_x11(Some(0), None), None);
        assert_eq!(from_x11(Some(0), Some(0)), None);
    }

    #[test]
    fn macos_numbers_desktops_on_the_display_shown_and_a_full_screen_space_is_zero() {
        let main: Spaces = vec![(10, 0), (11, 4), (12, 0)];
        let side: Spaces = vec![(20, 0), (21, 0)];
        let displays = [main, side];
        assert_eq!(from_spaces(12, &displays), Some(Desk { current: 2, count: 2 }));
        assert_eq!(from_spaces(11, &displays), Some(Desk { current: 0, count: 2 }));
        assert_eq!(from_spaces(21, &displays), Some(Desk { current: 2, count: 2 }));
        assert_eq!(from_spaces(99, &displays), None);
    }
}
