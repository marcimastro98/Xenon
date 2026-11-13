// The app's own login entry: kept in step with the choice made in Settings.

#[cfg(desktop)]
use crate::prefs;
#[cfg(windows)]
#[cfg(desktop)]
use crate::login_task;
// Only Windows keeps the engine's own entries in step from here.
#[cfg(windows)]
use crate::engine_install;

/// Register or remove the kiosk's own login entry to match the user's choice.
///
/// Called at startup and again whenever the placement changes, because the choice
/// is only honoured if the autostart entry follows it. Note this touches ONLY the
/// app's entry (`Xenon`); the backend has its own login mechanism on every
/// platform — the "Xenon Edge Widget" scheduled task, the
/// `com.marcimastro98.xenon.backend` LaunchAgent, `xenon-backend.service` — and
/// none of them is affected. In phone mode the backend keeps starting, hidden,
/// which is the whole point.
#[cfg(desktop)]
pub(crate) fn sync_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    // A development build leaves the login entries alone: one run from the build
    // folder would point the PC at an unoptimized shell at every sign-in.
    if cfg!(debug_assertions) {
        return;
    }
    // macOS is the exception and not a compromise: there the login item starts
    // the APP, and the app is what spawns the backend so it inherits Full Disk
    // Access (see spawn_backend_nudge). Not launching it would either leave the
    // backend down or hand it a far smaller view of the disk.
    let want = prefs::load(app).shows_on_this_pc() || cfg!(target_os = "macos");
    let manager = app.autolaunch();
    #[cfg(windows)]
    login_task::sync(want);
    #[cfg(windows)]
    engine_install::keep_one_entry();
    #[cfg(windows)]
    if !want {
        engine_install::keep_task_for_phone();
    }
    if want {
        // Idempotent, and it REWRITES the entry — which is what migrates an
        // existing registration onto the new `--autostart` argument.
        if manager.enable().is_ok() {
            #[cfg(windows)]
            quote_login_entry(app);
        }
    } else if manager.is_enabled().unwrap_or(false) {
        // Gated on is_enabled: the underlying crate's Windows `disable()` deletes
        // a registry value and returns an error when it is already absent.
        let _ = manager.disable();
    }
}

#[cfg(not(desktop))]
pub(crate) fn sync_autostart(_app: &tauri::AppHandle) {}

/// Rewrite the Windows login entry with the program path in quotes.
///
/// The autostart crate writes `C:\Users\John Smith\...\xenon-native.exe --autostart`
/// with no quotes. Under a user folder with a space in it Windows then has to
/// guess where the program name ends, and it can drop the `--autostart`
/// argument (the same bug in another Tauri app: localsend/localsend#1293), so a
/// login launch would be taken for a deliberate one. Same value name, so the
/// crate's `is_enabled` and `disable` still find it.
#[cfg(windows)]
fn quote_login_entry(app: &tauri::AppHandle) {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegSetKeyValueW(
            hkey: isize,
            sub_key: *const u16,
            value_name: *const u16,
            kind: u32,
            data: *const core::ffi::c_void,
            bytes: u32,
        ) -> i32;
    }
    // HKEY_CURRENT_USER is the sign-extended (LONG)0x80000001.
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    const REG_SZ: u32 = 1;
    let Ok(exe) = std::env::current_exe() else { return };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let sub_key = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide(&app.package_info().name);
    let data = wide(&format!("\"{}\" --autostart", exe.display()));
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            name.as_ptr(),
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    if status != 0 {
        crate::crash_log::note("autostart", &format!("could not quote the login entry (error {status})"));
    }
}
