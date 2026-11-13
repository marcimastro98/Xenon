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

#[cfg(test)]
mod unit_tests;


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
