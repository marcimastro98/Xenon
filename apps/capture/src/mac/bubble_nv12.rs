//! The webcam bubble drawn into an NV12 frame on the CPU, the way the Windows
//! shader draws it (win/record/bubble_pass.rs): the square middle of the
//! camera picture in a circle with a soft edge and a thin light ring, in the
//! corner bubble.rs places it. The bubble is rendered once per camera picture
//! (a `Stamp`, already in BT.709 limited range, what the recording holds) and
//! laid over every frame until the next one. Pure: tested on every OS.

use crate::bubble::{self, Corner};
use crate::stack::{Plane, PlaneMut};

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

#[cfg(test)]
mod tests {
    use super::*;

    /// A camera picture of one colour.
    fn flat(w: u32, h: u32, [b, g, r]: [u8; 3]) -> Vec<u8> {
        (0..w * h).flat_map(|_| [b, g, r, 255]).collect()
    }

    fn frame(w: usize, h: usize) -> (Vec<u8>, Vec<u8>) {
        (vec![16u8; w * h], vec![128u8; w * h / 2])
    }

    fn draw(stamp: &Stamp, y: &mut [u8], uv: &mut [u8], stride: usize) {
        stamp.draw([
            PlaneMut { data: y, stride },
            PlaneMut { data: uv, stride },
        ]);
    }

    #[test]
    fn a_white_camera_fills_the_middle_and_leaves_the_rest() {
        let bgra = flat(64, 48, [255, 255, 255]);
        let cam = Picture { width: 64, height: 48, stride: 64 * 4, bgra: &bgra };
        let (w, h) = (200usize, 100usize);
        let stamp = Stamp::new((w as u32, h as u32), Corner::BottomRight, &cam).unwrap();
        let (mut y, mut uv) = frame(w, h);
        draw(&stamp, &mut y, &mut uv, w);
        // 24% of 100 is 24 px, 3 px from the bottom right corner.
        let (cx, cy) = (200 - 3 - 12, 100 - 3 - 12);
        assert_eq!(y[cy * w + cx], 235, "white in the middle");
        assert_eq!(uv[(cy / 2) * w + (cx & !1)], 128, "no colour in white");
        assert_eq!(y[0], 16, "the top left is untouched");
        assert_eq!(y[74 * w + 174], 16, "outside the circle, in its box corner");
        assert_eq!(y[cy * w + 200 - 3 - 24 - 2], 16, "left of the box");
    }

    #[test]
    fn the_edge_is_soft_and_the_ring_is_light_grey() {
        // A black camera: what is not black is the ring.
        let bgra = flat(32, 32, [0, 0, 0]);
        let cam = Picture { width: 32, height: 32, stride: 32 * 4, bgra: &bgra };
        let (w, h) = (1000usize, 1000usize);
        let stamp = Stamp::new((w as u32, h as u32), Corner::TopLeft, &cam).unwrap();
        let (mut y, mut uv) = frame(w, h);
        draw(&stamp, &mut y, &mut uv, w);
        // 240 px wide from 30, so the middle row is 150.
        let row = &y[150 * w..150 * w + 300];
        assert_eq!(row[150], 16, "the black middle");
        let grey = 16 + (219.0f32 * RING_GREY).round() as u8;
        let ring = row[30..40].iter().copied().max().unwrap();
        assert!(ring >= grey - 2, "a light ring at the edge, got {ring}");
        // Soft: some pixel at the very edge is between frame and ring.
        assert!(row[28..34].iter().any(|&v| v > 16 && v < ring));
        assert_eq!(row[25], 16, "before the bubble");
    }

    #[test]
    fn a_red_camera_keeps_its_colour_in_the_chroma() {
        let bgra = flat(8, 8, [0, 0, 255]);
        let cam = Picture { width: 8, height: 8, stride: 32, bgra: &bgra };
        let stamp = Stamp::new((400, 400), Corner::TopRight, &cam).unwrap();
        let (mut y, mut uv) = frame(400, 400);
        draw(&stamp, &mut y, &mut uv, 400);
        // Middle of the bubble: 400 - 12 - 48.
        let (cx, cy) = (340usize, 60usize);
        let at = (cy / 2) * 400 + (cx & !1);
        // BT.709 limited red: Y 63, Cb 102, Cr 240.
        assert!((y[cy * 400 + cx] as i32 - 63).abs() <= 1);
        assert!((uv[at] as i32 - 102).abs() <= 1);
        assert!((uv[at + 1] as i32 - 240).abs() <= 1);
    }

    #[test]
    fn padded_rows_and_odd_or_tiny_frames_stay_in_bounds() {
        let bgra = flat(4, 4, [10, 200, 30]);
        let cam = Picture { width: 4, height: 4, stride: 16, bgra: &bgra };
        // Rows padded to 64 bytes, as CoreVideo hands them.
        let stamp = Stamp::new((50, 30), Corner::TopRight, &cam).unwrap();
        let (mut y, mut uv) = (vec![16u8; 64 * 30], vec![128u8; 64 * 15]);
        draw(&stamp, &mut y, &mut uv, 64);
        assert!(y.chunks(64).all(|r| r[50..].iter().all(|&v| v == 16)), "padding untouched");
        let stamp = Stamp::new((7, 5), Corner::BottomRight, &cam);
        if let Some(s) = stamp {
            let (mut y, mut uv) = (vec![16u8; 8 * 5], vec![128u8; 8 * 3]);
            draw(&s, &mut y, &mut uv, 8);
        }
        let empty = Picture { width: 0, height: 0, stride: 0, bgra: &[] };
        assert!(Stamp::new((100, 100), Corner::TopLeft, &empty).is_none());
    }

    #[test]
    fn a_frame_is_copied_row_by_row_across_paddings() {
        let src: Vec<u8> = (0..12).collect();
        let mut dst = vec![0u8; 10];
        let from = Plane { data: &src, stride: 4 };
        assert!(copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 5 }, 2, 3));
        assert_eq!(dst, vec![0, 1, 2, 0, 0, 4, 5, 6, 0, 0]);
        // Too few rows on either side: refused, not a panic.
        assert!(!copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 5 }, 3, 3));
        assert!(!copy_plane(&from, &mut PlaneMut { data: &mut dst, stride: 2 }, 1, 3));
    }
}
