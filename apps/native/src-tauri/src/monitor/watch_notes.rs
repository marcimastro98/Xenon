// What the watchdog writes to the log: screens that came and went, and the window's state.

use std::time::SystemTime;
use tauri::{Manager, Monitor, WebviewWindow};
use super::{kiosk_has_foreground, MAX_REPIN_ATTEMPTS, minimized, monitor_rect, should_log_repin};
use super::reveal::screens_text;
use super::screens::{current_of, monitors_of, on_main, primary_of};

/// A signature of the current display layout — each monitor's origin and size,
/// order-independent. Changes when a display is added/removed/repositioned or when
/// one is turned off (which can make the Edge the primary), so the watchdog can
/// tell a genuine topology change from an idle tick. Empty if monitors can't be
/// read this tick (treated as "unknown", never a change).
pub(super) fn topology_signature(window: &WebviewWindow) -> String {
    let Some(monitors) = monitors_of(window) else { return String::new() };
    let mut parts: Vec<String> = monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            format!("{},{},{}x{}", p.x, p.y, s.width, s.height)
        })
        .collect();
    parts.sort();
    // Prefix WHICH display is primary — the one Windows parks the taskbar on.
    // Powering a monitor off can hand the primary role (and thus the taskbar) to the
    // Edge; the position list alone can miss that if the remaining monitors keep
    // their coordinates, so key the primary's size + name in explicitly so such a
    // change still moves the signature and re-asserts fullscreen over the taskbar.
    let primary = primary_of(window)
        .map(|m| {
            let s = m.size();
            let name = m.name().cloned().unwrap_or_default();
            format!("{}x{}@{}", s.width, s.height, name)
        })
        .unwrap_or_default();
    format!("P:{}|{}", primary, parts.join("|"))
}

/// True when the newer signature lists fewer screens than the older one: a monitor
/// was unplugged, turned off, or taken by a KVM switch. An empty signature means the
/// screens could not be read, which is not a loss.
pub(super) fn lost_a_screen(before: &str, after: &str) -> bool {
    let count = |sig: &str| sig.split('|').skip(1).count();
    !before.is_empty() && !after.is_empty() && count(after) < count(before)
}

/// One crash-log line per re-placement of a window that was off its screen:
/// where it was, where it is going, and which attempt this is, so a report of
/// "it is still on the wrong screen" comes with what was tried. Slow retries are
/// logged sparingly (`should_log_repin`); the moment the quick attempts run out
/// is said once.
pub(super) fn note_repin(window: &WebviewWindow, target: &Monitor, attempts: u32, now: SystemTime, last_slow_log: &mut Option<SystemTime>) {
    let since = last_slow_log.and_then(|t| now.duration_since(t).ok());
    if !should_log_repin(attempts, since) {
        return;
    }
    if attempts >= MAX_REPIN_ATTEMPTS {
        *last_slow_log = Some(now);
    }
    let r = monitor_rect(target);
    let from = current_of(window)
        .map(|m| format!("{} at {},{}", m.name().map(String::as_str).unwrap_or("?"), m.position().x, m.position().y))
        .unwrap_or_else(|| "unknown screen".to_string());
    let name = target.name().map(String::as_str).unwrap_or("?");
    let state = if minimized(window) { "minimized on" } else { "on" };
    let mut line = format!(
        "re-placing the window (attempt {}): it is {} {}, its screen is {} {:.0}x{:.0} at {:.0},{:.0}",
        attempts + 1, state, from, name, r.w, r.h, r.x, r.y
    );
    if attempts + 1 == MAX_REPIN_ATTEMPTS {
        line.push_str("; last quick attempt, then once a minute");
    }
    crate::crash_log::note("display", &line);
}

/// What the window looked like, in words, for the crash log.
struct WindowState {
    rect: Option<(i32, i32, u32, u32)>,
    screen: Option<String>,
    minimized: bool,
    visible: bool,
    in_front: bool,
}

fn window_state_text(st: &WindowState) -> String {
    let yes_no = |b: bool| if b { "yes" } else { "no" };
    let at = st
        .rect
        .map(|(x, y, w, h)| format!("at {x},{y} {w}x{h}"))
        .unwrap_or_else(|| "at an unreadable place".to_string());
    format!(
        "the window is {at} on {}, minimized {}, shown {}, in front {}",
        st.screen.as_deref().unwrap_or("no screen"),
        yes_no(st.minimized),
        yes_no(st.visible),
        yes_no(st.in_front)
    )
}

/// One crash-log line about the window when the screens change, and one more on
/// the next tick, after the watchdog has had its turn. A KVM switch report said
/// the Edge showed the desktop while the main screen was away, yet the log held
/// nothing: the watchdog saw a window in place and not minimized. These lines say
/// what Windows really did to it, and whether our re-placement held.
pub(super) fn note_window_state(window: &WebviewWindow, when: &str, with_screens: bool) {
    let w = window.clone();
    let rect = on_main(window.app_handle(), move || {
        let p = w.outer_position().ok()?;
        let s = w.outer_size().ok()?;
        Some((p.x, p.y, s.width, s.height))
    })
    .flatten();
    let w = window.clone();
    let visible = on_main(window.app_handle(), move || w.is_visible().unwrap_or(false)).unwrap_or(false);
    let st = WindowState {
        rect,
        screen: current_of(window).and_then(|m| m.name().cloned()),
        minimized: minimized(window),
        visible,
        in_front: kiosk_has_foreground(window),
    };
    let mut line = format!("{when}: {}", window_state_text(&st));
    if with_screens {
        line.push_str(&format!("; screens: {}", screens_text(window)));
    }
    crate::crash_log::note("display", &line);
}

#[cfg(test)]
mod window_state_tests {
    use super::*;

    #[test]
    fn the_line_says_where_the_window_is_and_what_state_it_is_in() {
        let st = WindowState {
            rect: Some((0, 0, 2560, 720)),
            screen: Some("DISPLAY5".to_string()),
            minimized: false,
            visible: true,
            in_front: false,
        };
        assert_eq!(
            window_state_text(&st),
            "the window is at 0,0 2560x720 on DISPLAY5, minimized no, shown yes, in front no"
        );
    }

    #[test]
    fn an_unreadable_window_still_gives_a_line() {
        let st = WindowState { rect: None, screen: None, minimized: true, visible: false, in_front: false };
        assert_eq!(
            window_state_text(&st),
            "the window is at an unreadable place on no screen, minimized yes, shown no, in front no"
        );
    }
}

#[cfg(test)]
mod lost_screen_tests {
    use super::*;

    const TWO: &str = "P:3840x2160@\\\\.\\DISPLAY1|0,0,3840x2160|3840,1435,2560x720";
    const EDGE_ALONE: &str = "P:2560x720@\\\\.\\DISPLAY5|0,0,2560x720";

    #[test]
    fn a_kvm_switch_taking_the_main_screen_is_a_loss() {
        assert!(lost_a_screen(TWO, EDGE_ALONE));
    }

    #[test]
    fn a_screen_coming_back_or_moving_is_not() {
        assert!(!lost_a_screen(EDGE_ALONE, TWO));
        assert!(!lost_a_screen(TWO, "P:3840x2160@\\\\.\\DISPLAY1|0,0,3840x2160|3840,0,2560x720"));
    }

    #[test]
    fn unreadable_screens_are_not_a_loss() {
        assert!(!lost_a_screen(TWO, ""));
        assert!(!lost_a_screen("", EDGE_ALONE));
    }
}
