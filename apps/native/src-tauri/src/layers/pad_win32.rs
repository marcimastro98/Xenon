//! Reads the controller on Windows through XInput: the Xbox-style pads,
//! including the built-in pads of the ROG Ally, Legion Go and MSI Claw. XInput
//! answers whatever window has the focus, so the hold works over a game.
//! xinput1_4 ships with Windows 8 and later; it is opened at run time. Asking an
//! empty slot is slow, so the four slots are looked at every few seconds and only
//! the connected ones read. PlayStation pads are read beside it (pad_winmm.rs).
#![cfg(target_os = "windows")]

use std::sync::OnceLock;
use tauri::AppHandle;

use super::ffi::{GetProcAddress, GetTickCount64, LoadLibraryW};
use super::pad::{self, Hold, LOOK_EVERY, READ_EVERY};
use super::pad_winmm;

const SLOTS: u32 = 4;
const ERROR_SUCCESS: u32 = 0;

/// XINPUT_STATE: a packet number, then XINPUT_GAMEPAD.
#[repr(C)]
#[derive(Default)]
struct State {
    packet: u32,
    buttons: u16,
    left_trigger: u8,
    right_trigger: u8,
    thumbs: [i16; 4],
}

type GetState = unsafe extern "system" fn(slot: u32, state: *mut State) -> u32;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn get_state() -> Option<GetState> {
    static FN: OnceLock<Option<usize>> = OnceLock::new();
    let addr = *FN.get_or_init(|| {
        for dll in ["xinput1_4.dll", "xinput9_1_0.dll"] {
            // SAFETY: a system DLL by name; kept loaded for the life of the app.
            let module = unsafe { LoadLibraryW(wide(dll).as_ptr()) };
            if module == 0 {
                continue;
            }
            // SAFETY: a NUL-terminated export name on a loaded module.
            let f = unsafe { GetProcAddress(module, c"XInputGetState".as_ptr().cast()) };
            if !f.is_null() {
                return Some(f as usize);
            }
        }
        None
    });
    // SAFETY: the address of XInputGetState, whose signature this is.
    addr.map(|a| unsafe { std::mem::transmute::<usize, GetState>(a) })
}

pub fn supported() -> bool {
    get_state().is_some() || pad_winmm::supported()
}

/// The buttons of a slot, or None when nothing is connected there.
fn read(f: GetState, slot: u32) -> Option<u16> {
    let mut s = State::default();
    // SAFETY: a valid out pointer to an XINPUT_STATE.
    (unsafe { f(slot, &mut s) } == ERROR_SUCCESS).then_some(s.buttons)
}

pub fn run(app: AppHandle, gen: u32) {
    let xinput = get_state();
    let mut hold = Hold::default();
    let mut slots: Vec<u32> = Vec::new();
    let mut sony: Vec<u32> = Vec::new();
    let mut looked: u64 = 0;
    while pad::live(gen) {
        // SAFETY: no arguments.
        let now = unsafe { GetTickCount64() };
        let none = slots.is_empty() && sony.is_empty();
        if none || now.saturating_sub(looked) >= LOOK_EVERY.as_millis() as u64 {
            slots = xinput.map_or_else(Vec::new, |f| (0..SLOTS).filter(|&s| read(f, s).is_some()).collect());
            sony = pad_winmm::look();
            looked = now;
        }
        let mut down = pad_winmm::chord(&mut sony);
        if let Some(f) = xinput {
            slots.retain(|&s| match read(f, s) {
                Some(b) => {
                    down |= pad::xinput_chord(b);
                    true
                }
                None => false,
            });
        }
        if hold.step(down, now) {
            pad::fire(&app);
        }
        std::thread::sleep(if slots.is_empty() && sony.is_empty() { LOOK_EVERY } else { READ_EVERY });
    }
}
