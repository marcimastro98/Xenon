//! Pixel buffers opened for the CPU: the planes of a decoded frame to read,
//! the planes of a new frame to fill. Locked while open, unlocked when dropped.

use objc2_core_foundation::CFString;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBaseAddressOfPlane,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetPlaneCount, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::NSString;

use crate::stack::{Plane, PlaneMut};

/// kCVReturnSuccess
const CV_OK: i32 = 0;

/// A CoreFoundation string constant as the NSString it is (toll-free bridged).
pub fn ns(k: &CFString) -> &NSString {
    unsafe { &*(k as *const CFString).cast::<NSString>() }
}

/// A frame's size in pixels (no lock needed).
pub fn size(buffer: &CVPixelBuffer) -> (u32, u32) {
    (
        CVPixelBufferGetWidth(buffer) as u32,
        CVPixelBufferGetHeight(buffer) as u32,
    )
}

pub struct Locked<'a> {
    buffer: &'a CVPixelBuffer,
    flags: CVPixelBufferLockFlags,
}

impl<'a> Locked<'a> {
    fn lock(buffer: &'a CVPixelBuffer, flags: CVPixelBufferLockFlags) -> Option<Locked<'a>> {
        (unsafe { CVPixelBufferLockBaseAddress(buffer, flags) } == CV_OK)
            .then_some(Locked { buffer, flags })
    }

    pub fn read(buffer: &'a CVPixelBuffer) -> Option<Locked<'a>> {
        Locked::lock(buffer, CVPixelBufferLockFlags::ReadOnly)
    }

    pub fn write(buffer: &'a CVPixelBuffer) -> Option<Locked<'a>> {
        Locked::lock(buffer, CVPixelBufferLockFlags::empty())
    }

    /// Plane `i` (the whole picture for a buffer of one plane): its start,
    /// its bytes and its row length.
    fn raw(&self, i: usize) -> Option<(*mut u8, usize, usize)> {
        let (at, stride, rows) = if CVPixelBufferGetPlaneCount(self.buffer) == 0 {
            (
                CVPixelBufferGetBaseAddress(self.buffer),
                CVPixelBufferGetBytesPerRow(self.buffer),
                CVPixelBufferGetHeight(self.buffer),
            )
        } else {
            (
                CVPixelBufferGetBaseAddressOfPlane(self.buffer, i),
                CVPixelBufferGetBytesPerRowOfPlane(self.buffer, i),
                CVPixelBufferGetHeightOfPlane(self.buffer, i),
            )
        };
        (!at.is_null() && stride > 0).then_some((at.cast::<u8>(), stride * rows, stride))
    }

    pub fn plane(&self, i: usize) -> Option<Plane<'_>> {
        let (at, len, stride) = self.raw(i)?;
        Some(Plane {
            data: unsafe { std::slice::from_raw_parts(at, len) },
            stride,
        })
    }

    /// An NV12 frame's luma and chroma planes.
    pub fn planes(&self) -> Option<[Plane<'_>; 2]> {
        Some([self.plane(0)?, self.plane(1)?])
    }

    /// The same to fill, for a buffer locked to `write` (the two planes
    /// never overlap).
    pub fn planes_mut(&mut self) -> Option<[PlaneMut<'_>; 2]> {
        if self.flags.contains(CVPixelBufferLockFlags::ReadOnly)
            || CVPixelBufferGetPlaneCount(self.buffer) < 2
        {
            return None;
        }
        let (Some((y, y_len, y_stride)), Some((uv, uv_len, uv_stride))) =
            (self.raw(0), self.raw(1))
        else {
            return None;
        };
        Some([
            PlaneMut {
                data: unsafe { std::slice::from_raw_parts_mut(y, y_len) },
                stride: y_stride,
            },
            PlaneMut {
                data: unsafe { std::slice::from_raw_parts_mut(uv, uv_len) },
                stride: uv_stride,
            },
        ])
    }
}

impl Drop for Locked<'_> {
    fn drop(&mut self) {
        unsafe { CVPixelBufferUnlockBaseAddress(self.buffer, self.flags) };
    }
}
