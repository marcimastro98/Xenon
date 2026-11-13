//! Exports of a saved video, the parts that are the same on every platform:
//! the 9:16 crop of a vertical copy, the size and bitrate of a copy that must
//! fit in a number of megabytes, the size of a GIF, and the resampler that
//! turns a decoded frame into the exported one.

mod resample;
#[cfg(test)]
mod unit_tests;

pub use resample::Resampler;
// Only the Windows export reads video colours; elsewhere this import would be unused.
#[cfg(windows)]
pub use resample::{nv12_to_bgrx, Yuv};

/// Which part of a wide picture a vertical copy keeps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Focus {
    Left,
    Center,
    Right,
}

impl Focus {
    pub fn parse(asked: Option<&str>) -> Focus {
        match asked {
            Some("left") => Focus::Left,
            Some("right") => Focus::Right,
            _ => Focus::Center,
        }
    }
}

/// A part of a frame in pixels: left, top, width, height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Crop {
    pub fn whole(w: u32, h: u32) -> Crop {
        Crop { x: 0, y: 0, w, h }
    }
}

/// The tallest vertical copy: what phones and short-video apps show.
const VERTICAL_MAX_HEIGHT: u32 = 1920;

/// The 9:16 part of a `w` x `h` frame (all of it when it is already that
/// narrow), and the even size it is written at, never larger than it is.
pub fn vertical(w: u32, h: u32, focus: Focus) -> (Crop, (u32, u32)) {
    let (w, h) = (w.max(2), h.max(2));
    let crop = if w * 16 > h * 9 {
        let cw = (h * 9 / 16).max(2) & !1;
        let x = match focus {
            Focus::Left => 0,
            Focus::Center => (w - cw) / 2,
            Focus::Right => w - cw,
        };
        Crop { x, y: 0, w: cw, h }
    } else {
        let ch = (w * 16 / 9).min(h).max(2) & !1;
        Crop {
            x: 0,
            y: (h - ch) / 2,
            w,
            h: ch,
        }
    };
    let oh = crop.h.min(VERTICAL_MAX_HEIGHT);
    let ow = (crop.w as u64 * oh as u64 / crop.h as u64) as u32;
    (crop, (even(ow), even(oh)))
}

fn even(n: u32) -> u32 {
    (n & !1).max(2)
}

/// The share of a split vertical copy the webcam takes, at the top.
const SPLIT_CAM_SHARE: f64 = 0.35;
/// How much of the bubble's radius is the camera picture: the rest is the
/// soft edge and the light ring the recording drew around it.
const SPLIT_CAM_INSIDE: f64 = 0.9;

/// A vertical copy in two parts stacked, as streamers post them: the webcam
/// on top, the game below. Each part is a crop of the source and the size it
/// is written at; the two sizes share the width and add up to the copy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Split {
    pub cam: (Crop, (u32, u32)),
    pub game: (Crop, (u32, u32)),
}

/// The split copy of a `w` x `h` recording whose webcam bubble is `bubble`
/// (fractions of the frame: left, top, right, bottom, as bubble::place). The
/// webcam part is the widest rectangle inside the bubble's circle, so no game
/// shows around the face; the game part keeps the full height at `focus`.
pub fn vertical_split(w: u32, h: u32, focus: Focus, bubble: [f32; 4]) -> Split {
    let (w, h) = (w.max(2), h.max(2));
    let (_, (ow, oh)) = vertical(w, h, focus);
    let top = even((oh as f64 * SPLIT_CAM_SHARE) as u32);
    let bottom = even(oh - top);
    // The game: the output's shape at the source's full height when it fits.
    let full = (h as u64 * ow as u64 / bottom as u64) as u32;
    let (gw, gh) = if full <= w {
        (full & !1, h & !1)
    } else {
        (
            w & !1,
            ((w as u64 * bottom as u64 / ow as u64) as u32).min(h) & !1,
        )
    };
    let gx = match focus {
        Focus::Left => 0,
        Focus::Center => (w - gw) / 2,
        Focus::Right => w - gw,
    } & !1;
    let game = Crop {
        x: gx,
        y: ((h - gh) / 2) & !1,
        w: gw.max(2),
        h: gh.max(2),
    };
    // The webcam: a rectangle of the output's shape inside the circle.
    let (fw, fh) = (w as f64, h as f64);
    let cx = (bubble[0] + bubble[2]) as f64 / 2.0 * fw;
    let cy = (bubble[1] + bubble[3]) as f64 / 2.0 * fh;
    let r = (bubble[2] - bubble[0]) as f64 * fw / 2.0 * SPLIT_CAM_INSIDE;
    let aspect = ow as f64 / top as f64;
    let half_h = r / (1.0 + aspect * aspect).sqrt();
    let half_w = half_h * aspect;
    let cam_w = ((2.0 * half_w) as u32).clamp(2, w) & !1;
    let cam_h = ((2.0 * half_h) as u32).clamp(2, h) & !1;
    let cam = Crop {
        x: ((cx - half_w).max(0.0) as u32).min(w - cam_w) & !1,
        y: ((cy - half_h).max(0.0) as u32).min(h - cam_h) & !1,
        w: cam_w,
        h: cam_h,
    };
    Split {
        cam: (cam, (ow, top)),
        game: (game, (ow, bottom)),
    }
}

/// A good-looking vertical copy: bits per pixel of each frame, and the most.
const VERTICAL_BPP: f64 = 0.12;
const VERTICAL_MAX_BPS: u32 = 16_000_000;

pub fn vertical_bitrate(w: u32, h: u32, fps: u32) -> u32 {
    let bps = w as f64 * h as f64 * fps.max(1) as f64 * VERTICAL_BPP;
    (bps as u32).clamp(1_000_000, VERTICAL_MAX_BPS)
}

/// The copy that fits: its size, frame rate and video bitrate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_bps: u32,
}

/// Room left for the file's own boxes and the encoder overshooting a little.
const FIT_MARGIN: f64 = 0.9;
/// Below this the picture is mush: the clip is too long for the size.
pub const FIT_MIN_VIDEO_BPS: u32 = 150_000;
/// Bits each pixel of each frame needs to stay sharp at a size.
const FIT_BPP: f64 = 0.07;
/// The short sides tried, largest first; never larger than the source.
const FIT_SHORT_SIDES: [u32; 6] = [1440, 1080, 720, 540, 480, 360];

/// The largest size and frame rate (the source's, else 30) whose video still
/// gets FIT_BPP from what is left of `target_bytes` over `seconds` once the
/// sound (`audio_bps`) is paid; the smallest size when none does. None when
/// even that would be under FIT_MIN_VIDEO_BPS.
pub fn fit(
    (w, h): (u32, u32),
    src_fps: u32,
    seconds: f64,
    target_bytes: u64,
    audio_bps: u32,
) -> Option<Fit> {
    if !seconds.is_finite() || seconds <= 0.0 || w == 0 || h == 0 {
        return None;
    }
    let total = target_bytes as f64 * 8.0 * FIT_MARGIN / seconds;
    let video = total - audio_bps as f64;
    if video < FIT_MIN_VIDEO_BPS as f64 {
        return None;
    }
    let video = video.min(u32::MAX as f64) as u32;
    let short = w.min(h);
    let mut sides: Vec<u32> = std::iter::once(short)
        .chain(FIT_SHORT_SIDES.iter().copied().filter(|&s| s < short))
        .collect();
    sides.dedup();
    let rates: Vec<u32> = if src_fps > 30 {
        vec![src_fps, 30]
    } else {
        vec![src_fps.max(1)]
    };
    let sized = |s: u32| -> (u32, u32) {
        if w <= h {
            (even(s), even((h as u64 * s as u64 / w as u64) as u32))
        } else {
            (even((w as u64 * s as u64 / h as u64) as u32), even(s))
        }
    };
    for &s in &sides {
        let (fw, fh) = sized(s);
        for &fps in &rates {
            if video as f64 >= fw as f64 * fh as f64 * fps as f64 * FIT_BPP {
                return Some(Fit {
                    width: fw,
                    height: fh,
                    fps,
                    video_bps: video,
                });
            }
        }
    }
    let (fw, fh) = sized(*sides.last()?);
    Some(Fit {
        width: fw,
        height: fh,
        fps: *rates.last()?,
        video_bps: video,
    })
}

/// A copy that came out over the size is made again with this much less, per
/// byte it overshot.
pub fn retry_bitrate(video_bps: u32, target_bytes: u64, written: u64) -> u32 {
    if written == 0 {
        return video_bps;
    }
    let ratio = target_bytes as f64 / written as f64 * 0.95;
    ((video_bps as f64 * ratio.min(0.95)) as u32).max(FIT_MIN_VIDEO_BPS)
}

/// A GIF's longest side, and its frames per second (a frame every 8/100 s:
/// GIF counts time in hundredths).
pub const GIF_LONG_SIDE: u32 = 480;
pub const GIF_DELAY_CS: u16 = 8;

pub fn gif_size(w: u32, h: u32) -> (u32, u32) {
    let (w, h) = (w.max(1), h.max(1));
    if w >= h {
        let gw = w.min(GIF_LONG_SIDE);
        (gw, ((h as u64 * gw as u64 / w as u64) as u32).max(1))
    } else {
        let gh = h.min(GIF_LONG_SIDE);
        (((w as u64 * gh as u64 / h as u64) as u32).max(1), gh)
    }
}

/// Which source frames a copy at `fps` keeps: the first at or after each
/// output tick.
pub struct Pace {
    step: i64,
    next: i64,
}

impl Pace {
    /// `step` in 100-ns units (Media Foundation time).
    pub fn new(step: i64) -> Pace {
        Pace {
            step: step.max(1),
            next: 0,
        }
    }

    pub fn every(fps: u32) -> Pace {
        Pace::new(10_000_000 / fps.max(1) as i64)
    }

    /// True when the frame at `t` is kept.
    pub fn take(&mut self, t: i64) -> bool {
        if t + self.step / 4 < self.next {
            return false;
        }
        // A gap in the source (a paused game) does not burst frames after it.
        self.next = (self.next + self.step).max(t + self.step / 2);
        true
    }
}
