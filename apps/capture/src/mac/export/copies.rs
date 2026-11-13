// macOS export: the smaller copy, the vertical copy, the copy that must fit in a number of megabytes, and the GIF.

use std::path::Path;
use objc2::rc::autoreleasepool;
use crate::bubble::{self, Corner};
use crate::reframe::{self, Crop, Focus, Pace, Resampler};
use super::{cancelled, feed, FIT_TRIES, GIF_MAX_BYTES, GIF_MAX_HELD, Out, Stop};
use super::source::{even, even_crop, open, Opened, Plan};
use super::super::image;
use super::super::encode::Encoder;
use super::super::frame::Locked;
use super::super::reader::{self, Read};
use super::super::writer::Shape;

/// The opened source encoded as `plan` says into an MP4 at `part`.
fn transcode(o: Opened, part: &Path, plan: &Plan, progress: &mut dyn FnMut(f64)) -> Out<()> {
    let _ = std::fs::remove_file(part);
    let shape = Shape {
        width: plan.size.0,
        height: plan.size.1,
        fps: plan.fps,
        bitrate: plan.bps,
        tracks: 0,
    };
    let encoder = Encoder::new(part, &shape, o.source.sound.as_ref().map(|s| s.format()))?;
    match feed(&o, &encoder, plan, progress) {
        Ok(()) => encoder.finish().map_err(Stop::from),
        Err(stop) => {
            encoder.cancel();
            Err(stop)
        }
    }
}

/// A 9:16 copy; with the corner of the recording's webcam, that bubble on
/// top and the game below.
pub(super) fn vertical(
    src: &str,
    part: &Path,
    focus: Focus,
    webcam: Option<Corner>,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let o = open(src, reader::NV12, true)?;
    let (w, h) = o.size;
    let parts = match webcam {
        Some(corner) => {
            let split = reframe::vertical_split(w, h, focus, bubble::place(w, h, corner));
            vec![split.cam, split.game]
        }
        None => vec![reframe::vertical(w, h, focus)],
    };
    let parts: Vec<_> = parts
        .into_iter()
        .map(|(crop, size)| (even_crop(crop), even(size)))
        .collect();
    let size = (parts[0].1 .0, parts.iter().map(|p| p.1 .1).sum());
    let fps = o.source.fps.min(60);
    let plan = Plan {
        parts,
        size,
        fps,
        bps: reframe::vertical_bitrate(size.0, size.1, fps),
    };
    transcode(o, part, &plan, progress)?;
    Ok(size)
}

pub(super) fn fit(
    src: &str,
    part: &Path,
    target: u64,
    seconds: f64,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let o = open(src, reader::NV12, true)?;
    let length = if o.source.seconds > 0.0 {
        o.source.seconds
    } else {
        seconds
    };
    if !length.is_finite() || length <= 0.0 {
        return Err(Stop::Failed);
    }
    let sound = o.source.sound.as_ref().map_or(0, |s| s.bps);
    let (w, h) = o.size;
    let f =
        reframe::fit((w, h), o.source.fps.min(60), length, target, sound).ok_or(Stop::TooLong)?;
    let size = even((f.width, f.height));
    let mut plan = Plan {
        parts: vec![(even_crop(Crop::whole(w, h)), size)],
        size,
        fps: f.fps,
        bps: f.video_bps,
    };
    let mut opened = Some(o);
    for _ in 0..FIT_TRIES {
        let o = match opened.take() {
            Some(o) => o,
            None => open(src, reader::NV12, true)?,
        };
        transcode(o, part, &plan, progress)?;
        let written = std::fs::metadata(part).map_err(|_| Stop::Failed)?.len();
        if written <= target {
            return Ok(size);
        }
        let _ = std::fs::remove_file(part);
        let less = reframe::retry_bitrate(plan.bps, target, written);
        if less >= plan.bps {
            break;
        }
        plan.bps = less;
    }
    Err(Stop::TooLong)
}

/// A looping GIF: the decoder's colour frames scaled to the GIF's size,
/// written by ImageIO with a palette of its own each.
pub(super) fn gif(src: &str, part: &Path, progress: &mut dyn FnMut(f64)) -> Out<(u32, u32)> {
    let o = open(src, reader::BGRA, false)?;
    let (w, h) = o.size;
    let size = even(reframe::gif_size(w, h));
    let scale = Resampler::new(4, Crop::whole(w, h), size);
    let mut px = vec![0u8; scale.len()];
    let most = GIF_MAX_HELD / scale.len().max(1);
    let mut pace = Pace::new(reframe::GIF_DELAY_CS as i64 * 100_000);
    let (base, total) = (o.base()?, o.total());
    let mut first = Some(o.first.clone());
    let mut kept = Vec::new();
    loop {
        cancelled()?;
        let sample = match o.next(&mut first) {
            Read::Sample(s) => s,
            Read::End => break,
            Read::Failed => return Err(Stop::Failed),
        };
        let Some(at) = reader::time_of(&sample).map(|t| t - base) else {
            continue;
        };
        if at < 0 || !pace.take(at) {
            continue;
        }
        let picture = autoreleasepool(|_| {
            let buffer = unsafe { sample.image_buffer() }?;
            let locked = Locked::read(&buffer)?;
            let plane = locked.plane(0)?;
            scale.run(plane.data, plane.stride, &mut px);
            image::from_bgrx(&px, size)
        });
        kept.push(picture.ok_or(Stop::Failed)?);
        progress(at as f64 / total);
        if kept.len() > most {
            return Err(Stop::TooBig);
        }
    }
    cancelled()?;
    if kept.is_empty() || !image::write_gif(&kept, reframe::GIF_DELAY_CS, part) {
        return Err(Stop::Failed);
    }
    if std::fs::metadata(part).map_or(0, |m| m.len()) > GIF_MAX_BYTES {
        return Err(Stop::TooBig);
    }
    Ok(size)
}
