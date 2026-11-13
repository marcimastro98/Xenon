// Windows: the part of a layer window that is drawn and takes the mouse, cards closing included.

use std::sync::atomic::Ordering;
use std::time::Instant;
use super::{CURSOR_EVERY_MS, EDITING, Entry, Roll, ROLL_EVERY_MS, State, STATE};
use super::front::set_editing;
use super::styles::{cut_region, noactivate_tree};
use super::super::roll;
use super::super::ffi::*;
use super::wallpaper::drawn;

/// The page's tile rectangles, device pixels of its own window, the words on it
/// that clicks go through, and whether the widgets are being edited (every layer
/// page reports the same mode; `None` from a page that has no say in it, the
/// on-screen alerts).
pub fn set_region(hwnd: isize, solid: Vec<[i32; 4]>, through: Vec<[i32; 4]>, editing: Option<bool>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if let Some(e) = st.entries.iter_mut().find(|e| e.hwnd == hwnd) {
            e.base = drawn(&solid, &through);
            noactivate_tree(hwnd);
            cut_with_rolls(e);
            e.clicks.report(hwnd, solid, &through);
        } else {
            st.pending.retain(|(h, _)| *h != hwnd);
            st.pending.push((hwnd, (solid, through)));
        }
        watch_cursor(&mut st);
        let Some(editing) = editing else { return };
        if EDITING.swap(editing, Ordering::Relaxed) != editing {
            set_editing(&mut st, editing);
        }
    });
}

/// What the page shows, plus what is left of each closing card.
fn cut_with_rolls(e: &mut Entry) {
    let now = Instant::now();
    let left = |r: &Roll| roll::rolled(r.rect, now.duration_since(r.from).as_millis() as u64);
    let closing: Vec<[i32; 4]> = e.rolls.iter().filter_map(left).collect();
    e.rolls.retain(|r| left(r).is_some());
    cut_region(e.hwnd, &e.base, &closing);
    let empty = e.base.is_empty() && e.rolls.is_empty();
    memory_for_region(e, empty);
}

/// These rectangles close over the next ones the page reports (`set_region`).
pub fn roll_away(hwnd: isize, rects: Vec<[i32; 4]>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        let from = Instant::now();
        if let Some(e) = st.entries.iter_mut().find(|e| e.hwnd == hwnd) {
            e.rolls.extend(rects.into_iter().map(|rect| Roll { rect, from }));
        }
        watch_rolls(&mut st);
    });
}

/// The timer lives only while a card is closing.
fn watch_rolls(st: &mut State) {
    let wanted = st.entries.iter().any(|e| !e.rolls.is_empty());
    if wanted && st.roll_timer == 0 {
        st.roll_timer = unsafe { SetTimer(0, 0, ROLL_EVERY_MS, on_roll_tick as *const () as isize) };
    } else if !wanted && st.roll_timer != 0 {
        unsafe { KillTimer(0, st.roll_timer) };
        st.roll_timer = 0;
    }
}

extern "system" fn on_roll_tick(_: isize, _: u32, _: usize, _: u32) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        for e in st.entries.iter_mut().filter(|e| !e.rolls.is_empty()) {
            cut_with_rolls(e);
        }
        watch_rolls(&mut st);
    });
}

/// The timer lives only while some window needs the cursor looked at.
pub(super) fn watch_cursor(st: &mut State) {
    let wanted = st.entries.iter().any(|e| e.clicks.by_cursor());
    if wanted && st.cursor_timer == 0 {
        st.cursor_timer = unsafe { SetTimer(0, 0, CURSOR_EVERY_MS, on_cursor_tick as *const () as isize) };
    } else if !wanted && st.cursor_timer != 0 {
        unsafe { KillTimer(0, st.cursor_timer) };
        st.cursor_timer = 0;
    }
}

extern "system" fn on_cursor_tick(_: isize, _: u32, _: usize, _: u32) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        // A drag stays with the window it began on, like a slider leaving its
        // widget or a selection in the game crossing one.
        let held = unsafe { GetAsyncKeyState(VK_LBUTTON) | GetAsyncKeyState(VK_RBUTTON) } < 0;
        let mut at = Point { x: 0, y: 0 };
        if held || unsafe { GetCursorPos(&mut at) } == 0 {
            return;
        }
        for e in st.entries.iter_mut().filter(|e| e.clicks.by_cursor()) {
            let mut r = Rect::default();
            if unsafe { GetWindowRect(e.hwnd, &mut r) } != 0 {
                e.clicks.follow(e.hwnd, at.x - r.l, at.y - r.t);
            }
        }
    });
}

/// Only on a change, and only while the window is shown: a hidden one is
/// already Low (`show`) and must stay so until it is shown again.
fn memory_for_region(e: &mut Entry, empty: bool) {
    if e.empty == empty {
        return;
    }
    e.empty = empty;
    if unsafe { IsWindowVisible(e.hwnd) } != 0 {
        super::memory_for(e.hwnd, empty);
    }
}
