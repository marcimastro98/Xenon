// Windows: one sync applied, windows that left forgotten, new ones set up, all of them placed.

use std::sync::atomic::Ordering;
use super::{EDITING, Entry, lifted, Plan, POS_ONLY, State, STATE};
use super::anchored::{follow, unhook_target};
use super::front::{set_foreground_hook, watch_front};
use super::region::watch_cursor;
use super::styles::{cut_region, keep_bottom, keep_size, move_to, no_title_bar, no_transitions, noactivate_tree, set_floating, show};
use super::super::{menu_window, scene};
use super::super::clicks_win32::Clicks;
use super::super::ffi::*;
use super::super::spec::Kind;
use super::wallpaper::{drawn, settle_wallpaper, takes_over};

/// Apply a sync: forget windows that are gone, set up new ones, re-place all.
pub fn apply(plans: Vec<Plan>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        let mut old = std::mem::take(&mut st.entries);
        for e in old.iter_mut().filter(|e| !plans.iter().any(|p| p.hwnd == e.hwnd)) {
            unhook_target(e);
        }
        let had_saver = old.iter().any(|e| takes_over(e.kind));
        for p in plans {
            let known = old.iter().position(|e| e.hwnd == p.hwnd);
            let opened = known.is_none();
            let mut e = match known {
                Some(i) => old.swap_remove(i),
                None => first_time(&mut st, &p),
            };
            if e.anchor != p.anchor {
                unhook_target(&mut e);
                e.anchor = p.anchor;
            }
            e.area = p.area;
            place(&mut e);
            if opened && e.kind == Kind::Menu {
                let after = if menu_window::stays_on_top() { HWND_TOPMOST } else { HWND_TOP };
                move_to(e.hwnd, after, e.area, 0);
                // Landing on a screen of another scale resized it by that ratio, and
                // that size would be saved: every opening would come back smaller.
                move_to(e.hwnd, after, e.area, 0);
                scene::force_focus(e.hwnd);
                // It steps aside for a screenshot: a fade would still be in the picture.
                no_transitions(e.hwnd);
            }
            st.entries.push(e);
        }
        if had_saver && !st.entries.iter().any(|e| takes_over(e.kind)) {
            scene::give_back(std::mem::take(&mut st.before_saver));
        }
        set_foreground_hook(&mut st);
        let front = if st.front == 0 { unsafe { GetForegroundWindow() } } else { st.front };
        watch_front(&mut st, front);
        watch_cursor(&mut st);
    });
}

fn first_time(st: &mut State, p: &Plan) -> Entry {
    let mut entry = Entry {
        hwnd: p.hwnd, kind: p.kind, area: p.area, anchor: None, target: 0, hooks: Vec::new(), covered: false, empty: false, paused: false,
        clicks: Clicks::default(), base: Vec::new(), rolls: Vec::new(),
    };
    // The scenes draw their whole window: no tiles, no region.
    match p.kind {
        Kind::Wallpaper => {
            noactivate_tree(p.hwnd);
            if !scene::attach(p.hwnd) {
                crate::crash_log::note("layer-wallpaper", "no desktop window to attach to");
            }
            return entry;
        }
        Kind::Saver | Kind::Menu => {
            if !st.entries.iter().any(|e| takes_over(e.kind)) && st.before_saver == 0 {
                let front = unsafe { GetForegroundWindow() };
                if unsafe { IsWindowVisible(front) } != 0 {
                    st.before_saver = front;
                }
            }
            if p.kind == Kind::Saver {
                unsafe { SetWindowSubclass(p.hwnd, keep_size, 1, 0) };
            }
            return entry;
        }
        _ => {}
    }
    noactivate_tree(p.hwnd);
    set_floating(p.hwnd);
    // Nothing is drawn or clickable until the page says where its tiles are: a
    // monitor-sized window that swallowed clicks would break the desktop.
    let (solid, through) = st.pending.iter().position(|(h, _)| *h == p.hwnd).map(|i| st.pending.swap_remove(i).1).unwrap_or_default();
    entry.base = drawn(&solid, &through);
    unsafe { SetWindowSubclass(p.hwnd, no_title_bar, 2, 0) };
    cut_region(p.hwnd, &entry.base, &[]);
    entry.clicks.report(p.hwnd, solid, &through);
    if p.kind == Kind::Desktop {
        unsafe { SetWindowSubclass(p.hwnd, keep_bottom, 1, 0) };
    }
    unsafe { SetWindowSubclass(p.hwnd, keep_size, 1, 0) };
    entry
}

fn place(e: &mut Entry) {
    match e.kind {
        Kind::Desktop => {
            let after = if lifted() { HWND_TOPMOST } else { HWND_BOTTOM };
            move_to(e.hwnd, after, e.area, 0);
            show(e, !e.covered || EDITING.load(Ordering::Relaxed));
        }
        Kind::Overlay => {
            move_to(e.hwnd, HWND_TOPMOST, e.area, 0);
            show(e, true);
        }
        Kind::Anchor => follow(e, 0),
        Kind::Wallpaper => {
            // Explorer rebuilt the desktop under it: attach again.
            if !scene::attached(e.hwnd) {
                scene::attach(e.hwnd);
            }
            scene::place(e.hwnd, e.area);
            settle_wallpaper(e);
        }
        // The menu is placed and takes the focus once, when it opens (`apply`): a
        // later sync must not move it from where the user dragged it, or pull
        // the focus back from the app the user went to.
        Kind::Menu => {
            if menu_window::stays_on_top() {
                unsafe { SetWindowPos(e.hwnd, HWND_TOPMOST, 0, 0, 0, 0, POS_ONLY) };
            }
            show(e, !super::menu_aside());
        }
        Kind::Saver => {
            move_to(e.hwnd, HWND_TOPMOST, e.area, 0);
            show(e, true);
            let ours = unsafe { GetForegroundWindow() } == e.hwnd;
            if !ours {
                scene::take_focus(e.hwnd);
            }
        }
        // Filtered out in mod.rs: the capture engine draws on the screen here.
        Kind::Draw => {}
    }
}
