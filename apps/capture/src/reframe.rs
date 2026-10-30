//! Exports of a saved video, the parts that are the same on every platform:
//! the 9:16 crop of a vertical copy, the size and bitrate of a copy that must
//! fit in a number of megabytes, the size of a GIF, and the resampler that
//! turns a decoded frame into the exported one.

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

/// Fixed-point weights: 1.0 is this.
const ONE: i32 = 1 << 14;

/// For each output pixel along one side: the first source pixel it reads, and
/// where its weights sit in `weights` (a tent as wide as the shrink, so
/// nothing aliases). Each pixel's weights add up to exactly ONE.
struct Taps {
    start: Vec<u32>,
    at: Vec<(usize, usize)>,
    weights: Vec<i32>,
}

impl Taps {
    fn of(&self, i: usize) -> (usize, &[i32]) {
        let (at, n) = self.at[i];
        (self.start[i] as usize, &self.weights[at..at + n])
    }
}

fn taps(from: u32, len: u32, out: u32) -> Taps {
    let scale = len as f32 / out.max(1) as f32;
    let support = scale.max(1.0);
    let last = (from + len.max(1) - 1) as f32;
    let mut t = Taps {
        start: Vec::with_capacity(out as usize),
        at: Vec::with_capacity(out as usize),
        weights: Vec::new(),
    };
    for i in 0..out {
        let center = from as f32 + (i as f32 + 0.5) * scale - 0.5;
        let lo = (center - support).floor() + 1.0;
        let hi = (center + support).ceil() - 1.0;
        let first = lo.clamp(from as f32, last) as u32;
        let mut w: Vec<f32> = Vec::new();
        let mut j = lo;
        while j <= hi {
            let at = j.clamp(from as f32, last) as u32;
            let k = (1.0 - (j - center).abs() / support).max(0.0);
            let slot = (at - first) as usize;
            if w.len() <= slot {
                w.resize(slot + 1, 0.0);
            }
            w[slot] += k;
            j += 1.0;
        }
        let sum: f32 = w.iter().sum();
        let mut fixed: Vec<i32> = if sum > 0.0 {
            w.iter()
                .map(|x| (x / sum * ONE as f32).round() as i32)
                .collect()
        } else {
            vec![ONE]
        };
        // Rounding leftovers go to the heaviest tap: flat colour stays exact.
        let rest = ONE - fixed.iter().sum::<i32>();
        if let Some(m) = (0..fixed.len()).max_by_key(|&k| fixed[k]) {
            fixed[m] += rest;
        }
        t.start.push(first);
        t.at.push((t.weights.len(), fixed.len()));
        t.weights.extend(fixed);
    }
    t
}

fn to_byte(acc: i32) -> u8 {
    ((acc + ONE / 2) >> 14).clamp(0, 255) as u8
}

/// Turns `crop` of one image plane (`channels` bytes a pixel: 1 for luma,
/// 2 for NV12's paired chroma, 4 for BGRX) into `out` with tight rows. Built
/// once per export; `run` is called for every frame.
pub struct Resampler {
    channels: usize,
    crop: Crop,
    out: (u32, u32),
    x: Taps,
    y: Taps,
    threads: usize,
}

impl Resampler {
    pub fn new(channels: usize, crop: Crop, (ow, oh): (u32, u32)) -> Resampler {
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .clamp(1, 8);
        Resampler {
            channels: channels.max(1),
            crop,
            out: (ow.max(1), oh.max(1)),
            x: taps(crop.x, crop.w, ow.max(1)),
            y: taps(crop.y, crop.h, oh.max(1)),
            threads,
        }
    }

    /// Bytes `run` writes.
    pub fn len(&self) -> usize {
        self.out.0 as usize * self.out.1 as usize * self.channels
    }

    /// `src` holds the plane's rows `stride` bytes apart; `out` gets `len()`
    /// bytes. A plane too short for the crop gives black (zero) rows.
    pub fn run(&self, src: &[u8], stride: usize, out: &mut [u8]) {
        let ch = self.channels;
        let (ow, oh) = (self.out.0 as usize, self.out.1 as usize);
        let line_len = ow * ch;
        let rows = self.crop.h as usize;
        let right = (self.crop.x + self.crop.w) as usize * ch;
        let need = (self.crop.y as usize + rows.max(1) - 1) * stride + right;
        let out = &mut out[..line_len * oh];
        if rows == 0 || right > stride || src.len() < need {
            out.fill(0);
            return;
        }
        // Same size: a crop is a copy of rows.
        if (self.crop.w, self.crop.h) == self.out {
            let left = self.crop.x as usize * ch;
            for (r, line) in out.chunks_mut(line_len).enumerate() {
                let at = (self.crop.y as usize + r) * stride + left;
                line.copy_from_slice(&src[at..at + line_len]);
            }
            return;
        }
        // Each thread makes a band of output rows from the source rows that
        // band reads: across into its own scratch, then down.
        let band = oh.div_ceil(self.threads).max(1);
        std::thread::scope(|s| {
            for (n, chunk) in out.chunks_mut(band * line_len).enumerate() {
                s.spawn(move || self.band(src, stride, n * band, chunk));
            }
        });
    }

    fn band(&self, src: &[u8], stride: usize, first_out: usize, chunk: &mut [u8]) {
        let ch = self.channels;
        let line_len = self.out.0 as usize * ch;
        let lines = chunk.len() / line_len;
        let top = (first_out..first_out + lines)
            .map(|i| self.y.of(i).0)
            .min()
            .unwrap_or(0);
        let bottom = (first_out..first_out + lines)
            .map(|i| {
                let (start, w) = self.y.of(i);
                start + w.len()
            })
            .max()
            .unwrap_or(top);
        let mut mid = vec![0u8; (bottom - top) * line_len];
        for (r, line) in mid.chunks_mut(line_len).enumerate() {
            let row = &src[(top + r) * stride..];
            match ch {
                1 => across::<1>(row, &self.x, line),
                2 => across::<2>(row, &self.x, line),
                _ => across::<4>(row, &self.x, line),
            }
        }
        let mut acc = vec![0i32; line_len];
        for (r, line) in chunk.chunks_mut(line_len).enumerate() {
            let (start, weights) = self.y.of(first_out + r);
            acc.fill(0);
            for (k, &w) in weights.iter().enumerate() {
                let row = &mid[(start - top + k) * line_len..][..line_len];
                for (a, &p) in acc.iter_mut().zip(row) {
                    *a += p as i32 * w;
                }
            }
            for (o, &a) in line.iter_mut().zip(&acc) {
                *o = to_byte(a);
            }
        }
    }
}

/// One row across; `CH` fixed at compile time so the inner loops unroll.
fn across<const CH: usize>(row: &[u8], x: &Taps, line: &mut [u8]) {
    for (i, px) in line.chunks_exact_mut(CH).enumerate() {
        let (first, weights) = x.of(i);
        let from = &row[first * CH..][..weights.len() * CH];
        let mut acc = [0i32; CH];
        for (p, &w) in from.chunks_exact(CH).zip(weights) {
            for c in 0..CH {
                acc[c] += p[c] as i32 * w;
            }
        }
        for c in 0..CH {
            px[c] = to_byte(acc[c]);
        }
    }
}

/// How a video's YUV turns into RGB: BT.709 (HD and up, what Xenon writes)
/// or BT.601, in limited (16-235) or full range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Yuv {
    pub bt601: bool,
    pub full: bool,
}

/// Tight NV12 planes (`y` w*h, `uv` w*h/2) as tight BGRX rows: what a GIF
/// frame is built from.
pub fn nv12_to_bgrx(y: &[u8], uv: &[u8], (w, h): (u32, u32), yuv: Yuv) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let (kr, kb) = if yuv.bt601 {
        (0.299, 0.114)
    } else {
        (0.2126, 0.0722)
    };
    let kg = 1.0 - kr - kb;
    let (ys, yo, cs) = if yuv.full {
        (1.0, 0.0, 1.0)
    } else {
        (255.0 / 219.0, 16.0, 255.0 / 224.0)
    };
    let mut out = vec![255u8; w * h * 4];
    if y.len() < w * h || uv.len() < w * h.div_ceil(2) {
        return out;
    }
    for row in 0..h {
        for col in 0..w {
            let l = (y[row * w + col] as f32 - yo) * ys;
            let c = (row / 2) * w + (col & !1);
            let cb = (uv[c] as f32 - 128.0) * cs;
            let cr = (uv[c + 1] as f32 - 128.0) * cs;
            let r = l + 2.0 * (1.0 - kr) * cr;
            let b = l + 2.0 * (1.0 - kb) * cb;
            let g = (l - kr * r - kb * b) / kg;
            let o = (row * w + col) * 4;
            for (i, v) in [b, g, r].into_iter().enumerate() {
                out[o + i] = (v + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_copy_puts_the_face_on_top_and_the_game_below() {
        let bubble = crate::bubble::place(1920, 1080, crate::bubble::Corner::BottomRight);
        let s = vertical_split(1920, 1080, Focus::Center, bubble);
        let (plain, size) = vertical(1920, 1080, Focus::Center);
        assert_eq!(plain.h, 1080);
        // Same copy size as the plain vertical one, cut in two.
        assert_eq!(s.cam.1 .0, size.0);
        assert_eq!(s.game.1 .0, size.0);
        assert_eq!(s.cam.1 .1 + s.game.1 .1, size.1);
        assert_eq!(s.cam.1 .1 % 2, 0);
        // The game keeps the full height, wider than the plain 9:16 crop.
        let (game, gsize) = s.game;
        assert_eq!(game.h, 1080);
        assert!(game.w > plain.w && game.x + game.w <= 1920);
        let ratio = |c: Crop| c.w as f64 / c.h as f64;
        let out = |(w, h): (u32, u32)| w as f64 / h as f64;
        assert!((ratio(game) - out(gsize)).abs() < 0.02);
        // The webcam part is inside the circle (corners included) and keeps the shape.
        let (cam, csize) = s.cam;
        assert!((ratio(cam) - out(csize)).abs() < 0.05);
        let px = [bubble[0] * 1920.0, bubble[1] * 1080.0, bubble[2] * 1920.0];
        let (cx, cy, r) = (
            (px[0] + px[2]) / 2.0,
            px[1] + (px[2] - px[0]) / 2.0,
            (px[2] - px[0]) / 2.0,
        );
        for (x, y) in [(cam.x, cam.y), (cam.x + cam.w, cam.y + cam.h)] {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            assert!(d < r, "corner {x},{y} is {d} from the centre, radius {r}");
        }
        for c in [cam, game] {
            assert!(
                c.x % 2 == 0 && c.y % 2 == 0 && c.w % 2 == 0 && c.h % 2 == 0,
                "{c:?}"
            );
        }
        // Every corner, a small recording and a tall window stay in the frame.
        for corner in [
            crate::bubble::Corner::TopLeft,
            crate::bubble::Corner::TopRight,
            crate::bubble::Corner::BottomLeft,
        ] {
            for (w, h) in [(1280, 720), (3840, 2160), (600, 1200), (2, 2)] {
                let s = vertical_split(w, h, Focus::Left, crate::bubble::place(w, h, corner));
                for (c, _) in [s.cam, s.game] {
                    assert!(
                        c.x + c.w <= w.max(2) && c.y + c.h <= h.max(2),
                        "{w}x{h} {corner:?} {c:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_wide_frame_keeps_its_chosen_nine_by_sixteen() {
        let (c, size) = vertical(1920, 1080, Focus::Center);
        assert_eq!(
            c,
            Crop {
                x: 657,
                y: 0,
                w: 606,
                h: 1080
            }
        );
        assert_eq!(size, (606, 1080), "never scaled up");
        assert_eq!(vertical(1920, 1080, Focus::Left).0.x, 0);
        assert_eq!(vertical(1920, 1080, Focus::Right).0.x, 1920 - 606);
        // 4K: scaled down to the tallest phone picture.
        let (c, size) = vertical(3840, 2160, Focus::Center);
        assert_eq!((c.w, c.h), (1214, 2160));
        assert_eq!(size, (1078, 1920));
        // Already taller than 9:16: the middle band, nothing lost sideways.
        let (c, _) = vertical(600, 1200, Focus::Left);
        assert_eq!((c.x, c.w), (0, 600));
        assert_eq!((c.y, c.h), (67, 1066));
        let (c, size) = vertical(0, 0, Focus::Center);
        assert!(c.w >= 2 && c.h >= 2 && size.0 >= 2 && size.1 >= 2);
    }

    #[test]
    fn a_copy_that_must_fit_picks_the_largest_sharp_size() {
        const MB: u64 = 1024 * 1024;
        // 30 s of 1080p60 into 10 MB: 720p at 30 is what stays sharp.
        let f = fit((1920, 1080), 60, 30.0, 10 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (1280, 720, 30), "{f:?}");
        let budget = 10.0 * MB as f64 * 8.0 * 0.9 / 30.0 - 192_000.0;
        assert_eq!(f.video_bps, budget as u32);
        // Short and roomy: full size and frame rate.
        let f = fit((1920, 1080), 60, 5.0, 50 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (1920, 1080, 60));
        // Tight: the smallest size, not mush below it.
        let f = fit((3840, 2160), 60, 120.0, 10 * MB, 192_000).unwrap();
        assert_eq!((f.width, f.height, f.fps), (640, 360, 30));
        assert!(fit((1920, 1080), 60, 600.0, 10 * MB, 192_000).is_none());
        // A vertical source stays vertical.
        let f = fit((1080, 1920), 30, 20.0, 10 * MB, 0).unwrap();
        assert!(f.height > f.width && f.fps == 30);
        assert!(fit((1920, 1080), 60, 0.0, 10 * MB, 0).is_none());
    }

    #[test]
    fn an_overshoot_is_made_again_smaller() {
        assert_eq!(retry_bitrate(1_000_000, 100, 0), 1_000_000);
        let b = retry_bitrate(1_000_000, 10_000_000, 11_000_000);
        assert!(b < 1_000_000 * 10 / 11, "{b}");
        assert_eq!(retry_bitrate(200_000, 1, 1_000_000), FIT_MIN_VIDEO_BPS);
    }

    #[test]
    fn a_gif_is_small_and_keeps_its_shape() {
        assert_eq!(gif_size(1920, 1080), (480, 270));
        assert_eq!(gif_size(1080, 1920), (270, 480));
        assert_eq!(gif_size(320, 200), (320, 200));
        assert_eq!(gif_size(0, 0), (1, 1));
    }

    #[test]
    fn the_pace_keeps_one_frame_per_tick() {
        let mut p = Pace::every(30);
        let frame = 10_000_000 / 60;
        let kept = (0..60).filter(|i| p.take(i * frame)).count();
        assert_eq!(kept, 30);
        // A long gap: one frame after it, not a burst.
        let mut p = Pace::every(10);
        assert!(p.take(0));
        assert!(p.take(50_000_000));
        assert!(!p.take(50_100_000));
    }

    #[test]
    fn the_resampler_keeps_flat_colour_and_picks_the_crop() {
        // 8x4: left half red, right half blue (BGRX).
        let (w, h) = (8u32, 4u32);
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                src[i..i + 4].copy_from_slice(if x < 4 {
                    &[0, 0, 255, 255]
                } else {
                    &[255, 0, 0, 255]
                });
            }
        }
        let run = |r: Resampler, src: &[u8], stride: usize| {
            let mut out = vec![7u8; r.len()];
            r.run(src, stride, &mut out);
            out
        };
        let stride = (w * 4) as usize;
        let right = run(
            Resampler::new(
                4,
                Crop {
                    x: 4,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (2, 2),
            ),
            &src,
            stride,
        );
        assert!(right.chunks(4).all(|p| p == [255, 0, 0, 255]), "{right:?}");
        let up = run(
            Resampler::new(
                4,
                Crop {
                    x: 0,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (8, 8),
            ),
            &src,
            stride,
        );
        assert!(up.chunks(4).all(|p| p == [0, 0, 255, 255]));
        // Halving across the edge: the middle pixel mixes the two.
        let half = run(Resampler::new(4, Crop::whole(w, h), (3, 1)), &src, stride);
        assert_eq!(&half[0..4], &[0, 0, 255, 255]);
        assert!(half[4] > 60 && half[6] > 60, "{half:?}");
        // Rows wider than the picture (a decoder's padded pitch) are skipped over.
        let mut padded = vec![9u8; (stride + 16) * h as usize];
        for y in 0..h as usize {
            padded[y * (stride + 16)..y * (stride + 16) + stride]
                .copy_from_slice(&src[y * stride..(y + 1) * stride]);
        }
        let again = run(
            Resampler::new(
                4,
                Crop {
                    x: 4,
                    y: 0,
                    w: 4,
                    h: 4,
                },
                (2, 2),
            ),
            &padded,
            stride + 16,
        );
        assert_eq!(again, right);
        // One byte a pixel (luma) and two (paired chroma) keep their values.
        let luma = run(Resampler::new(1, Crop::whole(4, 2), (2, 1)), &[50; 8], 4);
        assert_eq!(luma, [50, 50]);
        let chroma = run(
            Resampler::new(2, Crop::whole(2, 2), (1, 1)),
            &[90, 200, 90, 200, 90, 200, 90, 200],
            4,
        );
        assert_eq!(chroma, [90, 200]);
        // Too little source: a black frame, never a panic.
        let none = run(
            Resampler::new(4, Crop::whole(w, h), (2, 2)),
            &src[..10],
            stride,
        );
        assert_eq!(none, vec![0; 16]);
    }

    #[test]
    fn nv12_turns_back_into_the_colours_it_was_made_from() {
        // BT.709 limited range: pure red, green, blue and grey.
        let yuv = Yuv {
            bt601: false,
            full: false,
        };
        for (ycc, bgr) in [
            ([63u8, 102, 240], [0u8, 0, 255]),
            ([173, 42, 26], [0, 255, 0]),
            ([32, 240, 118], [255, 0, 0]),
            ([126, 128, 128], [128, 128, 128]),
        ] {
            let px = nv12_to_bgrx(&[ycc[0]; 4], &[ycc[1], ycc[2], ycc[1], ycc[2]], (2, 2), yuv);
            for p in px.chunks(4) {
                assert!(
                    p[..3].iter().zip(bgr).all(|(a, b)| a.abs_diff(b) <= 3),
                    "{ycc:?} -> {p:?}"
                );
                assert_eq!(p[3], 255);
            }
        }
        // Too short planes: white, never a panic.
        assert_eq!(nv12_to_bgrx(&[0; 2], &[], (2, 2), yuv).len(), 16);
    }
}
