//! The webcam bubble drawn into an NV12 frame on the CPU, the way the Windows
//! shader draws it (win/record/bubble_pass.rs): the square middle of the
//! camera picture in a circle with a soft edge and a thin light ring, in the
//! corner bubble.rs places it. The bubble is rendered once per camera picture
//! (a `Stamp`, already in BT.709 limited range, what the recording holds) and
//! laid over every frame until the next one. Pure: tested on every OS.

use crate::bubble::{self, Corner};
use crate::stack::{Plane, PlaneMut};

// This file is also built by path for the tests of the other systems, where Rust looks for child files next to
// it: so each one is named in full, and a name handed on below may go unused there.
#[cfg(test)]
#[path = "bubble_nv12/unit_tests.rs"]
mod unit_tests;


/// The light ring: its width as a share of the radius, at least this many
/// pixels, and its grey (0..1).
const RING_SHARE: f32 = 0.03;
const RING_MIN: f32 = 1.5;
const RING_GREY: f32 = 0.92;
/// BT.709 luma weights.
const KR: f32 = 0.2126;
const KB: f32 = 0.0722;

/// A camera picture: BGRA rows `stride` bytes apart.
pub struct Picture<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub bgra: &'a [u8],
}

/// The bubble for one camera picture: luma (Y, alpha) per pixel and chroma
/// (Cb, Cr, alpha) per 2x2 block, over an even-aligned box of the frame.
pub struct Stamp {
    frame: (usize, usize),
    /// The box in luma pixels: left, top (both even), width, height.
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    luma: Vec<[u8; 2]>,
    chroma: Vec<[u8; 3]>,
}

/// Where the bubble is, in frame pixels, and what fills it.
struct Shape {
    left: f32,
    top: f32,
    side: f32,
    crop: [f32; 4],
}

fn saturate(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

/// The camera at (u, v), fractions of the picture, sampled bilinearly: RGB 0..1.
fn sample(cam: &Picture<'_>, u: f32, v: f32) -> [f32; 3] {
    let (cw, ch) = (cam.width.max(1) as f32, cam.height.max(1) as f32);
    let sx = (u * cw - 0.5).clamp(0.0, cw - 1.0);
    let sy = (v * ch - 0.5).clamp(0.0, ch - 1.0);
    let (x0, y0) = (sx.floor() as usize, sy.floor() as usize);
    let (x1, y1) = (
        (x0 + 1).min(cam.width.max(1) as usize - 1),
        (y0 + 1).min(cam.height.max(1) as usize - 1),
    );
    let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
    let px = |x: usize, y: usize, c: usize| -> f32 {
        cam.bgra.get(y * cam.stride + x * 4 + c).map_or(0.0, |&b| b as f32 / 255.0)
    };
    let mut rgb = [0.0; 3];
    // BGRA: red is byte 2, blue byte 0.
    for (i, c) in [2usize, 1, 0].into_iter().enumerate() {
        let top = px(x0, y0, c) * (1.0 - fx) + px(x1, y0, c) * fx;
        let bottom = px(x0, y1, c) * (1.0 - fx) + px(x1, y1, c) * fx;
        rgb[i] = top * (1.0 - fy) + bottom * fy;
    }
    rgb
}

/// The bubble at pixel (px, py) of the frame: its colour and its cover.
fn shade(s: &Shape, cam: &Picture<'_>, px: usize, py: usize) -> ([f32; 3], f32) {
    let q = (
        (px as f32 + 0.5 - s.left) / s.side,
        (py as f32 + 0.5 - s.top) / s.side,
    );
    let radius = s.side * 0.5;
    let (dx, dy) = (q.0 - 0.5, q.1 - 0.5);
    // Pixels inside the edge of the circle: below 0 is outside.
    let inside = (1.0 - (dx * dx + dy * dy).sqrt() * 2.0) * radius;
    if inside <= 0.0 {
        return ([0.0; 3], 0.0);
    }
    let [cl, ct, cr, cb] = s.crop;
    let c = sample(cam, cl + (cr - cl) * q.0, ct + (cb - ct) * q.1);
    let ring = (radius * RING_SHARE).max(RING_MIN);
    let t = saturate(ring + 0.5 - inside);
    (c.map(|v| v * (1.0 - t) + RING_GREY * t), saturate(inside))
}

/// RGB 0..1 as BT.709 limited range Y, Cb, Cr (0..255, unrounded).
fn ycbcr([r, g, b]: [f32; 3]) -> [f32; 3] {
    let l = KR * r + (1.0 - KR - KB) * g + KB * b;
    [
        16.0 + 219.0 * l,
        128.0 + 224.0 * (b - l) / (2.0 * (1.0 - KB)),
        128.0 + 224.0 * (r - l) / (2.0 * (1.0 - KR)),
    ]
}

fn byte(v: f32) -> u8 {
    (v + 0.5).clamp(0.0, 255.0) as u8
}

/// `dst` covered by `value` at `alpha` (0..255).
fn blend(dst: u8, value: u8, alpha: u8) -> u8 {
    let a = alpha as u32;
    ((dst as u32 * (255 - a) + value as u32 * a + 127) / 255) as u8
}

impl Stamp {
    /// The bubble in a `frame` sized recording, in `corner`, filled by `cam`;
    /// None when it would cover nothing.
    pub fn new(frame: (u32, u32), corner: Corner, cam: &Picture<'_>) -> Option<Stamp> {
        let (fw, fh) = (frame.0.max(1) as f32, frame.1.max(1) as f32);
        let b = bubble::place(frame.0, frame.1, corner);
        let shape = Shape {
            left: b[0] * fw,
            top: b[1] * fh,
            side: (b[2] - b[0]) * fw,
            crop: bubble::crop(cam.width, cam.height),
        };
        let even_down = |v: f32| (v.floor().max(0.0) as usize) & !1;
        let even_up = |v: f32, most: usize| (v.ceil().max(0.0) as usize).min(most).next_multiple_of(2);
        let (x, y) = (even_down(shape.left), even_down(shape.top));
        let x_end = even_up(shape.left + shape.side, frame.0 as usize);
        let y_end = even_up(shape.top + shape.side, frame.1 as usize);
        let (w, h) = (x_end.checked_sub(x)?, y_end.checked_sub(y)?);
        if w == 0 || h == 0 || cam.width == 0 || cam.height == 0 {
            return None;
        }
        let shades: Vec<([f32; 3], f32)> = (0..h)
            .flat_map(|r| (0..w).map(move |c| (c, r)))
            .map(|(c, r)| shade(&shape, cam, x + c, y + r))
            .collect();
        let luma = shades
            .iter()
            .map(|&(rgb, a)| [byte(ycbcr(rgb)[0]), byte(a * 255.0)])
            .collect();
        let mut chroma = Vec::with_capacity((w / 2) * (h / 2));
        for r in (0..h).step_by(2) {
            for c in (0..w).step_by(2) {
                // Premultiplied over the four pixels, so the soft edge stays soft.
                let (mut cb, mut cr, mut a) = (0.0, 0.0, 0.0);
                for (dc, dr) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (rgb, alpha) = shades[(r + dr) * w + c + dc];
                    let [_, u, v] = ycbcr(rgb);
                    cb += u * alpha;
                    cr += v * alpha;
                    a += alpha;
                }
                chroma.push(if a > 0.0 {
                    [byte(cb / a), byte(cr / a), byte(a / 4.0 * 255.0)]
                } else {
                    [128, 128, 0]
                });
            }
        }
        Some(Stamp {
            frame: (frame.0 as usize, frame.1 as usize),
            x,
            y,
            w,
            h,
            luma,
            chroma,
        })
    }

    /// The bubble laid over an NV12 frame of the size it was made for.
    pub fn draw(&self, dst: [PlaneMut<'_>; 2]) {
        let [y_plane, uv_plane] = dst;
        let cols = self.w.min(self.frame.0.saturating_sub(self.x));
        for r in 0..self.h.min(self.frame.1.saturating_sub(self.y)) {
            let at = (self.y + r) * y_plane.stride + self.x;
            let Some(row) = y_plane.data.get_mut(at..at + cols) else {
                return;
            };
            for (px, &[v, a]) in row.iter_mut().zip(&self.luma[r * self.w..]) {
                if a > 0 {
                    *px = blend(*px, v, a);
                }
            }
        }
        let (cw, ch) = (self.w / 2, self.h / 2);
        let chroma_cols = cw.min(self.frame.0.div_ceil(2).saturating_sub(self.x / 2));
        for r in 0..ch.min(self.frame.1.div_ceil(2).saturating_sub(self.y / 2)) {
            let at = (self.y / 2 + r) * uv_plane.stride + self.x;
            let Some(row) = uv_plane.data.get_mut(at..at + chroma_cols * 2) else {
                return;
            };
            for (pair, &[u, v, a]) in row.chunks_exact_mut(2).zip(&self.chroma[r * cw..]) {
                if a > 0 {
                    pair[0] = blend(pair[0], u, a);
                    pair[1] = blend(pair[1], v, a);
                }
            }
        }
    }
}

/// `rows` rows of `bytes` from `src` into `dst`, each with its own row
/// length: the frame copied before the bubble goes on it (the captured one
/// is never drawn on). False when either is too short.
pub fn copy_plane(src: &Plane<'_>, dst: &mut PlaneMut<'_>, rows: usize, bytes: usize) -> bool {
    if src.stride < bytes || dst.stride < bytes {
        return false;
    }
    for r in 0..rows {
        let (from, to) = (r * src.stride, r * dst.stride);
        let (Some(a), Some(b)) = (src.data.get(from..from + bytes), dst.data.get_mut(to..to + bytes)) else {
            return false;
        };
        b.copy_from_slice(a);
    }
    true
}
