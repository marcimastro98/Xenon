//! The folder picker: the system's own "choose a folder" dialog, so the user
//! browses to a folder instead of typing its path. It opens whole in the
//! middle of the monitor the pointer is on (the user just pressed the button
//! there), above every window, and closes by itself when it is left open. It runs on a thread of
//! its own, so screenshots and recordings go on while it is open.

use std::cell::Cell;
use std::time::Duration;

use crate::region::{centred_in, Rect};
use windows::core::{w, Result, HRESULT, HSTRING};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM,
    FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetCursorPos, GetWindow, GetWindowRect, IsWindowVisible,
    KillTimer, PostMessageW, SetForegroundWindow, SetTimer, SetWindowPos, GW_ENABLEDPOPUP,
    SWP_NOACTIVATE, SWP_NOZORDER, WM_CLOSE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// A dialog left open is closed after this long, so the engine is never held
/// by a window the user forgot about.
pub const GIVE_UP: Duration = Duration::from_secs(300);

/// How often the dialog is looked for until it is placed, and for how long.
const PLACE_EVERY_MS: u32 = 15;
const PLACE_TRIES: u32 = 200;

thread_local! {
    static OWNER: Cell<isize> = const { Cell::new(0) };
    static WORK: Cell<Rect> = const { Cell::new(Rect { left: 0, top: 0, right: 0, bottom: 0 }) };
    static PLACE_LEFT: Cell<u32> = const { Cell::new(0) };
}

pub enum Picked {
    Folder(String),
    Cancelled,
}

/// Shows the dialog and waits for the answer. Call it on a thread of its own:
/// the dialog needs a single-threaded apartment, the engine's is multi-threaded.
pub fn pick(title: &str, start: &str) -> Result<Picked> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let picked = show(title, start);
        CoUninitialize();
        picked
    }
}

unsafe fn show(title: &str, start: &str) -> Result<Picked> {
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
    let opts = dialog.GetOptions()?;
    dialog.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
    if !title.is_empty() {
        dialog.SetTitle(&HSTRING::from(title))?;
    }
    if !start.is_empty() {
        // A folder that no longer exists just opens the dialog where it likes.
        if let Ok(item) =
            SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(start), None)
        {
            let _ = dialog.SetFolder(&item);
        }
    }
    let (owner, work) = owner_window()?;
    OWNER.with(|o| o.set(owner.0 as isize));
    WORK.with(|w| w.set(work));
    PLACE_LEFT.with(|n| n.set(PLACE_TRIES));
    let _ = SetForegroundWindow(owner);
    let timer = SetTimer(None, 0, GIVE_UP.as_millis() as u32, Some(give_up));
    let placer = SetTimer(None, 0, PLACE_EVERY_MS, Some(place));
    let shown = dialog.Show(Some(owner));
    let _ = KillTimer(None, timer);
    let _ = KillTimer(None, placer);
    OWNER.with(|o| o.set(0));
    let _ = DestroyWindow(owner);
    match shown {
        Ok(()) => {}
        Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
            return Ok(Picked::Cancelled)
        }
        Err(e) => return Err(e),
    }
    let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
    let path = name.to_string();
    CoTaskMemFree(Some(name.0 as *const _));
    Ok(Picked::Folder(path?))
}

/// An invisible topmost window on the pointer's monitor, and that monitor's
/// work area. Owned by a topmost window, the dialog stays above the dashboard
/// that asked for it; where it sits is set by `place`, because the dialog
/// puts its top-left corner at its owner (or where it was last time), which
/// left its buttons below the bottom of the screen.
unsafe fn owner_window() -> Result<(HWND, Rect)> {
    let mut at = POINT::default();
    let _ = GetCursorPos(&mut at);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST), &mut info);
    let work = info.rcWork;
    let owner = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
        w!("STATIC"),
        None,
        WS_POPUP,
        (work.left + work.right) / 2,
        (work.top + work.bottom) / 2,
        0,
        0,
        None,
        None,
        None,
        None,
    )?;
    let area = Rect {
        left: work.left,
        top: work.top,
        right: work.right,
        bottom: work.bottom,
    };
    Ok((owner, area))
}

/// Runs inside the dialog's own message loop until the dialog exists, then
/// moves it whole into the middle of the work area, once.
unsafe extern "system" fn place(_: HWND, _: u32, id: usize, _: u32) {
    let left = PLACE_LEFT.with(|n| {
        let v = n.get().saturating_sub(1);
        n.set(v);
        v
    });
    let owner = HWND(OWNER.with(Cell::get) as *mut core::ffi::c_void);
    let dialog = GetWindow(owner, GW_ENABLEDPOPUP).ok();
    let mut now = RECT::default();
    // Visible first: before that the dialog still moves itself to where it was last time.
    let found =
        dialog.filter(|d| IsWindowVisible(*d).as_bool() && GetWindowRect(*d, &mut now).is_ok());
    if let Some(d) = found {
        let r = centred_in(
            now.right - now.left,
            now.bottom - now.top,
            WORK.with(Cell::get),
        );
        let flags = SWP_NOZORDER | SWP_NOACTIVATE;
        let _ = SetWindowPos(
            d,
            None,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            flags,
        );
    }
    if found.is_some() || left == 0 {
        let _ = KillTimer(None, id);
    }
}

/// Runs inside the dialog's own message loop: closing it answers as a cancel.
unsafe extern "system" fn give_up(_: HWND, _: u32, _: usize, _: u32) {
    let owner = HWND(OWNER.with(Cell::get) as *mut core::ffi::c_void);
    if let Ok(dialog) = GetWindow(owner, GW_ENABLEDPOPUP) {
        let _ = PostMessageW(Some(dialog), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
}
