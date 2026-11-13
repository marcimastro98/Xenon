// Tests of the glow around a widget window.

use super::{colour, erfc, MAX_MONITORS, MAX_PAYLOAD, paint, parse, parse_screens, pick, Screens, State};
#[cfg(any(test, not(target_os = "macos")))]
use super::breath_alpha;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_is_validated_not_trusted() {
        let s = parse(r#"{"state":"speaking","rgb":[1,2,3],"still":true,"monitors":["","\\\\.\\DISPLAY2",""]}"#).unwrap();
        assert_eq!(s.state, State::Speaking);
        assert_eq!(s.rgb, [1, 2, 3]);
        assert!(s.still);
        assert_eq!(s.monitors, vec!["".to_string(), "\\\\.\\DISPLAY2".to_string()]);
        assert!(parse(r#"{"state":"shouting","monitors":[""]}"#).is_none());
        assert!(parse(r#"{"state":"listening","rgb":[300,0,0],"monitors":[""]}"#).is_none());
        assert!(parse(&"x".repeat(MAX_PAYLOAD + 1)).is_none());
    }

    #[test]
    fn no_monitor_means_off_and_junk_monitors_are_dropped() {
        assert_eq!(parse(r#"{"state":"listening"}"#).unwrap().state, State::Off);
        let s = parse(r#"{"state":"listening","monitors":["a\u0001"]}"#).unwrap();
        assert_eq!(s.state, State::Off);
        let many: Vec<String> = (0..20).map(|i| format!("\"m{i}\"")).collect();
        let s = parse(&format!(r#"{{"state":"listening","monitors":[{}]}}"#, many.join(","))).unwrap();
        assert_eq!(s.monitors.len(), MAX_MONITORS);
    }

    #[test]
    fn the_alerts_window_names_the_screens_the_shell_picks_them() {
        let s = parse_screens(r#"{"state":"listening","rgb":[1,2,3],"screens":"second"}"#).unwrap();
        assert_eq!((s.state, s.screens, s.rgb), (State::Listening, Screens::Second, [1, 2, 3]));
        assert_eq!(parse_screens(r#"{"state":"off"}"#).unwrap().screens, Screens::Auto);
        assert!(parse_screens(r#"{"state":"listening","screens":"left"}"#).is_none());
        assert!(parse_screens(&"x".repeat(MAX_PAYLOAD + 1)).is_none());

        let primary = [false, true, false];
        assert_eq!(pick(Screens::Auto, &primary), vec![1], "auto: the main screen, where Bit is");
        assert_eq!(pick(Screens::Auto, &[false, false]), vec![0]);
        assert!(pick(Screens::Auto, &[]).is_empty());
        assert_eq!(pick(Screens::All, &primary), vec![0, 1, 2]);
        assert_eq!(pick(Screens::Main, &primary), vec![1]);
        assert_eq!(pick(Screens::Second, &primary), vec![0]);
        assert!(pick(Screens::Second, &[true]).is_empty(), "one screen: no second to light");
        assert_eq!(pick(Screens::All, &[false; 12]).len(), MAX_MONITORS);
    }

    #[test]
    fn thinking_is_lavender_the_rest_follow_the_accent() {
        assert_eq!(colour(State::Thinking, [0, 200, 255]), [182, 157, 255]);
        assert_eq!(colour(State::Speaking, [0, 200, 255]), [0, 200, 255]);
    }

    #[test]
    fn the_breath_matches_the_css_range() {
        assert_eq!(breath_alpha(0, 1900, false), (0.55f64 * 255.0).round() as u8);
        assert_eq!(breath_alpha(950, 1900, false), (0.95f64 * 255.0).round() as u8);
        assert_eq!(breath_alpha(1900, 1900, false), breath_alpha(0, 1900, false));
        assert_eq!(breath_alpha(123, 1900, true), 204);
        assert_eq!(breath_alpha(5, 0, false), breath_alpha(0, 1, false));
    }

    #[test]
    fn erfc_is_close_enough() {
        assert!((erfc(0.0) - 1.0).abs() < 1e-6);
        assert!((erfc(1.0) - 0.157_299_2).abs() < 1e-6);
        assert!((erfc(-1.0) - 1.842_700_8).abs() < 1e-6);
    }

    #[test]
    fn the_glow_hugs_the_edges_and_leaves_the_middle_clear() {
        let (w, h) = (900, 700);
        let px = paint(w, h, 1.0, State::Speaking, [255, 0, 0]);
        let alpha = |x: usize, y: usize| px[(y * w + x) * 4 + 3];
        assert!(alpha(0, 350) > 100, "edge {}", alpha(0, 350));
        assert!(alpha(0, 0) > alpha(0, 350), "corners add up");
        assert!(alpha(30, 350) < alpha(2, 350));
        assert_eq!(alpha(450, 350), 0, "the middle stays clear");
        assert_eq!(alpha(0, 350), alpha(w - 1, 350), "symmetric");
        // Premultiplied: colour never exceeds alpha.
        let i = (350 * w) * 4;
        assert!(px[i + 2] <= px[i + 3] && px[i] == 0 && px[i + 1] == 0);
    }

    #[test]
    fn a_higher_scale_reaches_further_in() {
        let lo = paint(600, 100, 1.0, State::Listening, [9, 9, 9]);
        let hi = paint(600, 100, 2.0, State::Listening, [9, 9, 9]);
        let a = |p: &Vec<u8>| p[(50 * 600 + 120) * 4 + 3];
        assert!(a(&hi) > a(&lo));
    }
}
