//! Toggle Windows' touch **edge swipes** for the duration of the kiosk session.
//!
//! On a touchscreen, a swipe in from the bottom edge is claimed by the Windows
//! shell to reveal the taskbar — so it never reaches our webview, and the kiosk's
//! own "swipe up to the desktop" gesture only works with a mouse. Setting the
//! `AllowEdgeSwipe` policy to 0 stops the shell from intercepting edge swipes, so
//! the gesture reaches the dashboard.
//!
//! We write it under HKCU (no elevation needed), apply it while the kiosk runs and
//! remove it again on a clean exit, so a normal desktop keeps its edge swipes the
//! moment the kiosk is closed. A crash simply leaves the policy in place until the
//! next launch re-applies (and the next clean exit) reconciles it — never a hard
//! failure. The shell reads this policy at sign-in, so the very first time it may
//! take a sign-out/in (or an Explorer restart) to take hold.

use std::os::windows::process::CommandExt;
use std::process::Command;

/// Don't flash a console window for the `reg` calls (release builds hide the
/// console, but a spawned child would otherwise pop one up).
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Per-user policy key that governs touch edge swipes.
const KEY: &str = r"HKCU\SOFTWARE\Policies\Microsoft\Windows\EdgeUI";

/// Disable Windows edge swipes so the kiosk's swipe-up-to-desktop gesture reaches
/// the webview instead of being swallowed by the taskbar reveal. Best-effort.
pub fn disable() {
    let _ = Command::new("reg")
        .args([
            "add", KEY, "/v", "AllowEdgeSwipe", "/t", "REG_DWORD", "/d", "0", "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// Restore Windows' default by removing the value we set, so edge swipes work again
/// everywhere once the kiosk exits. Best-effort — safe if the value is already gone.
pub fn restore() {
    let _ = Command::new("reg")
        .args(["delete", KEY, "/v", "AllowEdgeSwipe", "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}
