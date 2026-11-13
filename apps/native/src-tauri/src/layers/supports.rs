// What this system can draw outside the dashboard window: the scene, the drawing sheet, anchored widgets, the menu.

// On Windows every answer below is fixed, so only the other systems ask their backend.
#[cfg(target_os = "linux")]
use super::linux as backend;
#[cfg(target_os = "macos")]
use super::macos as backend;
#[cfg(not(windows))]
use super::spec::Kind;

/// Whether this OS draws the Ambient scene as wallpaper and screensaver: the
/// native caps (lib.rs `scene`) offer only what the backend accepts.
pub fn draws_scene() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Wallpaper) && backend::draws(Kind::Saver);
}

/// Whether the shell draws the "Draw on screen" sheet (draw.html): macOS and
/// Linux. Windows draws it with the capture engine instead.
pub fn draws_sheet() -> bool {
    #[cfg(windows)]
    return false;
    #[cfg(not(windows))]
    return backend::draws(Kind::Draw);
}

/// Whether a widget can follow another app's window (`anchor:` surfaces):
/// Windows, macOS and X11. Wayland gives no app the other windows' places.
pub fn draws_anchor() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Anchor);
}

/// Whether the shell draws the Xenon menu over the screen (menu.html): every
/// OS where layer windows can be drawn.
pub fn draws_menu() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Menu);
}
