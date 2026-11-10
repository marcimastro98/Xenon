//! The Xenon menu's window: an ordinary one with a title bar, that the user moves,
//! resizes and minimizes. It stays on top only while a game is on, where it would
//! otherwise vanish behind it; everywhere else it goes behind the app the user
//! clicks, like any window. Nothing here covers the screen, so a sync never moves
//! it: it goes where the user left it last, or in the middle of the screen under
//! the pointer, once, when it opens.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, Monitor, Runtime, WebviewWindow, WindowEvent};

const DEFAULT_SIZE: (f64, f64) = (1080.0, 720.0);
/// Below this the menu's rows stop being usable (logical pixels).
const MIN_SIZE: (f64, f64) = (480.0, 420.0);
/// A small screen (the Xeneon Edge is 720 high) keeps a margin around it.
const MAX_SHARE: f64 = 0.9;
/// A window this small is still out of sight, not placed yet.
const NOT_PLACED_BELOW: i32 = 100;
/// How long a press on the X waits for the server before the window just goes.
const GIVE_UP_AFTER: Duration = Duration::from_millis(1500);

/// A request to the server from the window's own page.
fn post_js(body: &str) -> String {
    format!("try{{fetch('/screen-menu',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:'{body}'}}).catch(function(){{}})}}catch(e){{}}")
}

/// x, y, width, height in physical pixels.
pub type Rect = [i32; 4];

/// A link opened from the menu: the window stays open, under the browser.
static LOWERED: AtomicBool = AtomicBool::new(false);

/// A game is on (the dashboard's sync says so).
static OVER_GAME: AtomicBool = AtomicBool::new(false);
/// The last time the server asked for the window to come forward.
static FRONT: AtomicU32 = AtomicU32::new(0);

pub fn stays_on_top() -> bool {
    OVER_GAME.load(Ordering::Relaxed) && !LOWERED.load(Ordering::Relaxed)
}

pub fn forget_lowered() {
    LOWERED.store(false, Ordering::Relaxed);
}

/// On top of a game it would cover the page the user just asked for. Going back
/// to the window puts it on top again (`watch_close`).
pub fn lower(win: &WebviewWindow) {
    LOWERED.store(true, Ordering::Relaxed);
    let _ = win.set_always_on_top(false);
}

fn raise(win: &WebviewWindow) {
    if LOWERED.swap(false, Ordering::Relaxed) && stays_on_top() {
        let _ = win.set_always_on_top(true);
    }
}

/// The menu key means "close" on a window the user can see and "come back" on one
/// that is minimized or behind an app, and only the window knows which it is.
fn report_behind(win: &WebviewWindow, focused: bool) {
    let behind = !focused && !stays_on_top();
    let _ = win.eval(post_js(&format!("{{\"behind\":{behind}}}")));
}

/// Out of the taskbar or from behind the app in use, with the keyboard.
fn bring_front(win: &WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.set_focus();
    super::force_focus(win.app_handle(), win);
}

/// What a sync says about the menu. `win` is the window staying open: one that
/// opens now reads the game from here and takes the focus by itself.
pub fn follow(win: Option<&WebviewWindow>, over_game: bool, front: u32) {
    let game_changed = OVER_GAME.swap(over_game, Ordering::Relaxed) != over_game;
    let asked = FRONT.swap(front, Ordering::Relaxed) != front;
    let Some(win) = win else { return };
    if game_changed {
        let _ = win.set_always_on_top(stays_on_top());
        report_behind(win, win.is_focused().unwrap_or(false));
    }
    if asked {
        bring_front(win);
    }
}

/// Where the window opens, and the scale of that screen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct At {
    pub rect: Rect,
    scale: f64,
}

fn work_rect(m: &Monitor) -> Rect {
    let area = m.work_area();
    [area.position.x, area.position.y, area.size.width as i32, area.size.height as i32]
}

/// The default size, or less on a small screen, in the middle of its work area.
fn centred(work: Rect, scale: f64) -> Rect {
    let fit = |wanted: f64, room: i32| ((wanted * scale) as i32).min((f64::from(room) * MAX_SHARE) as i32);
    let (w, h) = (fit(DEFAULT_SIZE.0, work[2]), fit(DEFAULT_SIZE.1, work[3]));
    [work[0] + (work[2] - w) / 2, work[1] + (work[3] - h) / 2, w, h]
}

fn holds(work: Rect, x: i32, y: i32) -> bool {
    x >= work[0] && y >= work[1] && x < work[0] + work[2] && y < work[1] + work[3]
}

/// The saved place, kept whole inside the screen that holds its middle. `None`
/// when that screen is gone: the window must not open out of sight.
fn kept(saved: Rect, works: &[Rect]) -> Option<(usize, Rect)> {
    let [x, y, w, h] = saved;
    let i = works.iter().position(|work| holds(*work, x + w / 2, y + h / 2))?;
    let work = works[i];
    let (w, h) = (w.min(work[2]), h.min(work[3]));
    let inside = |at: i32, size: i32, start: i32, room: i32| at.min(start + room - size).max(start);
    Some((i, [inside(x, w, work[0], work[2]), inside(y, h, work[1], work[3]), w, h]))
}

/// Where the menu opens now. Plain thread: the monitors are read on the main one.
pub fn opening(app: &AppHandle) -> At {
    let monitors = crate::monitor::app_monitors(app);
    let works: Vec<Rect> = monitors.iter().map(work_rect).collect();
    if let Some((i, rect)) = crate::prefs::load(app).menu_rect.and_then(|saved| kept(saved, &works)) {
        return At { rect, scale: monitors[i].scale_factor() };
    }
    let under_pointer = app.get_webview_window("main").and_then(|w| crate::monitor::pointer_monitor(&w));
    match under_pointer.or_else(|| crate::monitor::app_primary(app)).or_else(|| monitors.into_iter().next()) {
        Some(m) => At { rect: centred(work_rect(&m), m.scale_factor()), scale: m.scale_factor() },
        None => At { rect: [0, 0, DEFAULT_SIZE.0 as i32, DEFAULT_SIZE.1 as i32], scale: 1.0 },
    }
}

/// The window's look. On Windows it is built out of sight like the other layer
/// windows and `win32::apply` puts it in place in physical pixels: monitors with
/// different scales make a logical position there land on the wrong one.
pub fn dress<'a, R, M>(builder: WebviewWindowBuilder<'a, R, M>, at: At) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    let builder = builder
        .title("Xenon")
        .decorations(true)
        .resizable(true)
        .always_on_top(stays_on_top())
        .background_color(tauri::window::Color(17, 19, 20, 255))
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1);
    #[cfg(windows)]
    {
        let _ = at;
        builder.inner_size(1.0, 1.0).position(-32000.0, -32000.0)
    }
    #[cfg(not(windows))]
    {
        let [x, y, w, h] = at.rect.map(|v| f64::from(v) / at.scale);
        // Raising the window is not enough here: the page inside it needs the
        // focus too, or Esc and the keys never reach it.
        builder.inner_size(w, h).position(x, y).focused(true)
    }
}

/// The rectangle that gives the same window back through `opening`: Windows
/// places the whole frame, the other systems size the content.
fn rect_of(win: &WebviewWindow) -> Option<Rect> {
    let at = win.outer_position().ok()?;
    #[cfg(windows)]
    let size = win.outer_size().ok()?;
    #[cfg(not(windows))]
    let size = win.inner_size().ok()?;
    Some([at.x, at.y, size.width as i32, size.height as i32])
}

/// Saved when the window goes, not on every move: nothing is written while the
/// user drags. A maximized or minimized window keeps the place it had before.
pub fn remember(app: &AppHandle, win: &WebviewWindow) {
    if win.is_maximized().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
        return;
    }
    let Some(rect) = rect_of(win) else { return };
    if rect[2] >= NOT_PLACED_BELOW && rect[3] >= NOT_PLACED_BELOW {
        crate::prefs::update(app, |p| p.menu_rect = Some(rect));
    }
}

/// The X and Alt+F4 ask the server to close, as Esc does. If it does not answer
/// (it is restarting) the window goes anyway: nothing may stay on top for good.
fn ask_to_close(own: &WebviewWindow) {
    let _ = own.eval(post_js("{\"open\":false}"));
    let win = own.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GIVE_UP_AFTER);
        let app = win.app_handle();
        if app.get_webview_window(win.label()).is_some() {
            remember(app, &win);
            let _ = win.destroy();
        }
    });
}

pub fn watch_close(win: &WebviewWindow) {
    let own = win.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            ask_to_close(&own);
        }
        WindowEvent::Focused(focused) => {
            if *focused {
                raise(&own);
            }
            report_behind(&own, *focused);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = [0, 0, 3840, 2088];
    const EDGE: Rect = [573, 2160, 2560, 720];

    #[test]
    fn the_page_asks_the_server_in_valid_javascript() {
        let js = post_js("{\"behind\":true}");
        assert!(js.contains("body:'{\"behind\":true}'"));
        assert!(js.starts_with("try{fetch('/screen-menu',{method:'POST'"));
        assert!(js.ends_with("catch(e){}"));
    }

    #[test]
    fn opens_in_the_middle_at_the_size_of_its_screen() {
        assert_eq!(centred(MAIN, 1.5), [1110, 504, 1620, 1080]);
        assert_eq!(centred([100, 50, 1920, 1040], 1.0), [520, 210, 1080, 720]);
    }

    #[test]
    fn a_small_screen_keeps_a_margin() {
        let [_, y, _, h] = centred(EDGE, 1.0);
        assert_eq!(h, 648);
        assert_eq!(y, 2160 + 36);
        assert_eq!(centred([0, 0, 1024, 600], 2.0)[2..], [921, 540]);
    }

    #[test]
    fn the_saved_place_is_used_as_it_is() {
        assert_eq!(kept([200, 300, 900, 700], &[MAIN, EDGE]), Some((0, [200, 300, 900, 700])));
        assert_eq!(kept([700, 2200, 900, 400], &[MAIN, EDGE]), Some((1, [700, 2200, 900, 400])));
    }

    #[test]
    fn a_window_past_the_edge_comes_back_whole() {
        assert_eq!(kept([3200, -40, 900, 700], &[MAIN]), Some((0, [2940, 0, 900, 700])));
        assert_eq!(kept([0, 0, 5000, 3000], &[MAIN]), Some((0, [0, 0, 3840, 2088])));
    }

    #[test]
    fn a_screen_that_went_away_does_not_hold_the_window() {
        assert_eq!(kept([-1500, 700, 900, 700], &[MAIN, EDGE]), None);
    }
}
