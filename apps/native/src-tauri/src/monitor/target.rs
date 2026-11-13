// The one place that decides where the window goes: the saved choice and the live screens in, a target out.

use std::sync::atomic::Ordering;
use tauri::{Monitor, WebviewWindow};
use crate::prefs;
use crate::prefs::Placement;
use super::{DRIVER, find_edge, hide_window, HOME_MODE, is_edge_panel, NO_SCREEN, place_fullscreen_on, place_on_edge, place_windowed_on, primary_or_first, show_for, SHOW_OVERRIDE, VISIT};
use super::driver::visit_monitor;
use super::ids::preferred_monitor;
use super::pick::chosen_monitor;
use super::screens::{current_of, placement_cache, PlacementCache};

/// What the shell should do right now, given the saved choice and the live
/// monitor list. The single source of the placement rule.
pub enum Target {
    /// Borderless kiosk owning the whole panel (the Edge treatment).
    Kiosk(Monitor),
    /// Ordinary window, or reachable full-screen, on this monitor.
    Windowed(Monitor, bool),
    /// Nothing on this PC: phone mode, or the chosen screen is unplugged.
    Nothing(NoScreen),
}

pub enum NoScreen {
    Phone,
    ChosenMissing,
}

pub(super) fn resolve(window: &WebviewWindow, cache: &PlacementCache) -> Target {
    if VISIT.load(Ordering::SeqCst) {
        return match visit_monitor(window) {
            Some(m) if is_edge_panel(&m) => Target::Kiosk(m),
            Some(m) => Target::Windowed(m, false),
            None => Target::Nothing(NoScreen::ChosenMissing),
        };
    }
    // The driver page has nothing to show, whatever the placement says.
    if DRIVER.load(Ordering::SeqCst) {
        return Target::Nothing(NoScreen::Phone);
    }
    match cache.mode {
        Placement::Phone => Target::Nothing(NoScreen::Phone),
        Placement::Screen => match chosen_monitor(window, cache) {
            // Choosing the Edge is legal and means "the Edge, deliberately" —
            // and there is no windowed Edge: that panel IS the kiosk.
            Some(m) if is_edge_panel(&m) => Target::Kiosk(m),
            Some(m) => Target::Windowed(m, cache.fullscreen),
            // No fallback to primary on purpose. Putting the kiosk on a screen
            // the user did not pick, because the one they did pick is switched
            // off, is the "Xenon is covering my desktop" complaint.
            None => Target::Nothing(NoScreen::ChosenMissing),
        },
        Placement::Auto => match find_edge(window) {
            Some(edge) => Target::Kiosk(edge),
            None => {
                let prefs = prefs::DisplayPrefs {
                    monitor: cache.monitor.clone(),
                    ..Default::default()
                };
                match preferred_monitor(window, &prefs) {
                    Some(m) => Target::Windowed(m, cache.fullscreen),
                    None => Target::Nothing(NoScreen::ChosenMissing),
                }
            }
        },
    }
}

/// Apply a resolved target to the window.
pub(super) fn apply_target(window: &WebviewWindow, target: Target, focus: bool) {
    match target {
        Target::Kiosk(m) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_for(window, focus);
            place_on_edge(window, &m, focus);
        }
        Target::Windowed(m, true) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_for(window, focus);
            place_fullscreen_on(window, &m, focus);
        }
        Target::Windowed(m, false) => {
            NO_SCREEN.store(false, Ordering::SeqCst);
            show_for(window, focus);
            place_windowed_on(window, &m, focus);
        }
        Target::Nothing(NoScreen::Phone) => {
            // SHOW_OVERRIDE is what a DELIBERATE launch sets: the user chose
            // their phone, then double-clicked Xenon anyway, and an app that
            // opens and shows nothing reads as broken.
            if !SHOW_OVERRIDE.load(Ordering::SeqCst) {
                hide_window(window);
            } else {
                // Showing it is not enough: this arm used to leave the window with
                // whatever chrome it was BUILT with, which is the kiosk's —
                // undecorated and hidden from the taskbar and Alt-Tab. A window with
                // no title bar, no taskbar button and no way to move or close it is
                // not a dashboard somebody asked to see, it is a panel stuck to the
                // desktop. Give it the same ordinary window every other non-Edge
                // placement gets. (Same repair `exit_home` already performs for this
                // mode, and safe to do here: the watchdog `continue`s on `Phone`, so
                // this runs on deliberate placements only, never every tick.)
                if let Some(m) = current_of(window)
                    .or_else(|| primary_or_first(window))
                {
                    place_windowed_on(window, &m, true);
                }
            }
        }
        Target::Nothing(NoScreen::ChosenMissing) => {
            if !NO_SCREEN.swap(true, Ordering::SeqCst) && !SHOW_OVERRIDE.load(Ordering::SeqCst) {
                hide_window(window);
            }
        }
    }
}

/// Whether the window owns a screen of its own right now: the Edge, or full
/// screen on a screen the user picked. A windowed dashboard shares its screen,
/// and the round home button or the "widgets only" driver are not the kiosk.
/// Read by show_desktop.rs, which keeps only such a window above Win+D.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn owns_its_screen(window: &WebviewWindow) -> bool {
    if HOME_MODE.load(Ordering::SeqCst) || DRIVER.load(Ordering::SeqCst) || VISIT.load(Ordering::SeqCst) {
        return false;
    }
    matches!(resolve(window, &placement_cache()), Target::Kiosk(_) | Target::Windowed(_, true))
}

/// The window is the round home button, which is meant to stay on top.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn in_home_mode() -> bool {
    HOME_MODE.load(Ordering::SeqCst)
}

/// Place the window where the user's choice says it belongs. Called at startup,
/// after every choice, and whenever the watchdog decides a repair is due.
pub fn place_now(window: &WebviewWindow) {
    let cache = placement_cache();
    apply_target(window, resolve(window, &cache), true);
}
