//! A game controller opens the Xenon menu: hold the two small buttons in the
//! middle together for a moment (View and Menu on Xbox-style pads, Back and Start
//! on older ones, Create and Options on PlayStation ones). Handhelds such as the ROG Ally or the
//! Legion Go have no keyboard at hand, and a page in the background is never
//! given controller input, so the shell reads the pad itself. Inside the menu
//! the page drives it (server/js/menu-gamepad.js).
//!
//! Watched only while the dashboard asks (`pad` in the spec: the Xenon menu can
//! be drawn and `layers.menuPad` is on). With no controller connected the
//! readers look for one every few seconds; with one they read it 20 times a
//! second. Windows: XInput (pad_win32.rs) and, for PlayStation pads, winmm
//! (pad_winmm.rs). Linux: the joystick event devices
//! (pad_linux.rs). macOS: Game Controller, Beta (pad_macos.rs).
#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long both buttons stay down before the menu opens: long enough that a
/// game's own use of View or Menu never trips it.
pub const HOLD_MS: u64 = 800;
/// Reading a connected controller.
pub const READ_EVERY: Duration = Duration::from_millis(50);
/// Looking for a controller when none is connected.
pub const LOOK_EVERY: Duration = Duration::from_secs(3);

static WANTED: AtomicBool = AtomicBool::new(false);
/// Bumped on every start and stop: a reader whose generation is gone ends.
static GEN: AtomicU32 = AtomicU32::new(0);

/// Whether this OS can read a controller (lib.rs native caps `pad`).
pub fn supported() -> bool {
    #[cfg(windows)]
    return super::pad_win32::supported();
    #[cfg(target_os = "macos")]
    return super::pad_macos::supported();
    #[cfg(target_os = "linux")]
    return true;
}

/// From `sync` (plain thread): start or stop reading.
pub fn want(app: &AppHandle, on: bool) {
    let on = on && supported();
    if WANTED.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if on {
        start(app.clone(), gen);
    }
}

#[cfg(windows)]
fn start(app: AppHandle, gen: u32) {
    std::thread::spawn(move || super::pad_win32::run(app, gen));
}
#[cfg(target_os = "linux")]
fn start(app: AppHandle, gen: u32) {
    std::thread::spawn(move || super::pad_linux::run(app, gen));
}
#[cfg(target_os = "macos")]
fn start(app: AppHandle, gen: u32) {
    std::thread::spawn(move || super::pad_macos::run(app, gen));
}

/// Whether the reader of generation `gen` should go on.
pub(super) fn live(gen: u32) -> bool {
    WANTED.load(Ordering::SeqCst) && GEN.load(Ordering::SeqCst) == gen
}

/// The chord held long enough: the menu opens the way its shortcut does.
pub(super) fn fire(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.eval(crate::tray::OPEN_MENU_JS);
}

/// The hold of View + Menu: fires once when both have been down for
/// `HOLD_MS`, and again only after they were let go.
#[derive(Default, Debug)]
pub struct Hold {
    since: Option<u64>,
    fired: bool,
}

impl Hold {
    /// `down`: both buttons pressed on some controller; `now_ms`: a monotonic clock.
    pub fn step(&mut self, down: bool, now_ms: u64) -> bool {
        if !down {
            *self = Hold::default();
            return false;
        }
        let since = *self.since.get_or_insert(now_ms);
        if self.fired || now_ms.saturating_sub(since) < HOLD_MS {
            return false;
        }
        self.fired = true;
        true
    }
}

/// XInput's button word: View is BACK (0x20), Menu is START (0x10).
#[cfg(any(test, windows))]
pub fn xinput_chord(buttons: u16) -> bool {
    buttons & 0x30 == 0x30
}

/// winmm's button bits of a PlayStation pad: Create (Share) is button 9 and
/// Options button 10, counting from 1.
#[cfg(any(test, windows))]
pub fn playstation_chord(buttons: u32) -> bool {
    buttons & 0x300 == 0x300
}

/// Linux key codes of View and Menu on a gamepad (BTN_SELECT, BTN_START).
#[cfg(any(test, target_os = "linux"))]
pub const BTN_SELECT: u16 = 0x13a;
#[cfg(any(test, target_os = "linux"))]
pub const BTN_START: u16 = 0x13b;

/// The two buttons a Linux controller has down, from its key events:
/// `(code, value)` with value 0 released, 1 pressed, 2 repeat.
#[cfg(any(test, target_os = "linux"))]
#[derive(Default, Debug, Clone, Copy)]
pub struct Buttons {
    pub view: bool,
    pub menu: bool,
}

#[cfg(any(test, target_os = "linux"))]
impl Buttons {
    pub fn key(&mut self, code: u16, value: i32) {
        let down = value != 0;
        match code {
            BTN_SELECT => self.view = down,
            BTN_START => self.menu = down,
            _ => {}
        }
    }
    pub fn chord(&self) -> bool {
        self.view && self.menu
    }
}

/// One `struct input_event` on a 64-bit Linux: a 16-byte time, then type,
/// code and value. Only key events (type 1) are returned.
#[cfg(any(test, target_os = "linux"))]
pub const EVENT_SIZE: usize = 24;
#[cfg(any(test, target_os = "linux"))]
pub fn key_event(raw: &[u8]) -> Option<(u16, i32)> {
    if raw.len() != EVENT_SIZE {
        return None;
    }
    let kind = u16::from_ne_bytes([raw[16], raw[17]]);
    let code = u16::from_ne_bytes([raw[18], raw[19]]);
    let value = i32::from_ne_bytes([raw[20], raw[21], raw[22], raw[23]]);
    (kind == 1).then_some((code, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hold_fires_once_after_the_delay_and_again_only_after_a_release() {
        let mut h = Hold::default();
        assert!(!h.step(true, 1000));
        assert!(!h.step(true, 1000 + HOLD_MS - 1));
        assert!(h.step(true, 1000 + HOLD_MS));
        assert!(!h.step(true, 5000), "held on: once is enough");
        assert!(!h.step(false, 5050));
        assert!(!h.step(true, 5100));
        assert!(h.step(true, 5100 + HOLD_MS));
    }

    #[test]
    fn a_short_press_never_fires() {
        let mut h = Hold::default();
        for t in (0..HOLD_MS).step_by(50) {
            assert!(!h.step(true, t));
        }
        assert!(!h.step(false, HOLD_MS));
        assert!(!h.step(true, HOLD_MS + 10));
    }

    #[test]
    fn xinput_needs_both_view_and_menu() {
        assert!(xinput_chord(0x0030));
        assert!(xinput_chord(0x1030), "with A also down");
        assert!(!xinput_chord(0x0020));
        assert!(!xinput_chord(0x0010));
        assert!(!xinput_chord(0));
    }

    #[test]
    fn a_playstation_pad_needs_both_create_and_options() {
        assert!(playstation_chord(0x300));
        assert!(playstation_chord(0x302), "with Cross also down");
        assert!(!playstation_chord(0x100));
        assert!(!playstation_chord(0x200));
        assert!(!playstation_chord(0xC00), "the stick clicks are not the chord");
    }

    fn event(kind: u16, code: u16, value: i32) -> Vec<u8> {
        let mut e = vec![0u8; 16];
        e.extend_from_slice(&kind.to_ne_bytes());
        e.extend_from_slice(&code.to_ne_bytes());
        e.extend_from_slice(&value.to_ne_bytes());
        e
    }

    #[test]
    fn linux_reads_key_events_and_tracks_the_two_buttons() {
        assert_eq!(key_event(&event(1, BTN_START, 1)), Some((BTN_START, 1)));
        assert_eq!(key_event(&event(3, 0, 200)), None, "an axis is not a key");
        assert_eq!(key_event(&[0u8; 10]), None);
        let mut b = Buttons::default();
        b.key(BTN_SELECT, 1);
        assert!(!b.chord());
        b.key(BTN_START, 1);
        assert!(b.chord());
        b.key(BTN_START, 2);
        assert!(b.chord(), "a repeat keeps it down");
        b.key(0x130, 1);
        b.key(BTN_SELECT, 0);
        assert!(!b.chord());
    }
}
