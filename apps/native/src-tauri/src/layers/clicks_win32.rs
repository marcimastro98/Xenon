//! Words on the screen that clicks go through (the game HUD). Windows has one
//! region for what a window draws and what takes the mouse, so those rectangles
//! have to be in the region to be seen: the window lets the mouse past as a
//! whole instead, with the styles `set_ignore_cursor_events` uses. A window that
//! also holds a widget to press does that only while the cursor is off it.

use super::ffi::*;

/// How a window answers the mouse, from what its page reported.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Mode {
    /// Inside its region it takes every click, as any window does.
    #[default]
    Takes,
    /// Nothing on it can be pressed.
    Passes,
    /// Some of it can: the cursor decides, on a timer (`win32::watch_cursor`).
    ByCursor,
}

fn mode_of(solid: &[[i32; 4]], through: &[[i32; 4]]) -> Mode {
    match (solid.is_empty(), through.is_empty()) {
        (_, true) => Mode::Takes,
        (true, false) => Mode::Passes,
        (false, false) => Mode::ByCursor,
    }
}

fn on_any(rects: &[[i32; 4]], x: i32, y: i32) -> bool {
    rects.iter().any(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3])
}

fn with_passing(ex: isize, on: bool) -> isize {
    // Layered stays once set: taking it off rebuilds the window's surface, and
    // the cursor crossing a widget would show as a flicker.
    if on {
        ex | (WS_EX_TRANSPARENT | WS_EX_LAYERED) as isize
    } else {
        ex & !(WS_EX_TRANSPARENT as isize)
    }
}

fn set_passing(h: isize, on: bool) {
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    let layered = ex & WS_EX_LAYERED as isize != 0;
    unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, with_passing(ex, on)) };
    if on && !layered {
        // A layered window shows nothing until it is told how.
        unsafe { SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA) };
    }
}

#[derive(Default)]
pub struct Clicks {
    solid: Vec<[i32; 4]>,
    mode: Mode,
    passing: bool,
}

impl Clicks {
    fn pass(&mut self, h: isize, on: bool) {
        if self.passing != on {
            self.passing = on;
            set_passing(h, on);
        }
    }

    pub fn report(&mut self, h: isize, solid: Vec<[i32; 4]>, through: &[[i32; 4]]) {
        self.mode = mode_of(&solid, through);
        self.solid = solid;
        match self.mode {
            Mode::Takes => self.pass(h, false),
            Mode::Passes => self.pass(h, true),
            Mode::ByCursor => {}
        }
    }

    pub fn by_cursor(&self) -> bool {
        self.mode == Mode::ByCursor
    }

    /// The cursor in the window's own pixels, like the page's rectangles.
    pub fn follow(&mut self, h: isize, x: i32, y: i32) {
        self.pass(h, !on_any(&self.solid, x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDGET: [i32; 4] = [100, 50, 200, 80];
    const HUD: [i32; 4] = [1000, 16, 180, 90];

    #[test]
    fn a_window_decides_from_what_its_page_reported() {
        assert_eq!(mode_of(&[], &[]), Mode::Takes);
        assert_eq!(mode_of(&[WIDGET], &[]), Mode::Takes);
        assert_eq!(mode_of(&[], &[HUD]), Mode::Passes);
        assert_eq!(mode_of(&[WIDGET], &[HUD]), Mode::ByCursor);
    }

    #[test]
    fn the_last_pixel_of_a_widget_is_on_it_and_the_next_is_not() {
        assert!(on_any(&[WIDGET], 100, 50));
        assert!(on_any(&[WIDGET], 299, 129));
        assert!(!on_any(&[WIDGET], 300, 129));
        assert!(!on_any(&[WIDGET], 299, 130));
        assert!(!on_any(&[], 0, 0));
    }

    #[test]
    fn letting_the_mouse_past_keeps_the_other_styles() {
        let ex = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW as isize;
        let on = with_passing(ex, true);
        assert_eq!(on & WS_EX_NOACTIVATE, WS_EX_NOACTIVATE);
        assert_ne!(on & WS_EX_TRANSPARENT as isize, 0);
        let off = with_passing(on, false);
        assert_eq!(off & WS_EX_TRANSPARENT as isize, 0);
        assert_ne!(off & WS_EX_LAYERED as isize, 0, "the surface stays as it is");
        assert_ne!(off & WS_EX_TOOLWINDOW as isize, 0);
    }
}
