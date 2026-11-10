//! When a layer window hears whether it stays out of screenshots and recordings
//! (`spec::out_of_captures`).
//!
//! Only when the value changes, and never while the Xenon menu stands aside. On
//! Windows, setting it on the hidden menu made the system draw that window
//! again: a blank white frame with its title bar, where the menu was, until the
//! menu showed (reported 9 Nov 2026, on Remove of the last widget in edit mode,
//! and on every periodic sync while the menu waited aside). The menu hears what
//! it missed when it comes back.

/// What a window was told, and what it should be.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Shield {
    told: Option<bool>,
    want: bool,
}

impl Shield {
    /// A value from a sync: what to tell the window now, if anything.
    pub fn want(&mut self, out: bool, aside: bool) -> Option<bool> {
        self.want = out;
        self.due(aside)
    }

    /// What the window has still to hear, unless it stands aside.
    pub fn due(&self, aside: bool) -> Option<bool> {
        (!aside && self.told != Some(self.want)).then_some(self.want)
    }

    /// The window took it.
    pub fn told(&mut self, out: bool) {
        self.told = Some(out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_hears_the_first_value_and_then_only_changes() {
        let mut s = Shield::default();
        assert_eq!(s.want(false, false), Some(false), "a new window is told, even the default");
        s.told(false);
        assert_eq!(s.want(false, false), None, "the periodic sync repeats nothing");
        assert_eq!(s.want(true, false), Some(true));
        s.told(true);
        assert_eq!(s.want(true, false), None);
    }

    #[test]
    fn the_menu_aside_hears_nothing_until_it_comes_back() {
        let mut s = Shield::default();
        s.want(false, false);
        s.told(false);
        assert_eq!(s.want(true, true), None, "Xenon starts recording while the menu is aside");
        assert_eq!(s.want(false, true), None);
        assert_eq!(s.due(false), None, "back to what it already had: nothing to tell");
        assert_eq!(s.want(true, true), None);
        assert_eq!(s.due(false), Some(true), "back while recording: out of the picture first");
        s.told(true);
        assert_eq!(s.due(false), None);
    }

    #[test]
    fn a_value_the_window_did_not_take_is_tried_again() {
        let mut s = Shield::default();
        assert_eq!(s.want(true, false), Some(true));
        assert_eq!(s.want(true, false), Some(true), "never told: asked again");
    }
}
