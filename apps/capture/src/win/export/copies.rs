// Windows export: the vertical copy and the copy that must fit in a number of megabytes.

use crate::bubble::{self, Corner};
use crate::reframe::{self, Crop, Focus};
use super::{FIT_TRIES, Out, Stop};
use super::encode::{encode, Plan};
use super::source::open;

/// The plan's crop moved into the frame (it was planned on the visible part),
/// on even pixels: NV12 pairs every two pixels for colour.
pub(super) fn within(visible: Crop, c: Crop) -> Crop {
    Crop {
        x: (visible.x + c.x) & !1,
        y: (visible.y + c.y) & !1,
        w: c.w & !1,
        h: c.h & !1,
    }
}

/// Encoders take even sizes only.
pub(super) fn even((w, h): (u32, u32)) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

/// A 9:16 copy; with the corner of the recording's webcam, that bubble on
/// top and the game below.
pub(super) fn vertical(
    src: &str,
    part: &str,
    focus: Focus,
    webcam: Option<Corner>,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let s = open(src, false)?;
    let (w, h) = (s.visible.w, s.visible.h);
    let parts = match webcam {
        Some(corner) => {
            let split = reframe::vertical_split(w, h, focus, bubble::place(w, h, corner));
            vec![split.cam, split.game]
        }
        None => vec![reframe::vertical(w, h, focus)],
    };
    let parts: Vec<_> = parts
        .into_iter()
        .map(|(crop, size)| (within(s.visible, crop), even(size)))
        .collect();
    let size = (parts[0].1 .0, parts.iter().map(|p| p.1 .1).sum());
    let fps = s.fps.min(60);
    let plan = Plan {
        parts,
        size,
        fps,
        bps: reframe::vertical_bitrate(size.0, size.1, fps),
    };
    drop(s);
    encode(src, part, &plan, progress)?;
    Ok(size)
}

pub(super) fn fit(
    src: &str,
    part: &str,
    target: u64,
    seconds: f64,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let s = open(src, true)?;
    let length = if s.seconds > 0.0 { s.seconds } else { seconds };
    if !length.is_finite() || length <= 0.0 {
        return Err(Stop::Failed);
    }
    let sound = s.audio.as_ref().map_or(0, |a| a.2);
    let Some(f) = reframe::fit(
        (s.visible.w, s.visible.h),
        s.fps.min(60),
        length,
        target,
        sound,
    ) else {
        return Err(Stop::TooLong);
    };
    let mut plan = Plan {
        parts: vec![(
            within(s.visible, Crop::whole(s.visible.w, s.visible.h)),
            even((f.width, f.height)),
        )],
        size: even((f.width, f.height)),
        fps: f.fps,
        bps: f.video_bps,
    };
    drop(s);
    for _ in 0..FIT_TRIES {
        encode(src, part, &plan, progress)?;
        let written = std::fs::metadata(part).map_err(|_| Stop::Failed)?.len();
        if written <= target {
            return Ok(plan.size);
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
