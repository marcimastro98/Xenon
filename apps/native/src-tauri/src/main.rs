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
    // Installed apps → Uninstall. Before the app starts: its single-instance
    // hook would hand the request to a running window instead.
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(xenon_native_lib::UNINSTALL_ARG) {
        std::process::exit(xenon_native_lib::uninstall());
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(xenon_native_lib::UNINSTALL_ELEVATED_ARG) {
        std::process::exit(xenon_native_lib::uninstall_elevated());
    }
    // CI installs the packaged engine into a throwaway folder and checks it
    // answers, without a window and without touching the login entries.
    if std::env::args().nth(1).as_deref() == Some(xenon_native_lib::ENGINE_SELFTEST_ARG) {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(xenon_native_lib::engine_selftest(&args));
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
