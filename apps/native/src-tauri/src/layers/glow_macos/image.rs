// macOS: the picture of the glow, drawn once into memory.

use std::ffi::c_void;
use super::{BGRA_PREMULTIPLIED, CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGColorSpaceCreateDeviceRGB, CGColorSpaceRelease, CGContextRelease, CGImageRelease};

/// A CGImage, released with this value.
pub(super) struct Image(*mut c_void);

impl Drop for Image {
    fn drop(&mut self) {
        unsafe { CGImageRelease(self.0) };
    }
}

/// glow::paint's rows (premultiplied BGRA, top row first) as a CGImage. Core
/// Graphics owns the bitmap the rows are copied into, so the image never
/// points at a buffer of ours.
pub(super) fn image(pixels: &[u8], w: usize, h: usize) -> Option<Image> {
    unsafe {
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            return None;
        }
        let ctx = CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, space, BGRA_PREMULTIPLIED);
        CGColorSpaceRelease(space);
        if ctx.is_null() {
            return None;
        }
        let data = CGBitmapContextGetData(ctx).cast::<u8>();
        let stride = CGBitmapContextGetBytesPerRow(ctx);
        let mut made = std::ptr::null_mut();
        if !data.is_null() && stride >= w * 4 {
            for (y, row) in pixels.chunks_exact(w * 4).take(h).enumerate() {
                std::ptr::copy_nonoverlapping(row.as_ptr(), data.add(y * stride), row.len());
            }
            made = CGBitmapContextCreateImage(ctx);
        }
        CGContextRelease(ctx);
        (!made.is_null()).then_some(Image(made))
    }
}
