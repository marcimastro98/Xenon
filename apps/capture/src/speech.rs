//! A video's sound made ready for speech recognition: one channel, 16 kHz,
//! 16-bit PCM in a WAV file, the format whisper.cpp reads. The Win32 side
//! (decoding the recording's first audio track) lives in `win::speech`; this
//! is the arithmetic, streamed, so a long recording never sits in memory.

/// What whisper.cpp wants.
pub const RATE: u32 = 16_000;
/// A recording longer than this is cut here: two hours of speech is already
/// a long transcription on a CPU.
pub const MAX_SECONDS: u32 = 2 * 60 * 60;
/// Size of the WAV header written before the samples.
pub const HEADER_LEN: usize = 44;

/// Interleaved frames of `channels` samples to one channel (their mean).
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let ch = channels.max(1);
    for frame in interleaved.chunks_exact(ch) {
        out.push(frame.iter().sum::<f32>() / ch as f32);
    }
}

/// Streams one channel from `from` Hz to `RATE`. Going down, each output
/// sample is the mean of the input samples its span covers (a box filter: no
/// aliasing worth hearing in speech); going up, it is a straight line between
/// the two nearest inputs.
pub struct Resampler {
    step: f64,
    // Down: the running sum and count of the span being filled, and where it ends.
    sum: f64,
    count: u32,
    edge: f64,
    // Up: the last input sample and its index.
    at: f64,
    prev: f32,
    seen: u64,
}

impl Resampler {
    pub fn new(from: u32) -> Resampler {
        let step = from.max(1) as f64 / RATE as f64;
        Resampler {
            step,
            sum: 0.0,
            count: 0,
            edge: step,
            at: 0.0,
            prev: 0.0,
            seen: 0,
        }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        if self.step >= 1.0 {
            for &s in input {
                self.sum += s as f64;
                self.count += 1;
                self.seen += 1;
                if self.seen as f64 >= self.edge {
                    out.push(to_i16((self.sum / self.count as f64) as f32));
                    self.sum = 0.0;
                    self.count = 0;
                    self.edge += self.step;
                }
            }
            return;
        }
        for &s in input {
            let i = self.seen as f64;
            // Output times that fall between the previous input and this one.
            while self.at <= i {
                let t = if self.seen == 0 {
                    1.0
                } else {
                    (self.at - (i - 1.0)) as f32
                };
                out.push(to_i16(self.prev + (s - self.prev) * t));
                self.at += self.step;
            }
            self.prev = s;
            self.seen += 1;
        }
    }
}

fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

/// The 44-byte header of a mono 16-bit PCM WAV at `RATE` holding `data_len`
/// bytes of samples.
pub fn wav_header(data_len: u32) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    let mut put = |at: usize, bytes: &[u8]| h[at..at + bytes.len()].copy_from_slice(bytes);
    put(0, b"RIFF");
    put(4, &(36 + data_len).to_le_bytes());
    put(8, b"WAVEfmt ");
    put(16, &16u32.to_le_bytes());
    put(20, &1u16.to_le_bytes()); // PCM
    put(22, &1u16.to_le_bytes()); // mono
    put(24, &RATE.to_le_bytes());
    put(28, &(RATE * 2).to_le_bytes());
    put(32, &2u16.to_le_bytes());
    put(34, &16u16.to_le_bytes());
    put(36, b"data");
    put(40, &data_len.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_becomes_the_mean() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, -0.5, -0.5, 0.25], 2, &mut out);
        assert_eq!(out, vec![0.5, -0.5], "a half frame at the end is dropped");
    }

    #[test]
    fn forty_eight_khz_gives_a_third_of_the_samples() {
        let mut r = Resampler::new(48_000);
        let mut out = Vec::new();
        // Pushed in uneven pieces, as a decoder hands them.
        let input = vec![0.5f32; 48_000];
        for piece in input.chunks(1_031) {
            r.push(piece, &mut out);
        }
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|&s| (s - 16_384).abs() <= 1));
    }

    #[test]
    fn a_tone_the_speech_band_keeps_survives() {
        // 440 Hz at 44.1 kHz: still a 440 Hz wave of about the same height at 16 kHz.
        let mut r = Resampler::new(44_100);
        let input: Vec<f32> = (0..44_100)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.8)
            .collect();
        let mut out = Vec::new();
        r.push(&input, &mut out);
        assert!((out.len() as i64 - 16_000).abs() <= 1, "{}", out.len());
        let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(peak > 24_000, "peak {peak}");
        let crossings = out.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count();
        assert!((crossings as i64 - 880).abs() <= 4, "{crossings}");
    }

    #[test]
    fn eight_khz_is_doubled_on_a_line() {
        let mut r = Resampler::new(8_000);
        let mut out = Vec::new();
        r.push(&[0.0, 0.5], &mut out);
        r.push(&[1.0], &mut out);
        let half = i16::MAX / 2;
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], 0);
        assert!((out[2] - half).abs() <= 1 && out[4] == i16::MAX, "{out:?}");
    }

    #[test]
    fn loud_samples_are_clipped_not_wrapped() {
        assert_eq!(to_i16(3.0), i16::MAX);
        assert_eq!(to_i16(-3.0), -i16::MAX);
    }

    #[test]
    fn the_header_says_mono_16_bit_16_khz() {
        let h = wav_header(32_000);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 32_036);
        assert_eq!(u16::from_le_bytes([h[22], h[23]]), 1);
        assert_eq!(u32::from_le_bytes(h[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes([h[34], h[35]]), 16);
        assert_eq!(u32::from_le_bytes(h[40..44].try_into().unwrap()), 32_000);
    }
}
