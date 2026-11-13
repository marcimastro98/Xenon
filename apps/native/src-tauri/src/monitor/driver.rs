// Who chooses the screen right now (the user, or a test driver), and the short visit to another screen.

use std::sync::atomic::Ordering;
use tauri::{Manager, Monitor, WebviewWindow};
use crate::prefs;
use super::{DRIVER, DRIVER_PATH, hide_window, is_edge_panel, SHOW_OVERRIDE, STARTED_BY_HAND, VISIT, VISIT_SCREEN, xenon_has_foreground};
use super::reveal::load_local;
use super::screens::{monitors_of, on_main, placement_cache, primary_of};
use super::target::{apply_target, resolve};

pub fn seed_driver(prefs: &prefs::DisplayPrefs) {
    DRIVER.store(prefs.widgets_only, Ordering::SeqCst);
}

pub fn started_by_hand() {
    STARTED_BY_HAND.store(true, Ordering::SeqCst);
}

/// True once, on the first page of a start by hand, if that page is the driver.
pub fn opened_to_nothing(on_driver: bool) -> bool {
    STARTED_BY_HAND.swap(false, Ordering::SeqCst) && on_driver
}

/// What a page load of the main window changes.
#[derive(Debug, PartialEq, Eq)]
struct DriverStep {
    /// A visit is on after this load.
    visit: bool,
    /// The window needs placing.
    place: bool,
    /// The mirror in prefs follows the page. Never for a visit.
    mirror: bool,
}

fn driver_step(was_driver: bool, on: bool, full: bool, visiting: bool) -> DriverStep {
    let visit = !on && full && (was_driver || visiting);
    // The dashboard without `full=1` during a visit: the user changed mode from it.
    let changed_mode = visiting && !on && !full;
    DriverStep {
        visit,
        place: !on && (was_driver || changed_mode),
        mirror: changed_mode || (was_driver != on && !visit && !visiting),
    }
}

/// The main window loaded a page: the driver hides the window (every time: a
/// manual launch shows the splash even when the driver was seeded). The dashboard
/// asked for with `full=1` is a visit; any other page (the user switched back)
/// gets its normal placement again. True when the window just left the driver.
pub fn set_driver(window: &WebviewWindow, on: bool, full: bool) -> bool {
    let was = DRIVER.swap(on, Ordering::SeqCst);
    let visiting = VISIT.load(Ordering::SeqCst);
    let step = driver_step(was, on, full, visiting);
    if step.visit && !visiting {
        begin_visit(window);
    } else if !step.visit {
        VISIT.store(false, Ordering::SeqCst);
    }
    if on {
        SHOW_OVERRIDE.store(false, Ordering::SeqCst);
        hide_window(window);
    } else if step.place {
        let focus = leaving_driver_takes_focus(step.visit, xenon_has_foreground(window));
        apply_target(window, resolve(window, &placement_cache()), focus);
    }
    if step.mirror {
        prefs::update(window.app_handle(), |p| p.widgets_only = on);
    }
    was && !on
}

/// A visit is someone asking to look at the dashboard. A change of mode can come
/// from a Deck key in the middle of a game: then the dashboard comes back on its
/// screen and the game keeps the keyboard. From Xenon's own menu it comes forward.
fn leaving_driver_takes_focus(visit: bool, xenon_in_front: bool) -> bool {
    visit || xenon_in_front
}

/// First choice that is not the Edge; the Edge only when nothing else is there
/// (that panel has no windowed form, see `resolve`).
fn visit_screen<T>(candidates: Vec<T>, is_edge: impl Fn(&T) -> bool) -> Option<T> {
    let mut edge = None;
    for candidate in candidates {
        if !is_edge(&candidate) {
            return Some(candidate);
        }
        edge.get_or_insert(candidate);
    }
    edge
}

/// The screen under the pointer: the one the user just pressed something on.
pub(crate) fn pointer_monitor(window: &WebviewWindow) -> Option<Monitor> {
    let w = window.clone();
    on_main(window.app_handle(), move || {
        let at = w.cursor_position().ok()?;
        w.monitor_from_point(at.x, at.y).ok().flatten()
    })
    .flatten()
}

fn begin_visit(window: &WebviewWindow) {
    let mut candidates: Vec<Monitor> = pointer_monitor(window).into_iter().chain(primary_of(window)).collect();
    candidates.extend(monitors_of(window).unwrap_or_default());
    let screen = visit_screen(candidates, is_edge_panel).and_then(|m| m.name().cloned());
    if let Ok(mut saved) = VISIT_SCREEN.lock() {
        *saved = screen;
    }
    VISIT.store(true, Ordering::SeqCst);
}

/// The screen of the visit, or the first one if it went away meanwhile.
pub(super) fn visit_monitor(window: &WebviewWindow) -> Option<Monitor> {
    let saved = VISIT_SCREEN.lock().ok().and_then(|s| s.clone());
    let all = monitors_of(window)?;
    let found = all.iter().find(|m| m.name() == saved.as_ref()).cloned();
    found.or_else(|| visit_screen(all, is_edge_panel))
}

/// Closing the dashboard during a visit: back to the driver, with no page in
/// between (the window is hidden first, and `DRIVER` keeps the watchdog from
/// placing it). The driver asks the server again, so a mode that changed still
/// wins. False when there is no visit, and the caller goes on as usual.
pub fn end_visit(window: &WebviewWindow) -> bool {
    if !VISIT.swap(false, Ordering::SeqCst) {
        return false;
    }
    DRIVER.store(true, Ordering::SeqCst);
    SHOW_OVERRIDE.store(false, Ordering::SeqCst);
    hide_window(window);
    load_local(window, DRIVER_PATH);
    true
}

#[cfg(test)]
mod visit_tests {
    use super::*;

    fn step(visit: bool, place: bool, mirror: bool) -> DriverStep {
        DriverStep { visit, place, mirror }
    }

    #[test]
    fn a_mode_change_from_a_key_leaves_the_game_in_front() {
        assert!(!leaving_driver_takes_focus(false, false));
        assert!(leaving_driver_takes_focus(false, true), "from Xenon's own menu it comes forward");
        assert!(leaving_driver_takes_focus(true, false), "a visit is asked for");
    }

    #[test]
    fn the_dashboard_asked_for_from_the_driver_is_a_visit_and_keeps_the_mode() {
        assert_eq!(driver_step(true, false, true, false), step(true, true, false));
    }

    #[test]
    fn a_start_by_hand_that_lands_on_the_driver_shows_something_once() {
        assert!(!opened_to_nothing(true), "a login start stays hidden");
        started_by_hand();
        assert!(opened_to_nothing(true));
        assert!(!opened_to_nothing(true), "going back to the driver later stays hidden");
        started_by_hand();
        assert!(!opened_to_nothing(false), "the dashboard is already there");
        assert!(!opened_to_nothing(true), "only the first page counts");
    }

    #[test]
    fn a_reload_during_a_visit_leaves_the_window_where_the_user_put_it() {
        assert_eq!(driver_step(false, false, true, true), step(true, false, false));
    }

    #[test]
    fn leaving_a_visit_for_the_driver_changes_nothing_saved() {
        assert_eq!(driver_step(true, true, false, false), step(false, false, false));
    }

    #[test]
    fn changing_mode_during_a_visit_is_a_normal_dashboard_from_then_on() {
        assert_eq!(driver_step(false, false, false, true), step(false, true, true));
    }

    #[test]
    fn without_a_visit_the_driver_works_as_before() {
        assert_eq!(driver_step(false, true, false, false), step(false, false, true));
        assert_eq!(driver_step(true, false, false, false), step(false, true, true));
        assert_eq!(driver_step(false, false, false, false), step(false, false, false));
        assert_eq!(driver_step(false, false, true, false), step(false, false, false));
    }

    #[test]
    fn a_visit_opens_on_the_screen_in_use_and_on_the_edge_only_when_alone() {
        let edge = |s: &&str| *s == "edge";
        assert_eq!(visit_screen(vec!["left", "main", "edge"], edge), Some("left"));
        assert_eq!(visit_screen(vec!["edge", "main", "edge"], edge), Some("main"));
        assert_eq!(visit_screen(vec!["edge", "edge"], edge), Some("edge"));
        assert_eq!(visit_screen(Vec::<&str>::new(), edge), None);
    }
}
