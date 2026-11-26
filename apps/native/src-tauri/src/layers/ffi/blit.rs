// Windows: pixels into a layered window: a top-down 32-bit DIB of premultiplied BGRA handed to
// UpdateLayeredWindow with its place on the screen, then freed (the system keeps its own copy).

use super::{
    BitmapInfo, Blend, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, Point, Rect, ReleaseDC,
    SelectObject, Size, UpdateLayeredWindow, AC_SRC_ALPHA, ULW_ALPHA,
};

/// `pixels` holds `at`'s width x height, four bytes each; `alpha` fades the whole window.
pub fn blit(hwnd: isize, at: Rect, pixels: &[u8], alpha: u8) -> bool {
    let (cx, cy) = (at.r - at.l, at.b - at.t);
    if cx <= 0 || cy <= 0 || pixels.len() != cx as usize * cy as usize * 4 {
        return false;
    }
    let info = BitmapInfo {
        size: 40,
        width: cx,
        height: -cy,
        planes: 1,
        bit_count: 32,
        compression: 0,
        size_image: 0,
        x_ppm: 0,
        y_ppm: 0,
        clr_used: 0,
        clr_important: 0,
        colors: [0],
    };
    unsafe {
        let screen = GetDC(0);
        let mem = CreateCompatibleDC(screen);
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(mem, &info, 0, &mut bits, 0, 0);
        let mut ok = false;
        if bmp != 0 && !bits.is_null() {
            std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());
            let old = SelectObject(mem, bmp);
            let pos = Point { x: at.l, y: at.t };
            let size = Size { cx, cy };
            let src = Point { x: 0, y: 0 };
            let b = Blend { op: 0, flags: 0, alpha, format: AC_SRC_ALPHA };
            ok = UpdateLayeredWindow(hwnd, screen, &pos, &size, mem, &src, 0, &b, ULW_ALPHA) != 0;
            SelectObject(mem, old);
            DeleteObject(bmp);
        }
        DeleteDC(mem);
        ReleaseDC(0, screen);
        ok
    }
}
