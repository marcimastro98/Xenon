//! A decoded NV12 frame cut into parts and stacked again as one: the vertical
//! copy of a recording (reframe.rs plans the parts), with the webcam on top
//! when asked. The planes come with their own row lengths, as the macOS
//! decoder hands them (mac/export.rs); pure, so it is tested on every OS.

use crate::reframe::{Crop, Resampler};

/// One plane of a picture: its bytes, and how far apart its rows are.
pub struct Plane<'a> {
    pub data: &'a [u8],
    pub stride: usize,
}

pub struct PlaneMut<'a> {
    pub data: &'a mut [u8],
    pub stride: usize,
}

/// Per part: the luma resampler, the paired chroma one at half the size each
/// way, and the rows the part takes in the luma plane.
pub struct Stack {
    parts: Vec<(Resampler, Resampler, usize)>,
    width: u32,
    scratch: Vec<u8>,
}

impl Stack {
    /// `parts` top to bottom: the crop of the source and the size it is
    /// written at; all as wide as the first, every number even.
    pub fn new(parts: &[(Crop, (u32, u32))]) -> Stack {
        let width = parts.first().map_or(2, |p| p.1 .0);
        let parts: Vec<_> = parts
            .iter()
            .map(|&(crop, (w, h))| {
                let half = Crop {
                    x: crop.x / 2,
                    y: crop.y / 2,
                    w: (crop.w / 2).max(1),
                    h: (crop.h / 2).max(1),
                };
                (
                    Resampler::new(1, crop, (w, h)),
                    Resampler::new(2, half, (w / 2, h / 2)),
                    h as usize,
                )
            })
            .collect();
        let most = parts.iter().map(|p| p.0.len().max(p.1.len())).max();
        Stack {
            parts,
            width,
            scratch: vec![0; most.unwrap_or(0)],
        }
    }

    /// Every part of `src` (luma, chroma) into `dst`, top to bottom.
    pub fn run(&mut self, src: [Plane<'_>; 2], dst: [PlaneMut<'_>; 2]) {
        let [y, uv] = src;
        let [mut out_y, mut out_uv] = dst;
        let line = self.width as usize;
        let mut row = 0;
        for (luma, chroma, rows) in &self.parts {
            let tight = &mut self.scratch[..luma.len()];
            luma.run(y.data, y.stride, tight);
            put(tight, line, &mut out_y, row);
            let tight = &mut self.scratch[..chroma.len()];
            chroma.run(uv.data, uv.stride, tight);
            put(tight, line, &mut out_uv, row / 2);
            row += rows;
        }
    }
}

/// Tight rows `line` bytes long into `dst` from row `first`; rows past its
/// end are left out.
fn put(tight: &[u8], line: usize, dst: &mut PlaneMut<'_>, first: usize) {
    if line == 0 || dst.stride < line {
        return;
    }
    for (r, src) in tight.chunks_exact(line).enumerate() {
        let at = (first + r) * dst.stride;
        let Some(to) = dst.data.get_mut(at..at + line) else {
            return;
        };
        to.copy_from_slice(src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An 8x8 NV12 frame whose every byte says where it is: luma row*16+col,
    /// chroma 200 + row*8+col (cols of the paired bytes).
    fn frame() -> (Vec<u8>, Vec<u8>) {
        let y = (0..8u8)
            .flat_map(|r| (0..8u8).map(move |c| r * 16 + c))
            .collect();
        let uv = (0..4u8)
            .flat_map(|r| (0..8u8).map(move |c| 200 + r * 8 + c))
            .collect();
        (y, uv)
    }

    #[test]
    fn two_parts_are_stacked_into_a_padded_frame() {
        let (y, uv) = frame();
        let top = Crop {
            x: 0,
            y: 0,
            w: 4,
            h: 4,
        };
        let bottom = Crop {
            x: 4,
            y: 4,
            w: 4,
            h: 4,
        };
        let mut stack = Stack::new(&[(top, (4, 4)), (bottom, (4, 4))]);
        // Six bytes a row: the decoder's padding past the picture.
        let (mut out_y, mut out_uv) = (vec![9u8; 6 * 8], vec![9u8; 6 * 4]);
        stack.run(
            [
                Plane {
                    data: &y,
                    stride: 8,
                },
                Plane {
                    data: &uv,
                    stride: 8,
                },
            ],
            [
                PlaneMut {
                    data: &mut out_y,
                    stride: 6,
                },
                PlaneMut {
                    data: &mut out_uv,
                    stride: 6,
                },
            ],
        );
        for r in 0..8 {
            let (sr, sc) = if r < 4 { (r, 0) } else { (r, 4) };
            assert_eq!(
                &out_y[r * 6..r * 6 + 4],
                &y[sr * 8 + sc..sr * 8 + sc + 4],
                "row {r}"
            );
            assert_eq!(&out_y[r * 6 + 4..r * 6 + 6], &[9, 9], "padding of row {r}");
        }
        assert_eq!(&out_uv[0..4], &uv[0..4]);
        assert_eq!(&out_uv[6..10], &uv[8..12]);
        assert_eq!(&out_uv[12..16], &uv[2 * 8 + 4..2 * 8 + 8]);
        assert_eq!(&out_uv[18..22], &uv[3 * 8 + 4..3 * 8 + 8]);
    }

    #[test]
    fn a_short_destination_keeps_what_fits() {
        let (y, uv) = frame();
        let mut stack = Stack::new(&[(Crop::whole(8, 8), (8, 8))]);
        let (mut out_y, mut out_uv) = (vec![0u8; 8 * 3], vec![0u8; 8]);
        stack.run(
            [
                Plane {
                    data: &y,
                    stride: 8,
                },
                Plane {
                    data: &uv,
                    stride: 8,
                },
            ],
            [
                PlaneMut {
                    data: &mut out_y,
                    stride: 8,
                },
                PlaneMut {
                    data: &mut out_uv,
                    stride: 8,
                },
            ],
        );
        assert_eq!(out_y, y[..24]);
        assert_eq!(out_uv, uv[..8]);
    }
}
