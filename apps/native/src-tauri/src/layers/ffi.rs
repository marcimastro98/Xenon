//! The Win32 surface the layer windows need, as raw FFI like the rest of this
//! shell (cursor_guard.rs, focus_guard.rs): no `windows` crate.
#![cfg(target_os = "windows")]

#[repr(C)]
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub l: i32,
    pub t: i32,
    pub r: i32,
    pub b: i32,
}

#[repr(C)]
pub struct WindowPos {
    pub hwnd: isize,
    pub after: isize,
    pub x: i32,
    pub y: i32,
    pub cx: i32,
    pub cy: i32,
    pub flags: u32,
}

#[repr(C)]
pub struct MonitorInfo {
    pub size: u32,
    pub monitor: Rect,
    pub work: Rect,
    pub flags: u32,
}

pub type SubProc = extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize;
pub type WinEventProc = extern "system" fn(isize, u32, isize, i32, i32, u32, u32);
pub type EnumProc = extern "system" fn(isize, isize) -> i32;
pub type WndProc = extern "system" fn(isize, u32, usize, isize) -> isize;

#[repr(C)]
pub struct WndClassEx {
    pub size: u32,
    pub style: u32,
    pub proc_: WndProc,
    pub cls_extra: i32,
    pub wnd_extra: i32,
    pub instance: isize,
    pub icon: isize,
    pub cursor: isize,
    pub background: isize,
    pub menu: *const u16,
    pub class: *const u16,
    pub icon_sm: isize,
}

#[repr(C)]
pub struct BitmapInfo {
    pub size: u32,
    pub width: i32,
    pub height: i32,
    pub planes: u16,
    pub bit_count: u16,
    pub compression: u32,
    pub size_image: u32,
    pub x_ppm: i32,
    pub y_ppm: i32,
    pub clr_used: u32,
    pub clr_important: u32,
    pub colors: [u32; 1],
}

#[repr(C)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
pub struct Size {
    pub cx: i32,
    pub cy: i32,
}

#[repr(C)]
pub struct Blend {
    pub op: u8,
    pub flags: u8,
    pub alpha: u8,
    pub format: u8,
}

pub const HWND_TOP: isize = 0;
pub const HWND_BOTTOM: isize = 1;
pub const HWND_TOPMOST: isize = -1;
pub const HWND_NOTOPMOST: isize = -2;
pub const SWP_NOSIZE: u32 = 0x0001;
pub const SWP_NOMOVE: u32 = 0x0002;
pub const SWP_NOZORDER: u32 = 0x0004;
pub const SWP_NOACTIVATE: u32 = 0x0010;
pub const SW_HIDE: i32 = 0;
pub const SW_SHOWNOACTIVATE: i32 = 4;
pub const GW_OWNER: u32 = 4;
pub const GW_HWNDPREV: u32 = 3;
pub const GWL_EXSTYLE: i32 = -20;
pub const WS_EX_NOACTIVATE: isize = 0x0800_0000;
pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const WS_POPUP: u32 = 0x8000_0000;
pub const WM_NCHITTEST: u32 = 0x0084;
pub const WM_TIMER: u32 = 0x0113;
pub const HTTRANSPARENT: isize = -1;
pub const ULW_ALPHA: u32 = 2;
pub const AC_SRC_ALPHA: u8 = 1;
pub const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
pub const WM_WINDOWPOSCHANGING: u32 = 0x0046;
pub const WM_NCDESTROY: u32 = 0x0082;
pub const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
pub const EVENT_OBJECT_DESTROY: u32 = 0x8001;
pub const EVENT_OBJECT_HIDE: u32 = 0x8003;
pub const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
pub const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;
pub const MONITOR_DEFAULTTONEAREST: u32 = 2;
pub const MDT_EFFECTIVE_DPI: u32 = 0;
pub const RGN_OR: i32 = 2;
pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
pub const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
pub const DWMWA_CLOAKED: u32 = 14;
// The animated wallpaper and the screensaver (scene.rs).
pub const GWL_STYLE: i32 = -16;
pub const WS_CHILD: isize = 0x4000_0000;
pub const WS_TOPLEVEL_BITS: isize = 0x8000_0000 | 0x00C0_0000 | 0x0004_0000; // popup, caption, thick frame
pub const WS_EX_NOREDIRECTIONBITMAP: isize = 0x0020_0000;
pub const LWA_ALPHA: u32 = 2;
pub const SM_REMOTESESSION: i32 = 0x1000;
pub const SMTO_NORMAL: u32 = 0;
pub const SYSTEM_EXECUTION_STATE: i32 = 16;
pub const ES_DISPLAY_REQUIRED: u32 = 0x2;

#[link(name = "user32")]
extern "system" {
    pub fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, f: u32) -> i32;
    pub fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    pub fn GetWindowLongPtrW(h: isize, i: i32) -> isize;
    pub fn SetWindowLongPtrW(h: isize, i: i32, v: isize) -> isize;
    pub fn EnumChildWindows(h: isize, cb: EnumProc, l: isize) -> i32;
    pub fn EnumWindows(cb: EnumProc, l: isize) -> i32;
    pub fn SetWinEventHook(a: u32, b: u32, m: isize, cb: WinEventProc, pid: u32, tid: u32, f: u32) -> isize;
    pub fn UnhookWinEvent(h: isize) -> i32;
    pub fn GetWindowThreadProcessId(h: isize, pid: *mut u32) -> u32;
    pub fn GetWindowTextW(h: isize, s: *mut u16, n: i32) -> i32;
    pub fn GetClassNameW(h: isize, s: *mut u16, n: i32) -> i32;
    pub fn IsWindow(h: isize) -> i32;
    pub fn IsWindowVisible(h: isize) -> i32;
    pub fn IsIconic(h: isize) -> i32;
    pub fn IsZoomed(h: isize) -> i32;
    pub fn GetForegroundWindow() -> isize;
    pub fn ShowWindow(h: isize, c: i32) -> i32;
    pub fn GetWindow(h: isize, c: u32) -> isize;
    pub fn MonitorFromWindow(h: isize, f: u32) -> isize;
    pub fn GetMonitorInfoW(m: isize, i: *mut MonitorInfo) -> i32;
    pub fn SetWindowRgn(h: isize, rgn: isize, redraw: i32) -> i32;
    pub fn RegisterClassExW(c: *const WndClassEx) -> u16;
    pub fn CreateWindowExW(
        ex: u32, class: *const u16, name: *const u16, style: u32,
        x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, inst: isize, param: *mut core::ffi::c_void,
    ) -> isize;
    pub fn DestroyWindow(h: isize) -> i32;
    pub fn DefWindowProcW(h: isize, m: u32, w: usize, l: isize) -> isize;
    pub fn UpdateLayeredWindow(
        h: isize, dst: isize, pos: *const Point, size: *const Size, src: isize, src_pos: *const Point,
        key: u32, blend: *const Blend, flags: u32,
    ) -> i32;
    pub fn SetTimer(h: isize, id: usize, ms: u32, proc_: isize) -> usize;
    pub fn KillTimer(h: isize, id: usize) -> i32;
    pub fn SetWindowDisplayAffinity(h: isize, affinity: u32) -> i32;
    pub fn GetDC(h: isize) -> isize;
    pub fn ReleaseDC(h: isize, dc: isize) -> i32;
    pub fn SetParent(h: isize, parent: isize) -> isize;
    pub fn GetParent(h: isize) -> isize;
    pub fn FindWindowExW(parent: isize, after: isize, class: *const u16, name: *const u16) -> isize;
    pub fn SendMessageTimeoutW(h: isize, m: u32, w: usize, l: isize, f: u32, ms: u32, out: *mut usize) -> isize;
    pub fn MapWindowPoints(from: isize, to: isize, pts: *mut Point, n: u32) -> i32;
    pub fn SetLayeredWindowAttributes(h: isize, key: u32, alpha: u8, flags: u32) -> i32;
    pub fn GetSystemMetrics(i: i32) -> i32;
    pub fn SetForegroundWindow(h: isize) -> i32;
}

#[link(name = "powrprof")]
extern "system" {
    pub fn CallNtPowerInformation(level: i32, inp: *const core::ffi::c_void, inlen: u32, out: *mut core::ffi::c_void, outlen: u32) -> i32;
}

#[link(name = "comctl32")]
extern "system" {
    pub fn SetWindowSubclass(h: isize, p: SubProc, id: usize, d: usize) -> i32;
    pub fn RemoveWindowSubclass(h: isize, p: SubProc, id: usize) -> i32;
    pub fn DefSubclassProc(h: isize, m: u32, w: usize, l: isize) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    pub fn CreateRectRgn(l: i32, t: i32, r: i32, b: i32) -> isize;
    pub fn CombineRgn(dst: isize, a: isize, b: isize, mode: i32) -> i32;
    pub fn DeleteObject(h: isize) -> i32;
    pub fn CreateCompatibleDC(dc: isize) -> isize;
    pub fn DeleteDC(dc: isize) -> i32;
    pub fn SelectObject(dc: isize, obj: isize) -> isize;
    pub fn CreateDIBSection(
        dc: isize, info: *const BitmapInfo, usage: u32, bits: *mut *mut core::ffi::c_void, section: isize, offset: u32,
    ) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    pub fn QueryFullProcessImageNameW(h: isize, flags: u32, buf: *mut u16, len: *mut u32) -> i32;
    pub fn CloseHandle(h: isize) -> i32;
    pub fn GetCurrentProcessId() -> u32;
    pub fn GetModuleHandleW(name: *const u16) -> isize;
    pub fn GetTickCount64() -> u64;
    pub fn CreateEventW(attrs: *const core::ffi::c_void, manual: i32, initial: i32, name: *const u16) -> isize;
    pub fn SetEvent(h: isize) -> i32;
    pub fn WaitForMultipleObjects(count: u32, handles: *const isize, all: i32, ms: u32) -> u32;
    pub fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
    pub fn LoadLibraryW(name: *const u16) -> isize;
    pub fn GetProcAddress(module: isize, name: *const u8) -> *const core::ffi::c_void;
}

#[link(name = "advapi32")]
extern "system" {
    pub fn RegOpenKeyExW(key: isize, sub: *const u16, options: u32, access: u32, out: *mut isize) -> i32;
    pub fn RegQueryValueExW(
        key: isize, name: *const u16, reserved: *mut u32, kind: *mut u32, data: *mut u8, len: *mut u32,
    ) -> i32;
    pub fn RegNotifyChangeKeyValue(key: isize, subtree: i32, filter: u32, event: isize, asynchronous: i32) -> i32;
    pub fn RegCloseKey(key: isize) -> i32;
}

#[link(name = "dwmapi")]
extern "system" {
    pub fn DwmGetWindowAttribute(h: isize, attr: u32, out: *mut core::ffi::c_void, size: u32) -> i32;
}

#[link(name = "shcore")]
extern "system" {
    pub fn GetDpiForMonitor(m: isize, kind: u32, x: *mut u32, y: *mut u32) -> i32;
}

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
