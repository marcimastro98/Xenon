//! The sound sources of a recording, with WASAPI: the sound of the PC (the
//! default speakers, looped back), the sound of one app and its children
//! (process loopback, Windows 10 2004 and later), the microphone. Each runs on
//! a thread of its own, asks Windows for 48 kHz stereo 16-bit whatever the
//! device plays, and hands packets stamped on the recording's clock to the
//! mixer (`crate::audio`). A source that fails mid-recording turns to silence:
//! the recording goes on.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::Result;
use windows::Win32::Media::Audio::{AUDCLNT_BUFFERFLAGS_SILENT, IAudioCaptureClient};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

use crate::audio::{self, CHANNELS, Packet};

mod clients;

use clients::{open_client, Source};

const WAVE_FORMAT_PCM: u16 = 1;
const BITS: u16 = 16;
/// The device buffer: room for many polls, so a slow one never loses sound.
const BUFFER_TICKS: i64 = 2_000_000;
const POLL: Duration = Duration::from_millis(10);
/// How often a quiet source says so.
const QUIET_EVERY: Duration = Duration::from_millis(50);
/// How long Windows may take to hand over an app's sound.
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(3);
/// Not set yet: packets before the recording starts are dropped.
const NO_ORIGIN: i64 = i64::MIN;

/// Where a source's sound comes from.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// Everything the PC plays.
    System,
    /// What one process and its children play.
    App(u32),
    Microphone,
}

/// The sources that opened, each on its lane of the mixer.
pub struct Sources {
    pub kinds: Vec<Kind>,
    pub packets: Receiver<Packet>,
    /// The recording's start on the clock packets are stamped with.
    origin: Arc<AtomicI64>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Sources {
    /// Opens what it can of `wanted`, in order; an app whose sound cannot be
    /// taken on its own falls back to the sound of the whole PC.
    pub fn open(wanted: &[Kind]) -> Sources {
        let (tx, packets) = mpsc::channel();
        let origin = Arc::new(AtomicI64::new(NO_ORIGIN));
        let stop = Arc::new(AtomicBool::new(false));
        let mut kinds = Vec::new();
        let mut threads = Vec::new();
        for &want in wanted {
            let tries: &[Kind] = match want {
                Kind::App(_) => &[want, Kind::System],
                _ => &[want],
            };
            for &kind in tries {
                let lane = kinds.len();
                let started = start(kind, lane, &tx, &origin, &stop);
                if let Some(t) = started {
                    kinds.push(kind);
                    threads.push(t);
                    break;
                }
            }
        }
        Sources {
            kinds,
            packets,
            origin,
            stop,
            threads,
        }
    }

    /// The recording starts now: packets are stamped from this moment.
    pub fn begin(&self) {
        self.origin.store(now_ticks(), Ordering::SeqCst);
    }

    /// Stops every source; what they handed in last is still in the channel.
    pub fn close(self) -> Receiver<Packet> {
        self.stop.store(true, Ordering::SeqCst);
        for t in self.threads {
            let _ = t.join();
        }
        self.packets
    }
}

/// The performance counter in 100-ns units, the clock WASAPI stamps with.
fn now_ticks() -> i64 {
    let (mut count, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    (count as i128 * 10_000_000 / freq.max(1) as i128) as i64
}

/// Starts a source thread; None when its device cannot be opened.
fn start(
    kind: Kind,
    lane: usize,
    tx: &Sender<Packet>,
    origin: &Arc<AtomicI64>,
    stop: &Arc<AtomicBool>,
) -> Option<JoinHandle<()>> {
    let (ready_tx, ready) = mpsc::channel();
    let (tx, origin, stop) = (tx.clone(), origin.clone(), stop.clone());
    let thread = std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        match open_client(kind) {
            Ok((client, capture)) => {
                let _ = ready_tx.send(true);
                let source = Source {
                    lane,
                    tx,
                    origin,
                    stop,
                };
                source.pump(&capture);
                unsafe {
                    let _ = client.Stop();
                }
            }
            Err(_) => {
                let _ = ready_tx.send(false);
            }
        }
        unsafe { CoUninitialize() };
    });
    if ready.recv().unwrap_or(false) {
        Some(thread)
    } else {
        let _ = thread.join();
        None
    }
}

impl Source {
    /// Reads packets until the recording stops; after a device error, says
    /// "quiet" instead, so the track stays as long as the video.
    fn pump(&self, capture: &IAudioCaptureClient) {
        let mut broken = false;
        let mut quiet_since = Instant::now();
        while !self.stop.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            let origin = self.origin.load(Ordering::SeqCst);
            let got = if broken {
                Ok(false)
            } else {
                self.drain(capture, origin)
            };
            match got {
                Ok(true) => quiet_since = Instant::now(),
                Ok(false) if quiet_since.elapsed() >= QUIET_EVERY && origin != NO_ORIGIN => {
                    let until = audio::frame_at(now_ticks() - origin - audio::LATENCY_TICKS);
                    let _ = self.tx.send(Packet::Quiet {
                        lane: self.lane,
                        until,
                    });
                    quiet_since = Instant::now();
                }
                Ok(false) => {}
                // Unplugged, or the format changed: silence from here on.
                Err(_) => broken = true,
            }
        }
    }

    /// Hands over every packet waiting; true when there was any sound.
    fn drain(&self, capture: &IAudioCaptureClient, origin: i64) -> Result<bool> {
        let mut any = false;
        while unsafe { capture.GetNextPacketSize()? } > 0 {
            let mut data = std::ptr::null_mut();
            let (mut frames, mut flags, mut qpc) = (0u32, 0u32, 0u64);
            unsafe {
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))?;
            }
            let n = frames as usize * CHANNELS;
            let samples = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                vec![0i16; n]
            } else {
                unsafe { std::slice::from_raw_parts(data as *const i16, n).to_vec() }
            };
            unsafe { capture.ReleaseBuffer(frames)? };
            if origin == NO_ORIGIN || frames == 0 {
                continue;
            }
            // Some sources leave the stamp out: then it is "just now".
            let at = if qpc > 0 {
                audio::frame_at(qpc as i64 - origin)
            } else {
                audio::frame_at(now_ticks() - origin) - frames as i64
            };
            let _ = self.tx.send(Packet::Sound {
                lane: self.lane,
                at,
                samples,
            });
            any = true;
        }
        Ok(any)
    }
}
