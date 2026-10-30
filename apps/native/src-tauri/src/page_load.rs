//! Which page-load events are real loads. wry reports `Finished` for every
//! completed WebView2 navigation, including the `xenon-app:` signals the shell
//! cancels, while `Started` comes only from content actually loading. Work done
//! "when the page loaded" must skip the signals: the display-state push answered
//! each one, the page re-synced its layers, and that sent another signal.

use std::sync::Mutex;

static LOADING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// True for a real load's `Started` and for the `Finished` that follows it; a
/// `Finished` with no `Started` before it is a cancelled signal.
pub fn real(label: &str, started: bool) -> bool {
    let mut loading = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    step(&mut loading, label, started)
}

fn step(loading: &mut Vec<String>, label: &str, started: bool) -> bool {
    let at = loading.iter().position(|l| l == label);
    match (started, at) {
        (true, None) => {
            loading.push(label.to_owned());
            true
        }
        (true, Some(_)) => true,
        (false, Some(i)) => {
            loading.swap_remove(i);
            true
        }
        (false, None) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::step;

    #[test]
    fn a_load_counts_once_and_a_signal_never() {
        let mut l = Vec::new();
        assert!(step(&mut l, "main", true));
        assert!(step(&mut l, "main", false));
        // A cancelled `xenon-app:` signal: Finished with no Started.
        assert!(!step(&mut l, "main", false));
        assert!(!step(&mut l, "main", false));
        assert!(l.is_empty());
    }

    #[test]
    fn webviews_are_tracked_apart() {
        let mut l = Vec::new();
        assert!(step(&mut l, "main", true));
        assert!(step(&mut l, "scene-1", true));
        assert!(step(&mut l, "scene-1", false));
        assert!(!step(&mut l, "scene-1", false));
        assert!(step(&mut l, "main", false));
    }

    #[test]
    fn a_reload_before_finishing_still_finishes_once() {
        let mut l = Vec::new();
        assert!(step(&mut l, "main", true));
        assert!(step(&mut l, "main", true));
        assert_eq!(l.len(), 1);
        assert!(step(&mut l, "main", false));
        assert!(!step(&mut l, "main", false));
    }
}
