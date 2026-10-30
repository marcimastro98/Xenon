//! The virtual desktop shown on Windows. Explorer keeps the current desktop's
//! id under `Explorer\VirtualDesktops` (Windows 11; under
//! `Explorer\SessionInfo\<session>\VirtualDesktops` on Windows 10) with the
//! ids of all of them, and writes it on every switch. A thread waits on the
//! registry's change notification, so between switches it costs nothing; the
//! keys are opened again after each change because Explorer creates them only
//! with the second desktop. The documented IVirtualDesktopManager says only
//! whether a given window is on the current desktop, not which one that is.
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicIsize, Ordering};
use tauri::AppHandle;

use super::desks::{self, Desk};
use super::ffi::{
    CloseHandle, CreateEventW, GetCurrentProcessId, ProcessIdToSessionId, RegCloseKey, RegNotifyChangeKeyValue,
    RegOpenKeyExW, RegQueryValueExW, SetEvent, WaitForMultipleObjects,
};

// HKEY_CURRENT_USER is the sign-extended (LONG)0x80000001.
const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
const KEY_READ: u32 = 0x20019;
const REG_NOTIFY_CHANGE_NAME: u32 = 0x1;
const REG_NOTIFY_CHANGE_LAST_SET: u32 = 0x4;
/// The wait does not end with the thread that asked (Windows 8 and later).
const REG_NOTIFY_THREAD_AGNOSTIC: u32 = 0x1000_0000;
const INFINITE: u32 = u32::MAX;
const EXPLORER: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer";
/// 64 desktops of 16 bytes: the most the server takes.
const IDS_MAX: usize = 64 * 16;

/// Wakes the watcher so it sees its generation is gone. Made once and never
/// closed: a stop may come while a watcher is ending.
static STOP: AtomicIsize = AtomicIsize::new(0);

fn stop_event() -> isize {
    let h = STOP.load(Ordering::SeqCst);
    if h != 0 {
        return h;
    }
    // SAFETY: an auto-reset event with no name; kept for the life of the app.
    let made = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
    match STOP.compare_exchange(0, made, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => made,
        Err(other) => {
            // SAFETY: our own event, lost the race: nobody else has it.
            unsafe { CloseHandle(made) };
            other
        }
    }
}

pub fn wake() {
    let h = STOP.load(Ordering::SeqCst);
    if h != 0 {
        // SAFETY: the app-long stop event.
        unsafe { SetEvent(h) };
    }
}

pub fn start(app: AppHandle, gen: u32) {
    let stop = stop_event();
    if stop == 0 {
        return;
    }
    std::thread::spawn(move || run(&app, gen, stop));
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// An open registry key, closed when dropped (which also ends its notification).
struct Key(isize);

impl Key {
    fn open(path: &str) -> Option<Key> {
        let mut h = 0;
        // SAFETY: a NUL-terminated path and a local out-handle.
        let ok = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_READ, &mut h) };
        (ok == 0 && h != 0).then_some(Key(h))
    }

    /// A binary value, up to IDS_MAX bytes (a longer one is cut there).
    fn bytes(&self, name: &str) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; IDS_MAX];
        let mut len = buf.len() as u32;
        let mut kind = 0;
        // SAFETY: a live key, a NUL-terminated name and a buffer of `len` bytes.
        let ok = unsafe {
            RegQueryValueExW(self.0, wide(name).as_ptr(), std::ptr::null_mut(), &mut kind, buf.as_mut_ptr(), &mut len)
        };
        const ERROR_MORE_DATA: i32 = 234;
        match ok {
            0 => {
                buf.truncate(len as usize);
                Some(buf)
            }
            ERROR_MORE_DATA => Some(buf),
            _ => None,
        }
    }

    /// Signal `event` on the next change under this key.
    fn notify(&self, subtree: bool, event: isize) -> bool {
        let filter = REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC;
        // SAFETY: a live key and a live event; asynchronous, so it returns now.
        unsafe { RegNotifyChangeKeyValue(self.0, subtree as i32, filter, event, 1) == 0 }
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: our own key, closed once.
        unsafe { RegCloseKey(self.0) };
    }
}

fn session_key() -> String {
    let mut session = 0;
    // SAFETY: our own process id and a local out-value.
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
    format!(r"{EXPLORER}\SessionInfo\{session}\VirtualDesktops")
}

/// The desktop shown, from Windows 11's key first, then Windows 10's.
fn read(main: Option<&Key>, session: Option<&Key>) -> Option<Desk> {
    let ids = main.and_then(|k| k.bytes("VirtualDesktopIDs")).unwrap_or_default();
    let current = main
        .and_then(|k| k.bytes("CurrentVirtualDesktop"))
        .or_else(|| session.and_then(|k| k.bytes("CurrentVirtualDesktop")))
        .unwrap_or_default();
    desks::from_ids(&current, &ids)
}

fn run(app: &AppHandle, gen: u32, stop: isize) {
    // SAFETY: an auto-reset event with no name, closed below.
    let change = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
    if change == 0 {
        return;
    }
    let session_path = session_key();
    while desks::live(gen) {
        let main = Key::open(&format!(r"{EXPLORER}\VirtualDesktops"));
        let session = Key::open(&session_path);
        // Before the second desktop the keys may not exist yet: Explorer's own
        // key says when one is created.
        let parent = Key::open(EXPLORER);
        let mut watching = false;
        if let Some(k) = &main {
            watching |= k.notify(true, change);
        }
        if let Some(k) = &session {
            watching |= k.notify(true, change);
        }
        if main.is_none() {
            if let Some(k) = &parent {
                watching |= k.notify(false, change);
            }
        }
        if let Some(d) = read(main.as_ref(), session.as_ref()) {
            desks::seen(app, gen, d);
        }
        if !watching {
            break;
        }
        let handles = [stop, change];
        // SAFETY: two live events; the keys stay open (and their
        // notifications armed) until after the wait.
        unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        drop((main, session, parent));
    }
    // SAFETY: our own event, closed once.
    unsafe { CloseHandle(change) };
}
