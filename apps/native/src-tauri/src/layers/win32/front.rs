// Windows: following the window in front, so desktop layers lift, hide and come back at the right time.

use std::sync::atomic::Ordering;
use super::{EDITING, Entry, lifted, POS_ONLY, RAISED, State, STATE};
use super::anchored::follow;
use super::styles::show;
use super::super::menu_window;
use super::super::ffi::*;
use super::super::spec::Kind;
use super::wallpaper::settle_wallpaper;

/// Lift the desktop layers for editing, or put them back where the front
/// window says they belong.
pub(super) fn set_editing(st: &mut State, editing: bool) {
    let fg = unsafe { GetForegroundWindow() };
    let class = class_of(fg);
    let desktop = is_desktop(&class);
    let front = if desktop { None } else { front_on(&class, fg) };
    for e in st.entries.iter_mut().filter(|e| e.kind == Kind::Desktop) {
        if editing {
            show(e, true);
            unsafe { SetWindowPos(e.hwnd, HWND_TOPMOST, 0, 0, 0, 0, POS_ONLY) };
        } else {
            desk_on_foreground(e, desktop, front);
        }
    }
}

pub fn forget_return_focus() {
    STATE.with(|cell| {
        if let Ok(mut st) = cell.try_borrow_mut() {
            st.before_saver = 0;
        }
    });
}

pub(super) fn set_foreground_hook(st: &mut State) {
    if st.entries.is_empty() {
        if st.fg_hook != 0 {
            unsafe { UnhookWinEvent(st.fg_hook) };
            st.fg_hook = 0;
        }
        RAISED.store(false, Ordering::Relaxed);
    } else if st.fg_hook == 0 {
        st.fg_hook = unsafe {
            SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, on_foreground, 0, 0, WINEVENT_SKIPOWNPROCESS)
        };
    }
}

fn is_desktop(class: &str) -> bool {
    class == "Progman" || class == "WorkerW"
}

/// A topmost tool window drawn over everything for a moment: the Snipping Tool's
/// see-through overlay, Alt+Tab. It fills the screen and hides nothing.
pub(super) fn passing_overlay(ex: isize) -> bool {
    let both = (WS_EX_TOPMOST | WS_EX_TOOLWINDOW) as isize;
    ex & both == both
}

/// The monitor of the window in front, and whether it fills that monitor
/// (maximized or full screen). The taskbar, Start, cloaked windows and passing
/// overlays say nothing about what covers the desktop.
fn front_on(class: &str, h: isize) -> Option<(Rect, bool)> {
    if class.starts_with("Shell_") || cloaked(h) || passing_overlay(unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) }) {
        return None;
    }
    let mon = monitor_rect_of(h)?;
    let r = frame_of(h);
    let full = r.l <= mon.l && r.t <= mon.t && r.r >= mon.r && r.b >= mon.b;
    Some((mon, full || unsafe { IsZoomed(h) } != 0))
}

/// Only the layer on the front window's monitor changes: a small window on
/// another screen says nothing about this one.
fn desk_cover(e: &mut Entry, front: Option<(Rect, bool)>) {
    if let Some((mon, covering)) = front {
        if inside(&e.area, &mon) {
            e.covered = covering;
        }
    }
    if e.kind == Kind::Wallpaper {
        settle_wallpaper(e);
    } else {
        show(e, !e.covered);
    }
}

/// The layers that hide under a window filling their monitor.
fn hides_when_covered(kind: Kind) -> bool {
    matches!(kind, Kind::Desktop | Kind::Wallpaper)
}

/// Follow the front window's own moves (maximize, restore, full screen) with a
/// hook scoped to its process, re-scoped when the front app changes.
pub(super) fn watch_front(st: &mut State, front: isize) {
    st.front = front;
    st.front_mon = monitor_rect_of(front);
    let wanted = front != 0 && st.entries.iter().any(|e| hides_when_covered(e.kind));
    let pid = if wanted { pid_of(front) } else { 0 };
    if pid == st.front_pid {
        return;
    }
    if st.front_hook != 0 {
        unsafe { UnhookWinEvent(st.front_hook) };
        st.front_hook = 0;
    }
    if st.front_gone_hook != 0 {
        unsafe { UnhookWinEvent(st.front_gone_hook) };
        st.front_gone_hook = 0;
    }
    st.front_pid = pid;
    if pid != 0 {
        st.front_hook = unsafe {
            SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, 0, on_front_moved, pid, 0, 0)
        };
        st.front_gone_hook = unsafe { SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, 0, on_front_gone, pid, 0, 0) };
    }
}

/// The front window closed or hid. When the focus lands on a Xenon window no
/// foreground event comes (the hook skips this process), so a layer it covered
/// would stay hidden: uncover its monitor here.
extern "system" fn on_front_gone(_: isize, event: u32, h: isize, obj: i32, child: i32, _: u32, _: u32) {
    if event == EVENT_OBJECT_SHOW || obj != 0 || child != 0 {
        return;
    }
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if h != st.front || lifted() {
            return;
        }
        let Some(mon) = st.front_mon else { return };
        for e in st.entries.iter_mut().filter(|e| hides_when_covered(e.kind) && inside(&e.area, &mon)) {
            e.covered = false;
            desk_cover(e, None);
        }
    });
}

extern "system" fn on_front_moved(_: isize, _: u32, h: isize, obj: i32, child: i32, _: u32, _: u32) {
    if obj != 0 || child != 0 {
        return;
    }
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if h != st.front || lifted() {
            return;
        }
        let front = front_on(&class_of(h), h);
        for e in st.entries.iter_mut().filter(|e| hides_when_covered(e.kind)) {
            desk_cover(e, front);
        }
    });
}

pub(super) fn inside(area: &Rect, mon: &Rect) -> bool {
    let (cx, cy) = ((area.l + area.r) / 2, (area.t + area.b) / 2);
    cx >= mon.l && cx < mon.r && cy >= mon.t && cy < mon.b
}

extern "system" fn on_foreground(_: isize, _: u32, fg: isize, _: i32, _: i32, _: u32, _: u32) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        let class = class_of(fg);
        let desktop = is_desktop(&class);
        RAISED.store(desktop, Ordering::Relaxed);
        watch_front(&mut st, fg);
        let front = if desktop { None } else { front_on(&class, fg) };
        let editing = EDITING.load(Ordering::Relaxed);
        for e in st.entries.iter_mut() {
            match e.kind {
                Kind::Desktop if editing => {}
                Kind::Desktop => desk_on_foreground(e, desktop, front),
                // An ordinary window unless a game is on (`menu_window`).
                Kind::Menu if !menu_window::stays_on_top() => {}
                Kind::Overlay | Kind::Saver | Kind::Menu => unsafe {
                    SetWindowPos(e.hwnd, HWND_TOPMOST, 0, 0, 0, 0, POS_ONLY);
                },
                Kind::Anchor => follow(e, fg),
                Kind::Wallpaper if desktop => {
                    e.covered = false;
                    settle_wallpaper(e);
                }
                Kind::Wallpaper => desk_cover(e, front),
                Kind::Draw => {}
            }
        }
    });
}

fn desk_on_foreground(e: &mut Entry, desktop: bool, front: Option<(Rect, bool)>) {
    if desktop {
        e.covered = false;
        show(e, true);
    } else {
        desk_cover(e, front);
    }
    unsafe {
        if desktop {
            SetWindowPos(e.hwnd, HWND_TOPMOST, 0, 0, 0, 0, POS_ONLY);
        } else {
            SetWindowPos(e.hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, POS_ONLY);
            SetWindowPos(e.hwnd, HWND_BOTTOM, 0, 0, 0, 0, POS_ONLY);
        }
    }
}
