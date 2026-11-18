//! The keyboard for a widget picked in edit mode, so its arrow keys can move it
//! (server/js/layer-edit/nudge.js). A layer window never takes the keyboard
//! otherwise: it must not take it from the app or game in front (Windows
//! `WS_EX_NOACTIVATE`, Linux no focus). While a widget is picked its page adds
//! `keys=1` to the rectangles it reports, and only in edit mode; when the
//! widget is let go or edit mode ends, the window that had the keyboard before
//! gets it back (Windows), if it is still in this window's hands.
//!
//! One window holds it at a time: a pick on another screen takes it over and
//! keeps the window to give back to. Main thread only (navigation hooks run
//! there), state in a thread_local.

use std::cell::RefCell;
use tauri::{AppHandle, Manager};

use super::spec::Kind;

struct Held {
    label: String,
    /// The window in front before the first pick (Windows), 0 when it was Xenon's.
    #[cfg(windows)]
    before: isize,
}

thread_local! {
    static HELD: RefCell<Option<Held>> = const { RefCell::new(None) };
}

/// Only the windows that hold widgets to move ask for it.
pub(super) fn asks(kind: Kind) -> bool {
    matches!(kind, Kind::Desktop | Kind::Overlay)
}

/// What a report from window `label` changes: take the keyboard (`Some(true)`),
/// give it back (`Some(false)`), or nothing: a window that never held it, or
/// that another took it from, has nothing to give back.
fn change(held: Option<&str>, label: &str, on: bool) -> Option<bool> {
    let mine = held == Some(label);
    (on != mine).then_some(on)
}

pub(super) fn want(app: &AppHandle, label: &str, on: bool) {
    HELD.with(|cell| {
        let Ok(mut held) = cell.try_borrow_mut() else { return };
        let Some(take) = change(held.as_ref().map(|h| h.label.as_str()), label, on) else { return };
        let Some(win) = app.get_webview_window(label) else { return };
        if take {
            let was = held.take();
            *held = Some(Held {
                label: label.to_string(),
                #[cfg(windows)]
                before: was.map(|h| h.before).filter(|h| *h != 0).unwrap_or_else(platform::front_not_ours),
            });
            #[cfg(not(windows))]
            let _ = was;
            platform::take(app, &win);
        } else if let Some(h) = held.take() {
            platform::give_back(&win, &h);
        }
    });
}

#[cfg(windows)]
mod platform {
    use super::super::ffi::{pid_of, GetCurrentProcessId, GetForegroundWindow};
    use super::super::{native_handle, scene};
    use super::Held;
    use tauri::{AppHandle, WebviewWindow};

    pub(super) fn front_not_ours() -> isize {
        let front = unsafe { GetForegroundWindow() };
        if front == 0 || pid_of(front) == unsafe { GetCurrentProcessId() } { 0 } else { front }
    }

    /// The same way the menu's window takes it over the app in use (menu_window.rs).
    pub(super) fn take(app: &AppHandle, win: &WebviewWindow) {
        let _ = win.set_focus();
        super::super::force_focus(app, win);
    }

    /// Only from the window that has it now: the user may have gone to another app.
    pub(super) fn give_back(win: &WebviewWindow, held: &Held) {
        let Some(h) = native_handle(win) else { return };
        if unsafe { GetForegroundWindow() } == h {
            scene::give_back(held.before);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Held;
    use tauri::{AppHandle, WebviewWindow};

    /// A click there already makes Xenon the active app; this makes the window the key one.
    pub(super) fn take(_app: &AppHandle, win: &WebviewWindow) {
        let _ = win.set_focus();
    }

    /// The user clicks back into their app, as after any other Xenon window.
    pub(super) fn give_back(_win: &WebviewWindow, _held: &Held) {}
}

#[cfg(target_os = "linux")]
mod platform {
    use super::super::{linux, native_handle};
    use super::Held;
    use tauri::{AppHandle, WebviewWindow};

    pub(super) fn take(_app: &AppHandle, win: &WebviewWindow) {
        if let Some(h) = native_handle(win) {
            linux::set_keys(h, true);
        }
    }

    pub(super) fn give_back(win: &WebviewWindow, _held: &Held) {
        if let Some(h) = native_handle(win) {
            linux::set_keys(h, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pick_takes_the_keyboard_once_and_letting_go_gives_it_back() {
        assert_eq!(change(None, "layer-1", true), Some(true));
        assert_eq!(change(Some("layer-1"), "layer-1", true), None, "already held: nothing to do");
        assert_eq!(change(Some("layer-1"), "layer-1", false), Some(false));
        assert_eq!(change(None, "layer-1", false), None, "never held: nothing to give back");
    }

    #[test]
    fn another_screen_takes_it_over_and_the_first_one_letting_go_changes_nothing() {
        assert_eq!(change(Some("layer-1"), "layer-2", true), Some(true));
        assert_eq!(change(Some("layer-2"), "layer-1", false), None);
    }

    #[test]
    fn only_the_windows_with_widgets_to_move_ask() {
        assert!(asks(Kind::Desktop) && asks(Kind::Overlay));
        assert!(!asks(Kind::Anchor) && !asks(Kind::Wallpaper) && !asks(Kind::Saver) && !asks(Kind::Menu));
    }
}
