//! The webcam bubble in a recording: each captured frame is copied into a
//! buffer of our own pool and the bubble (bubble_nv12.rs) drawn on the copy,
//! so the captured picture is never written to. The bubble is drawn again
//! only when the camera hands a new picture, and a frame repeated by the
//! clock with the same camera picture reuses the last copy.

use std::ptr::{null_mut, NonNull};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_foundation::{CFDictionary, CFRetained};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelBufferWidthKey, CVPixelBuffer, CVPixelBufferPool,
};
use objc2_foundation::{NSDictionary, NSString};

use super::bubble_nv12::{copy_plane, Picture, Stamp};
use super::camera::Camera;
use super::frame::{self, Locked};
use super::reader::NV12;
use super::writer::{any, dict, num};
use crate::bubble::Corner;

/// kCVReturnSuccess
const CV_OK: i32 = 0;

struct Pool {
    size: (u32, u32),
    pool: CFRetained<CVPixelBufferPool>,
}

/// The last frame drawn: the captured picture, the camera picture in it and
/// the copy that went to the writer.
struct Last {
    src: CFRetained<CVPixelBuffer>,
    seq: u64,
    out: CFRetained<CVPixelBuffer>,
}

pub struct Bubble {
    camera: Camera,
    corner: Corner,
    pool: Option<Pool>,
    /// The camera picture and frame size it was drawn for.
    stamp: Option<(u64, (u32, u32), Stamp)>,
    last: Option<Last>,
}

impl Bubble {
    /// The camera running for a bubble in `corner`; None without a camera.
    pub fn open(corner: Corner) -> Option<Bubble> {
        Some(Bubble {
            camera: Camera::open()?,
            corner,
            pool: None,
            stamp: None,
            last: None,
        })
    }

    /// `picture` with the bubble on a copy; the picture as it is when the
    /// copy cannot be made (the frame is kept, without the bubble).
    pub fn over(&mut self, picture: CFRetained<CVPixelBuffer>) -> CFRetained<CVPixelBuffer> {
        let Some(seq) = self.camera.with_latest(|p| p.seq) else {
            return picture;
        };
        if let Some(last) = &self.last {
            if last.seq == seq && std::ptr::eq::<CVPixelBuffer>(&*last.src, &*picture) {
                return last.out.clone();
            }
        }
        match self.draw(&picture) {
            Some(out) => {
                self.last = Some(Last { src: picture, seq, out: out.clone() });
                out
            }
            None => picture,
        }
    }

    fn draw(&mut self, src: &CVPixelBuffer) -> Option<CFRetained<CVPixelBuffer>> {
        let size = frame::size(src);
        self.restamp(size);
        let out = self.blank(size)?;
        let stamp = &self.stamp.as_ref().filter(|s| s.1 == size)?.2;
        {
            let from = Locked::read(src)?;
            let [y, uv] = from.planes()?;
            let mut to = Locked::write(&out)?;
            let [mut ty, mut tuv] = to.planes_mut()?;
            let (w, h) = (size.0 as usize, size.1 as usize);
            let chroma_bytes = w.div_ceil(2) * 2;
            if !copy_plane(&y, &mut ty, h, w) || !copy_plane(&uv, &mut tuv, h.div_ceil(2), chroma_bytes) {
                return None;
            }
            stamp.draw([ty, tuv]);
        }
        // The colour tags (BT.709) go with the picture to the encoder.
        src.propagate_attachments(&out);
        Some(out)
    }

    /// The bubble drawn again when the camera has a new picture or the
    /// frame changed size.
    fn restamp(&mut self, size: (u32, u32)) {
        let corner = self.corner;
        let current = self.stamp.as_ref().map(|s| (s.0, s.1));
        let made = self.camera.with_latest(|p| {
            if current == Some((p.seq, size)) {
                return None;
            }
            let picture = Picture {
                width: p.width,
                height: p.height,
                stride: p.width as usize * 4,
                bgra: &p.bgra,
            };
            Stamp::new(size, corner, &picture).map(|s| (p.seq, size, s))
        });
        if let Some(Some(stamp)) = made {
            self.stamp = Some(stamp);
        }
    }

    /// A frame of `size` from our pool, made again when the size changes.
    fn blank(&mut self, size: (u32, u32)) -> Option<CFRetained<CVPixelBuffer>> {
        if self.pool.as_ref().map(|p| p.size) != Some(size) {
            self.last = None;
            self.pool = pool(size);
        }
        let pool = &self.pool.as_ref()?.pool;
        let mut out: *mut CVPixelBuffer = null_mut();
        let status = unsafe { CVPixelBufferPool::create_pixel_buffer(None, pool, NonNull::from(&mut out)) };
        let out = NonNull::new(out).map(|p| unsafe { CFRetained::from_raw(p) })?;
        (status == CV_OK).then_some(out)
    }
}

/// A pool of NV12 frames of `size`, IOSurface backed as the encoder likes them.
fn pool(size: (u32, u32)) -> Option<Pool> {
    let attributes: Retained<NSDictionary<NSString, AnyObject>> = dict(&[
        (frame::ns(unsafe { kCVPixelBufferPixelFormatTypeKey }), num(NV12 as i64)),
        (frame::ns(unsafe { kCVPixelBufferWidthKey }), num(size.0 as i64)),
        (frame::ns(unsafe { kCVPixelBufferHeightKey }), num(size.1 as i64)),
        (
            frame::ns(unsafe { kCVPixelBufferIOSurfacePropertiesKey }),
            any(NSDictionary::<NSString, AnyObject>::new()),
        ),
    ]);
    // NSDictionary and CFDictionary are the same object (toll-free bridged).
    let cf: &CFDictionary = unsafe { &*Retained::as_ptr(&attributes).cast::<CFDictionary>() };
    let mut out: *mut CVPixelBufferPool = null_mut();
    let status = unsafe { CVPixelBufferPool::create(None, None, Some(cf), NonNull::from(&mut out)) };
    let pool = NonNull::new(out).map(|p| unsafe { CFRetained::from_raw(p) })?;
    (status == CV_OK).then_some(Pool { size, pool })
}
