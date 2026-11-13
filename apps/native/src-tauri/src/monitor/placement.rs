// Applies a change of screen or of fullscreen that the user made in the dashboard or the tray.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use crate::prefs;
use crate::prefs::Placement;
use super::{display_state, NO_SCREEN, SHOW_OVERRIDE};
use super::ids::{fingerprint, id_of, monitor_by_id};
use super::screens::{placement_cache, set_placement_cache};
use super::target::{place_now, resolve, Target};

/// Tray/Settings action: switch between full-screen and windowed, and remember it.
///
/// A no-op only when the effective target is the Edge PANEL — that one is always
/// borderless-fullscreen, so the toggle has nothing to say. It used to bail
/// whenever an Edge existed anywhere, which meant F11 and the tray checkbox did
/// nothing on a PC that had an Edge attached but whose owner had chosen another
/// screen.
pub fn set_fullscreen_pref(app: &AppHandle, on: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let cache = placement_cache();
    if matches!(resolve(&window, &cache), Target::Kiosk(_) | Target::Nothing(_)) {
        return;
    }
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        p.fullscreen = on;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    place_now(&window);
    push_display_state(app);
}

/// Tray/Settings action: put the window on this monitor, by display id.
///
/// Picking a display IS the explicit choice, so it also switches the mode to
/// `Screen` — and there is no longer an "a Xeneon Edge is attached, so no"
/// early-return: refusing the pick was exactly the behaviour this replaces.
pub fn move_to_named_monitor(app: &AppHandle, name: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    // An id we did not just read from the OS is not an id. Resolving before
    // writing is what stops any caller from putting an arbitrary string into
    // display.json and leaving the window unplaceable at the next launch.
    let Some(monitor) = monitor_by_id(&window, name) else { return };
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        // The id, not the raw OS name: an unnamed output would otherwise save a
        // `null` monitor and lean entirely on the fingerprint fallback, and a
        // name shared with another screen would save an ambiguity.
        p.monitor = id_of(&window, &monitor).or_else(|| monitor.name().cloned());
        p.monitor_fingerprint = Some(fingerprint(&monitor));
        p.placement = Placement::Screen;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    SHOW_OVERRIDE.store(false, Ordering::SeqCst);
    place_now(&window);
    // Picking a screen can be the way OUT of phone mode — most obviously from
    // the tray, where it is the only control that does it. Without this the
    // window would come back now and be gone again at the next login, which is
    // the kind of half-applied setting this whole feature exists to remove.
    crate::sync_autostart(app);
    push_display_state(app);
}

/// Set the placement mode without naming a screen: "automatic" or "my phone".
///
/// `apply_now` only means anything for `Phone`, and it is the difference between
/// recording the choice and acting on it in this session. See the note below.
pub fn set_placement(app: &AppHandle, mode: Placement, apply_now: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    let mut snapshot = prefs::DisplayPrefs::default();
    prefs::update(app, |p| {
        p.placement = mode;
        snapshot = p.clone();
    });
    set_placement_cache(&snapshot);
    // A deliberate mode change ends any "show it anyway" the tray granted.
    SHOW_OVERRIDE.store(false, Ordering::SeqCst);
    if mode == Placement::Phone {
        // Recorded, NOT applied to the window that is open right now — unless the
        // caller says otherwise.
        //
        // "Nothing on this PC" is about STARTUP: it is what stops the kiosk
        // reappearing at every login once the dashboard lives on a phone. Doing
        // it the instant the choice is made takes the screen away mid-sentence —
        // the user picks "my phone", and the window carrying the pairing QR, the
        // Settings panel and the confirmation all vanish at once. So the current
        // session keeps its window, the login entry goes (see sync_autostart
        // below in the caller), and the next launch opens hidden.
        //
        // `apply_now` is the one place that is not true: the last step of the
        // phone guide, pressed with a paired device already showing the
        // dashboard, where "hide it from this PC" is the whole of what the
        // button says it does. `place_now` hides it (see apply_target's
        // Target::Nothing(NoScreen::Phone) arm); SHOW_OVERRIDE was cleared above,
        // so the tray's "Show Xenon" is still the way back.
        NO_SCREEN.store(false, Ordering::SeqCst);
        if apply_now {
            place_now(&window);
        }
    } else {
        place_now(&window);
    }
    crate::sync_autostart(app);
    push_display_state(app);
}

/// Push the current display state into the dashboard page. Best-effort: the page
/// may not be loaded yet, and the next push will carry the same state anyway.
pub fn push_display_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = display_state(&window);
    let _ = window.eval(&crate::display_state_js(&state));
}
