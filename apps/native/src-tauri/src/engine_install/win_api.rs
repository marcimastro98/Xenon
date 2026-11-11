//! The few Win32 calls the uninstall needs, declared by hand: a message box in
//! the system's language, stopping the processes that run from a folder, and
//! one program run as administrator behind the system's own prompt.
//! No new crate: kernel32 and user32 are linked by every Windows build already.

use std::path::{Path, PathBuf};

/// isize, as layers/ffi.rs declares the same kernel32 calls: one signature each.
type Handle = isize;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const PROCESS_TERMINATE: u32 = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const MAX_PATH: usize = 260;

pub const MB_OK: u32 = 0x0000_0000;
pub const MB_YESNOCANCEL: u32 = 0x0000_0003;
pub const MB_ICONWARNING: u32 = 0x0000_0030;
pub const MB_ICONQUESTION: u32 = 0x0000_0020;
pub const MB_ICONINFORMATION: u32 = 0x0000_0040;
const MB_SETFOREGROUND: u32 = 0x0001_0000;
pub const IDYES: i32 = 6;
pub const IDNO: i32 = 7;
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
const SW_HIDE: i32 = 0;
const INFINITE: u32 = 0xFFFF_FFFF;

#[repr(C)]
struct ProcessEntry32W {
    size: u32,
    usage: u32,
    process_id: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_process_id: u32,
    pri_class_base: i32,
    flags: u32,
    exe_file: [u16; MAX_PATH],
}

#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
    fn QueryFullProcessImageNameW(process: Handle, flags: u32, name: *mut u16, size: *mut u32) -> i32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(owner: Handle, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

/// SHELLEXECUTEINFOW, the fields ShellExecuteExW reads, in its own order.
#[repr(C)]
struct ShellExecuteInfoW {
    size: u32,
    mask: u32,
    window: Handle,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: Handle,
    id_list: *mut std::ffi::c_void,
    class: *const u16,
    class_key: Handle,
    hot_key: u32,
    icon_or_monitor: Handle,
    process: Handle,
}

// The size Windows checks in `size`: 112 bytes on 64-bit, 60 on 32-bit.
const _: () = assert!(std::mem::size_of::<ShellExecuteInfoW>() == if cfg!(target_pointer_width = "64") { 112 } else { 60 });

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Handle, path: *mut *mut u16) -> i32;
}

#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(memory: *mut core::ffi::c_void);
}

#[repr(C)]
pub struct Guid(u32, u16, u16, [u8; 8]);

pub const FOLDERID_PROGRAM_FILES: Guid = Guid(0x905e_63b6, 0xc1bf, 0x494e, [0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a]);
pub const FOLDERID_PROGRAM_DATA: Guid = Guid(0x62ab_5d82, 0xfdc1, 0x4dc3, [0xa9, 0xdd, 0x07, 0x0d, 0x1d, 0x49, 0x5d, 0x97]);

/// A system folder from the known-folder API, never from an environment
/// variable: an elevated process must not let the user's environment pick
/// what it deletes.
pub fn known_folder(id: &Guid) -> Option<PathBuf> {
    let mut raw: *mut u16 = std::ptr::null_mut();
    let hr = unsafe { SHGetKnownFolderPath(id, 0, 0, &mut raw) };
    let path = (hr == 0 && !raw.is_null()).then(|| {
        let len = (0..).take_while(|&i| unsafe { *raw.add(i) } != 0).count();
        PathBuf::from(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(raw, len) }))
    });
    if !raw.is_null() {
        unsafe { CoTaskMemFree(raw.cast()) };
    }
    path.filter(|p| p.is_absolute())
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The primary language of the Windows display language (LANG_ITALIAN = 0x10…).
pub fn ui_language() -> u16 {
    unsafe { GetUserDefaultUILanguage() & 0x03ff }
}

/// A plain system message box; its buttons follow the Windows language.
pub fn message(caption: &str, text: &str, kind: u32) -> i32 {
    let (text, caption) = (wide(text), wide(caption));
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), kind | MB_SETFOREGROUND) }
}

/// Runs `program` as administrator behind the Windows consent prompt and waits
/// for it. `parameters` is the program's own command line, never a shell's.
/// False when the user declines or the program cannot start.
pub fn run_elevated(program: &Path, parameters: &str) -> bool {
    let (verb, file, parameters) = (wide("runas"), wide(&program.to_string_lossy()), wide(parameters));
    let mut info = ShellExecuteInfoW {
        size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        mask: SEE_MASK_NOCLOSEPROCESS,
        window: 0,
        verb: verb.as_ptr(),
        file: file.as_ptr(),
        parameters: parameters.as_ptr(),
        directory: std::ptr::null(),
        show: SW_HIDE,
        instance: 0,
        id_list: std::ptr::null_mut(),
        class: std::ptr::null(),
        class_key: 0,
        hot_key: 0,
        icon_or_monitor: 0,
        process: 0,
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.process == 0 {
        return false;
    }
    unsafe {
        WaitForSingleObject(info.process, INFINITE);
        CloseHandle(info.process);
    }
    true
}

fn image_path(process: Handle) -> Option<PathBuf> {
    let mut buf = [0u16; 32768];
    let mut size = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut size) };
    (ok != 0).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..size as usize])))
}

fn process_ids() -> Vec<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == 0 || snapshot == -1 {
        return Vec::new();
    }
    let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;
    let mut ids = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        ids.push(entry.process_id);
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    ids
}

/// Ends every process (but this one) whose program file `wanted` accepts, and
/// waits up to 5 s for each to be gone. Returns how many were ended. Chosen by
/// the program's own path, never by a port: only what runs from Xenon's folders.
pub fn end_processes(wanted: impl Fn(&Path) -> bool) -> usize {
    let me = std::process::id();
    let mut ended = 0;
    for id in process_ids().into_iter().filter(|&id| id != me && id != 0) {
        let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        let process = unsafe { OpenProcess(access, 0, id) };
        if process == 0 {
            continue;
        }
        if image_path(process).is_some_and(|p| wanted(&p)) && unsafe { TerminateProcess(process, 1) } != 0 {
            unsafe { WaitForSingleObject(process, 5000) };
            ended += 1;
        }
        unsafe { CloseHandle(process) };
    }
    ended
}

/// True when `path` is `root` itself or inside it, compared as Windows does
/// (case-insensitive, either slash). `C:\Xenon2` is not inside `C:\Xenon`.
pub fn is_inside(path: &Path, root: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string();
    let (path, root) = (norm(path), norm(root));
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}\\")))
}
