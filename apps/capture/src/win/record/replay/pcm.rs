//! The replay's sound, kept as raw 16-bit PCM next to each segment. AAC per
//! segment would leave a gap at every joint (each encoder starts with its own
//! priming), so the sound is encoded once, when a clip is saved (remux.rs).
//! A piece goes to the segment whose span it falls in, at its place in that
//! file: late sound still lands where it belongs.

use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use windows::core::{Error, Result, HRESULT};

use super::super::sound::SoundOut;
use crate::{audio, ring};

/// Segment starts remembered for placing late sound; sound is never this late.
const STARTS_KEPT: usize = 8;
/// Open files kept: the segment being written and the one before.
const FILES_KEPT: u64 = 2;
const BYTES_PER_FRAME: u64 = audio::CHANNELS as u64 * 2;
const E_WRITE: HRESULT = HRESULT(0x8007_001D_u32 as i32);

pub struct PcmRing {
    dir: PathBuf,
    tracks: usize,
    /// The first segment id in `starts`, and the sound frame each one starts at.
    starts: RefCell<(u64, Vec<u64>)>,
    files: RefCell<Vec<(u64, usize, File)>>,
    /// Per track, the sound frame written up to: a save waits for its end.
    written: Arc<Vec<AtomicU64>>,
}

impl PcmRing {
    pub fn new(dir: &Path, tracks: usize) -> PcmRing {
        PcmRing {
            dir: dir.to_path_buf(),
            tracks,
            starts: RefCell::new((0, Vec::new())),
            files: RefCell::new(Vec::new()),
            written: Arc::new((0..tracks).map(|_| AtomicU64::new(0)).collect()),
        }
    }

    pub fn written(&self) -> Arc<Vec<AtomicU64>> {
        self.written.clone()
    }

    /// Segment `id` starts at sound frame `at`.
    pub fn begin(&self, id: u64, at: u64) {
        let mut s = self.starts.borrow_mut();
        if s.1.is_empty() {
            s.0 = id;
        }
        s.1.push(at);
        if s.1.len() > STARTS_KEPT {
            s.1.remove(0);
            s.0 += 1;
        }
        self.files
            .borrow_mut()
            .retain(|(sid, _, _)| sid + FILES_KEPT > id);
    }

    fn write_at(&self, id: u64, track: usize, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        let mut files = self.files.borrow_mut();
        let i = match files.iter().position(|(s, t, _)| *s == id && *t == track) {
            Some(i) => i,
            None => {
                let f = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(self.dir.join(ring::sound_name(id, track)))?;
                files.push((id, track, f));
                files.len() - 1
            }
        };
        let f = &mut files[i].2;
        f.seek(SeekFrom::Start(offset * BYTES_PER_FRAME))?;
        f.write_all(bytes)
    }
}

impl SoundOut for PcmRing {
    fn put(&self, track: usize, at: u64, samples: &[i16]) -> Result<()> {
        if track >= self.tracks {
            return Ok(());
        }
        let frames = (samples.len() / audio::CHANNELS) as u64;
        let parts = {
            let s = self.starts.borrow();
            ring::split_sound(at, frames, s.0, &s.1)
        };
        for (id, offset, from, len) in parts {
            let a = (from as usize) * audio::CHANNELS;
            let b = a + len as usize * audio::CHANNELS;
            let bytes: Vec<u8> = samples[a..b].iter().flat_map(|v| v.to_le_bytes()).collect();
            self.write_at(id, track, offset, &bytes)
                .map_err(|e| Error::new(disk_code(&e), e.to_string()))?;
        }
        self.written[track].fetch_max(at + frames, Ordering::SeqCst);
        Ok(())
    }
}

/// A full disk keeps its own code, so the replay can say why it stopped.
fn disk_code(e: &std::io::Error) -> HRESULT {
    match e.raw_os_error() {
        Some(code @ (0x27 | 0x70)) => HRESULT((0x8007_0000_u32 | code as u32) as i32),
        _ => E_WRITE,
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
