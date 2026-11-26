// Windows: the mouse on a window of our own: held while a press lasts, the hand cursor over it, no activation on a click.

pub const WM_SETCURSOR: u32 = 0x0020;
pub const WM_MOUSEACTIVATE: u32 = 0x0021;
pub const MA_NOACTIVATE: isize = 3;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_CAPTURECHANGED: u32 = 0x0215;
pub const IDC_HAND: usize = 32649;

#[link(name = "user32")]
extern "system" {
    pub fn SetCapture(h: isize) -> isize;
    pub fn ReleaseCapture() -> i32;
    pub fn LoadCursorW(inst: isize, name: *const u16) -> isize;
    pub fn SetCursor(cursor: isize) -> isize;
}
