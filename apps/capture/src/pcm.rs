//! Sound as a device hands it in, brought to what the mixer takes (audio.rs):
//! interleaved 16-bit stereo at `audio::RATE`. Devices give float or integer
//! samples, packed or one buffer per channel, mono to many channels, at their
//! own rate; macOS describes each buffer with its format and these turn it
//! into the mixer's. Pure, so it is tested on every OS.

use crate::audio::{CHANNELS, RATE};

/// How a buffer of samples is laid out (what CoreAudio's stream description says).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub rate: f64,
    pub channels: usize,
    /// 16, 24 or 32 for integers; 32 or 64 for floats.
    pub bits: u32,
    pub float: bool,
    /// One buffer per channel, one after the other, instead of frames.
    pub planar: bool,
    pub big_endian: bool,
}

/// CoreAudio's format flags (AudioStreamBasicDescription.mFormatFlags).
pub const FLAG_FLOAT: u32 = 1 << 0;
pub const FLAG_BIG_ENDIAN: u32 = 1 << 1;
pub const FLAG_NON_INTERLEAVED: u32 = 1 << 5;
/// 'lpcm': linear PCM, the only format read here.
pub const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");

impl Layout {
    /// From a stream description; None for anything but linear PCM this can read.
    pub fn from_description(
        format: u32,
        flags: u32,
        rate: f64,
        channels: u32,
        bits: u32,
    ) -> Option<Layout> {
        let float = flags & FLAG_FLOAT != 0;
        let readable = matches!((float, bits), (true, 32 | 64) | (false, 16 | 24 | 32));
        if format != LINEAR_PCM || !readable || channels == 0 || rate.is_nan() || rate <= 0.0 {
            return None;
        }
        Some(Layout {
            rate,
            channels: channels as usize,
            bits,
            float,
            planar: flags & FLAG_NON_INTERLEAVED != 0,
            big_endian: flags & FLAG_BIG_ENDIAN != 0,
        })
    }

    fn bytes(&self) -> usize {
        (self.bits / 8) as usize
    }
}

/// One sample as a float in -1..1.
fn sample(l: &Layout, b: &[u8]) -> f64 {
    let word = |n: usize| -> u64 {
        let mut v = 0u64;
        for i in 0..n {
            let byte = if l.big_endian { b[i] } else { b[n - 1 - i] };
            v = (v << 8) | byte as u64;
        }
        v
    };
    match (l.float, l.bits) {
        (true, 32) => f32::from_bits(word(4) as u32) as f64,
        (true, _) => f64::from_bits(word(8)),
        (false, 16) => word(2) as u16 as i16 as f64 / 32_768.0,
        (false, 24) => (((word(3) as u32) << 8) as i32 >> 8) as f64 / 8_388_608.0,
        (false, _) => word(4) as u32 as i32 as f64 / 2_147_483_648.0,
    }
}

fn to_i16(v: f64) -> i16 {
    let v = if v.is_finite() { v } else { 0.0 };
    (v * 32_767.0).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

/// `frames` frames of `data` as interleaved stereo at the layout's own rate:
/// mono goes to both sides, more than two channels keep the first two.
/// A buffer shorter than it says gives only the frames it holds.
pub fn stereo(l: &Layout, frames: usize, data: &[u8]) -> Vec<i16> {
    let n = l.bytes();
    let frames = frames.min(data.len() / (n * l.channels).max(1));
    let at = |frame: usize, ch: usize| -> usize {
        if l.planar {
            (ch * frames + frame) * n
        } else {
            (frame * l.channels + ch) * n
        }
    };
    let mut out = Vec::with_capacity(frames * CHANNELS);
    for f in 0..frames {
        let left = sample(l, &data[at(f, 0)..]);
        let right = if l.channels > 1 {
            sample(l, &data[at(f, 1)..])
        } else {
            left
        };
        out.push(to_i16(left));
        out.push(to_i16(right));
    }
    out
}

/// Interleaved stereo at `rate` brought to `audio::RATE`, by straight lines
/// between neighbouring samples: each packet on its own, which is what the
/// mixer's timestamps expect (a packet's length matches its time).
pub fn resample(stereo: &[i16], rate: f64) -> Vec<i16> {
    let frames = stereo.len() / CHANNELS;
    if frames == 0 || rate.is_nan() || rate <= 0.0 || (rate - RATE as f64).abs() < 0.5 {
        return stereo[..frames * CHANNELS].to_vec();
    }
    let out_frames = ((frames as f64) * RATE as f64 / rate).round() as usize;
    let step = rate / RATE as f64;
    let mut out = Vec::with_capacity(out_frames * CHANNELS);
    for k in 0..out_frames {
        let pos = k as f64 * step;
        let i = (pos.floor() as usize).min(frames - 1);
        let j = (i + 1).min(frames - 1);
        let t = pos - i as f64;
        for ch in 0..CHANNELS {
            let a = stereo[i * CHANNELS + ch] as f64;
            let b = stereo[j * CHANNELS + ch] as f64;
            out.push((a + (b - a) * t).round() as i16);
        }
    }
    out
}

/// Little-endian bytes of interleaved 16-bit samples, what a 16-bit PCM
/// buffer for the encoder holds.
pub fn le_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn float_planar(channels: u32) -> Layout {
        Layout::from_description(
            LINEAR_PCM,
            FLAG_FLOAT | FLAG_NON_INTERLEAVED,
            48_000.0,
            channels,
            32,
        )
        .unwrap()
    }

    #[test]
    fn reads_only_linear_pcm_it_knows() {
        assert!(Layout::from_description(LINEAR_PCM, FLAG_FLOAT, 48_000.0, 2, 32).is_some());
        assert!(Layout::from_description(LINEAR_PCM, 0, 44_100.0, 1, 16).is_some());
        assert!(Layout::from_description(LINEAR_PCM, 0, 48_000.0, 2, 24).is_some());
        assert_eq!(
            Layout::from_description(u32::from_be_bytes(*b"aac "), 0, 48_000.0, 2, 16),
            None
        );
        assert_eq!(Layout::from_description(LINEAR_PCM, FLAG_FLOAT, 48_000.0, 2, 16), None);
        assert_eq!(Layout::from_description(LINEAR_PCM, 0, 48_000.0, 0, 16), None);
        assert_eq!(Layout::from_description(LINEAR_PCM, 0, 0.0, 2, 16), None);
        assert_eq!(Layout::from_description(LINEAR_PCM, 0, f64::NAN, 2, 16), None);
        let l = float_planar(2);
        assert!(l.planar && l.float && !l.big_endian);
        assert_eq!(l.bytes(), 4);
    }

    #[test]
    fn planar_float_stereo_is_interleaved() {
        // Left: 0.5, 0.25; right: -0.5, -1.0, one buffer per channel.
        let data: Vec<u8> = [0.5f32, 0.25, -0.5, -1.0]
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();
        let out = stereo(&float_planar(2), 2, &data);
        assert_eq!(out, vec![16_384, -16_384, 8_192, -32_767]);
    }

    #[test]
    fn mono_goes_to_both_sides_and_extra_channels_are_dropped() {
        let mono = Layout::from_description(LINEAR_PCM, 0, 48_000.0, 1, 16).unwrap();
        let data: Vec<u8> = [1000i16, -2000].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(stereo(&mono, 2, &data), vec![1000, 1000, -2000, -2000]);
        let four = Layout::from_description(LINEAR_PCM, 0, 48_000.0, 4, 16).unwrap();
        let data: Vec<u8> = [1i16, 2, 3, 4, 5, 6, 7, 8]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(stereo(&four, 2, &data), vec![1, 2, 5, 6]);
    }

    #[test]
    fn integers_of_every_width_and_order() {
        let be = Layout::from_description(LINEAR_PCM, FLAG_BIG_ENDIAN, 48_000.0, 1, 16).unwrap();
        assert_eq!(stereo(&be, 1, &[0x40, 0x00]), vec![16_384, 16_384]);
        let i24 = Layout::from_description(LINEAR_PCM, 0, 48_000.0, 1, 24).unwrap();
        // -4194304 = -0.5 of full scale, little-endian 24-bit.
        assert_eq!(stereo(&i24, 1, &[0x00, 0x00, 0xC0]), vec![-16_384, -16_384]);
        let i32l = Layout::from_description(LINEAR_PCM, 0, 48_000.0, 1, 32).unwrap();
        assert_eq!(
            stereo(&i32l, 1, &i32::MIN.to_le_bytes()),
            vec![-32_767, -32_767]
        );
        let f64l = Layout::from_description(LINEAR_PCM, FLAG_FLOAT, 48_000.0, 1, 64).unwrap();
        assert_eq!(stereo(&f64l, 1, &2.0f64.to_le_bytes()), vec![32_767, 32_767]);
    }

    #[test]
    fn a_short_buffer_gives_what_it_holds_and_junk_is_silence() {
        let l = float_planar(1);
        assert_eq!(stereo(&l, 10, &0.5f32.to_le_bytes()).len(), 2);
        assert!(stereo(&l, 3, &[]).is_empty());
        assert_eq!(stereo(&l, 1, &f32::NAN.to_le_bytes()), vec![0, 0]);
    }

    #[test]
    fn resampling_keeps_the_length_in_time() {
        let at44: Vec<i16> = (0..441).flat_map(|i| [i as i16, -(i as i16)]).collect();
        let out = resample(&at44, 44_100.0);
        assert_eq!(out.len(), 480 * CHANNELS);
        assert_eq!((out[0], out[1]), (0, 0));
        // Halfway through the packet is halfway through the ramp.
        assert!((out[240 * CHANNELS] - 220).abs() <= 1);
        let same: Vec<i16> = vec![5; 96];
        assert_eq!(resample(&same, 48_000.0), same);
        assert!(resample(&[], 44_100.0).is_empty());
        assert_eq!(resample(&[1, 2, 3], 48_000.0), vec![1, 2], "a half frame is dropped");
        assert_eq!(resample(&[7, 7], 24_000.0), vec![7, 7, 7, 7]);
    }

    #[test]
    fn bytes_are_little_endian() {
        assert_eq!(le_bytes(&[1, -2]), vec![1, 0, 0xFE, 0xFF]);
    }
}
