//! The Xenon AI edge glow on screens other than the dashboard's: the same
//! inset halo the dashboard draws in ambient voice mode (AIPanel.css
//! `.ai-overlay::after`), drawn by a plain layered window per monitor instead of
//! a webview, so it costs no browser process, shows at once and never takes a
//! click: glow_win32.rs on Windows, glow_macos.rs and glow_linux.rs elsewhere.
//!
//! Driven by the main dashboard (js/ai-edge-glow.js), which navigates
//! `xenon-app:ai-glow?d=<json>` when the voice state changes, or in "widgets
//! only" by the on-screen alerts window, where Bit answers. This file holds
//! the payload rule and the pixels; both are plain functions with tests.

use serde::Deserialize;

const MAX_PAYLOAD: usize = 2048;
const MAX_MONITORS: usize = 8;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Off,
    Listening,
    Thinking,
    Speaking,
}

#[derive(Deserialize, Debug)]
pub struct Spec {
    pub state: State,
    /// The theme accent, `--accent-rgb`.
    #[serde(default)]
    pub rgb: [u8; 3],
    /// prefers-reduced-motion: a steady glow, no breathing.
    #[serde(default)]
    pub still: bool,
    /// Display ids as the shell reports them (`display_list_json`).
    #[serde(default)]
    pub monitors: Vec<String>,
}

fn printable(s: &str) -> bool {
    s.len() <= 64 && s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// The payload, or None when it breaks the rule. "off" needs no monitors;
/// anything else without one is off too.
pub fn parse(json: &str) -> Option<Spec> {
    if json.len() > MAX_PAYLOAD {
        return None;
    }
    let mut s: Spec = serde_json::from_str(json).ok()?;
    let mut seen = Vec::new();
    s.monitors.retain(|m| printable(m) && !seen.contains(m) && {
        seen.push(m.clone());
        true
    });
    s.monitors.truncate(MAX_MONITORS);
    if s.monitors.is_empty() {
        s.state = State::Off;
    }
    Some(s)
}

/// The screens setting (`hubSettings.aiEdgeGlow`) as the on-screen alerts
/// window sends it. That window answers for Bit in "widgets only" and has no
/// display list (it is not the main webview), so the shell picks the screens.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Screens {
    /// No dashboard to leave out: every screen.
    #[default]
    Auto,
    Main,
    Second,
    All,
}

#[derive(Deserialize, Debug)]
pub struct ScreensSpec {
    pub state: State,
    #[serde(default)]
    pub rgb: [u8; 3],
    #[serde(default)]
    pub still: bool,
    #[serde(default)]
    pub screens: Screens,
}

pub fn parse_screens(json: &str) -> Option<ScreensSpec> {
    if json.len() > MAX_PAYLOAD {
        return None;
    }
    serde_json::from_str(json).ok()
}

/// Which of the attached monitors glow, by index, given which one is primary.
/// Same rule as js/ai-edge-glow.js `screensFor` with no dashboard: Bit is then
/// on the main screen, so `auto` lights that one alone (the first without one).
pub fn pick(screens: Screens, primary: &[bool]) -> Vec<usize> {
    let all = (0..primary.len()).take(MAX_MONITORS);
    match screens {
        Screens::All => all.collect(),
        Screens::Auto => {
            let main = all.clone().find(|&i| primary[i]);
            main.or_else(|| all.clone().next()).into_iter().collect()
        }
        Screens::Main => all.filter(|&i| primary[i]).take(1).collect(),
        Screens::Second => all.filter(|&i| !primary[i]).take(1).collect(),
    }
}

/// One `inset 0 0 <blur>px rgba(…, alpha)` shadow of the CSS.
struct Layer {
    blur: f64,
    alpha: f64,
}

/// The CSS shadows of each state, and their colour: thinking is lavender,
/// the rest follow the accent.
fn layers(state: State) -> [Layer; 3] {
    match state {
        State::Speaking => [
            Layer { blur: 4.0, alpha: 0.78 },
            Layer { blur: 46.0, alpha: 0.42 },
            Layer { blur: 120.0, alpha: 0.18 },
        ],
        _ => [
            Layer { blur: 3.0, alpha: 0.55 },
            Layer { blur: 34.0, alpha: 0.30 },
            Layer { blur: 90.0, alpha: 0.12 },
        ],
    }
}

pub fn colour(state: State, accent: [u8; 3]) -> [u8; 3] {
    if state == State::Thinking {
        [182, 157, 255]
    } else {
        accent
    }
}

/// The breathing period of the CSS animation, in milliseconds.
pub fn period_ms(state: State) -> u32 {
    match state {
        State::Listening => 2600,
        State::Thinking => 1500,
        State::Speaking => 1900,
        State::Off => 4400,
    }
}

/// The opacity range of `xn-edge-breathe`, and the steady opacity for reduced
/// motion: macOS hands them to Core Animation, the others use `breath_alpha`.
pub const BREATH_LOW: f64 = 0.55;
pub const BREATH_HIGH: f64 = 0.95;
pub const STILL_OPACITY: f64 = 0.8;

/// `xn-edge-breathe`: opacity .55 → .95 → .55 over one period, eased; a
/// steady .8 for reduced motion. Returned as a 0-255 window alpha. Not on
/// macOS, where Core Animation breathes the layer itself.
#[cfg(any(test, not(target_os = "macos")))]
pub fn breath_alpha(elapsed_ms: u64, period: u32, still: bool) -> u8 {
    let opacity = if still {
        STILL_OPACITY
    } else {
        let phase = (elapsed_ms % u64::from(period.max(1))) as f64 / f64::from(period.max(1));
        BREATH_LOW + (BREATH_HIGH - BREATH_LOW) * (1.0 - (phase * std::f64::consts::TAU).cos()) / 2.0
    };
    (opacity * 255.0).round() as u8
}

/// erfc, Abramowitz and Stegun 7.1.26 (error < 1.5e-7): plenty for 8-bit alpha.
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * z);
    let poly = t * (0.254_829_592 + t * (-0.284_496_736 + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    let r = poly * (-z * z).exp();
    if x >= 0.0 {
        r
    } else {
        2.0 - r
    }
}

/// How much of a blurred inset shadow reaches `d` pixels in from one edge: a
/// Gaussian of sigma = blur / 2, as browsers draw box-shadow. 0.5 at the edge.
fn edge(d: f64, sigma: f64) -> f64 {
    0.5 * erfc(d / (sigma * std::f64::consts::SQRT_2))
}

/// Per-axis shadow reach of one layer: both edges of a line `len` long.
fn axis(len: usize, sigma: f64) -> Vec<f64> {
    (0..len)
        .map(|i| {
            let near = i as f64 + 0.5;
            let far = len as f64 - near;
            (edge(near, sigma) + edge(far, sigma)).min(1.0)
        })
        .collect()
}

/// The glow as premultiplied BGRA rows, top row first, `w` x `h` physical
/// pixels at `scale` (the monitor's DPI scale: CSS blur is in CSS pixels).
pub fn paint(w: usize, h: usize, scale: f64, state: State, accent: [u8; 3]) -> Vec<u8> {
    let [r, g, b] = colour(state, accent);
    let parts: Vec<(f64, Vec<f64>, Vec<f64>)> = layers(state)
        .iter()
        .map(|l| {
            let sigma = (l.blur * scale.max(1.0) / 2.0).max(0.5);
            (l.alpha, axis(w, sigma), axis(h, sigma))
        })
        .collect();
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            // The shadow is the blurred outside of the screen: 1 - blur(box),
            // and blur(box) is separable.
            let mut clear = 1.0;
            for (alpha, gx, gy) in &parts {
                let cover = 1.0 - (1.0 - gx[x]) * (1.0 - gy[y]);
                clear *= 1.0 - alpha * cover;
            }
            let a = 1.0 - clear;
            if a < 0.5 / 255.0 {
                continue;
            }
            let i = (y * w + x) * 4;
            out[i] = (f64::from(b) * a).round() as u8;
            out[i + 1] = (f64::from(g) * a).round() as u8;
            out[i + 2] = (f64::from(r) * a).round() as u8;
            out[i + 3] = (a * 255.0).round() as u8;
        }
    }
    out
}

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
