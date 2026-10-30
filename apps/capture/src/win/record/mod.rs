//! Screen and window recording: a thread of its own captures the picture
//! (source.rs), draws it into a video frame at a steady rate (painter.rs) and
//! hands the frame to the encoder (encoder.rs). The engine keeps answering
//! requests meanwhile; `stop` ends it, or it ends by itself (window closed,
//! disk full) and says so with an event line. Sound (sound.rs) is written
//! next to the frames, on the same clock.

mod audio;
pub(super) mod badge;
mod bubble_pass;
mod camera;
pub(super) mod encoder;
mod painter;
pub(super) mod replay;
mod sound;
mod source;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::core::HRESULT;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11RenderTargetView, D3D11_RENDER_TARGET_VIEW_DESC, D3D11_RENDER_TARGET_VIEW_DESC_0,
    D3D11_RTV_DIMENSION_TEXTURE2DARRAY, D3D11_TEX2D_ARRAY_RTV, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_LITE, MF_VERSION};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::d3d::{self, Device};
use super::grab::Target;
use crate::proto::{Fail, Notify};
use crate::video;
use badge::Badge;
use bubble_pass::Bubble;
use camera::Camera;
use encoder::{Encoder, Frame};
use painter::{Painter, Params};
use sound::Sound;
pub use sound::Wanted;
use source::Source;

/// How long the encoder may take to open before the start is given up.
const START_TIMEOUT: Duration = Duration::from_secs(10);

/// HDR is brought to SDR white and no further: the desktop and apps convert
/// exactly, brighter highlights keep their colour and clip. A fixed roll-off
/// would dim every white on the desktop; a per-frame one would pump.
const HDR_PEAK: f32 = 1.0;

const ERROR_HANDLE_DISK_FULL: HRESULT = HRESULT(0x8007_0027_u32 as i32);
const ERROR_DISK_FULL: HRESULT = HRESULT(0x8007_0070_u32 as i32);

/// What to record. Handles travel as numbers: they are not `Send`.
pub enum Aim {
    Monitor(isize),
    Window(isize),
}

pub struct Plan {
    pub aim: Aim,
    /// Some(SDR white in scRGB units) when the picture is HDR.
    pub hdr_white: Option<f32>,
    /// The size of the monitor the picture is on (0 x 0 when unknown).
    pub room: (u32, u32),
    pub path: String,
    pub fps: u32,
    /// 0 keeps the size of the source (video::height_cap).
    pub height: u32,
    pub quality: video::Quality,
    /// The "recording" pill on screen; off when the user hid it.
    pub badge: bool,
    pub audio: Wanted,
    /// Some(seconds) for a timelapse: one picture that often, played at `fps`.
    pub every: Option<u32>,
    /// Some(corner): the webcam in a bubble there, asked for on this recording only.
    pub webcam: Option<crate::bubble::Corner>,
}

pub struct Recording {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Value>,
}

impl Recording {
    pub fn active(&self) -> bool {
        !self.thread.is_finished()
    }

    /// Ends the recording and waits for the file to be complete.
    pub fn stop(self) -> Value {
        self.stop.store(true, Ordering::SeqCst);
        self.thread
            .join()
            .unwrap_or_else(|_| json!({ "reason": "crashed" }))
    }
}

/// Starts recording; answers once the first frame can be written, with the
/// size of the video.
pub fn start(plan: Plan, notify: Notify) -> Result<(Recording, Value), Fail> {
    let stop = Arc::new(AtomicBool::new(false));
    let (started, rx) = mpsc::channel();
    let flag = stop.clone();
    let thread = std::thread::spawn(move || run(plan, flag, started, notify));
    match rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(info)) => Ok((Recording { stop, thread }, info)),
        Ok(Err(fail)) => Err(fail),
        Err(_) => {
            // Leave it to end by itself; it finds the flag once it gets going.
            stop.store(true, Ordering::SeqCst);
            Err(Fail::code("record_failed"))
        }
    }
}

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

fn failure(e: &windows::core::Error) -> &'static str {
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

fn run(
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

/// Draws the latest picture into an encoder frame of `size`, letterboxed;
/// HDR (`hdr_white`) is brought to SDR. Shared with the replay.
fn draw(
    dev: &Device,
    painter: &Painter,
    source: &Source,
    size: (u32, u32),
    hdr_white: Option<f32>,
    frame: &Frame,
) {
    let Some(target) = target_view(dev, frame) else {
        return;
    };
    let (w, h) = size;
    let picture = source.picture();
    let params = picture.map_or(Params::default(), |(_, (cw, ch), uv_scale)| Params {
        bounds: video::letterbox(cw, ch, w, h),
        uv_scale,
        frame: [w as f32, h as f32],
        white: hdr_white.unwrap_or(1.0),
        peak: HDR_PEAK,
        hdr: if hdr_white.is_some() { 1.0 } else { 0.0 },
        unused: 0.0,
    });
    painter.paint(&dev.ctx, picture.map(|(view, _, _)| view), &target, &params);
}

/// A view to draw into the frame's texture (one slice of it when the
/// allocator hands out texture arrays).
fn target_view(dev: &Device, frame: &Frame) -> Option<ID3D11RenderTargetView> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    let slice = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: desc.Format,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2DARRAY,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
            Texture2DArray: D3D11_TEX2D_ARRAY_RTV {
                MipSlice: 0,
                FirstArraySlice: frame.subresource,
                ArraySize: 1,
            },
        },
    };
    let desc_ptr = (desc.ArraySize > 1).then_some(&slice as *const _);
    let mut view = None;
    unsafe {
        dev.d3d
            .CreateRenderTargetView(&frame.texture, desc_ptr, Some(&mut view))
            .ok()?;
    }
    view
}
