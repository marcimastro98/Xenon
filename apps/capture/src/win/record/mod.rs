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
mod session;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};
use windows::core::HRESULT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11RenderTargetView, D3D11_RENDER_TARGET_VIEW_DESC, D3D11_RENDER_TARGET_VIEW_DESC_0,
    D3D11_RTV_DIMENSION_TEXTURE2DARRAY, D3D11_TEX2D_ARRAY_RTV, D3D11_TEXTURE2D_DESC,
};

use super::d3d::Device;
use crate::proto::{Fail, Notify};
use crate::video;
use encoder::Frame;
use painter::{Painter, Params};
pub use sound::Wanted;
use source::Source;

use session::{failure, run};

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
