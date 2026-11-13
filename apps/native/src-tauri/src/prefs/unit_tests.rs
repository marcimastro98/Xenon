// Tests of the saved display choices.

use super::{clean_language, DisplayPrefs};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_written_before_widgets_only_read_as_the_dashboard() {
        let old: DisplayPrefs = serde_json::from_str(r#"{"fullscreen":true,"monitor":null}"#).unwrap();
        assert!(!old.widgets_only);
        assert!(old.fullscreen);
        let now: DisplayPrefs =
            serde_json::from_str(r#"{"fullscreen":false,"monitor":null,"widgets_only":true}"#).unwrap();
        assert!(now.widgets_only);
    }

    #[test]
    fn files_written_before_the_menu_window_open_it_in_the_middle() {
        let old: DisplayPrefs = serde_json::from_str(r#"{"fullscreen":true,"monitor":null}"#).unwrap();
        assert_eq!(old.menu_rect, None);
        let now: DisplayPrefs =
            serde_json::from_str(r#"{"fullscreen":true,"monitor":null,"menu_rect":[10,20,900,700]}"#).unwrap();
        assert_eq!(now.menu_rect, Some([10, 20, 900, 700]));
    }

    #[test]
    fn files_written_before_see_through_keep_an_opaque_window() {
        let old: DisplayPrefs = serde_json::from_str(r#"{"fullscreen":true,"monitor":null}"#).unwrap();
        assert!(!old.see_through);
        let now: DisplayPrefs =
            serde_json::from_str(r#"{"fullscreen":true,"monitor":null,"see_through":true}"#).unwrap();
        assert!(now.see_through);
    }
}

#[cfg(test)]
mod language_tests {
    use super::clean_language;

    #[test]
    fn takes_only_two_lowercase_letters() {
        assert_eq!(clean_language("it").as_deref(), Some("it"));
        for bad in ["", "i", "ita", "IT", "i1", "../"] {
            assert_eq!(clean_language(bad), None, "{bad}");
        }
    }
}
