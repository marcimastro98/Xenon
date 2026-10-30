//! Reads PlayStation controllers on Windows (DualShock 4, DualSense, DualSense
//! Edge, wired or Bluetooth). XInput only sees Xbox-style pads, so these are read
//! through the joystick API of winmm, which answers in the background too: the
//! hold works over a game. The chord is Create (Share on the DualShock 4) and
//! Options, the two small buttons beside the touchpad.
//!
//! Only Sony's vendor id is read: an Xbox-style pad also shows up here, with its
//! stick clicks where Create and Options are, and XInput already reads it.
//! winmm.dll is opened at run time like xinput. Asking an empty id costs about
//! 0.1 ms, so the 16 ids are looked at every few seconds and only Sony's read.
#![cfg(target_os = "windows")]

use std::sync::OnceLock;

use super::ffi::{GetProcAddress, LoadLibraryW};

const IDS: u32 = 16;
const JOYERR_NOERROR: u32 = 0;
const JOY_RETURNBUTTONS: u32 = 0x80;
const SONY: u16 = 0x054C;

/// JOYINFOEX: thirteen DWORDs, buttons are the ninth.
#[repr(C)]
#[derive(Default)]
struct Info {
    size: u32,
    flags: u32,
    axes: [u32; 6],
    buttons: u32,
    button_number: u32,
    pov: u32,
    reserved: [u32; 2],
}

/// JOYCAPSW: manufacturer and product id first, 728 bytes in all.
#[repr(C)]
struct Caps {
    mid: u16,
    pid: u16,
    name: [u16; 32],
    ints: [u32; 19],
    reg_key: [u16; 32],
    oem_vxd: [u16; 260],
}

type GetPosEx = unsafe extern "system" fn(id: u32, info: *mut Info) -> u32;
type GetDevCaps = unsafe extern "system" fn(id: usize, caps: *mut Caps, size: u32) -> u32;

#[derive(Clone, Copy)]
struct Api {
    pos: GetPosEx,
    caps: GetDevCaps,
}

fn api() -> Option<Api> {
    static FNS: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    let (pos, caps) = (*FNS.get_or_init(|| {
        let name: Vec<u16> = "winmm.dll".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a system DLL by name; kept loaded for the life of the app.
        let module = unsafe { LoadLibraryW(name.as_ptr()) };
        if module == 0 {
            return None;
        }
        // SAFETY: NUL-terminated export names on a loaded module.
        let pos = unsafe { GetProcAddress(module, c"joyGetPosEx".as_ptr().cast()) };
        let caps = unsafe { GetProcAddress(module, c"joyGetDevCapsW".as_ptr().cast()) };
        (!pos.is_null() && !caps.is_null()).then_some((pos as usize, caps as usize))
    }))?;
    // SAFETY: the addresses of joyGetPosEx and joyGetDevCapsW, whose signatures these are.
    Some(unsafe {
        Api {
            pos: std::mem::transmute::<usize, GetPosEx>(pos),
            caps: std::mem::transmute::<usize, GetDevCaps>(caps),
        }
    })
}

pub fn supported() -> bool {
    api().is_some()
}

/// The buttons of a joystick id, or None when nothing is connected there.
fn read(a: Api, id: u32) -> Option<u32> {
    let mut info = Info { size: std::mem::size_of::<Info>() as u32, flags: JOY_RETURNBUTTONS, ..Info::default() };
    // SAFETY: a valid JOYINFOEX with its size set.
    (unsafe { (a.pos)(id, &mut info) } == JOYERR_NOERROR).then_some(info.buttons)
}

fn vendor(a: Api, id: u32) -> Option<u16> {
    // SAFETY: JOYCAPSW is plain integers; all zero is a valid value to overwrite.
    let mut caps: Caps = unsafe { std::mem::zeroed() };
    // SAFETY: a valid out pointer with its size.
    let ok = unsafe { (a.caps)(id as usize, &mut caps, std::mem::size_of::<Caps>() as u32) } == JOYERR_NOERROR;
    ok.then_some(caps.mid)
}

/// The connected PlayStation controllers, by joystick id.
pub fn look() -> Vec<u32> {
    let Some(a) = api() else { return Vec::new() };
    (0..IDS).filter(|&id| read(a, id).is_some() && vendor(a, id) == Some(SONY)).collect()
}

/// Whether one of `ids` holds the chord; drops the ones that went away.
pub fn chord(ids: &mut Vec<u32>) -> bool {
    let Some(a) = api() else {
        ids.clear();
        return false;
    };
    let mut down = false;
    ids.retain(|&id| match read(a, id) {
        Some(b) => {
            down |= super::pad::playstation_chord(b);
            true
        }
        None => false,
    });
    down
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_structs_match_winmm() {
        assert_eq!(std::mem::size_of::<Info>(), 52);
        assert_eq!(std::mem::size_of::<Caps>(), 728);
    }
}
