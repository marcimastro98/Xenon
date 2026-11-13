// Shrinks or crops one picture plane to a new size, and turns video colours into screen colours.

use super::Crop;

/// Fixed-point weights: 1.0 is this.
const ONE: i32 = 1 << 14;

/// For each output pixel along one side: the first source pixel it reads, and
/// where its weights sit in `weights` (a tent as wide as the shrink, so
/// nothing aliases). Each pixel's weights add up to exactly ONE.
pub(super) struct Taps {
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
    pub(super) crop: Crop,
    pub(super) out: (u32, u32),
    pub(super) x: Taps,
    pub(super) y: Taps,
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
