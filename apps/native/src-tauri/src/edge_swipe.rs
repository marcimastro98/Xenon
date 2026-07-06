//! Best-effort control of Windows' touch **edge swipes** for the kiosk.
//!
//! On a touchscreen, swipes that start at the screen edge are claimed by the
//! Windows shell (taskbar reveal, Start, notification centre), so they never
//! reach our webview and the kiosk's "swipe up to the desktop" gesture loses
//! the race. The only switch Windows honours is the MACHINE policy
//! `AllowEdgeSwipe = 0` under **HKLM** — the HKCU twin is silently ignored
//! (learned the hard way) — and the shell only re-reads it when Explorer
//! restarts or the user signs in again.
//!
//! HKLM needs elevation and the kiosk normally runs unelevated, so the policy
//! is **owned by the installer**: `install.ps1` writes it for native installs
//! and restarts Explorer so it applies immediately; `uninstall.ps1` removes it.
//! The calls below are a best-effort mirror for elevated runs — they fail
//! silently without admin rights — and nothing restores the policy on exit:
//! dropping it on every clean shutdown would undo the installer's work and
//! hand the gesture back to Windows on the next launch.

use std::os::windows::process::CommandExt;
use std::process::Command;

/// Don't flash a console window for the `reg` calls (release builds hide the
/// console, but a spawned child would otherwise pop one up).
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Machine policy key that governs touch edge swipes (per-user is ignored).
const KEY: &str = r"HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI";

/// Disable Windows edge swipes so the kiosk's swipe-up-to-desktop gesture reaches
/// the webview instead of being swallowed by the taskbar reveal. Best-effort:
/// succeeds only when the process is elevated (the installer is the usual owner).
pub fn disable() {
    let _ = Command::new("reg")
        .args([
            "add", KEY, "/v", "AllowEdgeSwipe", "/t", "REG_DWORD", "/d", "0", "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// Give Windows its edge swipes back by removing the policy value. Called only
/// when the user explicitly turns the gesture off in Settings — never on exit.
/// Best-effort: succeeds only when elevated (UNINSTALL.bat covers the rest).
pub fn restore() {
    let _ = Command::new("reg")
        .args(["delete", KEY, "/v", "AllowEdgeSwipe", "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}
