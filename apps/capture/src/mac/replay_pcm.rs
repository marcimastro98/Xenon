//! Instant Replay's sound on macOS, kept as raw 16-bit PCM next to each
//! segment, as on Windows (win/record/replay/pcm.rs): AAC per segment would
//! leave a gap at every joint (each encoder starts with its own priming), so
//! the sound is encoded once, when a clip is saved (replay_join.rs). A piece
//! goes to the segment whose span it falls in, at its place in that file.
//! Plain files only: its tests run on every OS.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::{audio, ring};

/// Segment starts remembered for placing late sound; sound is never this late.
const STARTS_KEPT: usize = 8;
/// Open files kept: the segment being written and the one before.
const FILES_KEPT: u64 = 2;
const BYTES_PER_FRAME: u64 = audio::CHANNELS as u64 * 2;
/// ENOSPC on macOS (and Linux): the disk is full.
const NO_SPACE: i32 = 28;

pub struct PcmRing {
    dir: PathBuf,
    tracks: usize,
    /// The first segment id in `starts`, and the sound frame each one starts at.
    first: u64,
    starts: Vec<u64>,
    files: Vec<(u64, usize, File)>,
    /// Per track, the sound frame written up to: a save waits for its end.
    written: Arc<Vec<AtomicU64>>,
}

impl PcmRing {
    pub fn new(dir: &Path, tracks: usize) -> PcmRing {
        PcmRing {
            dir: dir.to_path_buf(),
            tracks,
            first: 0,
            starts: Vec::new(),
            files: Vec::new(),
            written: Arc::new((0..tracks).map(|_| AtomicU64::new(0)).collect()),
        }
    }

    pub fn tracks(&self) -> usize {
        self.tracks
    }

    pub fn written(&self) -> Arc<Vec<AtomicU64>> {
        self.written.clone()
    }

    /// Segment `id` starts at sound frame `at`.
    pub fn begin(&mut self, id: u64, at: u64) {
        if self.starts.is_empty() {
            self.first = id;
        }
        self.starts.push(at);
        if self.starts.len() > STARTS_KEPT {
            self.starts.remove(0);
            self.first += 1;
        }
        self.files.retain(|(sid, _, _)| sid + FILES_KEPT > id);
    }

    /// A finished piece of track `track` starting at timeline frame `at`;
    /// the error is the code the replay ends with.
    pub fn put(&mut self, track: usize, at: u64, samples: &[i16]) -> Result<(), &'static str> {
        if track >= self.tracks {
            return Ok(());
        }
        let frames = (samples.len() / audio::CHANNELS) as u64;
        for (id, offset, from, len) in ring::split_sound(at, frames, self.first, &self.starts) {
            let a = from as usize * audio::CHANNELS;
            let b = a + len as usize * audio::CHANNELS;
            let bytes: Vec<u8> = samples[a..b].iter().flat_map(|v| v.to_le_bytes()).collect();
            self.write_at(id, track, offset, &bytes).map_err(|e| match e.raw_os_error() {
                Some(NO_SPACE) => "disk_full",
                _ => "write_failed",
            })?;
        }
        self.written[track].fetch_max(at + frames, Ordering::SeqCst);
        Ok(())
    }

    fn write_at(&mut self, id: u64, track: usize, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        let i = match self.files.iter().position(|(s, t, _)| *s == id && *t == track) {
            Some(i) => i,
            None => {
                let f = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(self.dir.join(ring::sound_name(id, track)))?;
                self.files.push((id, track, f));
                self.files.len() - 1
            }
        };
        let f = &mut self.files[i].2;
        f.seek(SeekFrom::Start(offset * BYTES_PER_FRAME))?;
        f.write_all(bytes)
    }
}

/// Track `track` of segment `id`, exactly `frames` long: silence where
/// nothing was written (a quiet source, or the end not reached).
pub fn read(dir: &Path, id: u64, track: usize, frames: u64) -> Vec<i16> {
    let mut bytes = Vec::new();
    if let Ok(mut f) = File::open(dir.join(ring::sound_name(id, track))) {
        let _ = f.read_to_end(&mut bytes);
    }
    let mut out: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    out.resize(frames as usize * audio::CHANNELS, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("xenon-pcm-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sound_lands_in_the_segment_it_belongs_to() {
        let dir = temp_dir("place");
        let mut r = PcmRing::new(&dir, 1);
        r.begin(0, 0);
        r.begin(1, 4);
        // Six frames from frame 2: two in segment 0 (at 2), four in segment 1.
        let samples: Vec<i16> = (1..=12).collect();
        r.put(0, 2, &samples).unwrap();
        assert_eq!(read(&dir, 0, 0, 4), vec![0, 0, 0, 0, 1, 2, 3, 4]);
        assert_eq!(read(&dir, 1, 0, 4), (5..=12).collect::<Vec<i16>>());
        assert_eq!(r.written()[0].load(Ordering::SeqCst), 8);
        // A track it does not have is ignored.
        assert!(r.put(3, 0, &samples).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_short_or_missing_file_reads_as_silence_of_the_right_length() {
        let dir = temp_dir("read");
        assert_eq!(read(&dir, 9, 0, 3), vec![0; 6]);
        let mut r = PcmRing::new(&dir, 2);
        r.begin(5, 100);
        r.put(1, 100, &[7, 7]).unwrap();
        assert_eq!(read(&dir, 5, 1, 2), vec![7, 7, 0, 0]);
        assert_eq!(read(&dir, 5, 1, 0), Vec::<i16>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_ring_names_are_written() {
        let dir = temp_dir("names");
        let mut r = PcmRing::new(&dir, 1);
        r.begin(3, 0);
        r.put(0, 0, &[1, 1]).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![ring::sound_name(3, 0)]);
        assert!(names.iter().all(|n| ring::is_ring_file(n)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
