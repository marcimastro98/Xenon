// Prevent a console window from flashing up alongside the app on Windows release
// builds. Debug builds keep the console so `tauri dev` logs are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // PlayStation controllers are read by a process of this same program, before
    // anything of the app starts (layers/pad_sony.rs says why).
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(xenon_native_lib::PAD_READER_ARG) {
        xenon_native_lib::pad_reader();
        return;
    }
    // A debug build started at sign-in has nobody reading its console, and the
    // window would just sit on the desktop.
    #[cfg(all(windows, debug_assertions))]
    if std::env::args().any(|a| a == "--autostart") {
        extern "system" {
            fn FreeConsole() -> i32;
            fn SetStdHandle(id: u32, handle: *mut core::ffi::c_void) -> i32;
        }
        // The console's handles die with it, and a child that inherits a dead
        // handle fails to start: Restart closed the app and opened nothing.
        const STD_HANDLES: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
        unsafe {
            FreeConsole();
            for id in STD_HANDLES {
                SetStdHandle(id, std::ptr::null_mut());
            }
        }
    }
    xenon_native_lib::run();
}
