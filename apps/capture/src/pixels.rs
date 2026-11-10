//! Pixel conversions for the area picker: the frozen screen it shows, the area
//! cut out of it and the bitmap put on the clipboard.

use crate::region::Crop;

/// Full brightness for `to_bgra`.
pub const FULL: u16 = 256;
/// What is outside the picked area: half as bright, still readable.
pub const DIMMED: u16 = 128;

/// Tight 24-bit BGR into 32-bit BGRA at `shade`/256 brightness (`out` holds
/// width x height x 4 bytes).
pub fn to_bgra(bgr: &[u8], out: &mut [u8], shade: u16) {
    for (src, dst) in bgr.chunks_exact(3).zip(out.chunks_exact_mut(4)) {
        for i in 0..3 {
            dst[i] = ((src[i] as u16 * shade) >> 8) as u8;
        }
        dst[3] = 255;
    }
}

/// The `crop` part of a top-down BGRA image `width` pixels wide, as tight BGR.
pub fn crop_bgra(bgra: &[u8], width: u32, crop: Crop) -> Vec<u8> {
    let mut out = Vec::with_capacity((crop.width * crop.height * 3) as usize);
    for y in crop.y..crop.y + crop.height {
        let start = ((y * width + crop.x) * 4) as usize;
        let row = &bgra[start..start + (crop.width * 4) as usize];
        row.chunks_exact(4)
            .for_each(|p| out.extend_from_slice(&p[..3]));
    }
    out
}

/// A CF_DIB clipboard bitmap: BITMAPINFOHEADER, then 24-bit rows bottom-up,
/// each padded to 4 bytes.
pub fn dib(width: u32, height: u32, bgr: &[u8]) -> Vec<u8> {
    const HEADER: u32 = 40;
    let stride = (width * 3).div_ceil(4) * 4;
    let size = stride * height;
    let mut out = Vec::with_capacity((HEADER + size) as usize);
    out.extend_from_slice(&HEADER.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes()); // positive: bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&24u16.to_le_bytes()); // bits per pixel
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&[0u8; 16]); // resolution and palette: unused
    let row = (width * 3) as usize;
    for y in (0..height as usize).rev() {
        out.extend_from_slice(&bgr[y * row..(y + 1) * row]);
        out.resize(out.len() + stride as usize - row, 0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_keeps_or_halves_the_colour_and_is_opaque() {
        let bgr = [200, 100, 50, 255, 0, 1];
        let mut out = [0u8; 8];
        to_bgra(&bgr, &mut out, FULL);
        assert_eq!(out, [200, 100, 50, 255, 255, 0, 1, 255]);
        to_bgra(&bgr, &mut out, DIMMED);
        assert_eq!(out, [100, 50, 25, 255, 127, 0, 0, 255]);
    }

    #[test]
    fn crop_takes_the_right_pixels_and_drops_alpha() {
        // 3x2 image, pixel value = its index.
        let bgra: Vec<u8> = (0..6u8).flat_map(|i| [i, i, i, 255]).collect();
        let c = crop_bgra(
            &bgra,
            3,
            Crop {
                x: 1,
                y: 0,
                width: 2,
                height: 2,
            },
        );
        assert_eq!(c, vec![1, 1, 1, 2, 2, 2, 4, 4, 4, 5, 5, 5]);
    }

    #[test]
    fn dib_is_bottom_up_with_padded_rows() {
        // 1x2 image: top pixel 1,2,3, bottom pixel 4,5,6; each row pads 3 -> 4 bytes.
        let d = dib(1, 2, &[1, 2, 3, 4, 5, 6]);
        assert_eq!(d.len(), 40 + 8);
        assert_eq!(u32::from_le_bytes(d[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(d[4..8].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(d[8..12].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(d[14..16].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(d[20..24].try_into().unwrap()), 8);
        assert_eq!(&d[40..], &[4, 5, 6, 0, 1, 2, 3, 0]);
    }
}
