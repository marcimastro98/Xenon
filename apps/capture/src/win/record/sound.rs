//! The sound of one recording: the sources it asked for (audio.rs), the
//! mixer that lines them up (`crate::audio`), and the tracks they become.

use serde_json::{json, Value};
use windows::core::Result;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use super::audio::{Kind, Sources};
use super::encoder::Encoder;
use super::Aim;
use crate::audio::{self, Mixer};

/// What the request asked for.
#[derive(Clone, Copy, Default)]
pub struct Wanted {
    /// The sound of the PC, or of the app when a window is recorded.
    pub sound: bool,
    pub mic: bool,
}

/// Where finished pieces of sound go: the encoder of a recording, or the
/// replay's sound files.
pub trait SoundOut {
    fn put(&self, track: usize, at: u64, samples: &[i16]) -> Result<()>;
}

impl SoundOut for Encoder {
    fn put(&self, track: usize, at: u64, samples: &[i16]) -> Result<()> {
        self.write_sound(track, at, samples)
    }
}

pub struct Sound {
    sources: Sources,
    mixer: Mixer,
}

impl Sound {
    pub fn open(aim: &Aim, wanted: Wanted) -> Sound {
        let mut kinds = Vec::new();
        if wanted.sound {
            kinds.push(match *aim {
                Aim::Window(h) => app_of(h).map_or(Kind::System, Kind::App),
                Aim::Monitor(_) => Kind::System,
            });
        }
        if wanted.mic {
            kinds.push(Kind::Microphone);
        }
        let sources = Sources::open(&kinds);
        let n = sources.kinds.len();
        Sound {
            mixer: Mixer::new(n, audio::tracks(n)),
            sources,
        }
    }

    /// How many sound tracks the file gets.
    pub fn tracks(&self) -> usize {
        audio::tracks(self.sources.kinds.len()).len()
    }

    /// What opened, for the start reply: `sound` is "app", "system" or null.
    pub fn info(&self) -> Value {
        let kinds = &self.sources.kinds;
        let sound = kinds.iter().find_map(|k| match k {
            Kind::App(_) => Some("app"),
            Kind::System => Some("system"),
            Kind::Microphone => None,
        });
        json!({ "sound": sound, "mic": kinds.contains(&Kind::Microphone) })
    }

    /// The recording starts now.
    pub fn begin(&self) {
        self.sources.begin();
    }

    /// Writes whatever every source has reached.
    pub fn pump(&mut self, out: &impl SoundOut) -> Result<()> {
        while let Ok(p) = self.sources.packets.try_recv() {
            self.mixer.push(p);
        }
        write(out, self.mixer.take())
    }

    /// Stops the sources and makes every track exactly `end_ticks` long.
    pub fn end(mut self, out: &impl SoundOut, end_ticks: i64) -> Result<()> {
        let packets = self.sources.close();
        while let Ok(p) = packets.try_recv() {
            self.mixer.push(p);
        }
        let end = audio::frame_at(end_ticks).max(0) as u64;
        write(out, self.mixer.finish(end))
    }
}

fn write(out: &impl SoundOut, pieces: Vec<audio::Piece>) -> Result<()> {
    for p in pieces {
        out.put(p.track, p.at, &p.samples)?;
    }
    Ok(())
}

/// The process that owns window `h`.
fn app_of(h: isize) -> Option<u32> {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(HWND(h as *mut core::ffi::c_void), Some(&mut pid));
    }
    (pid != 0).then_some(pid)
}
