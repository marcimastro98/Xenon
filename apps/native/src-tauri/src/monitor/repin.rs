// Decides what the watchdog does when the window is found away from its screen, and moves it back without stealing focus.

use std::time::{Duration, SystemTime};
use tauri::{Monitor, WebviewWindow};
use super::{MAX_REPIN_ATTEMPTS, SLEEP_GAP, SLOW_REPIN_EVERY, SLOW_REPIN_LOG_EVERY};
#[cfg(test)]
use super::edge::kiosk_off_screen;
#[cfg(windows)]
use super::edge::restore_quietly;

/// The length of the sleep between two ticks, or `None` when there was none (an
/// ordinary tick, or a clock that was set back, which is not a sleep).
pub(super) fn slept(prev: SystemTime, now: SystemTime) -> Option<Duration> {
    match now.duration_since(prev) {
        Ok(gap) if gap > SLEEP_GAP => Some(gap),
        _ => None,
    }
}

/// Whether a re-placement goes in the crash log: every quick attempt, and a slow
/// retry only when the last logged one is old enough.
pub(super) fn should_log_repin(attempts: u32, since_last_slow_log: Option<Duration>) -> bool {
    attempts < MAX_REPIN_ATTEMPTS || since_last_slow_log.map_or(true, |d| d >= SLOW_REPIN_LOG_EVERY)
}

/// What one watchdog tick does about a kiosk or full-screen window.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) enum Repin {
    Nothing,
    /// The whole re-placement: leave full-screen, move, re-enter, maybe focus.
    Full,
    /// Slide the window back onto its screen and nothing else (`move_back_quietly`).
    Quiet,
}

/// The one rule for re-placing a window that should own a whole screen.
///
/// Outside a game: re-place on a topology change, or while the window sits off
/// its screen, up to the attempt cap.
///
/// During a game, a topology change alone is left alone. It is almost always the
/// game switching resolution for exclusive full-screen, and a full re-place there
/// once bounced the game in and out of full-screen until Xenon was force-quit
/// (see the Edge branch of `start_watchdog`). But a window that has LEFT its
/// screen is still brought back, quietly. Windows moves windows off a display
/// whose mode changes under them, and a game turning HDR on does exactly that:
/// reported on Discord with Control Resonant in borderless full-screen, the
/// dashboard moved to the main display and stayed there, behind the game, until
/// Alt+Tab ended game mode. Turning HDR on from Windows settings moved it too,
/// and it came back a few seconds later, because nothing was being played.
///
/// `since_last` is the time since the previous attempt. Past the cap, a window
/// still off its screen gets one full attempt per `SLOW_REPIN_EVERY`, outside a
/// game only: in a game the quick, quiet attempts are all there is.
pub(super) fn repin_action(gaming: bool, drifted: bool, topology_changed: bool, attempts: u32, since_last: Option<Duration>) -> Repin {
    let quick = drifted && attempts < MAX_REPIN_ATTEMPTS;
    let slow = drifted && since_last.map_or(false, |d| d >= SLOW_REPIN_EVERY);
    if gaming {
        if quick { Repin::Quiet } else { Repin::Nothing }
    } else if topology_changed || quick || slow {
        Repin::Full
    } else {
        Repin::Nothing
    }
}

/// Put the window back over the whole of `monitor` without activating it, without
/// changing its z-order and without a full-screen transition: a single
/// `SetWindowPos` with `SWP_NOACTIVATE`. This is what makes it safe mid-game.
/// `place_on_edge` drops and re-enters full-screen and may raise the window, and
/// either can take the foreground from the game; a plain move takes nothing.
/// The window keeps its borderless kiosk chrome while it is moved, so covering
/// the screen's rectangle looks exactly like full-screen on it. When game mode
/// ends, the ordinary re-pin is free to run again.
#[cfg(windows)]
pub(super) fn move_back_quietly(window: &WebviewWindow, monitor: &Monitor) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    }
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    restore_quietly(window);
    let Ok(hwnd) = window.hwnd() else { return };
    // Physical pixels on both sides: Monitor reports them, and the process is
    // per-monitor DPI aware, which is what SetWindowPos then takes.
    let p = monitor.position();
    let s = monitor.size();
    unsafe {
        SetWindowPos(
            hwnd.0 as isize,
            0,
            p.x,
            p.y,
            s.width as i32,
            s.height as i32,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

/// Game mode only exists on Windows (see `game_mode`), so this never runs elsewhere.
#[cfg(not(windows))]
pub(super) fn move_back_quietly(_window: &WebviewWindow, _monitor: &Monitor) {}

#[cfg(test)]
mod repin_tests {
    use super::*;

    const NEVER: Option<Duration> = None;
    fn secs(n: u64) -> Option<Duration> { Some(Duration::from_secs(n)) }

    #[test]
    fn outside_a_game_a_topology_change_or_a_drift_re_places_fully() {
        assert_eq!(repin_action(false, false, true, 0, NEVER), Repin::Full);
        assert_eq!(repin_action(false, true, false, 0, NEVER), Repin::Full);
        assert_eq!(repin_action(false, false, false, 0, NEVER), Repin::Nothing);
    }

    #[test]
    fn a_game_switching_resolution_is_left_alone() {
        // The exclusive full-screen bounce: the layout changed, the window is where
        // it belongs. Nothing may run, or the game loses the foreground.
        assert_eq!(repin_action(true, false, true, 0, NEVER), Repin::Nothing);
    }

    #[test]
    fn a_window_moved_off_its_screen_mid_game_comes_back_quietly() {
        // A game turning HDR on: Windows moved the dashboard to the main display.
        assert_eq!(repin_action(true, true, true, 0, NEVER), Repin::Quiet);
        assert_eq!(repin_action(true, true, false, 2, secs(3)), Repin::Quiet);
    }

    #[test]
    fn the_attempt_cap_holds_in_and_out_of_a_game() {
        assert_eq!(repin_action(true, true, false, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Nothing);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Nothing);
        // A real layout change outside a game still re-places past the cap.
        assert_eq!(repin_action(false, true, true, MAX_REPIN_ATTEMPTS, secs(3)), Repin::Full);
    }

    #[test]
    fn past_the_cap_a_window_still_off_its_screen_is_retried_once_a_minute() {
        // The Mac after a wake: five quick attempts did not land, the layout reads
        // the same as before the sleep. It used to stay on the main screen for good.
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(59)), Repin::Nothing);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS, secs(60)), Repin::Full);
        assert_eq!(repin_action(false, true, false, MAX_REPIN_ATTEMPTS + 40, secs(600)), Repin::Full);
        // Only while it is off its screen, and never in a game.
        assert_eq!(repin_action(false, false, false, MAX_REPIN_ATTEMPTS, secs(600)), Repin::Nothing);
        assert_eq!(repin_action(true, true, false, MAX_REPIN_ATTEMPTS, secs(600)), Repin::Nothing);
    }

    #[test]
    fn a_minimized_kiosk_has_left_its_screen_even_where_its_origin_still_matches() {
        assert!(kiosk_off_screen(true, true));
        assert!(kiosk_off_screen(false, false));
        assert!(!kiosk_off_screen(true, false));
    }

    #[test]
    fn a_long_gap_between_ticks_is_a_sleep_and_a_short_one_is_not() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(slept(t0, t0 + Duration::from_secs(3)), None, "an ordinary tick");
        assert_eq!(slept(t0, t0 + SLEEP_GAP), None, "exactly the threshold is not a sleep");
        assert_eq!(slept(t0, t0 + Duration::from_secs(8 * 3600)), Some(Duration::from_secs(8 * 3600)));
        assert_eq!(slept(t0, t0 - Duration::from_secs(3600)), None, "a clock set back is not a sleep");
    }

    #[test]
    fn slow_retries_are_logged_sparingly() {
        assert!(should_log_repin(0, None));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS - 1, Some(Duration::from_secs(1))));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS, None), "the first slow retry is logged");
        assert!(!should_log_repin(MAX_REPIN_ATTEMPTS, Some(Duration::from_secs(60))));
        assert!(should_log_repin(MAX_REPIN_ATTEMPTS, Some(SLOW_REPIN_LOG_EVERY)));
    }
}
