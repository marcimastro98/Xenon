//! Windows backend: Windows.Graphics.Capture, Direct3D 11, WIC and Media Foundation.

mod clipboard;
mod cover;
mod d3d;
mod dib;
mod draw;
mod edit;
mod export;
mod folder;
mod grab;
mod loupe;
mod monitors;
mod ocr;
mod picker;
mod png;
mod record;
mod speech;
mod steps;
mod window;
mod shots;
mod frames;
mod recording;
mod jobs;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use windows::Graphics::Capture::GraphicsCaptureAccess;
use windows::Graphics::Capture::GraphicsCaptureAccessKind;
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use crate::proto::Fail;

use frames::WindowWorker;

/// The hint line the server sends for the area picker, in the user's language.
const HINT_MAX: usize = 160;

pub struct Backend {
    device: Option<d3d::Device>,
    window_worker: Option<WindowWorker>,
    recording: Option<record::Recording>,
    replay: Option<record::replay::Replay>,
    /// Drawing on the screen, while open.
    drawing: Option<draw::Drawing>,
    /// The steps recorder, while it runs.
    steps: Option<steps::Steps>,
    borderless: bool,
    /// The folder dialog is open (one at a time).
    picking: Arc<AtomicBool>,
    /// Gallery previews and trims running now.
    edits: edit::Jobs,
}

impl Backend {
    pub fn new() -> Backend {
        unsafe {
            // Physical pixels everywhere, so a window rect matches its frame.
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        // Without this the capture draws a yellow frame round the screen for the
        // instant it runs. Windows 11 grants it to a desktop app without asking;
        // Windows 10 has no such call and keeps its border.
        let borderless =
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                .and_then(|op| op.join())
                .map(|s| s == AppCapabilityAccessStatus::Allowed)
                .unwrap_or(false);
        Backend {
            device: None,
            window_worker: None,
            recording: None,
            replay: None,
            drawing: None,
            steps: None,
            borderless,
            picking: Arc::new(AtomicBool::new(false)),
            edits: edit::Jobs::default(),
        }
    }

    fn device(&mut self) -> Result<&d3d::Device, Fail> {
        if self.device.is_none() {
            self.device = Some(d3d::create().map_err(|e| Fail::new("no_gpu", e))?);
        }
        Ok(self.device.as_ref().unwrap())
    }

    pub fn monitors(&self) -> Value {
        let list: Vec<Value> = monitors::list()
            .iter()
            .map(|m| {
                json!({
                    "index": m.index, "name": m.name, "primary": m.primary, "hdr": m.hdr,
                    "x": m.rect.left, "y": m.rect.top,
                    "width": m.rect.right - m.rect.left, "height": m.rect.bottom - m.rect.top,
                })
            })
            .collect();
        json!({
            "monitors": list, "supported": grab::supported(), "borderless": self.borderless,
            "ocr": ocr::available(),
        })
    }

    /// Recording, recording steps, drawing, the folder dialog open or a gallery job running: the engine
    /// must not exit for idleness.
    pub fn busy(&self) -> bool {
        self.recording()
            || self.replaying()
            || self.drawing()
            || self.steps_running()
            || self.picking.load(Ordering::SeqCst)
            || self.edits.load(Ordering::SeqCst) > 0
    }

    pub fn recording(&self) -> bool {
        self.recording
            .as_ref()
            .is_some_and(record::Recording::active)
    }

    /// The server went away: a recording in progress is finished properly.
    pub fn shutdown(&mut self) {
        if let Some(r) = self.recording.take() {
            r.stop();
        }
        if let Some(r) = self.replay.take() {
            r.stop();
        }
        self.drawing = None;
        self.steps = None;
    }
}

/// The monitor asked for, or the one the foreground window is on.
fn pick_monitor(
    list: &[monitors::Monitor],
    index: Option<u64>,
) -> Result<&monitors::Monitor, Fail> {
    match index {
        Some(i) => list.iter().find(|m| m.index as u64 == i),
        None => {
            let active = window::active_monitor();
            list.iter().find(|m| m.handle == active).or(list.first())
        }
    }
    .ok_or(Fail::code("no_monitor"))
}
