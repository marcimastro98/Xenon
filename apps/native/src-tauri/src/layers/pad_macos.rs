//! Reads the controller on macOS through Game Controller (Xbox, PlayStation,
//! MFi pads), Beta: never run on a real Mac. The framework is opened at run
//! time; `shouldMonitorBackgroundEvents` (macOS 11.3) lets the pad reach Xenon
//! while a game has the focus, without any grant. Game Controller is read on
//! the main thread: this thread only keeps time and asks for a reading.
#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_int, c_void};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::AppHandle;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, sel};

use super::pad::{self, Hold, LOOK_EVERY, READ_EVERY};

const RTLD_LAZY: c_int = 1;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
}

fn controller_class() -> Option<&'static AnyClass> {
    static LOADED: OnceLock<bool> = OnceLock::new();
    let ok = *LOADED.get_or_init(|| {
        // SAFETY: a system framework by its fixed path; never closed.
        !unsafe { dlopen(c"/System/Library/Frameworks/GameController.framework/GameController".as_ptr(), RTLD_LAZY) }
            .is_null()
    });
    ok.then(|| AnyClass::get(c"GCController")).flatten()
}

pub fn supported() -> bool {
    controller_class().is_some()
}

fn pressed(button: Option<Retained<AnyObject>>) -> bool {
    // SAFETY: a GCControllerButtonInput.
    button.is_some_and(|b| unsafe { msg_send![&*b, isPressed] })
}

/// On the main thread: (some controller connected, View + Menu down on one).
fn read(cls: &AnyClass) -> (bool, bool) {
    // SAFETY: GCController's class methods and its gamepad profile, all of
    // macOS 10.15 or later; every object may be nil and is checked.
    unsafe {
        let Some(list): Option<Retained<AnyObject>> = msg_send![cls, controllers] else { return (false, false) };
        let count: usize = msg_send![&*list, count];
        let mut down = false;
        for i in 0..count {
            let c: Option<Retained<AnyObject>> = msg_send![&*list, objectAtIndex: i];
            let Some(c) = c else { continue };
            let pad: Option<Retained<AnyObject>> = msg_send![&*c, extendedGamepad];
            let Some(pad) = pad else { continue };
            down |= pressed(msg_send![&*pad, buttonOptions]) && pressed(msg_send![&*pad, buttonMenu]);
        }
        (count > 0, down)
    }
}

/// Once, on the main thread: the pad keeps reaching Xenon in the background.
fn monitor_background(cls: &AnyClass) {
    // SAFETY: a class property of macOS 11.3, set only where it exists.
    unsafe {
        let has: Bool = msg_send![cls, respondsToSelector: sel!(setShouldMonitorBackgroundEvents:)];
        if has.as_bool() {
            let _: () = msg_send![cls, setShouldMonitorBackgroundEvents: Bool::YES];
        }
    }
}

/// One reading taken on the main thread, or None when it did not answer.
fn ask(app: &AppHandle, first: bool) -> Option<(bool, bool)> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let Some(cls) = controller_class() else { return };
        if first {
            monitor_background(cls);
        }
        let _ = tx.send(read(cls));
    })
    .ok()?;
    rx.recv_timeout(LOOK_EVERY).ok()
}

pub fn run(app: AppHandle, gen: u32) {
    let start = Instant::now();
    let mut hold = Hold::default();
    let mut first = true;
    while pad::live(gen) {
        let (any, down) = ask(&app, first).unwrap_or((false, false));
        first = false;
        if hold.step(down, start.elapsed().as_millis() as u64) {
            pad::fire(&app);
        }
        std::thread::sleep(if any { READ_EVERY } else { LOOK_EVERY });
    }
}
