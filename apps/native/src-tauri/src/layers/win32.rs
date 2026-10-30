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

use super::ffi::*;
use super::scene;
use super::anchor;
use super::spec::{Anchor, Kind};

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
    /// Rectangles a page reported before its window joined `entries`.
    pending: Vec<(isize, Vec<[i32; 4]>)>,
    /// The window in front when a screensaver opened, given the focus back
    /// when the last one closes.
    before_saver: isize,
}

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

extern "system" fn keep_bottom(h: isize, m: u32, w: usize, l: isize, _: usize, _: usize) -> isize {
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

fn set_noactivate(h: isize) {
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    if ex & WS_EX_NOACTIVATE == 0 {
        unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE) };
    }
}

extern "system" fn noactivate_child(h: isize, _: isize) -> i32 {
    set_noactivate(h);
    1
}

/// The window and its WebView2 children, which can appear after the build.
fn noactivate_tree(h: isize) {
    set_noactivate(h);
    unsafe { EnumChildWindows(h, noactivate_child, 0) };
}

fn cut_region(h: isize, rects: &[[i32; 4]]) {
    unsafe {
        let rgn = CreateRectRgn(0, 0, 0, 0);
        for r in rects {
            let part = CreateRectRgn(r[0], r[1], r[0] + r[2], r[1] + r[3]);
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
fn show(e: &Entry, on: bool) {
    let visible = unsafe { IsWindowVisible(e.hwnd) } != 0;
    if visible != on {
        unsafe { ShowWindow(e.hwnd, if on { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
        super::memory_for(e.hwnd, !on || e.empty);
    }
}

fn move_to(h: isize, after: isize, r: Rect, flags: u32) {
    unsafe { SetWindowPos(h, after, r.l, r.t, r.r - r.l, r.b - r.t, flags | SWP_NOACTIVATE) };
}

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
            let mut e = match old.iter().position(|e| e.hwnd == p.hwnd) {
                Some(i) => old.swap_remove(i),
                None => first_time(&mut st, &p),
            };
            if e.anchor != p.anchor {
                unhook_target(&mut e);
                e.anchor = p.anchor;
            }
            e.area = p.area;
            place(&mut e);
            st.entries.push(e);
        }
        if had_saver && !st.entries.iter().any(|e| takes_over(e.kind)) {
            scene::give_back(std::mem::take(&mut st.before_saver));
        }
        set_foreground_hook(&mut st);
        let front = if st.front == 0 { unsafe { GetForegroundWindow() } } else { st.front };
        watch_front(&mut st, front);
    });
}

fn first_time(st: &mut State, p: &Plan) -> Entry {
    let entry = Entry {
        hwnd: p.hwnd, kind: p.kind, area: p.area, anchor: None, target: 0, hooks: Vec::new(), covered: false, empty: false, paused: false,
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
                st.before_saver = unsafe { GetForegroundWindow() };
            }
            return entry;
        }
        _ => {}
    }
    noactivate_tree(p.hwnd);
    // Nothing is drawn or clickable until the page says where its tiles are: a
    // monitor-sized window that swallowed clicks would break the desktop.
    let rects = st.pending.iter().position(|(h, _)| *h == p.hwnd).map(|i| st.pending.swap_remove(i).1);
    cut_region(p.hwnd, rects.as_deref().unwrap_or(&[]));
    if p.kind == Kind::Desktop {
        unsafe { SetWindowSubclass(p.hwnd, keep_bottom, 1, 0) };
    }
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
            show(e, wallpaper_on(e));
        }
        Kind::Saver | Kind::Menu => {
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

/// The screensaver and the Xenon menu cover the screen and take the keyboard;
/// the window they took it from gets it back when the last one closes.
fn takes_over(kind: Kind) -> bool {
    matches!(kind, Kind::Saver | Kind::Menu)
}

fn wallpaper_on(e: &Entry) -> bool {
    scene::attached(e.hwnd) && !e.covered && !e.paused && !scene::remote_session()
}

/// `xenon-app:scene-pause` from a wallpaper page: on battery it stops until
/// the charger is back.
pub fn set_paused(hwnd: isize, paused: bool) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if let Some(e) = st.entries.iter_mut().find(|e| e.hwnd == hwnd && e.kind == Kind::Wallpaper) {
            e.paused = paused;
            show(e, wallpaper_on(e));
        }
    });
}

/// The page's tile rectangles, device pixels of its own window, and whether
/// the widgets are being edited (every layer page reports the same mode;
/// `None` from a page that has no say in it, the on-screen alerts).
pub fn set_region(hwnd: isize, rects: Vec<[i32; 4]>, editing: Option<bool>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if let Some(e) = st.entries.iter_mut().find(|e| e.hwnd == hwnd) {
            noactivate_tree(hwnd);
            cut_region(hwnd, &rects);
            memory_for_region(e, rects.is_empty());
        } else {
            st.pending.retain(|(h, _)| *h != hwnd);
            st.pending.push((hwnd, rects));
        }
        let Some(editing) = editing else { return };
        if EDITING.swap(editing, Ordering::Relaxed) != editing {
            set_editing(&mut st, editing);
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

/// Lift the desktop layers for editing, or put them back where the front
/// window says they belong.
fn set_editing(st: &mut State, editing: bool) {
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

fn set_foreground_hook(st: &mut State) {
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

/// The monitor of the window in front, and whether it fills that monitor
/// (maximized or full screen). The taskbar, Start and cloaked windows say
/// nothing about what covers the desktop.
fn front_on(class: &str, h: isize) -> Option<(Rect, bool)> {
    if class.starts_with("Shell_") || cloaked(h) {
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
    let on = if e.kind == Kind::Wallpaper { wallpaper_on(e) } else { !e.covered };
    show(e, on);
}

/// The layers that hide under a window filling their monitor.
fn hides_when_covered(kind: Kind) -> bool {
    matches!(kind, Kind::Desktop | Kind::Wallpaper)
}

/// Follow the front window's own moves (maximize, restore, full screen) with a
/// hook scoped to its process, re-scoped when the front app changes.
fn watch_front(st: &mut State, front: isize) {
    st.front = front;
    let wanted = front != 0 && st.entries.iter().any(|e| hides_when_covered(e.kind));
    let pid = if wanted { pid_of(front) } else { 0 };
    if pid == st.front_pid {
        return;
    }
    if st.front_hook != 0 {
        unsafe { UnhookWinEvent(st.front_hook) };
        st.front_hook = 0;
    }
    st.front_pid = pid;
    if pid != 0 {
        st.front_hook = unsafe {
            SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, 0, on_front_moved, pid, 0, 0)
        };
    }
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

fn inside(area: &Rect, mon: &Rect) -> bool {
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
                Kind::Overlay | Kind::Saver | Kind::Menu => unsafe {
                    SetWindowPos(e.hwnd, HWND_TOPMOST, 0, 0, 0, 0, POS_ONLY);
                },
                Kind::Anchor => follow(e, fg),
                Kind::Wallpaper if desktop => {
                    e.covered = false;
                    show(e, wallpaper_on(e));
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
    anchor: &'a Anchor,
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

fn unhook_target(e: &mut Entry) {
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
fn follow(e: &mut Entry, fg: isize) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_desktop_layer_belongs_to_the_monitor_holding_its_centre() {
        let mon = Rect { l: 0, t: 0, r: 1920, b: 1080 };
        assert!(inside(&Rect { l: 0, t: 0, r: 1920, b: 1040 }, &mon));
        assert!(!inside(&Rect { l: 1920, t: 0, r: 4480, b: 1440 }, &mon));
    }
}
