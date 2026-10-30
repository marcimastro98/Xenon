//! The window in front of the user and the program it belongs to. Only the
//! executable's file name leaves this module (it names the folder a capture is
//! saved in); a window title never does.

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    CreateRectRgn, DeleteObject, GetRegionData, GetWindowRgn, MonitorFromWindow, HMONITOR,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY, RGNDATA, RGNDATAHEADER,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowDisplayAffinity, GetWindowLongW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SendMessageTimeoutW,
    GWL_EXSTYLE, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_NULL, WS_EX_TRANSPARENT,
};

use crate::region::{self, Rect};

/// How long a window's thread may take to answer before it counts as frozen.
const RESPONSIVE_MS: u32 = 250;

fn class_name(h: HWND) -> String {
    let mut class = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut class) } as usize;
    String::from_utf16_lossy(&class[..n])
}

fn shown(h: HWND) -> bool {
    !unsafe { IsIconic(h) }.as_bool() && unsafe { IsWindowVisible(h) }.as_bool()
}

/// The foreground window, unless it is the desktop itself, the taskbar or minimized.
pub fn foreground() -> Option<HWND> {
    let h = unsafe { GetForegroundWindow() };
    if h.is_invalid() || !shown(h) {
        return None;
    }
    if matches!(
        class_name(h).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return None;
    }
    Some(h)
}

unsafe extern "system" fn collect(h: HWND, data: LPARAM) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<HWND>);
    list.push(h);
    BOOL(1)
}

/// True for a window the user can see and point at: shown, not cloaked (other
/// virtual desktops, suspended Store apps), not click-through and present in
/// captures (our own edge glow is neither).
fn pickable(h: HWND) -> bool {
    if !shown(h) || matches!(class_name(h).as_str(), "Progman" | "WorkerW") {
        return false;
    }
    let mut cloaked = 0u32;
    let size = std::mem::size_of::<u32>() as u32;
    if unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            size,
        )
    }
    .is_ok()
        && cloaked != 0
    {
        return false;
    }
    if unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32 & WS_EX_TRANSPARENT.0 != 0 {
        return false;
    }
    let mut affinity = 0u32;
    unsafe { GetWindowDisplayAffinity(h, &mut affinity) }.is_err() || affinity == 0
}

/// The parts of a window with a region (Xenon's widget layers are clickable
/// only on their tiles), in desktop pixels; None when it has no region.
fn region_parts(h: HWND) -> Option<Vec<Rect>> {
    let mut wr = RECT::default();
    unsafe { GetWindowRect(h, &mut wr) }.ok()?;
    let rgn = unsafe { CreateRectRgn(0, 0, 0, 0) };
    let kind = unsafe { GetWindowRgn(h, rgn) };
    // SIMPLEREGION (2) or COMPLEXREGION (3); ERROR when the window has none.
    let parts = (kind.0 >= 2).then(|| {
        let need = unsafe { GetRegionData(rgn, 0, None) } as usize;
        let mut buf = vec![0u8; need.max(std::mem::size_of::<RGNDATA>())];
        let got = unsafe { GetRegionData(rgn, need as u32, Some(buf.as_mut_ptr() as *mut RGNDATA)) }
            as usize;
        if got == 0 {
            return Vec::new();
        }
        let header = unsafe { &*(buf.as_ptr() as *const RGNDATAHEADER) };
        let rects = unsafe {
            std::slice::from_raw_parts(
                buf.as_ptr().add(header.dwSize as usize) as *const RECT,
                header.nCount as usize,
            )
        };
        let bands: Vec<Rect> = rects
            .iter()
            .map(|r| Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            })
            .collect();
        region::merge_bands(&bands)
            .into_iter()
            .map(|r| r.offset(wr.left, wr.top))
            .collect()
    });
    unsafe {
        let _ = DeleteObject(rgn.into());
    }
    parts
}

/// What the area picker can point at, top of the z-order first: every visible
/// window's frame, or each part of a window that has a region. Nothing about a
/// window but its rectangle leaves this function.
pub fn stack() -> Vec<Rect> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    let mut out = Vec::new();
    for h in all.into_iter().filter(|&h| pickable(h)) {
        match region_parts(h) {
            Some(parts) => out.extend(parts),
            None => out.extend(bounds(h).filter(|b| b.right > b.left && b.bottom > b.top)),
        }
    }
    out
}

/// False for a frozen app: capturing its window on its own stalls for seconds
/// (measured 8 s, and past the server's 15 s while a console was starting).
pub fn responsive(h: HWND) -> bool {
    let answered = unsafe {
        SendMessageTimeoutW(
            h,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            RESPONSIVE_MS,
            None,
        )
    };
    answered.0 != 0
}

/// The window's visible frame in desktop pixels, without the invisible resize borders.
pub fn bounds(h: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let size = std::mem::size_of::<RECT>() as u32;
    unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut core::ffi::c_void,
            size,
        )
    }
    .ok()?;
    Some(Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    })
}

/// The monitor under the foreground window, else the primary one.
pub fn active_monitor() -> HMONITOR {
    match foreground() {
        Some(h) => unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) },
        None => unsafe { MonitorFromWindow(HWND::default(), MONITOR_DEFAULTTOPRIMARY) },
    }
}

/// "game.exe" for the window's process; empty when it cannot be read.
pub fn exe_name(h: HWND) -> String {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    if pid == 0 {
        return String::new();
    }
    let Ok(proc) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return String::new();
    };
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
    };
    unsafe {
        let _ = CloseHandle(proc);
    }
    if ok.is_err() {
        return String::new();
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
}
