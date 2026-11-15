//! Windows: nothing of Xenon is drawn on the screens while Windows has them off.
//!
//! A 5.0 report: a PC (RTX 4090, both screens on DisplayPort) froze when its
//! screens woke from sleep, only while Xenon ran. The kernel dump showed the
//! display driver timing out while it waited for a flip to finish
//! (`VidSchiWaitForDrainFlipQueue`), and the freezes began the day 5.0 arrived,
//! which put windows on the main screens that present all the time: the widgets,
//! the wallpaper scene, the screensaver. Nobody sees them while the screens
//! sleep, so they are hidden then (hidden, they present nothing and their pages
//! stop), and shown again a few seconds after the screens are back, once the
//! driver has brought them up.
//!
//! The kiosk is not hidden: its timers and the widgets-only driver must keep
//! running (memory_level.rs). Its page is told instead and draws nothing (the
//! `screens-off` class) until the screens are back. That covers the same report's
//! next answer: Xenon only on the Edge, and the Edge stays lit while the main
//! screen sleeps.
//!
//! Windows tells a window through `GUID_CONSOLE_DISPLAY_STATE`, sent at once on
//! registering and on every change. The kiosk's window receives it, through a
//! subclass, so it works with or without any layer open.
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use super::ffi::*;

/// After the screens are back, the time the driver gets to bring them up before
/// anything of Xenon presents on them again. A wake shows the desktop at once;
/// the widgets following a moment later is not something anyone waits for.
const BACK_AFTER_MS: u32 = 3000;

const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_POWERSETTINGCHANGE: usize = 0x8013;
const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;
/// GUID_CONSOLE_DISPLAY_STATE {6FE69556-704A-47A0-8F24-C28D936FDA47}.
const CONSOLE_DISPLAY_STATE: Guid = Guid {
    data1: 0x6FE6_9556,
    data2: 0x704A,
    data3: 0x47A0,
    data4: [0x8F, 0x24, 0xC2, 0x8D, 0x93, 0x6F, 0xDA, 0x47],
};

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

/// POWERBROADCAST_SETTING with its one DWORD of data.
#[repr(C)]
struct Setting {
    guid: Guid,
    len: u32,
    data: u32,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterPowerSettingNotification(h: isize, guid: *const Guid, flags: u32) -> isize;
    fn UnregisterPowerSettingNotification(h: isize) -> i32;
}

static APP: OnceLock<AppHandle> = OnceLock::new();
/// What Windows said last: the screens are off.
static OFF: AtomicBool = AtomicBool::new(false);

thread_local! {
    static NOTIFY: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
    static BACK_TIMER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The screens' state from the setting's data: 0 off, 1 on, 2 dimmed (a laptop
/// panel turned down, still showing). `None` for a value Windows may add later.
pub(super) fn screens_off(data: u32) -> Option<bool> {
    match data {
        0 => Some(true),
        1 | 2 => Some(false),
        _ => None,
    }
}

/// Start listening on the kiosk's window. Once per process; best-effort: on a
/// failure the windows simply keep drawing as before, and the log says so.
pub fn watch(app: &AppHandle, hwnd: isize) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let notify = unsafe { RegisterPowerSettingNotification(hwnd, &CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE) };
    if notify == 0 {
        crate::crash_log::note("screens-off", "no display state notification");
        return;
    }
    NOTIFY.with(|n| n.set(notify));
    unsafe { SetWindowSubclass(hwnd, on_message, 7, 0) };
}

extern "system" fn on_message(h: isize, m: u32, w: usize, l: isize, _: usize, _: usize) -> isize {
    if m == WM_POWERBROADCAST && w == PBT_POWERSETTINGCHANGE && l != 0 {
        // SAFETY: Windows hands a POWERBROADCAST_SETTING for this message; the
        // GUID is checked before the data is read, and this one's data is a DWORD.
        let setting = unsafe { &*(l as *const Setting) };
        if setting.guid == CONSOLE_DISPLAY_STATE && setting.len >= 4 {
            if let Some(off) = screens_off(setting.data) {
                changed(off);
            }
        }
    }
    if m == WM_NCDESTROY {
        let notify = NOTIFY.with(|n| n.replace(0));
        if notify != 0 {
            unsafe { UnregisterPowerSettingNotification(notify) };
        }
        stop_back_timer();
        unsafe { RemoveWindowSubclass(h, on_message, 7) };
    }
    unsafe { DefSubclassProc(h, m, w, l) }
}

/// Off: hide at once. On: one timer, restarted by every "on" and dropped by an
/// "off", so a screen flickering on and off settles on the last word.
fn changed(off: bool) {
    stop_back_timer();
    if off {
        if !OFF.swap(true, Ordering::SeqCst) {
            crate::crash_log::note("screens-off", "screens off: Xenon windows hidden");
        }
        apply(true);
    } else if OFF.load(Ordering::SeqCst) {
        let id = unsafe { SetTimer(0, 0, BACK_AFTER_MS, on_back as *const () as isize) };
        BACK_TIMER.with(|t| t.set(id));
    }
}

extern "system" fn on_back(_: isize, _: u32, _: usize, _: u32) {
    stop_back_timer();
    if OFF.swap(false, Ordering::SeqCst) {
        crate::crash_log::note("screens-off", "screens on: Xenon windows back");
        apply(false);
    }
}

fn stop_back_timer() {
    let id = BACK_TIMER.with(|t| t.replace(0));
    if id != 0 {
        unsafe { KillTimer(0, id) };
    }
}

/// Queued on the UI thread rather than run inside the window procedure, so it
/// never lands inside a layer update that holds the layers' state.
fn apply(off: bool) {
    let Some(app) = APP.get() else { return };
    let _ = app.run_on_main_thread(move || super::win32::set_screens_off(off));
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(freeze_js(off));
    }
}

/// The class stops the page drawing at all (styles/global.css); the freeze
/// also holds what keys off `overlay-frozen`, such as a background video.
fn freeze_js(off: bool) -> String {
    format!(
        "try{{document.documentElement.classList.toggle('screens-off',{off});\
         if(typeof window.ambientFreeze==='function')window.ambientFreeze('screens-off',{off})}}catch(e){{}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_screens_state() {
        assert_eq!(screens_off(0), Some(true));
        assert_eq!(screens_off(1), Some(false));
        assert_eq!(screens_off(2), Some(false), "dimmed still shows");
        assert_eq!(screens_off(9), None);
    }

    #[test]
    fn the_guid_is_console_display_state() {
        let g = CONSOLE_DISPLAY_STATE;
        let text = format!(
            "{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{}",
            g.data1, g.data2, g.data3, g.data4[0], g.data4[1],
            g.data4[2..].iter().map(|b| format!("{b:02X}")).collect::<String>()
        );
        assert_eq!(text, "6FE69556-704A-47A0-8F24-C28D936FDA47");
    }

    #[test]
    fn the_kiosk_page_stops_drawing() {
        assert_eq!(
            freeze_js(true),
            "try{document.documentElement.classList.toggle('screens-off',true);\
             if(typeof window.ambientFreeze==='function')window.ambientFreeze('screens-off',true)}catch(e){}"
        );
        assert!(freeze_js(false).contains("classList.toggle('screens-off',false)"));
        assert!(freeze_js(false).contains("'screens-off',false)"));
    }
}
