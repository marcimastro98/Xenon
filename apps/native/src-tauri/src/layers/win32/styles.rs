// Windows: the styles, size and shape a layer window is given so it stays where it is put.

use std::sync::atomic::{AtomicBool, Ordering};
use super::{Entry, lifted};
use super::super::roll;
use super::super::ffi::*;

pub(super) extern "system" fn keep_bottom(h: isize, m: u32, w: usize, l: isize, _: usize, _: usize) -> isize {
    if m == WM_WINDOWPOSCHANGING && !lifted() {
        let p = unsafe { &mut *(l as *mut WindowPos) };
        p.after = HWND_BOTTOM;
        p.flags &= !SWP_NOZORDER;
    }
    if m == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(h, keep_bottom, 1) };
    }
    unsafe { DefSubclassProc(h, m, w, l) }
}

/// True while tao answers a screen change for a window we size ourselves.
static RESCALING: AtomicBool = AtomicBool::new(false);

/// These windows are sized for the screen they are going to, and tao then
/// multiplies that size by the ratio of the two screens: 320 px became 213
/// going from 150% to 100%, 720 coming back. A window covering a 100% screen
/// stopped at two thirds of it, so a widget in its right corner sat mid-screen.
/// tao still hears of the change, only its own move is dropped.
pub(super) extern "system" fn keep_size(h: isize, m: u32, w: usize, l: isize, _: usize, _: usize) -> isize {
    if m == WM_DPICHANGED {
        RESCALING.store(true, Ordering::Relaxed);
        let done = unsafe { DefSubclassProc(h, m, w, l) };
        RESCALING.store(false, Ordering::Relaxed);
        return done;
    }
    if m == WM_WINDOWPOSCHANGING && RESCALING.load(Ordering::Relaxed) {
        let p = unsafe { &mut *(l as *mut WindowPos) };
        p.flags = same_place(p.flags);
    }
    if m == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(h, keep_size, 1) };
    }
    unsafe { DefSubclassProc(h, m, w, l) }
}

pub(super) fn same_place(flags: u32) -> u32 {
    flags | SWP_NOMOVE | SWP_NOSIZE
}

/// What reaches Windows of a message about the frame: None stops it, otherwise
/// the `lParam` to send on. -1 lets WM_NCACTIVATE work without repainting.
pub(super) fn frame_message(m: u32, l: isize) -> Option<isize> {
    match m {
        WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => None,
        WM_NCACTIVATE => Some(-1),
        _ => Some(l),
    }
}

/// tao leaves WS_CAPTION on a window without decorations, and a window with a
/// region loses the DWM frame: Windows then paints the old title bar across the
/// top 45 px, and the cut shows it as a light band behind the card. A click was
/// enough to set it off. Nothing here should ever paint a frame.
pub(super) extern "system" fn no_title_bar(h: isize, m: u32, w: usize, l: isize, _: usize, _: usize) -> isize {
    if m == WM_NCDESTROY {
        unsafe { RemoveWindowSubclass(h, no_title_bar, 2) };
    }
    match frame_message(m, l) {
        Some(l) => unsafe { DefSubclassProc(h, m, w, l) },
        None => 0,
    }
}

fn set_noactivate(h: isize) {
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    if ex & WS_EX_NOACTIVATE == 0 {
        unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE) };
    }
}

/// Chrome, Edge and every Electron app stop painting a window they believe is
/// covered, and they count a topmost window with an empty or one-rectangle region
/// as a full cover of its whole rectangle: a page opened under the overlay stayed
/// blank. A tool window is the one they skip, and it stays out of Alt+Tab too.
pub(super) fn floating_style(ex: isize) -> isize {
    (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize)
}

pub(super) fn set_floating(h: isize) {
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, floating_style(ex)) };
}

extern "system" fn noactivate_child(h: isize, _: isize) -> i32 {
    set_noactivate(h);
    1
}

/// The window and its WebView2 children, which can appear after the build.
pub(super) fn noactivate_tree(h: isize) {
    set_noactivate(h);
    unsafe { EnumChildWindows(h, noactivate_child, 0) };
}

pub(super) fn cut_region(h: isize, rects: &[[i32; 4]], closing: &[[i32; 4]]) {
    unsafe {
        let rgn = CreateRectRgn(0, 0, 0, 0);
        for r in rects {
            let part = CreateRectRgn(r[0], r[1], r[0] + r[2], r[1] + r[3]);
            CombineRgn(rgn, rgn, part, RGN_OR);
            DeleteObject(part);
        }
        for r in closing {
            let round = roll::corner(r[3]);
            let part = CreateRoundRectRgn(r[0], r[1], r[0] + r[2] + 1, r[1] + r[3] + 1, round, round);
            CombineRgn(rgn, rgn, part, RGN_OR);
            DeleteObject(part);
        }
        // On success the system owns the region.
        if SetWindowRgn(h, rgn, 1) == 0 {
            DeleteObject(rgn);
        }
    }
}

/// A shown window with nothing drawn (empty region) keeps its memory Low too.
pub(super) fn show(e: &Entry, on: bool) {
    let visible = unsafe { IsWindowVisible(e.hwnd) } != 0;
    if visible == on {
        return;
    }
    // Waking the page first gives it a head start on the window appearing.
    if on {
        super::memory_for(e.hwnd, e.empty);
    }
    unsafe { ShowWindow(e.hwnd, if on { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    if !on {
        super::memory_for(e.hwnd, true);
    }
}

pub(super) fn no_transitions(h: isize) {
    let on: i32 = 1;
    unsafe { DwmSetWindowAttribute(h, DWMWA_TRANSITIONS_FORCEDISABLED, (&on as *const i32).cast(), 4) };
}

pub(super) fn move_to(h: isize, after: isize, r: Rect, flags: u32) {
    unsafe { SetWindowPos(h, after, r.l, r.t, r.r - r.l, r.b - r.t, flags | SWP_NOACTIVATE) };
}
