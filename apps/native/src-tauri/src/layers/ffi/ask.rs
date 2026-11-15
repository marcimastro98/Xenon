// Windows: what a window says of itself when asked: its class, title, process, frame, and the screen it is on.

use super::{CloseHandle, DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, GetClassNameW, GetDpiForMonitor, GetMonitorInfoW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, MDT_EFFECTIVE_DPI, MONITOR_DEFAULTTONEAREST, MonitorFromWindow, MonitorInfo, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, Rect};

fn utf16(buf: &[u16], n: i32) -> String {
    String::from_utf16_lossy(&buf[..n.clamp(0, buf.len() as i32) as usize])
}

pub fn class_of(h: isize) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
    utf16(&buf, n)
}

pub fn title_of(h: isize) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) };
    utf16(&buf, n)
}

pub fn pid_of(h: isize) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, &mut pid) };
    pid
}

/// The executable's file name (never the path) of the process owning `h`.
pub fn exe_of(h: isize) -> Option<String> {
    let proc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid_of(h)) };
    if proc == 0 {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(proc, 0, buf.as_mut_ptr(), &mut len) };
    unsafe { CloseHandle(proc) };
    if ok == 0 {
        return None;
    }
    let path = utf16(&buf, len as i32);
    path.rsplit('\\').next().map(str::to_string)
}

/// Hidden by the shell: on another virtual desktop, or a suspended Store app.
pub fn cloaked(h: isize) -> bool {
    let mut v = 0u32;
    let hr = unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut v as *mut u32).cast(), 4) };
    hr == 0 && v != 0
}

/// The visible frame, without the invisible resize borders GetWindowRect adds.
pub fn frame_of(h: isize) -> Rect {
    let mut r = Rect::default();
    let hr = unsafe {
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, (&mut r as *mut Rect).cast(), 16)
    };
    if hr != 0 {
        unsafe { GetWindowRect(h, &mut r) };
    }
    r
}

/// The scale of the monitor a window is on. Not `GetDpiForWindow`: a
/// DPI-unaware app reports 96 there even on a 150% screen, where the layer's
/// own page still renders at 150%.
pub fn monitor_scale_of(h: isize) -> f64 {
    let m = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
    let (mut x, mut y) = (96u32, 96u32);
    if m == 0 || unsafe { GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut x, &mut y) } != 0 {
        x = 96;
    }
    f64::from(x.max(96)) / 96.0
}

pub fn monitor_rect_of(h: isize) -> Option<Rect> {
    let m = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
    let mut info = MonitorInfo { size: std::mem::size_of::<MonitorInfo>() as u32, monitor: Rect::default(), work: Rect::default(), flags: 0 };
    (m != 0 && unsafe { GetMonitorInfoW(m, &mut info) } != 0).then_some(info.monitor)
}
