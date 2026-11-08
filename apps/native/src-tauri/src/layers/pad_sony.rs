//! Keeps the reading of PlayStation controllers out of the shell's process.
//!
//! winmm's joystick calls run Windows' old DirectInput code, and a game starting
//! changes the device list under it: on 5 Nov 2026 that ended in heap corruption
//! (0xC0000374) inside those calls, and it took the whole shell down with every
//! widget on the screen. So they live in a small process of this same program
//! (`--pad-reader`, `serve` in pad_winmm.rs): if it falls, only it falls.
//!
//! It runs only with a Sony controller connected, which the shell learns from the
//! Raw Input device list: that asks user32 and never touches DirectInput. The
//! reader prints a line when the chord changes (`1` held, `0` let go) and ends by
//! itself when its stdin closes, so it cannot outlive the shell.
#![cfg(target_os = "windows")]

use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::ffi::{GetRawInputDeviceInfoW, GetRawInputDeviceList, RawDeviceInfo, RawDeviceListItem};

/// The argument that makes this program the reader (main.rs).
pub const READER_ARG: &str = "--pad-reader";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RIM_TYPEHID: u32 = 2;
const RIDI_DEVICEINFO: u32 = 0x2000_000b;
const SONY: u32 = 0x054C;
const GENERIC_DESKTOP: u16 = 1;
const GAMEPAD: u16 = 5;
/// The first wait after the reader falls; it doubles up to `RETRY_MAX_MS`.
const RETRY_MS: u64 = 5_000;
const RETRY_MAX_MS: u64 = 300_000;
/// A reader that lasted this long was fine: the next fall starts counting again.
const STEADY_MS: u64 = 60_000;

/// When a fallen reader may start again.
#[derive(Default, Debug)]
struct Retry {
    wait_ms: u64,
    not_before: u64,
}

impl Retry {
    fn ready(&self, now: u64) -> bool {
        now >= self.not_before
    }

    /// The reader ended after `lived_ms`.
    fn fell(&mut self, now: u64, lived_ms: u64) {
        self.wait_ms = if lived_ms >= STEADY_MS || self.wait_ms == 0 {
            RETRY_MS
        } else {
            (self.wait_ms * 2).min(RETRY_MAX_MS)
        };
        self.not_before = now + self.wait_ms;
    }
}

fn is_held(line: &str) -> bool {
    line.trim() == "1"
}

fn is_sony_gamepad(info: &RawDeviceInfo) -> bool {
    info.kind == RIM_TYPEHID && info.vendor == SONY && info.usage_page == GENERIC_DESKTOP && info.usage == GAMEPAD
}

fn device_info(device: isize) -> Option<RawDeviceInfo> {
    let mut info = RawDeviceInfo { size: std::mem::size_of::<RawDeviceInfo>() as u32, ..RawDeviceInfo::default() };
    let mut size = info.size;
    // SAFETY: a valid RID_DEVICE_INFO with its size set, and that size as the capacity.
    let read = unsafe { GetRawInputDeviceInfoW(device, RIDI_DEVICEINFO, std::ptr::from_mut(&mut info).cast(), &mut size) };
    (read != u32::MAX).then_some(info)
}

/// Whether a PlayStation controller is connected, wired or over Bluetooth.
fn connected() -> bool {
    let item = std::mem::size_of::<RawDeviceListItem>() as u32;
    let mut count = 0u32;
    // SAFETY: a null list asks only for the count.
    if unsafe { GetRawInputDeviceList(std::ptr::null_mut(), &mut count, item) } == u32::MAX {
        return false;
    }
    let mut list = vec![RawDeviceListItem::default(); count as usize];
    // SAFETY: `list` holds `count` items of `item` bytes.
    let read = unsafe { GetRawInputDeviceList(list.as_mut_ptr(), &mut count, item) };
    if read == u32::MAX {
        return false;
    }
    list.iter().take(read as usize).filter_map(|d| device_info(d.device)).any(|i| is_sony_gamepad(&i))
}

/// The shell's side: starts the reader while a controller is there, holds what it says.
#[derive(Default)]
pub struct Reader {
    child: Option<Child>,
    held: Arc<AtomicBool>,
    started: u64,
    retry: Retry,
}

impl Reader {
    /// Every few seconds: start, stop or restart the reader.
    pub fn look(&mut self, now: u64) {
        self.reap(now);
        if !connected() {
            self.stop();
        } else if self.child.is_none() && self.retry.ready(now) {
            self.start(now);
        }
    }

    pub fn running(&self) -> bool {
        self.child.is_some()
    }

    pub fn held(&self) -> bool {
        self.held.load(Ordering::Relaxed)
    }

    fn start(&mut self, now: u64) {
        let Ok(exe) = std::env::current_exe() else { return };
        let spawned = Command::new(exe)
            .arg(READER_ARG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        let Ok(mut child) = spawned else {
            self.retry.fell(now, 0);
            return;
        };
        // Its own flag: a reader that fell must not write over the next one.
        let held = Arc::new(AtomicBool::new(false));
        self.held = held.clone();
        if let Some(out) = child.stdout.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    held.store(is_held(&line), Ordering::Relaxed);
                }
                held.store(false, Ordering::Relaxed);
            });
        }
        self.child = Some(child);
        self.started = now;
    }

    /// Notices a reader that ended by itself.
    fn reap(&mut self, now: u64) {
        let Some(child) = self.child.as_mut() else { return };
        if !matches!(child.try_wait(), Ok(None)) {
            self.child = None;
            self.held.store(false, Ordering::Relaxed);
            self.retry.fell(now, now.saturating_sub(self.started));
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.held.store(false, Ordering::Relaxed);
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gamepad(vendor: u32) -> RawDeviceInfo {
        RawDeviceInfo { kind: RIM_TYPEHID, vendor, usage_page: GENERIC_DESKTOP, usage: GAMEPAD, ..RawDeviceInfo::default() }
    }

    #[test]
    fn the_structs_match_user32() {
        assert_eq!(std::mem::size_of::<RawDeviceInfo>(), 32);
        assert_eq!(std::mem::size_of::<RawDeviceListItem>(), 16);
    }

    #[test]
    fn asking_for_the_devices_works_with_or_without_a_pad() {
        let _ = connected();
    }

    #[test]
    fn only_a_sony_gamepad_starts_the_reader() {
        assert!(is_sony_gamepad(&gamepad(SONY)));
        assert!(!is_sony_gamepad(&gamepad(0x045E)));
        assert!(!is_sony_gamepad(&RawDeviceInfo { usage: 6, ..gamepad(SONY) }));
        assert!(!is_sony_gamepad(&RawDeviceInfo { kind: 1, ..gamepad(SONY) }));
    }

    #[test]
    fn only_a_one_means_held() {
        assert!(is_held("1\r"));
        assert!(!is_held("0"));
        assert!(!is_held(""));
    }

    #[test]
    fn a_reader_that_keeps_falling_waits_longer_each_time() {
        let mut r = Retry::default();
        assert!(r.ready(0));
        r.fell(1_000, 100);
        assert!(!r.ready(5_999) && r.ready(6_000));
        r.fell(6_000, 100);
        assert_eq!(r.wait_ms, 10_000);
        for _ in 0..10 {
            r.fell(6_000, 100);
        }
        assert_eq!(r.wait_ms, RETRY_MAX_MS);
    }

    #[test]
    fn a_reader_that_ran_for_a_while_starts_the_count_again() {
        let mut r = Retry { wait_ms: RETRY_MAX_MS, not_before: 0 };
        r.fell(1_000, STEADY_MS);
        assert_eq!(r.wait_ms, RETRY_MS);
    }
}
