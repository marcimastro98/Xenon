//! The steps recorder's pure parts on macOS: which tapped events count, the
//! words for what was clicked from its Accessibility role, where the ring
//! goes in the saved picture and how big, and the pixel rows CoreGraphics
//! hands over turned into the ones `crate::steps::ring` draws on. Keys are
//! never kept: a key press only says that typing happened. Tested on every OS.

use crate::steps;

/// kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventKeyDown.
pub const LEFT_DOWN: u32 = 1;
pub const RIGHT_DOWN: u32 = 3;
pub const KEY_DOWN: u32 = 10;
/// The shell's executable: clicks on Xenon itself are not steps.
pub const XENON_EXE: &str = "xenon-native";

/// A left or right press as the event tap sees it: at (`x`, `y`) in points
/// (top-left origin), `time` in ms since the tap started, over CoreGraphics
/// window `window` (0 unknown). Typing is only a flag, never an event.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Press {
    pub right: bool,
    pub x: f64,
    pub y: f64,
    pub time: u64,
    pub window: u32,
}

/// The events the tap listens to.
pub fn mask() -> u64 {
    (1 << LEFT_DOWN) | (1 << RIGHT_DOWN) | (1 << KEY_DOWN)
}

/// What a tapped event says: a press (right or not), typing, or nothing.
pub fn kind(event_type: u32) -> Option<Option<bool>> {
    match event_type {
        LEFT_DOWN => Some(Some(false)),
        RIGHT_DOWN => Some(Some(true)),
        KEY_DOWN => Some(None),
        _ => None,
    }
}

/// The kind of thing clicked, from its AXRole, in the words the document
/// uses on every OS (`crate::steps::role`); "" when it says nothing useful.
pub fn role(ax_role: &str) -> &'static str {
    match ax_role {
        "AXButton" | "AXMenuButton" | "AXDisclosureTriangle" | "AXIncrementor" => "button",
        "AXCheckBox" => "checkbox",
        "AXPopUpButton" | "AXComboBox" => "dropdown",
        "AXTextField" | "AXTextArea" | "AXSearchField" => "field",
        "AXLink" => "link",
        "AXCell" | "AXRow" | "AXOutlineRow" => "item",
        "AXMenuBar" | "AXMenuBarItem" | "AXMenu" | "AXMenuItem" => "menu",
        "AXRadioButton" => "option",
        "AXSlider" => "slider",
        "AXTabGroup" => "tab",
        _ => "",
    }
}

/// False when the element under the click is a whole window, app, scroll
/// area or web page: its title is the window's or the document's, not the
/// thing clicked, so the step says "the circled spot" instead.
pub fn names_the_click(ax_role: &str) -> bool {
    !matches!(
        ax_role,
        "AXWindow" | "AXApplication" | "AXScrollArea" | "AXSplitGroup" | "AXWebArea" | "AXSheet"
    )
}

/// The name of what was clicked: its AXTitle, else its AXDescription,
/// cleaned to one short line; "" when its role names a whole window.
pub fn name(ax_role: &str, title: Option<&str>, description: Option<&str>) -> String {
    if !names_the_click(ax_role) {
        return String::new();
    }
    [title, description]
        .into_iter()
        .flatten()
        .map(steps::clean_name)
        .find(|n| !n.is_empty())
        .unwrap_or_default()
}

/// A press on Xenon itself (or this engine): not a step of the procedure.
pub fn is_ours(pid: i32, own_pid: u32, exe: &str) -> bool {
    (pid > 0 && pid as u32 == own_pid) || exe == XENON_EXE
}

/// A display in points, top-left origin: x, y, width, height.
pub type Area = (i64, i64, i64, i64);

/// Where the press at (`x`, `y`) points lands in the saved picture of
/// `area`, `saved` pixels big.
pub fn ring_at(x: f64, y: f64, area: Area, saved: (u32, u32)) -> (i32, i32) {
    let (ax, ay, aw, ah) = area;
    let cx = (x - ax as f64) * f64::from(saved.0) / aw.max(1) as f64;
    let cy = (y - ay as f64) * f64::from(saved.1) / ah.max(1) as f64;
    (cx.floor() as i32, cy.floor() as i32)
}

/// The ring's size in the saved picture: as big as on a Retina screen at
/// the display's own scale (`scale` pixels per point), never under 100%
/// once a large picture was scaled down, as on Windows.
pub fn ring_scale(scale: f64, saved_width: u32, taken_width: u32) -> f32 {
    let kept = f64::from(saved_width) / f64::from(taken_width.max(1));
    (scale * kept).max(1.0) as f32
}

/// CoreGraphics' 32-bit rows (blue, green, red, unused; `stride` bytes
/// apart) as the tight 24-bit rows the ring is drawn on.
pub fn bgrx_to_bgr(bgrx: &[u8], (w, h): (u32, u32), stride: usize) -> Vec<u8> {
    let (w, h) = (w as usize, h as usize);
    let mut out = Vec::with_capacity(w * h * 3);
    for r in 0..h {
        let Some(row) = bgrx.get(r * stride..r * stride + w * 4) else {
            break;
        };
        for px in row.chunks_exact(4) {
            out.extend_from_slice(&px[..3]);
        }
    }
    out
}

/// Tight 24-bit rows back to tight 32-bit ones for an image.
pub fn bgr_to_bgrx(bgr: &[u8]) -> Vec<u8> {
    bgr.chunks_exact(3)
        .flat_map(|p| [p[0], p[1], p[2], 255])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presses_and_typing_count_and_keys_are_not_kept() {
        assert_eq!(kind(LEFT_DOWN), Some(Some(false)));
        assert_eq!(kind(RIGHT_DOWN), Some(Some(true)));
        assert_eq!(kind(KEY_DOWN), Some(None), "only that typing happened");
        assert_eq!(kind(2), None, "a release is not a step");
        assert_eq!(kind(25), None, "the middle button is not a step");
        assert_eq!(mask(), 0b100_0000_1010);
    }

    #[test]
    fn roles_read_the_same_words_as_windows() {
        assert_eq!(role("AXButton"), "button");
        assert_eq!(role("AXPopUpButton"), "dropdown");
        assert_eq!(role("AXTextField"), "field");
        assert_eq!(role("AXMenuItem"), "menu");
        assert_eq!(role("AXRadioButton"), "option");
        assert_eq!(role("AXGroup"), "");
        assert_eq!(role(""), "");
        let words = ["button", "checkbox", "dropdown", "field", "link", "item", "menu", "option", "slider", "tab"];
        for r in ["AXCheckBox", "AXLink", "AXCell", "AXSlider", "AXTabGroup"] {
            assert!(words.contains(&role(r)), "{r}");
        }
    }

    #[test]
    fn a_window_or_page_is_never_named_by_its_title() {
        assert_eq!(name("AXButton", Some("  Save\nAs "), None), "Save As");
        assert_eq!(name("AXButton", Some(""), Some("Close")), "Close");
        assert_eq!(name("AXButton", None, None), "");
        assert_eq!(name("AXWindow", Some("Secret.docx"), None), "");
        assert_eq!(name("AXWebArea", Some("My bank"), Some("page")), "");
        assert!(name("AXButton", Some(&"x".repeat(200)), None).chars().count() <= steps::NAME_MAX);
    }

    #[test]
    fn clicks_on_xenon_are_not_steps() {
        assert!(is_ours(42, 42, "Finder"));
        assert!(is_ours(7, 42, XENON_EXE));
        assert!(!is_ours(7, 42, "Safari"));
        assert!(!is_ours(0, 0, ""), "an unknown app is a step");
    }

    #[test]
    fn the_ring_lands_where_the_press_was_at_the_saved_size() {
        // A Retina display at x 1440 in points, 1512 x 982, saved at 1600 wide.
        let area = (1440, 0, 1512, 982);
        let saved = steps::picture_size(3024, 1964);
        assert_eq!(saved, (1600, 1038));
        assert_eq!(ring_at(1440.0 + 756.0, 491.0, area, saved), (800, 519));
        assert_eq!(ring_at(1440.0, 0.0, area, saved), (0, 0));
        // Retina scaled down to 1600: 2 x 1600/3024, about 1.06.
        assert!((ring_scale(2.0, 1600, 3024) - 1.058).abs() < 0.01);
        assert_eq!(ring_scale(1.0, 1600, 3840), 1.0, "never under 100%");
        assert_eq!(ring_scale(2.0, 1280, 1280), 2.0);
    }

    #[test]
    fn rows_change_width_without_losing_a_pixel() {
        // 2 x 2 with rows padded to 12 bytes.
        let bgrx = [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9, 7, 8, 9, 0, 10, 11, 12, 0, 9, 9, 9, 9];
        let bgr = bgrx_to_bgr(&bgrx, (2, 2), 12);
        assert_eq!(bgr, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert_eq!(bgr_to_bgrx(&bgr)[..8], [1, 2, 3, 255, 4, 5, 6, 255]);
        assert_eq!(bgrx_to_bgr(&bgrx[..10], (2, 2), 12).len(), 6, "a short buffer stops at its last whole row");
    }
}
