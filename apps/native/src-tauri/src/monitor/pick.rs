// Finds the screen the user chose among the screens attached now, also after ports or ids changed.

use std::sync::Mutex;
use tauri::{AppHandle, Manager, Monitor, PhysicalSize, WebviewWindow};
use crate::prefs;
use crate::prefs::Placement;
use super::is_edge_size;
use super::ids::{display_ids, find_by_id, fingerprint};
use super::screens::{monitors_of, PlacementCache, set_placement_cache};

/// How a saved screen choice resolved against the screens attached right now.
#[derive(Debug, PartialEq, Clone, Copy)]
pub(super) enum Pick {
    /// The saved id, and that screen still has the shape that was chosen.
    Name(usize),
    /// Found by its shape. `moved` means the saved id now names a DIFFERENT
    /// screen, the Windows renumbering below.
    Shape { index: usize, moved: bool },
    /// The saved id names a screen of another shape, and the screen that was
    /// chosen is the Edge, which is not connected yet. Wait for it.
    Waiting,
    /// The saved id names a screen of another shape, no screen has the saved
    /// shape, and that shape is an ordinary monitor: most likely its resolution
    /// was changed, so it is still the one.
    Resized(usize),
    /// Neither the id nor the shape is attached.
    Missing,
}

impl Pick {
    pub(super) fn index(self) -> Option<usize> {
        match self {
            Pick::Name(i) | Pick::Shape { index: i, .. } | Pick::Resized(i) => Some(i),
            Pick::Waiting | Pick::Missing => None,
        }
    }
}

/// `"2560x720@1"` → `"2560x720"`: the size alone, which a change of Windows
/// scaling leaves alone.
fn fp_size(fp: &str) -> &str {
    fp.split('@').next().unwrap_or(fp)
}

/// True when two fingerprints are the same panel, also turned by 90°. Rotating a
/// screen in Windows swaps its width and height; it is still the screen that was
/// chosen. Without this a saved Edge rotated to vertical read as "the Edge is
/// not connected yet" and the kiosk stayed hidden (reported 20 Oct 2026).
fn fp_same_panel(a: &str, b: &str) -> bool {
    let (a, b) = (fp_size(a), fp_size(b));
    if a == b {
        return true;
    }
    match (a.split_once('x'), b.split_once('x')) {
        (Some((aw, ah)), Some((bw, bh))) => aw == bh && ah == bw,
        _ => false,
    }
}

/// True when a saved fingerprint is the shape of a Xeneon Edge.
fn fp_is_edge(fp: &str) -> bool {
    let mut it = fp_size(fp).split('x').map(|n| n.parse::<u32>());
    match (it.next(), it.next(), it.next()) {
        (Some(Ok(w)), Some(Ok(h)), None) => is_edge_size(PhysicalSize::new(w, h)),
        _ => false,
    }
}

/// Which screen is the one the user chose, given the screen the saved id names
/// (`by_name`), the fingerprint of every screen attached (`shapes`) and the
/// fingerprint saved with the choice (`saved`).
///
/// The id alone is not enough on Windows. There it is `\\.\DISPLAYn`, numbered
/// in the order the screens come up, and after a restart the Edge often comes up
/// last: "Display 2" is then the MAIN screen, and the kiosk opened on it as a
/// small window and stayed there, because the shape was only consulted when no
/// screen had the id at all. Reported on Discord: "it opens as a window on my
/// main screen and not in fullscreen on my Xeneon Edge". So the id has to agree
/// with the shape, and when it does not, the shape wins.
fn pick_chosen(by_name: Option<usize>, shapes: &[String], saved: Option<&str>) -> Pick {
    // A choice saved before shapes were recorded: the id is all there is.
    let Some(saved) = saved else {
        return by_name.map_or(Pick::Missing, Pick::Name);
    };
    if let Some(i) = by_name {
        if shapes.get(i).map_or(false, |s| fp_same_panel(s, saved)) {
            return Pick::Name(i);
        }
    }
    let found = shapes
        .iter()
        .position(|s| s == saved)
        .or_else(|| shapes.iter().position(|s| fp_size(s) == fp_size(saved)))
        .or_else(|| shapes.iter().position(|s| fp_same_panel(s, saved)));
    if let Some(index) = found {
        return Pick::Shape { index, moved: by_name.is_some() };
    }
    match by_name {
        None => Pick::Missing,
        // Putting the kiosk on a screen the user did not pick is the one outcome
        // this must never have; the Edge arriving a few seconds late is normal.
        Some(_) if fp_is_edge(saved) => Pick::Waiting,
        Some(i) => Pick::Resized(i),
    }
}

/// `pick_chosen` over a live monitor list.
pub(super) fn pick_in(monitors: &[Monitor], id: Option<&str>, saved: Option<&str>) -> Pick {
    let by_name = id.and_then(|id| find_by_id(monitors, id));
    let shapes: Vec<String> = monitors.iter().map(fingerprint).collect();
    pick_chosen(by_name, &shapes, saved)
}

/// The last unusual `Pick` written to the crash log, so the watchdog, which
/// resolves the choice every 3 seconds, says it once and not every tick.
static LAST_PICK_NOTE: Mutex<String> = Mutex::new(String::new());

fn note_pick(pick: Pick, monitors: &[Monitor], id: Option<&str>, saved: Option<&str>) {
    let describe = |i: usize| {
        monitors.get(i).map_or_else(String::new, |m| {
            format!("{} {}", m.name().map(String::as_str).unwrap_or("?"), fingerprint(m))
        })
    };
    let id = id.unwrap_or("-");
    let saved = saved.unwrap_or("-");
    let line = match pick {
        Pick::Shape { index, moved: true } => format!(
            "the saved screen {id} is now another screen; using {} ({saved}) instead",
            describe(index)
        ),
        Pick::Waiting => format!(
            "the saved screen {id} is now another screen and the Edge ({saved}) is not connected yet; waiting for it"
        ),
        Pick::Resized(i) => format!(
            "the saved screen {id} changed shape ({saved} -> {}); keeping it",
            describe(i)
        ),
        Pick::Name(_) | Pick::Shape { moved: false, .. } | Pick::Missing => String::new(),
    };
    let mut last = LAST_PICK_NOTE.lock().unwrap_or_else(|e| e.into_inner());
    if *last != line {
        if !line.is_empty() {
            crate::crash_log::note("display", &line);
        }
        *last = line;
    }
}

/// Resolve the screen the user explicitly chose (see `pick_chosen`). `None`
/// means it is genuinely not connected right now.
///
/// A choice found by its shape is saved again under the id that screen has now,
/// so Settings and the tray mark the right screen as chosen and the next lookup
/// is a plain id match.
pub(super) fn chosen_monitor(window: &WebviewWindow, cache: &PlacementCache) -> Option<Monitor> {
    let monitors = monitors_of(window)?;
    let id = cache.monitor.as_deref();
    let saved = cache.fingerprint.as_deref();
    let pick = pick_in(&monitors, id, saved);
    note_pick(pick, &monitors, id, saved);
    let found = monitors.get(pick.index()?)?.clone();
    if let Pick::Shape { .. } = pick {
        if let Some(new_id) = display_ids(&monitors).get(pick.index()?).cloned() {
            heal_saved_id(window.app_handle(), id, new_id);
        }
    }
    Some(found)
}

/// Re-save the chosen screen under its current id, unless the choice changed in
/// the meantime (a pick from the tray racing the watchdog).
fn heal_saved_id(app: &AppHandle, old: Option<&str>, new_id: String) {
    let old = old.map(str::to_string);
    let mut snapshot = None;
    prefs::update(app, |p| {
        if p.placement == Placement::Screen && p.monitor == old {
            p.monitor = Some(new_id);
            snapshot = Some(p.clone());
        }
    });
    if let Some(p) = snapshot {
        set_placement_cache(&p);
    }
}

#[cfg(test)]
mod pick_tests {
    use super::*;

    fn shapes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    const EDGE: &str = "2560x720@1";
    const MAIN: &str = "3840x2160@1.5";

    #[test]
    fn the_saved_id_still_on_the_chosen_screen_is_used() {
        assert_eq!(pick_chosen(Some(1), &shapes(&[MAIN, EDGE]), Some(EDGE)), Pick::Name(1));
        // A change of Windows scaling is not a different screen.
        assert_eq!(pick_chosen(Some(1), &shapes(&[MAIN, "2560x720@1.25"]), Some(EDGE)), Pick::Name(1));
    }

    #[test]
    fn after_a_restart_the_numbers_shift_and_the_shape_wins() {
        // "DISPLAY2" was the Edge; after the restart it is the main screen and the
        // Edge came up as DISPLAY1.
        assert_eq!(
            pick_chosen(Some(1), &shapes(&[EDGE, MAIN]), Some(EDGE)),
            Pick::Shape { index: 0, moved: true }
        );
    }

    #[test]
    fn the_edge_not_up_yet_is_waited_for_not_replaced_by_the_main_screen() {
        assert_eq!(pick_chosen(Some(0), &shapes(&[MAIN]), Some(EDGE)), Pick::Waiting);
        // Vertical mount: still the Edge.
        assert_eq!(pick_chosen(Some(0), &shapes(&[MAIN]), Some("720x2560@1")), Pick::Waiting);
    }

    #[test]
    fn a_screen_turned_by_90_degrees_is_still_the_chosen_one() {
        // The Edge chosen landscape, then rotated to vertical in Windows.
        assert_eq!(pick_chosen(Some(1), &shapes(&[MAIN, "720x2560@1"]), Some(EDGE)), Pick::Name(1));
        // …and after a restart that also renumbered the screens.
        assert_eq!(
            pick_chosen(Some(1), &shapes(&["720x2560@1", MAIN]), Some(EDGE)),
            Pick::Shape { index: 0, moved: true }
        );
        // An unrotated screen of the saved size still wins over a rotated one.
        assert_eq!(
            pick_chosen(None, &shapes(&["720x2560@1", EDGE]), Some(EDGE)),
            Pick::Shape { index: 1, moved: false }
        );
        assert!(!fp_same_panel("2560x1440@1", EDGE));
    }

    #[test]
    fn an_ordinary_screen_with_a_new_resolution_is_still_the_one() {
        assert_eq!(
            pick_chosen(Some(1), &shapes(&[MAIN, "1920x1080@1"]), Some("2560x1440@1")),
            Pick::Resized(1)
        );
    }

    #[test]
    fn a_vanished_id_falls_back_to_the_shape_as_before() {
        assert_eq!(
            pick_chosen(None, &shapes(&[MAIN, EDGE]), Some(EDGE)),
            Pick::Shape { index: 1, moved: false }
        );
        assert_eq!(pick_chosen(None, &shapes(&[MAIN]), Some(EDGE)), Pick::Missing);
    }

    #[test]
    fn an_exact_fingerprint_beats_a_same_size_screen() {
        assert_eq!(
            pick_chosen(None, &shapes(&["2560x720@1.25", EDGE]), Some(EDGE)),
            Pick::Shape { index: 1, moved: false }
        );
    }

    #[test]
    fn a_choice_saved_without_a_shape_trusts_the_id() {
        assert_eq!(pick_chosen(Some(0), &shapes(&[MAIN]), None), Pick::Name(0));
        assert_eq!(pick_chosen(None, &shapes(&[MAIN]), None), Pick::Missing);
    }

    #[test]
    fn index_is_none_only_when_there_is_nowhere_to_go() {
        assert_eq!(Pick::Waiting.index(), None);
        assert_eq!(Pick::Missing.index(), None);
        assert_eq!(Pick::Resized(2).index(), Some(2));
        assert_eq!(Pick::Shape { index: 1, moved: true }.index(), Some(1));
    }

    #[test]
    fn fp_is_edge_reads_the_saved_shape() {
        assert!(fp_is_edge("2560x720@1"));
        assert!(fp_is_edge("720x2560@2"));
        assert!(!fp_is_edge("1920x1080@1"));
        assert!(!fp_is_edge("garbage"));
    }
}
