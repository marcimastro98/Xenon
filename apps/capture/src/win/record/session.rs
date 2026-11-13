// Windows recording: the thread that captures, encodes and finishes one recording.

use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{HMONITOR, MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFShutdown, MFStartup, MFSTARTUP_LITE};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use crate::video;
use crate::proto::{Fail, Notify};
use super::{Aim, draw, ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL, Plan, target_view};
use super::badge::Badge;
use super::bubble_pass::Bubble;
use super::camera::Camera;
use super::encoder::{Encoder, Frame};
use super::painter::Painter;
use super::sound::Sound;
use super::source::Source;
use super::super::d3d::{self, Device};
use super::super::grab::Target;

struct Tools {
    dev: Device,
    source: Source,
    encoder: Encoder,
    painter: Painter,
    sound: Sound,
    size: (u32, u32),
    /// None when no webcam was asked for, or none could be opened.
    bubble: Option<Bubble>,
}

fn open(plan: &Plan) -> Result<Tools, Fail> {
    let dev = d3d::create_for_video().map_err(|e| Fail::new("no_encoder", e))?;
    let target = match plan.aim {
        Aim::Monitor(h) => Target::Monitor(HMONITOR(h as *mut core::ffi::c_void)),
        Aim::Window(h) => Target::Window(HWND(h as *mut core::ffi::c_void)),
    };
    let source = Source::open(&dev, target, plan.hdr_white.is_some(), plan.room)
        .map_err(|e| Fail::new("capture_failed", e))?;
    let (w, h) = source.size();
    let size = video::encode_size(w, h, plan.height);
    let bitrate = video::bitrate(size.0, size.1, plan.fps, plan.quality);
    let sound = Sound::open(&plan.aim, plan.audio);
    let encoder = Encoder::create(
        &dev.d3d,
        &plan.path,
        size,
        plan.fps,
        bitrate,
        sound.tracks(),
    )
    .map_err(|e| Fail::new(failure(&e), e))?;
    let painter = Painter::new(&dev.d3d).map_err(|e| Fail::new("no_encoder", e))?;
    // No camera, or one another app holds: the recording goes on without it.
    let bubble = plan
        .webcam
        .and_then(|corner| Bubble::new(&dev.d3d, Camera::open()?, corner).ok());
    Ok(Tools {
        dev,
        source,
        encoder,
        painter,
        sound,
        size,
        bubble,
    })
}

pub(super) fn failure(e: &windows::core::Error) -> &'static str {
    match e.code() {
        ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => "disk_full",
        _ => "encoder_failed",
    }
}

#[derive(Default)]
struct Counts {
    frames: u64,
    dropped: u64,
    /// The index after the last frame written: the length of the video.
    end: u64,
}

pub(super) fn run(
    plan: Plan,
    stop: Arc<AtomicBool>,
    started: mpsc::Sender<Result<Value, Fail>>,
    notify: Notify,
) -> Value {
    let pressed = Arc::new(AtomicBool::new(false));
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_LITE) {
            let _ = started.send(Err(Fail::new("no_encoder", e)));
            return json!({ "reason": "no_encoder" });
        }
    }
    let summary = match open(&plan) {
        Err(fail) => {
            let reason = fail.code;
            let _ = std::fs::remove_file(&plan.path);
            let _ = started.send(Err(fail));
            json!({ "reason": reason })
        }
        Ok(tools) => {
            let mut info = json!({
                "width": tools.size.0, "height": tools.size.1,
                "fps": plan.fps, "hdr": plan.hdr_white.is_some(),
            });
            if let (Some(o), Some(s)) = (info.as_object_mut(), tools.sound.info().as_object()) {
                o.extend(s.clone());
            }
            if let (Some(o), Some(_)) = (info.as_object_mut(), plan.webcam) {
                o.insert("camera".into(), json!(tools.bubble.is_some()));
            }
            if started.send(Ok(info)).is_err() {
                stop.store(true, Ordering::SeqCst);
            }
            let badge = plan
                .badge
                .then(|| Badge::show(badge_monitor(&plan.aim), stop.clone(), pressed.clone()));
            let summary = record(tools, &plan, &stop);
            drop(badge);
            summary
        }
    };
    unsafe {
        let _ = MFShutdown();
    }
    let reason = summary["reason"].as_str().unwrap_or("");
    // A stop asked by the server needs no event; one clicked on the badge does.
    if !matches!(reason, "stopped" | "") || pressed.load(Ordering::SeqCst) {
        let mut event = json!({ "event": "record_ended" });
        if let (Some(e), Some(s)) = (event.as_object_mut(), summary.as_object()) {
            e.extend(s.clone());
        }
        notify(event);
    }
    summary
}

/// The monitor the badge goes on: the one recorded, or the one the window is on.
fn badge_monitor(aim: &Aim) -> isize {
    match *aim {
        Aim::Monitor(h) => h,
        Aim::Window(h) => unsafe {
            MonitorFromWindow(HWND(h as *mut core::ffi::c_void), MONITOR_DEFAULTTONEAREST).0
                as isize
        },
    }
}

/// The frame clock: frame N is due N/fps seconds after the start (N * every
/// for a timelapse). A tick that comes late skips to the frame of the moment,
/// so the video keeps real time.
fn record(mut t: Tools, plan: &Plan, stop: &AtomicBool) -> Value {
    let start = Instant::now();
    t.sound.begin();
    let mut counts = Counts::default();
    let mut index = 0u64;
    let reason = loop {
        if stop.load(Ordering::SeqCst) {
            break "stopped";
        }
        if t.source.closed() {
            break "window_closed";
        }
        let due = start
            + Duration::from_nanos(video::shot_time(index, plan.fps, plan.every) as u64 * 100);
        let now = Instant::now();
        if now < due {
            std::thread::sleep(due - now);
        } else {
            let ticks = (now - start).as_nanos() as i64 / 100;
            let current = video::shot_index(ticks, plan.fps, plan.every);
            if current > index {
                counts.dropped += current - index;
                index = current;
            }
        }
        if t.source.refresh(&t.dev).is_err() {
            break "capture_failed";
        }
        match t.encoder.frame() {
            Ok(Some(frame)) => {
                paint(&mut t, plan, &frame);
                if let Err(e) = t.encoder.write(frame, index) {
                    break failure(&e);
                }
                counts.frames += 1;
                counts.end = index + 1;
                if let Err(e) = t.sound.pump(&t.encoder) {
                    break failure(&e);
                }
            }
            Ok(None) => counts.dropped += 1,
            Err(e) => break failure(&e),
        }
        index += 1;
    };
    let end_ticks = video::frame_time(counts.end, plan.fps);
    let sound = t.sound.end(&t.encoder, end_ticks);
    let mut summary = finish(t.encoder, sound, plan, reason, &counts);
    if let (Some(_), Some(o)) = (plan.every, summary.as_object_mut()) {
        o.insert("span".into(), json!(start.elapsed().as_secs()));
    }
    summary
}

fn finish(
    encoder: Encoder,
    sound: windows::core::Result<()>,
    plan: &Plan,
    reason: &'static str,
    counts: &Counts,
) -> Value {
    let finalized = sound.and_then(|()| encoder.finish());
    let reason = match finalized {
        Err(e) if reason == "stopped" => failure(&e),
        _ => reason,
    };
    let bytes = if counts.frames == 0 {
        // Nothing to watch: no empty file left behind.
        let _ = std::fs::remove_file(&plan.path);
        0
    } else {
        std::fs::metadata(&plan.path).map_or(0, |m| m.len())
    };
    json!({
        "reason": reason,
        "seconds": video::frame_time(counts.end, plan.fps) as f64 / video::TICKS_PER_SECOND as f64,
        "frames": counts.frames, "dropped": counts.dropped, "bytes": bytes,
    })
}

fn paint(t: &mut Tools, plan: &Plan, frame: &Frame) {
    draw(&t.dev, &t.painter, &t.source, t.size, plan.hdr_white, frame);
    if let (Some(b), Some(target)) = (t.bubble.as_mut(), target_view(&t.dev, frame)) {
        b.draw(&t.dev.d3d, &t.dev.ctx, &target, t.size);
    }
}
