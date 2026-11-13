// Windows: a widget that follows the window of another app.

use super::{Entry, STATE};
use super::styles::{move_to, show};
use super::super::anchor;
use super::super::ffi::*;
use super::super::spec::Anchor;

// ── Anchored widgets ────────────────────────────────────────────────────────

/// A real, top-level window of the anchor's app that a person can see.
fn candidate(h: isize, a: &Anchor) -> bool {
    unsafe {
        if IsWindowVisible(h) == 0 || GetWindow(h, GW_OWNER) != 0 || pid_of(h) == GetCurrentProcessId() {
            return false;
        }
    }
    let title = title_of(h);
    if title.is_empty() || cloaked(h) {
        return false;
    }
    if !exe_of(h).is_some_and(|exe| anchor::app_matches(&a.app, &exe)) {
        return false;
    }
    a.title.is_empty() || title.to_lowercase().contains(&a.title.to_lowercase())
}

struct Search<'a> {
    pub(super) anchor: &'a Anchor,
    found: isize,
}

extern "system" fn search_window(h: isize, l: isize) -> i32 {
    let s = unsafe { &mut *(l as *mut Search) };
    if candidate(h, s.anchor) {
        s.found = h;
        return 0;
    }
    1
}

/// The topmost window of the app, i.e. the one used last.
fn find_target(a: &Anchor) -> isize {
    let mut s = Search { anchor: a, found: 0 };
    unsafe { EnumWindows(search_window, &mut s as *mut Search as isize) };
    s.found
}

pub(super) fn unhook_target(e: &mut Entry) {
    for h in e.hooks.drain(..) {
        unsafe { UnhookWinEvent(h) };
    }
    e.target = 0;
}

fn hook_target(e: &mut Entry, t: isize) {
    unhook_target(e);
    let pid = pid_of(t);
    e.hooks = [(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE), (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE)]
        .iter()
        .map(|&(a, b)| unsafe { SetWinEventHook(a, b, 0, on_target_event, pid, 0, 0) })
        .filter(|&h| h != 0)
        .collect();
    e.target = t;
}

/// Keep the widget on the right window: re-target when another window of the
/// same app comes forward, find one when there is none, then place it.
pub(super) fn follow(e: &mut Entry, fg: isize) {
    let Some(a) = e.anchor.clone() else { return show(e, false) };
    let alive = e.target != 0 && unsafe { IsWindow(e.target) } != 0;
    if fg != 0 && fg != e.target && candidate(fg, &a) {
        hook_target(e, fg);
    } else if !alive {
        unhook_target(e);
        let t = find_target(&a);
        if t != 0 {
            hook_target(e, t);
        }
    }
    place_anchor(e, &a);
}

fn place_anchor(e: &Entry, a: &Anchor) {
    let t = e.target;
    let visible = t != 0 && unsafe { IsWindowVisible(t) != 0 && IsIconic(t) == 0 } && !cloaked(t);
    if !visible {
        return show(e, false);
    }
    let r = frame_of(t);
    let frame = [r.l, r.t, r.r, r.b].map(f64::from);
    let [left, top, w, h] = anchor::rect_for(frame, a, monitor_scale_of(t)).map(|v| v as i32);
    // Just above the target in the z-order: under any window the user puts
    // over the app, over the app itself.
    // (`above` is 0 = HWND_TOP when the target is the topmost window.)
    let above = unsafe { GetWindow(t, GW_HWNDPREV) };
    let (after, flags) = if above == e.hwnd { (HWND_TOP, SWP_NOZORDER) } else { (above, 0) };
    move_to(e.hwnd, after, Rect { l: left, t: top, r: left + w, b: top + h }, flags);
    show(e, true);
}

extern "system" fn on_target_event(_: isize, event: u32, h: isize, obj: i32, child: i32, _: u32, _: u32) {
    if obj != 0 || child != 0 {
        return; // a control inside the window, not the window itself
    }
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        for e in st.entries.iter_mut().filter(|e| e.target == h) {
            if event == EVENT_OBJECT_DESTROY {
                unhook_target(e);
                show(e, false);
            } else if let Some(a) = e.anchor.clone() {
                place_anchor(e, &a);
            }
        }
    });
}
