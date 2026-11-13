// The thread that keeps the window on its screen through replug, reorder, sleep and wake.

use std::{thread, sync::atomic::Ordering, time::SystemTime};
use tauri::{AppHandle, Manager};
use crate::prefs::Placement;
use super::{
    DRIVER, HIDE_ON_RDP, HOME_MODE, NO_SCREEN, RAISE_TICKS_AFTER_LOSS, RDP_HIDDEN, Repin, VISIT,
    SETTLE_AFTER_WAKE, SHOW_OVERRIDE, WATCHDOG_INTERVAL, find_edge, game_mode, hide_window, slept,
    is_edge_panel, is_remote_session, kiosk_has_foreground, kiosk_off_screen, minimized,
    move_back_quietly, place_fullscreen_on, place_on_edge, place_windowed_on, raise_quietly,
    repin_action, window_is_on, pick::chosen_monitor, placement::push_display_state,
    screens::{current_of, placement_cache}, target::place_now,
    watch_notes::{lost_a_screen, note_repin, note_window_state, topology_signature},
};
#[cfg(windows)]
use super::clear_stuck_topmost;

/// Start the background watchdog. Re-pins the window to the Edge whenever it is
/// present but the window has drifted off it (display reorder, replug, resume) or
/// the display topology changes (e.g. a monitor powered off relocates the Windows
/// taskbar onto the Edge, on top of the kiosk).
///
/// Captures the `AppHandle` (Send + Sync) and looks the window up each tick, so
/// the loop stops cleanly once the window is gone.
pub fn start_watchdog(app: AppHandle) {
    crate::crash_log::spawn_supervised("xenon-display-watchdog", move || {
        // Baseline the layout on the first tick so a genuine change is detectable
        // without re-pinning once at startup for no reason.
        let mut last_topology = String::new();
        // Consecutive ticks spent chasing a window that has not landed. Reset the
        // moment it lands or the layout changes; see MAX_REPIN_ATTEMPTS.
        let mut repin_attempts: u32 = 0;
        // Wake from sleep, and the slow retry past the cap (see SLOW_REPIN_EVERY).
        let mut last_tick = SystemTime::now();
        let mut settle_until: Option<SystemTime> = None;
        let mut last_attempt: Option<SystemTime> = None;
        let mut last_slow_log: Option<SystemTime> = None;
        // Set on a change of screens: the next tick logs the window once more.
        let mut recheck_window = false;
        // Ticks left in which to raise the kiosk over windows a lost screen moved.
        let mut raise_ticks: u8 = 0;
        loop {
        thread::sleep(WATCHDOG_INTERVAL);

        // The machine slept. The displays come back one by one, and the OS has
        // probably moved the window onto whichever came back first; the layout
        // will read the same as before the sleep, so nothing else would re-arm the
        // repair. Lift the attempt cap for a while and start counting afresh.
        let now = SystemTime::now();
        if let Some(gap) = slept(last_tick, now) {
            crate::crash_log::note("display", &format!("woke after {} s: checking the window is on its screen", gap.as_secs()));
            settle_until = Some(now + SETTLE_AFTER_WAKE);
            repin_attempts = 0;
        }
        last_tick = now;
        if settle_until.map_or(false, |t| now < t) {
            repin_attempts = 0;
        }
        let since_last = last_attempt.and_then(|t| now.duration_since(t).ok());

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => break, // window destroyed → stop the watchdog
        };

        // Read the user's choice from memory, not disk — the same reason
        // HIDE_ON_RDP is mirrored. This runs every 3 seconds, forever.
        let cache = placement_cache();

        // Phone mode: this PC shows nothing, so there is nothing to re-pin and
        // nothing to reveal. Checked BEFORE the RDP branch, whose show() would
        // otherwise put a hidden window back on screen when a remote session ends.
        if cache.mode == Placement::Phone || DRIVER.load(Ordering::SeqCst) || VISIT.load(Ordering::SeqCst) {
            continue;
        }

        // A see-through window that a display change moved onto a screen the
        // other graphics card drives would go blank; this relaunches the app,
        // which pins the webview to the right card (see_through.rs). A no-op for
        // the opaque window everyone else has.
        #[cfg(windows)]
        {
            let presenting = current_of(&window).and_then(|m| m.name().cloned());
            crate::see_through::watch(&app, presenting.as_deref());
        }

        // Remote-Desktop hide (opt-in): while the user is RDP'd into this PC, keep
        // the borderless kiosk out of the way so it doesn't cover the desktop they
        // came in to use; bring it back when the session ends. Checked before the
        // HOME_MODE / Edge re-pin logic so a remote login always reveals the
        // desktop regardless of the current placement. `RDP_HIDDEN` makes this fire
        // only on the transition, not every tick.
        if HIDE_ON_RDP.load(Ordering::SeqCst) {
            if is_remote_session() {
                if !RDP_HIDDEN.swap(true, Ordering::SeqCst) {
                    hide_window(&window);
                }
                continue; // stay hidden — don't re-pin while the session is remote
            } else if RDP_HIDDEN.swap(false, Ordering::SeqCst) {
                // Back at the console. `place_now` shows the window itself, and
                // only if no OTHER rule still wants it hidden.
                place_now(&window); // back at the console — restore the kiosk
            }
        } else if RDP_HIDDEN.swap(false, Ordering::SeqCst) {
            // Toggled off while hidden (rare) — reveal it again.
            place_now(&window);
        }

        // The user deliberately dropped to the home-bar strip — don't fight it
        // (and leave the round button's always-on-top alone; that one is wanted).
        if HOME_MODE.load(Ordering::SeqCst) {
            continue;
        }

        // Outside home mode the kiosk must never be pinned above other windows.
        #[cfg(windows)]
        clear_stuck_topmost(&window);

        // Computed once per tick, for whichever branch runs. The ASSIGNMENT stays
        // below the HOME_MODE and RDP `continue`s on purpose: while either holds
        // the window, the baseline is deliberately left stale so that returning
        // re-pins exactly once.
        let topology = topology_signature(&window);
        // An empty signature means monitors couldn't be read this tick — treat it
        // as "unknown", not a change, and keep the previous baseline so the next
        // valid read still compares against real data.
        let topology_changed =
            !last_topology.is_empty() && !topology.is_empty() && topology != last_topology;
        // Windows may still be moving the lost screen's windows when this tick runs,
        // so the kiosk is raised again on the next one (see `raise_quietly`).
        if lost_a_screen(&last_topology, &topology) {
            raise_ticks = RAISE_TICKS_AFTER_LOSS;
        }
        let raise_now = raise_ticks > 0 && !game_mode();
        raise_ticks = raise_ticks.saturating_sub(1);
        if !topology.is_empty() {
            last_topology = topology.clone();
        }
        if recheck_window {
            recheck_window = false;
            note_window_state(&window, "3 s after the screens changed", false);
        }
        if topology_changed {
            // The list the dashboard's screen picker is showing just went stale.
            push_display_state(&app);
            // Not in a game: a game flipping resolution would fill the log, which
            // keeps only its last 64 KB.
            if !game_mode() {
                note_window_state(&window, "the screens changed", true);
                recheck_window = true;
            }
        }

        // The screen the user NAMED. Structurally the Edge branch below, with the
        // target swapped — including both of its guards, which have nothing to do
        // with the Edge and everything to do with re-placing at a bad moment.
        if cache.mode == Placement::Screen {
            match chosen_monitor(&window, &cache) {
                None => {
                    if !NO_SCREEN.swap(true, Ordering::SeqCst)
                        && !SHOW_OVERRIDE.load(Ordering::SeqCst)
                    {
                        hide_window(&window);
                        push_display_state(&app);
                    }
                }
                Some(target) => {
                    if NO_SCREEN.swap(false, Ordering::SeqCst) {
                        // The chosen screen is back. Reveal and re-place once.
                        crate::crash_log::note("display", "the chosen screen is connected again: showing the window on it");
                        place_now(&window);
                        push_display_state(&app);
                        repin_attempts = 0;
                        continue;
                    }
                    // Only the kiosk and full-screen targets chase a window that has
                    // drifted; the windowed one re-places on a topology change only
                    // (see below). So only those two feed the attempt counter.
                    let chases = is_edge_panel(&target) || cache.fullscreen;
                    // Full screen on a chosen screen has a taskbar button, so
                    // minimizing it is the user's to do and to undo.
                    let gone = is_edge_panel(&target) && minimized(&window);
                    let drifted = chases && kiosk_off_screen(window_is_on(&window, &target), gone);
                    if !drifted || topology_changed {
                        repin_attempts = 0;
                    }
                    match repin_action(game_mode(), drifted, topology_changed, repin_attempts, since_last) {
                        Repin::Nothing => {}
                        Repin::Quiet => {
                            // `drifted` is only ever true for the kiosk and
                            // full-screen targets, which both own the whole screen.
                            repin_attempts += 1;
                            last_attempt = Some(now);
                            move_back_quietly(&window, &target);
                        }
                        Repin::Full => {
                            if drifted {
                                note_repin(&window, &target, repin_attempts, now, &mut last_slow_log);
                                repin_attempts = repin_attempts.saturating_add(1);
                                last_attempt = Some(now);
                            }
                            let focus = kiosk_has_foreground(&window);
                            if is_edge_panel(&target) {
                                place_on_edge(&window, &target, focus);
                            } else if cache.fullscreen {
                                place_fullscreen_on(&window, &target, true);
                            } else if topology_changed {
                                // Windowed: only re-place on a real topology change.
                                // Chasing `window_is_on` here would drag the window
                                // back every time the user moved it themselves.
                                place_windowed_on(&window, &target, true);
                            }
                        }
                    }
                    // The kiosk only: a full-screen or windowed Xenon has a taskbar
                    // button and sits among the other windows like any of them.
                    if raise_now && is_edge_panel(&target) {
                        raise_quietly(&window);
                    }
                }
            }
            continue;
        }

        // Auto hid the window because no screen could be read when it was first
        // placed, early at login typically. Nothing below would show it again:
        // the Edge branch only moves it, so Xenon sat in the tray, running and
        // invisible, which reads as "it did not start". Place it the way a launch
        // would, as soon as a screen can be read; until then this is a no-op.
        if NO_SCREEN.load(Ordering::SeqCst) {
            place_now(&window);
            if !NO_SCREEN.load(Ordering::SeqCst) {
                crate::crash_log::note("display", "the screens can be read again: showing the window");
                push_display_state(&app);
                repin_attempts = 0;
            }
            continue;
        }

        if let Some(edge) = find_edge(&window) {
            // Re-pin when the window drifted off the Edge OR the display topology
            // changed. The latter covers "monitor turned off": the window itself
            // hasn't moved, but Windows relocated the taskbar onto the Edge above
            // the kiosk — re-asserting fullscreen (place_on_edge drops and re-enters
            // it) puts the borderless window back over the taskbar. Only fires on a
            // real change (not the first tick), so there's no idle-time flicker.
            //
            // While a game is running, a topology change is almost always the game
            // itself switching the desktop resolution for exclusive full-screen.
            // Re-pinning here calls set_focus() (see place_on_edge), which yanks the
            // foreground off the game; the game re-enters full-screen, flips the
            // resolution again, and the two bounce until Xenon is force-quit — the
            // "screen goes back and forth between Xenon and the game on launch"
            // report, seen only with resolution-CHANGING exclusive-fullscreen games
            // plus an Edge attached (a game at native resolution never moves the
            // signature, which is why it is rare). Hold the re-pin off while gaming:
            // focus_guard keeps the game foreground, and the watchdog re-pins once
            // the game exits. last_topology stays current (updated above), so the
            // resolution reverting on exit is not itself seen as a change to chase.
            // What stays allowed mid-game is bringing back a window that has left
            // the Edge, by a move that activates nothing (see `repin_action`).
            let drifted = kiosk_off_screen(window_is_on(&window, &edge), minimized(&window));
            if !drifted || topology_changed {
                repin_attempts = 0;
            }
            match repin_action(game_mode(), drifted, topology_changed, repin_attempts, since_last) {
                Repin::Nothing => {}
                Repin::Quiet => {
                    repin_attempts += 1;
                    last_attempt = Some(now);
                    move_back_quietly(&window, &edge);
                }
                Repin::Full => {
                    if drifted {
                        note_repin(&window, &edge, repin_attempts, now, &mut last_slow_log);
                        repin_attempts = repin_attempts.saturating_add(1);
                        last_attempt = Some(now);
                    }
                    // Re-place, but only re-raise if the kiosk already had the
                    // foreground — see `place_on_edge`. A window the user moved onto
                    // the Edge must stay in front of the dashboard.
                    let focus = kiosk_has_foreground(&window);
                    place_on_edge(&window, &edge, focus);
                }
            }
            if raise_now {
                raise_quietly(&window);
            }
        } else {
            // Off the Edge: keep the baseline current so returning to it re-pins once.
            // Same guard as above — a failed enumeration must not wipe the baseline.
            let topology = topology_signature(&window);
            if !topology.is_empty() {
                last_topology = topology;
            }
        }
        }
    });
}
