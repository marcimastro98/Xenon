// Windows: the wallpaper stops under a window that fills its monitor, and starts again after.

use super::{COVER_TIMER, Entry, STATE};
use super::styles::show;
use super::super::scene;
use super::super::ffi::*;
use super::super::spec::Kind;

/// The screensaver and the Xenon menu take the keyboard; the window they took
/// it from gets it back when the last one closes.
pub(super) fn takes_over(kind: Kind) -> bool {
    matches!(kind, Kind::Saver | Kind::Menu)
}

/// Longer than Windows' window animations, which run about a quarter of a second.
const COVER_GRACE_MS: u32 = 600;

fn wallpaper_on(e: &Entry) -> bool {
    scene::attached(e.hwnd) && !e.paused && !scene::remote_session()
}

/// Under a window filling its monitor the wallpaper stops, but only once that
/// window has finished arriving: hidden at once, the picture under it flashed
/// through the app's opening animation.
pub(super) fn settle_wallpaper(e: &Entry) {
    let on = wallpaper_on(e);
    if on && e.covered {
        COVER_TIMER.with(|t| {
            if t.get() == 0 {
                t.set(unsafe { SetTimer(0, 0, COVER_GRACE_MS, on_cover_settled as *const () as isize) });
            }
        });
    } else {
        show(e, on);
    }
}

/// Decides again when it fires, so a window closed meanwhile hid nothing.
extern "system" fn on_cover_settled(_: isize, _: u32, _: usize, _: u32) {
    COVER_TIMER.with(|t| {
        unsafe { KillTimer(0, t.get()) };
        t.set(0);
    });
    STATE.with(|cell| {
        let Ok(st) = cell.try_borrow() else { return };
        for e in st.entries.iter().filter(|e| e.kind == Kind::Wallpaper && e.covered) {
            show(e, false);
        }
    });
}

/// `xenon-app:scene-pause` from a wallpaper page: on battery it stops until
/// the charger is back.
pub fn set_paused(hwnd: isize, paused: bool) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        if let Some(e) = st.entries.iter_mut().find(|e| e.hwnd == hwnd && e.kind == Kind::Wallpaper) {
            e.paused = paused;
            settle_wallpaper(e);
        }
    });
}

pub(super) fn drawn(solid: &[[i32; 4]], through: &[[i32; 4]]) -> Vec<[i32; 4]> {
    [solid, through].concat()
}
