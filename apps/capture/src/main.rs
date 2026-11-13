//! xenon-capture: the capture engine the Xenon server starts on demand.
//! `xenon-capture serve` answers JSON lines on stdio (proto.rs) and exits by
//! itself after a minute without requests (never while recording, while the
//! replay runs, while steps are recorded or while the
//! folder dialog is open), or when stdin closes (the server went away, a
//! recording is finished first), so it never outlives what it serves.

#[cfg_attr(not(windows), allow(dead_code))]
mod audio;
#[cfg_attr(not(windows), allow(dead_code))]
mod badge;
#[cfg_attr(not(windows), allow(dead_code))]
mod bubble;
#[cfg_attr(not(windows), allow(dead_code))]
mod faststart;
#[cfg_attr(not(windows), allow(dead_code))]
mod inspect;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg_attr(not(windows), allow(dead_code))]
mod ocr_text;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod pcm;
#[cfg_attr(not(windows), allow(dead_code))]
mod pixels;
#[cfg_attr(not(windows), allow(dead_code))]
mod private_spots;
mod proto;
#[cfg_attr(not(windows), allow(dead_code))]
mod reframe;
#[cfg_attr(not(windows), allow(dead_code))]
mod region;
#[cfg_attr(not(windows), allow(dead_code))]
mod ring;
#[cfg_attr(not(windows), allow(dead_code))]
mod sketch;
#[cfg_attr(not(windows), allow(dead_code))]
mod speech;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod stack;
#[cfg_attr(not(windows), allow(dead_code))]
mod steps;
#[cfg_attr(not(windows), allow(dead_code))]
mod tonemap;
#[cfg_attr(not(windows), allow(dead_code))]
mod video;
// The macOS argv builders and parsers are pure: their tests run on every OS.
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/tools.rs"]
mod mac_tools;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/replay_plan.rs"]
mod mac_replay_plan;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/replay_pcm.rs"]
mod mac_replay_pcm;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/bubble_nv12.rs"]
mod mac_bubble_nv12;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/steps_plan.rs"]
mod mac_steps_plan;
#[cfg(all(test, not(target_os = "macos")))]
#[allow(dead_code)]
#[path = "mac/no_share_plan.rs"]
mod mac_no_share_plan;
// The same for the Linux ones.
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/tools.rs"]
mod linux_tools;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/export_plan.rs"]
mod linux_export_plan;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/cover_plan.rs"]
mod linux_cover_plan;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/inspect_plan.rs"]
mod linux_inspect_plan;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/replay_plan.rs"]
mod linux_replay_plan;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/steps_plan.rs"]
mod linux_steps_plan;
#[cfg(all(test, not(target_os = "linux")))]
#[allow(dead_code)]
#[path = "linux/portal_plan.rs"]
mod linux_portal_plan;
#[cfg(windows)]
mod win;
mod serve;

use std::time::Duration;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
use serde_json::{json, Value};

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
use proto::{Fail, Notify};

use serve::serve;

/// Idle time after which the process exits; the server starts it again on the next request.
const IDLE_EXIT: Duration = Duration::from_secs(60);

#[cfg(target_os = "linux")]
use linux::Backend;
#[cfg(target_os = "macos")]
use mac::{Backend, FEATURES};
#[cfg(windows)]
use win::Backend;

/// What this engine can do; the server offers only what is listed here.
#[cfg(windows)]
const FEATURES: &[&str] = &[
    "screenshot",
    "region",
    "window",
    "record",
    "mic",
    "sound",
    "webcam",
    "lapse",
    "replay",
    "ocr",
    "thumb",
    "trim",
    "copy_files",
    "pick_folder",
    "speech",
    "export",
    "cover",
    "inspect",
    "measure",
    "draw",
    "steps",
    "tuning",
    "badge",
];
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
const FEATURES: &[&str] = &[];

/// What this engine can do here: a fixed list on Windows and macOS; on Linux
/// it depends on the session and the tools installed (linux/mod.rs).
#[cfg(not(target_os = "linux"))]
fn features(_backend: &Backend) -> Vec<&'static str> {
    FEATURES.to_vec()
}
#[cfg(target_os = "linux")]
fn features(backend: &Backend) -> Vec<&'static str> {
    backend.features()
}

/// Any other OS has no backend: every capture says so instead of pretending.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
struct Backend;
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
impl Backend {
    fn new() -> Backend {
        Backend
    }
    fn monitors(&self) -> Value {
        json!({ "monitors": [], "supported": false })
    }
    fn screenshot(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn record_start(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn record_stop(&mut self) -> Result<Value, Fail> {
        Err(Fail::code("not_recording"))
    }
    fn replay_start(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn replay_save(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("not_running"))
    }
    fn replay_keep(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("not_running"))
    }
    fn replay_stop(&mut self) -> Result<Value, Fail> {
        Err(Fail::code("not_running"))
    }
    fn pick_folder(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn thumb(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn trim(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn export(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn export_cancel(&mut self) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn cover(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn speech(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn copy_files(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn ocr(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn inspect(&mut self, _req: &Value) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn draw(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn steps(&mut self, _req: &Value, _notify: Notify) -> Result<Value, Fail> {
        Err(Fail::code("unsupported"))
    }
    fn busy(&self) -> bool {
        false
    }
    fn shutdown(&mut self) {}
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("serve") => serve(),
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("usage: xenon-capture serve");
            std::process::exit(2);
        }
    }
}
