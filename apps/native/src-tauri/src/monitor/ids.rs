// A lasting name for each screen: the system's id, or a fingerprint of the panel when there is none.

use tauri::{Monitor, WebviewWindow};
use crate::prefs;
use super::primary_or_first;
use super::screens::monitors_of;

/// Prefix marking a display id that is a PLACE, not an OS name (see `display_ids`).
const FP_ID_PREFIX: &str = "fp:";

/// The id every surface uses to name a screen — the tray menu, the first-run
/// picker, Settings → Screen and `display.json` alike. Computed for the WHOLE
/// list at once, because whether a name identifies a screen is a fact about the
/// other screens, not about that one.
///
/// An OS name is used only when it is non-empty AND unique among what is attached
/// right now. Otherwise the screen is identified by its shape and its origin:
/// `fp:2560x1440@1+1920,0`.
///
/// Both halves of that rule are load-bearing, and each covers a platform:
///
///   * Linux/GTK returns `None` for an output it has no model string for. Those
///     displays used to get a `null` id, which the tray menu skipped outright and
///     the picker drew as a button that could not be pressed — listed, and
///     refusing to be chosen.
///   * macOS NEVER returns `None`: tao builds the name from the display's MODEL
///     NUMBER (`Monitor #123`), so two identical monitors — an ordinary dual-screen
///     Mac — report the same name and the same shape. Under a name-only id they
///     shared one identity: both were flagged primary, the tray offered two menu
///     items that did the same thing, and a saved choice of the second could only
///     ever resolve back to the first.
///
/// The origin is what breaks that tie: no two monitors can share one, by
/// definition. It moves when displays are rearranged, which is exactly why
/// `DisplayPrefs::monitor_fingerprint` stays SHAPE-ONLY — the two keys have to be
/// able to fail independently, or the fallback is not a fallback.
pub(super) fn display_ids(monitors: &[Monitor]) -> Vec<String> {
    let names: Vec<Option<&String>> = monitors.iter().map(|m| m.name()).collect();
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| match names[i] {
            Some(name)
                if !name.is_empty()
                    && names.iter().filter(|n| **n == Some(name)).count() == 1 =>
            {
                name.to_string()
            }
            _ => {
                let p = m.position();
                format!("{FP_ID_PREFIX}{}+{},{}", fingerprint(m), p.x, p.y)
            }
        })
        .collect()
}

/// The id of one specific monitor, computed in the context of every monitor
/// attached with it. Matched by ORIGIN, the one property no two screens share.
pub(super) fn id_of(window: &WebviewWindow, target: &Monitor) -> Option<String> {
    let monitors = monitors_of(window)?;
    let i = monitors
        .iter()
        .position(|m| m.position() == target.position())?;
    display_ids(&monitors).into_iter().nth(i)
}

/// Resolve an id from `display_ids` back to a live monitor.
///
/// Recomputed rather than parsed, so the two can never drift apart. The trailing
/// name match is for ids saved by an OLDER build (and by this one, whenever the
/// name was unique at the time): a plain OS name that has since stopped being
/// unique still finds its screen instead of falling through to "not connected".
pub(super) fn monitor_by_id(window: &WebviewWindow, id: &str) -> Option<Monitor> {
    let monitors = monitors_of(window)?;
    let i = find_by_id(&monitors, id)?;
    monitors.into_iter().nth(i)
}

/// The same lookup over a list read from anywhere — used before a window exists
/// (see `initial_window`), which is why it returns an INDEX and not a `Monitor`.
pub(super) fn find_by_id(monitors: &[Monitor], id: &str) -> Option<usize> {
    let ids = display_ids(monitors);
    ids.iter()
        .position(|candidate| candidate == id)
        .or_else(|| monitors.iter().position(|m| m.name().map(|n| n.as_str()) == Some(id)))
}

/// The monitor a saved preference points at, falling back to the primary display.
/// Used in `Auto` only, where the saved name is a *preference*; an explicit
/// choice must never silently land somewhere else (see `chosen_monitor`).
pub(super) fn preferred_monitor(window: &WebviewWindow, prefs: &prefs::DisplayPrefs) -> Option<Monitor> {
    prefs
        .monitor
        .as_deref()
        .and_then(|n| monitor_by_id(window, n))
        .or_else(|| primary_or_first(window))
}

/// A shape-based key for a monitor, used to recover an explicit choice when the
/// OS name has shifted under it (see `DisplayPrefs::monitor_fingerprint`). Two
/// identical panels produce identical fingerprints; that is accepted, because the
/// alternative — landing on a monitor the user did not choose — is worse than
/// landing on the wrong one of two screens that look the same.
pub(super) fn fingerprint(monitor: &Monitor) -> String {
    let s = monitor.size();
    format!("{}x{}@{}", s.width, s.height, monitor.scale_factor())
}
