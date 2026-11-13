// macOS export: opening the saved video and taking its frames, cropped to even sizes.

use objc2_core_media::CMSampleBuffer;
use objc2::rc::Retained;
use crate::reframe::{Crop, Pace};
use crate::stack::Stack;
use crate::video::TICKS_PER_SECOND;
use super::{Out, Stop};
use super::super::encode::Encoder;
use super::super::frame::{self, Locked};
use super::super::reader::{self, Read, Source};

/// A source with its first frame read: every plan is made on the size the
/// decoder hands, which is what the CPU cuts.
pub(super) struct Opened {
    pub(super) source: Source,
    pub(super) first: Retained<CMSampleBuffer>,
    pub(super) size: (u32, u32),
}

pub(super) fn open(src: &str, pixels: u32, with_sound: bool) -> Out<Opened> {
    let source = reader::open(src, pixels, with_sound).ok_or(Stop::Failed)?;
    let Read::Sample(first) = source.next_video() else {
        return Err(Stop::Failed);
    };
    let buffer = unsafe { first.image_buffer() }.ok_or(Stop::Failed)?;
    let size = frame::size(&buffer);
    if size.0 < 2 || size.1 < 2 {
        return Err(Stop::Failed);
    }
    Ok(Opened {
        source,
        first,
        size,
    })
}

impl Opened {
    /// The first frame again, then the rest.
    pub(super) fn next(&self, first: &mut Option<Retained<CMSampleBuffer>>) -> Read {
        match first.take() {
            Some(s) => Read::Sample(s),
            None => self.source.next_video(),
        }
    }

    pub(super) fn base(&self) -> Out<i64> {
        reader::time_of(&self.first).ok_or(Stop::Failed)
    }

    pub(super) fn total(&self) -> f64 {
        (self.source.seconds * TICKS_PER_SECOND as f64).max(1.0)
    }
}

/// What one encode makes: the parts of the source stacked top to bottom,
/// each with the size it is written at (all as wide as the copy), the copy's
/// size, frames per second and video bits per second.
pub(super) struct Plan {
    pub(super) parts: Vec<(Crop, (u32, u32))>,
    pub(super) size: (u32, u32),
    pub(super) fps: u32,
    pub(super) bps: u32,
}

/// A crop on even pixels: NV12 pairs every two pixels for colour.
pub(super) fn even_crop(c: Crop) -> Crop {
    Crop {
        x: c.x & !1,
        y: c.y & !1,
        w: c.w & !1,
        h: c.h & !1,
    }
}

/// Encoders take even sizes only.
pub(super) fn even((w, h): (u32, u32)) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

/// Each frame the copy keeps: cut and stacked into a frame from the
/// encoder's pool, with the source's colour tags.
pub(super) struct Frames {
    pub(super) stack: Stack,
    pub(super) pace: Pace,
    pub(super) base: i64,
    pub(super) total: f64,
}

impl Frames {
    pub(super) fn take(
        &mut self,
        sample: &CMSampleBuffer,
        encoder: &Encoder,
        progress: &mut dyn FnMut(f64),
    ) -> Out<()> {
        let Some(t) = reader::time_of(sample) else {
            return Ok(());
        };
        let at = t - self.base;
        if at < 0 || !self.pace.take(at) {
            return Ok(());
        }
        let src = unsafe { sample.image_buffer() }.ok_or(Stop::Failed)?;
        let out = encoder.blank()?;
        {
            let from = Locked::read(&src).ok_or(Stop::Failed)?;
            let mut to = Locked::write(&out).ok_or(Stop::Failed)?;
            let (Some(src_planes), Some(out_planes)) = (from.planes(), to.planes_mut()) else {
                return Err(Stop::Failed);
            };
            self.stack.run(src_planes, out_planes);
        }
        // Primaries, matrix and transfer, so the copy plays in the same colours.
        src.propagate_attachments(&out);
        encoder.picture(&out, t)?;
        progress(at as f64 / self.total);
        Ok(())
    }
}
