// macOS: one layer window made to fill its screen and sit at its level.

use std::sync::atomic::Ordering;
use objc2::msg_send;
use objc2_app_kit::{NSFloatingWindowLevel, NSNormalWindowLevel, NSScreenSaverWindowLevel, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::NSRect;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use super::{CGWindowLevelForKey, DESKTOP_LEVEL_KEY, EDITING, Entry};
use super::super::spec::Kind;

/// The window over its whole screen, menu bar included.
pub(super) fn fill_screen(w: &NSWindow) {
    let screen: Option<Retained<AnyObject>> = unsafe { msg_send![w, screen] };
    let Some(screen) = screen else { return };
    let full: NSRect = unsafe { msg_send![&*screen, frame] };
    if w.frame() != full {
        w.setFrame_display(full, true);
    }
}

pub(super) fn configure(w: &NSWindow, e: &Entry) {
    let level = match e.kind {
        Kind::Desktop if EDITING.load(Ordering::Relaxed) => NSFloatingWindowLevel,
        Kind::Desktop => NSNormalWindowLevel - 1,
        // Among the apps' own windows: one the person brings over its app
        // covers the widget too.
        Kind::Anchor => NSNormalWindowLevel,
        Kind::Wallpaper => (unsafe { CGWindowLevelForKey(DESKTOP_LEVEL_KEY) }) as isize + 1,
        Kind::Saver | Kind::Draw => NSScreenSaverWindowLevel,
        // An ordinary window unless a game is on.
        Kind::Menu if !super::menu_window::stays_on_top() => NSNormalWindowLevel,
        _ => NSStatusWindowLevel,
    };
    w.setLevel(level);
    // The menu is an ordinary window to the system: Exposé and Cmd+` see it.
    let mut behaviour = if e.kind == Kind::Menu {
        NSWindowCollectionBehavior::CanJoinAllSpaces
    } else {
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
    };
    if matches!(e.kind, Kind::Overlay | Kind::Anchor | Kind::Saver | Kind::Draw | Kind::Menu) {
        behaviour |= NSWindowCollectionBehavior::FullScreenAuxiliary;
    }
    w.setCollectionBehavior(behaviour);
    // "Hide Xenon" (Cmd+H) hides the dashboard, not the widgets on the screen.
    w.setCanHide(false);
    match e.kind {
        Kind::Wallpaper => w.setIgnoresMouseEvents(true),
        // Any input ends a screensaver, so it takes it all; the drawing
        // sheet draws with it.
        Kind::Saver | Kind::Draw | Kind::Menu | Kind::Anchor => w.setIgnoresMouseEvents(false),
        _ => w.setIgnoresMouseEvents(!e.takes_mouse),
    }
    if e.scene() {
        w.setHasShadow(false);
        fill_screen(w);
    }
    if e.kind == Kind::Wallpaper && e.paused {
        w.orderOut(None);
    }
}
