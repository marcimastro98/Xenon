//! HDR to SDR for screenshots. An HDR monitor is captured in scRGB (linear,
//! Rec.709 primaries, 1.0 = 80 nits, half floats). The user's "SDR content
//! brightness" is what looks white on that screen, so it becomes white in the
//! PNG. A frame with nothing brighter (the desktop, most apps) converts exactly;
//! a frame with HDR highlights rolls the top of the range off toward the frame's
//! own peak instead of clipping it flat. The three channels scale together, so
//! a bright orange stays orange instead of turning yellow or white.

/// Where the roll-off starts, as a fraction of SDR white.
const KNEE: f32 = 0.75;
/// The brightest peak the curve makes room for, in SDR whites. One stray
/// specular pixel beyond it no longer darkens the whole picture.
const MAX_PEAK: f32 = 16.0;

/// IEEE 754 half float to f32.
pub fn half_to_f32(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 0x1f) as i32;
    let frac = (h & 0x3ff) as f32;
    match exp {
        0 => sign * frac * 2f32.powi(-24),
        31 => {
            if frac == 0.0 {
                sign * f32::INFINITY
            } else {
                f32::NAN
            }
        }
        _ => sign * (1.0 + frac / 1024.0) * 2f32.powi(exp - 15),
    }
}

fn sane_white(white: f32) -> f32 {
    if white.is_finite() && white > 0.0 {
        white
    } else {
        2.5
    }
}

/// Steps of the linear-to-sRGB table: fine enough that no two neighbouring
/// steps differ by more than one output level, even in the darks.
const LUT_STEPS: usize = 16384;

fn srgb_exact(v: f32) -> u8 {
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0 + 0.5) as u8
}

/// Linear light to the sRGB curve, 0..=1 in, 0..=255 out. A 4K frame is 25
/// million channels; a table lookup instead of `powf` each makes it ~10x faster.
fn encode_srgb(v: f32) -> u8 {
    static LUT: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let lut = LUT.get_or_init(|| {
        (0..=LUT_STEPS)
            .map(|i| srgb_exact(i as f32 / LUT_STEPS as f32))
            .collect()
    });
    let v = if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) };
    lut[(v * LUT_STEPS as f32 + 0.5) as usize]
}

/// The brightest channel of one pixel, in SDR whites (0 for garbage).
fn level(r: f32, g: f32, b: f32, white: f32) -> f32 {
    let m = r.max(g).max(b) / sane_white(white);
    if m.is_finite() && m > 0.0 {
        m
    } else {
        0.0
    }
}

/// Maps `m` (in SDR whites) so that `peak` lands on 1.0: identity below the
/// knee, then a rational curve with the same slope at the knee, so there is no
/// visible step. `peak <= 1` means nothing to compress.
fn roll_off(m: f32, peak: f32) -> f32 {
    if peak <= 1.0 || m <= KNEE {
        return m;
    }
    let peak = peak.min(MAX_PEAK);
    let s = (peak - KNEE) / (1.0 - KNEE);
    let x = ((m - KNEE) / (peak - KNEE)).min(1.0);
    KNEE + (1.0 - KNEE) * (s * x / (1.0 + (s - 1.0) * x))
}

/// One scRGB pixel to sRGB bytes. `white` is SDR white in scRGB units
/// (nits / 80); `peak` is the frame's brightest level from `peak_fp16_row`.
pub fn pixel(r: f32, g: f32, b: f32, white: f32, peak: f32) -> [u8; 3] {
    let m = level(r, g, b, white);
    if m == 0.0 {
        return [0, 0, 0];
    }
    let k = roll_off(m, peak) / m / sane_white(white);
    [
        encode_srgb(r.max(0.0) * k),
        encode_srgb(g.max(0.0) * k),
        encode_srgb(b.max(0.0) * k),
    ]
}

/// Every half float as f32, built once: a 4K frame decodes 25 million of them.
fn halves() -> &'static [f32] {
    static TABLE: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| (0..=u16::MAX).map(half_to_f32).collect())
}

fn fp16_rgb(px: &[u8]) -> (f32, f32, f32) {
    let table = halves();
    let c = |i: usize| table[u16::from_le_bytes([px[i], px[i + 1]]) as usize];
    (c(0), c(2), c(4))
}

/// The brightest level in a row of R16G16B16A16 half floats, in SDR whites.
pub fn peak_fp16_row(src: &[u8], white: f32) -> f32 {
    src.chunks_exact(8).fold(0.0, |acc, px| {
        let (r, g, b) = fp16_rgb(px);
        acc.max(level(r, g, b, white))
    })
}

/// A row of R16G16B16A16 half floats to tight BGR bytes.
pub fn row_fp16_to_bgr(src: &[u8], white: f32, peak: f32, out: &mut Vec<u8>) {
    for px in src.chunks_exact(8) {
        let (r, g, b) = fp16_rgb(px);
        let [r, g, b] = pixel(r, g, b, white, peak);
        out.extend_from_slice(&[b, g, r]);
    }
}

/// A row of B8G8R8A8 to tight BGR bytes (the alpha of a desktop capture means nothing).
pub fn row_bgra_to_bgr(src: &[u8], out: &mut Vec<u8>) {
    for px in src.chunks_exact(4) {
        out.extend_from_slice(&px[..3]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halves() {
        assert_eq!(half_to_f32(0x3c00), 1.0);
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0xc000), -2.0);
        assert_eq!(half_to_f32(0x3800), 0.5);
        assert!(half_to_f32(0x7c00).is_infinite());
        assert!(half_to_f32(0x7e00).is_nan());
        assert!((half_to_f32(0x0001) - 5.960_464_5e-8).abs() < 1e-12);
    }

    #[test]
    fn an_sdr_frame_converts_exactly() {
        assert_eq!(pixel(2.5, 2.5, 2.5, 2.5, 1.0), [255, 255, 255]);
        assert_eq!(pixel(0.0, 0.0, 0.0, 2.5, 1.0), [0, 0, 0]);
        // 18% grey is the plain sRGB curve: 118.
        assert_eq!(pixel(0.45, 0.45, 0.45, 2.5, 1.0), [118, 118, 118]);
    }

    #[test]
    fn highlights_roll_off_toward_the_frame_peak() {
        // A frame peaking at 4x SDR white: the peak is white, SDR white is not
        // clipped, and darker tones below the knee are untouched.
        assert_eq!(pixel(10.0, 10.0, 10.0, 2.5, 4.0), [255, 255, 255]);
        let sdr_white = pixel(2.5, 2.5, 2.5, 2.5, 4.0)[0];
        assert!(sdr_white > 200 && sdr_white < 255, "{sdr_white}");
        assert_eq!(pixel(0.45, 0.45, 0.45, 2.5, 4.0), [118, 118, 118]);
        // Monotonic: brighter in, never darker out.
        let mut last = 0;
        for i in 0..200 {
            let v = pixel(i as f32 * 0.05, 0.0, 0.0, 2.5, 4.0)[0];
            assert!(v >= last);
            last = v;
        }
    }

    #[test]
    fn hue_is_kept() {
        let orange = pixel(10.0, 5.0, 0.0, 2.5, 4.0);
        assert_eq!(orange[0], 255);
        assert!(
            orange[1] > 100 && orange[1] < 255,
            "orange stays orange: {orange:?}"
        );
        assert_eq!(orange[2], 0);
    }

    #[test]
    fn garbage_never_panics() {
        assert_eq!(pixel(f32::NAN, f32::INFINITY, -1.0, 2.5, 4.0), [0, 0, 0]);
        assert_eq!(
            pixel(1.0, 1.0, 1.0, 0.0, 1.0),
            pixel(1.0, 1.0, 1.0, 2.5, 1.0),
            "bad white falls back"
        );
        assert!(roll_off(100.0, 1000.0) <= 1.0, "peak is capped");
    }

    #[test]
    fn the_table_matches_the_curve_within_one_level() {
        for i in 0..=100_000 {
            let v = i as f32 / 100_000.0;
            assert!(
                (encode_srgb(v) as i32 - srgb_exact(v) as i32).abs() <= 1,
                "{v}"
            );
        }
        assert_eq!(encode_srgb(1.0), 255);
        assert_eq!(encode_srgb(0.0), 0);
    }

    #[test]
    fn rows_convert_to_tight_bgr() {
        let mut out = Vec::new();
        row_bgra_to_bgr(&[1, 2, 3, 0, 4, 5, 6, 255], &mut out);
        assert_eq!(out, [1, 2, 3, 4, 5, 6]);
        out.clear();
        let one = 0x3c00u16.to_le_bytes();
        let zero = [0u8, 0];
        let red = [one, zero, zero, one].concat(); // pure red at 1.0 (80 nits)
        assert_eq!(peak_fp16_row(&red, 1.0), 1.0);
        row_fp16_to_bgr(&red, 1.0, 1.0, &mut out);
        assert_eq!(out, [0, 0, 255]);
    }
}
