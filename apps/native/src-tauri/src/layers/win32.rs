//! How each layer window behaves on Windows (the techniques the spike measured):
//!
//! - desktop: kept under every window by a `WM_WINDOWPOSCHANGING` subclass, and
//!   lifted over the desktop while the desktop itself is in front (Win+D, a
//!   click on the wallpaper). Hidden while a maximized or full-screen window
//!   covers its monitor, so it costs nothing there: the window in front is
//!   watched for moves too, because maximizing the active window changes no
//!   foreground.
//! - overlay: topmost, re-asserted on every foreground change.
//! - anchor: slotted just above one window of the chosen app and moved with it
//!   on that process's location events (no polling). Deliberately NOT owned by
//!   the target: Windows destroys owned windows with their owner, which would
//!   take the webview down the moment the user closes the app.
//!
//! - wallpaper: a child of the desktop under the icons (scene.rs), hidden like
//!   a desktop layer when a window covers its monitor, in Remote Desktop, and
//!   while its page asks for a pause (on battery). Hidden also stops its page.
//! - saver: over everything on its whole monitor, and the one window here that
//!   takes the focus, so the key that ends it does not reach the app beneath;
//!   the focus goes back to that app when the last one closes.
//!
//! - edit mode (a page reports `edit=1`): desktop windows come over every window
//!   and stay shown until it ends, so the widgets can be dragged; the page then
//!   reports its whole window as clickable.
//!
//! Every window is non-activating, so clicking a widget never takes the focus
//! from the game or the document, and its region is cut to the tile rectangles
//! the page reports: clicks everywhere else go to whatever is underneath.
//!
//! Runs on the main thread only (it owns the windows and the event hooks), so
//! the state is a thread-local. Hook callbacks only `try_borrow_mut`: a callback
//! that re-enters while the state is busy skips that event instead of panicking
//! across the FFI boundary.
#![cfg(target_os = "windows")]

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::ffi::*;
use super::clicks_win32::Clicks;
use super::spec::{Anchor, Kind};

mod styles;
mod sync;
mod wallpaper;
mod region;
mod front;
mod anchored;

pub use front::forget_return_focus;
#[cfg(test)]
use front::{inside, passing_overlay};
pub use region::{roll_away, set_region};
#[cfg(test)]
use styles::{floating_style, frame_message, same_place};
pub use sync::apply;
pub use wallpaper::set_paused;
use super::{memory_for, menu_aside};

pub struct Plan {
    pub hwnd: isize,
    pub kind: Kind,
    /// Desktop/overlay: the monitor's work area, physical pixels.
    pub area: Rect,
    pub anchor: Option<Anchor>,
}

struct Entry {
    hwnd: isize,
    kind: Kind,
    area: Rect,
    anchor: Option<Anchor>,
    target: isize,
    hooks: Vec<isize>,
    covered: bool,
    /// The page last reported nothing to draw (an empty region). A visible
    /// window with nothing on it gives its memory back like a hidden one.
    empty: bool,
    /// Wallpaper: its page asked for a pause (`xenon-app:scene-pause`).
    paused: bool,
    clicks: Clicks,
    /// What the page last asked to show, and the cards closing on top of it.
    base: Vec<[i32; 4]>,
    rolls: Vec<Roll>,
}

/// A card closing under the cut (roll.rs).
struct Roll {
    rect: [i32; 4],
    from: Instant,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    fg_hook: isize,
    /// The window in front, and a location hook on its process while any
    /// desktop layer exists (see `watch_front`).
    front: isize,
    front_pid: u32,
    front_hook: isize,
    front_gone_hook: isize,
    front_mon: Option<Rect>,
    /// Rectangles a page reported before its window joined `entries`.
    pending: Vec<(isize, Reported)>,
    /// The window in front when a screensaver opened, given the focus back
    /// when the last one closes.
    before_saver: isize,
    /// Running only while a window holds both words and widgets (`watch_cursor`).
    cursor_timer: usize,
    /// Running only while a card is closing (`watch_rolls`).
    roll_timer: usize,
}

/// What a page reported: rectangles that take the mouse, and words clicks go through.
type Reported = (Vec<[i32; 4]>, Vec<[i32; 4]>);

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// True while the desktop is the foreground window: desktop layers sit on top.
static RAISED: AtomicBool = AtomicBool::new(false);
/// True while the widgets are being edited: desktop layers sit on top too.
static EDITING: AtomicBool = AtomicBool::new(false);

fn lifted() -> bool {
    RAISED.load(Ordering::Relaxed) || EDITING.load(Ordering::Relaxed)
}

const POS_ONLY: u32 = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
/// How often the cursor is looked at: the time a click could still land on the
/// wrong side of a widget's edge.
const CURSOR_EVERY_MS: u32 = 33;
/// Asks for every tick Windows can give: a card closing must not stutter.
const ROLL_EVERY_MS: u32 = 8;

thread_local! {
    static COVER_TIMER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_layer_belongs_to_the_monitor_holding_its_centre() {
        let mon = Rect { l: 0, t: 0, r: 1920, b: 1080 };
        assert!(inside(&Rect { l: 0, t: 0, r: 1920, b: 1040 }, &mon));
        assert!(!inside(&Rect { l: 1920, t: 0, r: 4480, b: 1440 }, &mon));
    }

    #[test]
    fn a_cut_window_never_paints_a_frame() {
        for m in [WM_NCPAINT, WM_NCUAHDRAWCAPTION, WM_NCUAHDRAWFRAME] {
            assert_eq!(frame_message(m, 7), None);
        }
        assert_eq!(frame_message(WM_NCACTIVATE, 0), Some(-1), "activates, repaints nothing");
        assert_eq!(frame_message(WM_NCDESTROY, 7), Some(7), "the rest goes through untouched");
    }

    #[test]
    fn a_screen_change_leaves_an_anchored_widget_where_it_was_put() {
        let kept = same_place(SWP_NOZORDER);
        assert_eq!(kept & (SWP_NOMOVE | SWP_NOSIZE), SWP_NOMOVE | SWP_NOSIZE);
        assert_ne!(kept & SWP_NOZORDER, 0);
    }

    #[test]
    fn a_screenshot_overlay_does_not_count_as_covering_the_desktop() {
        assert!(passing_overlay(0x0020_0188), "Snipping Tool, sampled on Windows 11");
        assert!(passing_overlay(0x0020_0088), "Alt+Tab, sampled on Windows 11");
        assert!(!passing_overlay(0x0020_0100), "a maximized app");
        assert!(!passing_overlay(0x0000_0008), "a topmost full-screen game");
    }

    #[test]
    fn a_layer_is_a_tool_window_so_browsers_under_it_keep_painting() {
        let ex = floating_style(0x0804_0118);
        assert_ne!(ex & WS_EX_TOOLWINDOW as isize, 0);
        assert_eq!(ex & WS_EX_APPWINDOW as isize, 0);
        assert_ne!(ex & WS_EX_NOACTIVATE, 0);
    }
}
