//! A recording through ScreenCaptureKit, the way Windows records
//! (win/record/mod.rs): a frame clock takes the latest picture N/fps seconds
//! after the start (every N seconds for a timelapse, played back at
//! `video::LAPSE_FPS`), the Mac's sound and the microphone go through the
//! shared mixer, and AVFoundation writes the MP4 next to its final name until
//! it is finished. With the webcam asked for, its bubble is drawn on a copy
//! of each frame before the writer (webcam.rs). The answers and the summary
//! are the Windows ones.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use objc2_core_foundation::CFRetained;
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::CVPixelBuffer;
use serde_json::{json, Value};

use super::ffi::Sent;
use super::sck::{self, Target};
use super::media;
use crate::audio::{self, Packet};
use crate::bubble::Corner;
use crate::proto::{Fail, Notify};

mod running;

use running::run;

/// The setup (permission prompts included) before the start is answered.
const START_WAIT: Duration = Duration::from_secs(90);
/// How long the first picture may take once the stream runs.
const FIRST_WAIT: Duration = Duration::from_secs(3);
const STOP_WAIT: Duration = Duration::from_secs(40);
const NOT_STARTED: i64 = i64::MIN;

pub struct Plan {
    pub target: Target,
    /// The encoded size (the stream is asked for pictures this size).
    pub width: u32,
    pub height: u32,
    /// The rate the file plays at: `video::LAPSE_FPS` for a timelapse.
    pub fps: u32,
    /// Some(seconds) for a timelapse: one picture that often.
    pub every: Option<u32>,
    pub bitrate: u32,
    pub cursor: bool,
    pub sound: bool,
    pub mic: bool,
    /// Some(corner): the webcam in a bubble there (never in a timelapse).
    pub webcam: Option<Corner>,
    pub path: String,
}

/// What opened: the answer's `sound`, `mic` and `camera`.
pub struct Opened {
    pub sound: bool,
    pub mic: bool,
    pub camera: bool,
}

pub struct Recording {
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    done: mpsc::Receiver<Value>,
}

impl Recording {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Ends it and answers the summary.
    pub fn stop(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.done
            .recv_timeout(STOP_WAIT)
            .unwrap_or_else(|_| json!({ "reason": "capture_failed" }))
    }
}

/// What the stream and the microphone hand in, read by the frame clock
/// (Instant Replay's too: replay.rs).
pub(super) struct Shared {
    latest: Mutex<Option<Sent<CFRetained<CVPixelBuffer>>>>,
    sound: Mutex<Vec<Packet>>,
    /// The host time of the clock's start; NOT_STARTED until then.
    origin: AtomicI64,
    ended: Mutex<Option<isize>>,
    /// The Mac's sound is lane 0 when it is recorded.
    system: bool,
}

impl Shared {
    pub(super) fn new(system: bool) -> Arc<Shared> {
        Arc::new(Shared {
            latest: Mutex::new(None),
            sound: Mutex::new(Vec::new()),
            origin: AtomicI64::new(NOT_STARTED),
            ended: Mutex::new(None),
            system,
        })
    }

    /// The clock starts now: sound before this is dropped.
    pub(super) fn start_clock(&self) {
        self.origin.store(media::host_now(), Ordering::SeqCst);
    }

    /// The SCStreamErrorCode the stream ended with, once it did.
    pub(super) fn ended_code(&self) -> Option<isize> {
        self.ended.lock().ok().and_then(|e| *e)
    }

    /// The sound handed in since the last call.
    pub(super) fn take_sound(&self) -> Vec<Packet> {
        self.sound.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }

    pub(super) fn push(&self, lane: usize, buffer: &CMSampleBuffer) {
        let origin = self.origin.load(Ordering::SeqCst);
        if origin == NOT_STARTED {
            return;
        }
        if let Some((at, samples)) = media::sound_of(buffer) {
            let at = audio::frame_at(at - origin);
            if let Ok(mut q) = self.sound.lock() {
                q.push(Packet::Sound { lane, at, samples });
            }
        }
    }

    pub(super) fn picture(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.latest.lock().ok()?.as_ref().map(|p| p.0.clone())
    }
}

impl sck::Sink for Shared {
    fn picture(&self, picture: CFRetained<CVPixelBuffer>) {
        if let Ok(mut l) = self.latest.lock() {
            *l = Some(Sent(picture));
        }
    }
    fn sound(&self, buffer: &CMSampleBuffer) {
        if self.system {
            self.push(0, buffer);
        }
    }
    fn ended(&self, code: isize) {
        if let Ok(mut e) = self.ended.lock() {
            e.get_or_insert(code);
        }
    }
}

pub fn start(plan: Plan, notify: Notify) -> Result<(Recording, Opened), Fail> {
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicBool::new(true));
    let (ready_tx, ready_rx) = mpsc::channel();
    let (done_tx, done) = mpsc::channel();
    let (s, a) = (stop.clone(), active.clone());
    std::thread::spawn(move || {
        let (summary, pressed) = run(&plan, &s, &ready_tx);
        a.store(false, Ordering::SeqCst);
        let Some(summary) = summary else { return };
        let reason = summary["reason"].as_str().unwrap_or("");
        // As on Windows: a stop the server asked for needs no event; one from
        // the system (the menu bar's stop, a closed window) does.
        if !matches!(reason, "stopped" | "") || pressed {
            let mut event = json!({ "event": "record_ended" });
            if let (Some(e), Some(s)) = (event.as_object_mut(), summary.as_object()) {
                e.extend(s.clone());
            }
            notify(event);
        }
        let _ = done_tx.send(summary);
    });
    let opened = ready_rx
        .recv_timeout(START_WAIT)
        .unwrap_or_else(|_| Err(Fail::new("capture_failed", "start timed out")));
    match opened {
        Ok(o) => Ok((Recording { stop, active, done }, o)),
        Err(f) => {
            stop.store(true, Ordering::SeqCst);
            Err(f)
        }
    }
}
