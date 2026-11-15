// macOS: the parts of a layer window that take the mouse, and the watcher that follows the pointer over them.

use std::sync::atomic::Ordering;
use objc2_app_kit::{NSEvent, NSWindow};
use objc2_foundation::NSArray;
use tauri::AppHandle;
use super::{EDITING, find, QUEUED, State, STATE, WANTED, WATCH_EVERY, WATCHING, windows};
use super::super::spec::{self, Kind};
use super::window::configure;

/// The page's tile rectangles, and whether the widgets are being edited
/// (`None` from the alerts window, which has no say in it). Main thread: the
/// navigation hooks run there. Rectangles only decide where the mouse goes here,
/// nothing clips the drawing, so words that clicks go through need nothing.
pub fn set_region(handle: isize, rects: Vec<[i32; 4]>, _through: Vec<[i32; 4]>, editing: Option<bool>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let Some(all) = windows() else { return };
        match st.entries.iter_mut().find(|e| e.handle == handle) {
            Some(e) => e.rects = rects,
            None => {
                st.pending.retain(|(h, _)| *h != handle);
                st.pending.push((handle, rects));
            }
        }
        if let Some(editing) = editing {
            if EDITING.swap(editing, Ordering::Relaxed) != editing {
                for e in st.entries.iter().filter(|e| e.kind == Kind::Desktop) {
                    if let Some(w) = find(&all, e.handle) {
                        configure(&w, e);
                    }
                }
            }
        }
        hit_test(&mut st, &all);
    });
    watch();
}

/// Each window takes the mouse only while the cursor is on one of its tiles.
/// Windows that are gone leave the state here.
pub(super) fn hit_test(st: &mut State, all: &NSArray<NSWindow>) {
    st.entries.retain(|e| find(all, e.handle).is_some());
    // A drag that leaves the tile (a slider, a scrollbar) keeps its window
    // until the button is up.
    let held = NSEvent::pressedMouseButtons() != 0;
    for e in st.entries.iter_mut().filter(|e| !e.scene() && !matches!(e.kind, Kind::Anchor | Kind::Menu)) {
        let Some(w) = find(all, e.handle) else {
            continue;
        };
        let on = cursor_on(&w, &e.rects);
        if on != e.takes_mouse && !(held && e.takes_mouse) {
            e.takes_mouse = on;
            w.setIgnoresMouseEvents(!on);
        }
    }
    WANTED.store(
        st.entries.iter().any(|e| !e.rects.is_empty() && e.kind != Kind::Anchor),
        Ordering::Relaxed,
    );
}

/// The cursor in the window's own device pixels, top-left origin like the
/// page's rectangles (AppKit counts points from the bottom-left).
fn cursor_on(w: &NSWindow, rects: &[[i32; 4]]) -> bool {
    if rects.is_empty() {
        return false;
    }
    let Some(view) = w.contentView() else {
        return false;
    };
    let p = w.mouseLocationOutsideOfEventStream();
    let height = view.frame().size.height;
    let scale = w.backingScaleFactor();
    spec::hit(rects, p.x * scale, (height - p.y) * scale)
}

fn tick() {
    QUEUED.store(false, Ordering::Relaxed);
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let Some(all) = windows() else { return };
        hit_test(&mut st, &all);
    });
}

/// Start the watcher if some window has tiles and none is running. It stops on
/// its own when no window has any, re-checking once so a tile reported while
/// it was stopping is never left without one.
pub(super) fn watch() {
    if !WANTED.load(Ordering::Relaxed) || WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(app) = super::APP.get().cloned() else {
        WATCHING.store(false, Ordering::SeqCst);
        return;
    };
    std::thread::spawn(move || run_watcher(&app));
}

fn run_watcher(app: &AppHandle) {
    let mut last: Option<(f64, f64)> = None;
    loop {
        std::thread::sleep(WATCH_EVERY);
        if !WANTED.load(Ordering::Relaxed) {
            WATCHING.store(false, Ordering::SeqCst);
            if !WANTED.load(Ordering::Relaxed) || WATCHING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let p = NSEvent::mouseLocation();
        let now = Some((p.x, p.y));
        if now == last {
            continue;
        }
        last = now;
        if !QUEUED.swap(true, Ordering::Relaxed) && app.run_on_main_thread(tick).is_err() {
            WATCHING.store(false, Ordering::SeqCst);
            return;
        }
    }
}
