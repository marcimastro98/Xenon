//! Reads the controller on Linux from its event device
//! (`/dev/input/by-id/*-event-joystick`). The desktop gives the seat's user
//! access to joysticks (udev `uaccess`), so no group or grant is needed; a
//! device that cannot be opened is skipped. Opened without blocking and
//! drained 20 times a second while one is connected; the folder is looked at
//! again every few seconds. Works the same on X11 and Wayland.
#![cfg(target_os = "linux")]

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::Instant;
use tauri::AppHandle;

use super::pad::{self, Buttons, Hold, EVENT_SIZE, LOOK_EVERY, READ_EVERY};

const BY_ID: &str = "/dev/input/by-id";
/// O_NONBLOCK on Linux (x86_64 and aarch64).
const O_NONBLOCK: i32 = 0o4000;
/// At most this many controllers are read.
const MAX_PADS: usize = 4;

struct Pad {
    path: PathBuf,
    file: File,
    buttons: Buttons,
}

fn joysticks() -> Vec<PathBuf> {
    let Ok(dir) = fs::read_dir(BY_ID) else { return Vec::new() };
    let mut out: Vec<PathBuf> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with("-event-joystick")))
        .collect();
    out.sort();
    out.truncate(MAX_PADS);
    out
}

fn open(path: PathBuf) -> Option<Pad> {
    let file = fs::OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(&path).ok()?;
    Some(Pad { path, file, buttons: Buttons::default() })
}

/// Every event waiting on the device. False when it is gone.
fn drain(p: &mut Pad) -> bool {
    let mut buf = [0u8; EVENT_SIZE * 32];
    loop {
        match p.file.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => {
                for raw in buf[..n].chunks_exact(EVENT_SIZE) {
                    if let Some((code, value)) = pad::key_event(raw) {
                        p.buttons.key(code, value);
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => return true,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
}

pub fn run(app: AppHandle, gen: u32) {
    let start = Instant::now();
    let mut hold = Hold::default();
    let mut pads: Vec<Pad> = Vec::new();
    let mut looked: Option<Instant> = None;
    while pad::live(gen) {
        if looked.map_or(true, |t| t.elapsed() >= LOOK_EVERY) {
            looked = Some(Instant::now());
            for path in joysticks() {
                if !pads.iter().any(|p| p.path == path) {
                    if let Some(p) = open(path) {
                        pads.push(p);
                    }
                }
            }
        }
        pads.retain_mut(drain);
        let down = pads.iter().any(|p| p.buttons.chord());
        if hold.step(down, start.elapsed().as_millis() as u64) {
            pad::fire(&app);
        }
        std::thread::sleep(if pads.is_empty() { LOOK_EVERY } else { READ_EVERY });
    }
}
