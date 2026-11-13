//! Windows: match the WebView2 render GPU to the display that presents the kiosk.
//!
//! On a hybrid-GPU machine (integrated + discrete) Chromium renders the webview on
//! the discrete GPU by default, but the Xeneon Edge is usually driven by the
//! integrated GPU (it connects over USB-C, which routes through the iGPU). When the
//! render GPU differs from the GPU scanning out the window, Chromium copies every
//! composited frame across adapters **on the CPU** — measured at ~1.5 idle cores on
//! an RTX 5080 + AMD iGPU here, which starved the main thread until the Deck stopped
//! responding. See the "native-app-hybrid-gpu-idle-burn" note.
//!
//! The fix is the Chromium flag `--force_low_power_gpu` / `--force_high_performance_gpu`
//! (works via WebView2 since Chromium v145+, per WebView2Feedback#5072). We pick the
//! one that MATCHES the GPU driving the target display, so rendering and presentation
//! land on the same adapter and the cross-GPU copy disappears — and we only do it on
//! genuine iGPU+dGPU systems, leaving single-GPU and dual-discrete rigs untouched.
//!
//! **The choice is made once and cannot be remade.** `additional_browser_args` is a
//! WebView2 *environment* option, fixed when the first webview of a process is
//! created, so the flag we launch with is the flag we keep until the app restarts.
//! Two consequences the rest of this module exists to handle:
//!
//!   * Every webview in the process must be built with the SAME flag. WebView2
//!     rejects a second webview whose environment options differ from the ones the
//!     shared user-data folder was opened with — silently and asynchronously, so the
//!     window simply never appears. Recomputing per window made that a live bug:
//!     plug the Edge in after launch and Spotlight stopped opening, with nothing
//!     anywhere saying why. `applied()` is therefore the only value any builder may
//!     use; `decide()` is for deciding, once, at startup.
//!   * A display change after launch can leave the pinned adapter and the presenting
//!     adapter disagreeing again — the exact cross-adapter copy this module removes,
//!     silently reintroduced. `mismatch()` reports that, and the tray's Restart entry
//!     says so (see `tray.rs`), because a restart is the only thing that can fix it.
//!
//! Pure Win32 FFI (no `windows` crate) to keep the tiny, dependency-free binary,
//! matching the style in `monitor.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

mod displays;
#[cfg(test)]
mod unit_tests;

use displays::{Display, enumerate_displays};
pub use displays::virtual_display_names;

// Native panel resolution of the CORSAIR Xeneon Edge — the reliable signal for
// which display is the Edge (mirrors `monitor::is_edge`).
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

/// The Edge panel in EITHER orientation, mirroring `monitor::is_edge_size`.
///
/// This module and `monitor.rs` must agree about which screen the kiosk presents
/// on, or the pin aims at the adapter driving a display the window is not on. A
/// panel mounted vertically reports 720×2560, so recognising rotation in only one
/// of the two files would reintroduce exactly that split.
fn is_edge_size(width: u32, height: u32) -> bool {
    (width == EDGE_WIDTH && height == EDGE_HEIGHT) || (width == EDGE_HEIGHT && height == EDGE_WIDTH)
}

/// Render on the discrete adapter. Named rather than repeated so the launch value
/// and the mismatch comparison cannot drift apart from a typo.
const FLAG_DISCRETE: &str = "--force_high_performance_gpu";
/// Render on the integrated adapter.
const FLAG_INTEGRATED: &str = "--force_low_power_gpu";

/// A GPU name that belongs to an integrated adapter (Intel iGPU, or an AMD APU's
/// "Radeon(TM) Graphics"). Every caller checks `is_discrete` FIRST so Intel Arc
/// (discrete, and named "Arc") is never read as integrated.
fn is_integrated(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("intel")
        || n.contains("radeon(tm) graphics")
        || n.contains("amd radeon graphics")
        || n.contains("radeon graphics")
        || (n.contains("vega") && n.contains("graphics"))
}

/// A GPU name that belongs to a discrete adapter.
fn is_discrete(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("geforce")
        || n.contains("rtx")
        || n.contains("gtx")
        || n.contains("quadro")
        || n.contains("titan")
        || n.contains("radeon rx")
        || n.contains("radeon pro")
        || n.contains("arc ")
}

/// Integrated *and not* discrete. The order matters and getting it wrong is silent:
/// several discrete adapters carry a name `is_integrated` also matches (an Intel Arc
/// contains "intel"), so asking `is_integrated` on its own can classify a
/// dual-discrete rig as a hybrid and pin the webview to a "low power" GPU that is
/// really the second card.
fn integrated_only(name: &str) -> bool {
    !is_discrete(name) && is_integrated(name)
}

/// Adapters that are not real hardware. Xenon's own second-screen feature installs
/// one (MttVDD) and offers 2560×720 among its modes — exactly the Edge's panel size,
/// so size alone cannot tell the two apart.
fn is_virtual_adapter(gpu: &str) -> bool {
    let n = gpu.to_ascii_lowercase();
    n.contains("virtual display") || n.contains("mttvdd") || n.contains("iddsample")
}

/// The display the kiosk presents on. `presenting` is the GDI name of the screen
/// `monitor.rs` placed (or is about to place) the window on, and wins whenever it
/// names a real display: the user can pick ANY screen, and guessing here while
/// `monitor.rs` decides there pinned the webview to the primary's adapter while the
/// window sat on a monitor wired to the other one — the cross-adapter copy, on
/// every hybrid where someone chose a second screen on the motherboard output.
///
/// Without a usable name, the old guess: the Edge (by panel size, either
/// orientation), else the primary, else whatever is first. Virtual displays are
/// excluded by the caller, so a phantom name falls through to that guess too.
fn target<'a>(real: &'a [&'a Display], presenting: Option<&str>) -> Option<&'a Display> {
    presenting
        .and_then(|name| real.iter().find(|d| d.name.eq_ignore_ascii_case(name)))
        .or_else(|| real.iter().find(|d| is_edge_size(d.width, d.height)))
        .or_else(|| real.iter().find(|d| d.primary))
        .or_else(|| real.first())
        .copied()
}

/// The flag matching the adapter that drives `target`, ignoring whether the machine
/// is a hybrid. Split out from `decide` because the two questions differ once the
/// display layout changes: "should we pin at all" is asked at launch, while "is what
/// we pinned still right" (see `mismatch`) is about the target alone. A machine that
/// stops being a hybrid — the iGPU-driven screen unplugged — still has a webview
/// pinned to the integrated adapter, and that is a mismatch even though `decide`
/// would now answer `None`.
fn flag_for_target(displays: &[Display], presenting: Option<&str>) -> Option<&'static str> {
    let real: Vec<&Display> = displays.iter().filter(|d| !d.virtual_display).collect();
    let t = target(&real, presenting)?;
    if is_discrete(&t.gpu) {
        Some(FLAG_DISCRETE)
    } else if is_integrated(&t.gpu) {
        Some(FLAG_INTEGRATED)
    } else {
        None
    }
}

/// The Chromium flag that pins WebView2 to the GPU presenting the kiosk, or `None`
/// when no flag is warranted (single-GPU rig, dual-discrete, or the target GPU can't
/// be classified — in which case Chromium's own default is left alone).
///
/// Only acts on genuine integrated+discrete hybrids, which is exactly where the
/// cross-adapter frame copy occurs. Virtual displays are dropped before anything is
/// judged: a phantom adapter is neither integrated nor discrete, and one advertising
/// the Edge's 2560×720 would otherwise be chosen as the target and pin the webview to
/// a GPU that presents nothing.
fn decide(displays: &[Display], presenting: Option<&str>) -> Option<&'static str> {
    if !hybrid(displays) {
        // The render and present GPUs already agree; forcing an adapter here could
        // only pick the wrong one, so leave Chromium's default.
        return None;
    }
    flag_for_target(displays, presenting)
}

/// A genuine integrated + discrete pair among the real (non-virtual) displays —
/// the only shape where the cross-adapter frame copy can occur, and therefore the
/// only shape where any of this applies.
fn hybrid(displays: &[Display]) -> bool {
    let real: Vec<&Display> = displays.iter().filter(|d| !d.virtual_display).collect();
    real.iter().any(|d| integrated_only(&d.gpu)) && real.iter().any(|d| is_discrete(&d.gpu))
}

/// Whether this machine is a hybrid iGPU+dGPU rig right now. Read by the tray, which
/// offers the pin toggle only where it does something: a control that is present and
/// inert on every single-GPU PC is worse than no control at all.
///
/// Deliberately independent of the user's preference and of what we pinned, so
/// turning the toggle off cannot make the toggle itself disappear.
pub fn is_hybrid() -> bool {
    hybrid(&enumerate_displays())
}

/// The flag this process launched with. `None` means "we expressed no preference",
/// which is both the no-flag case and the user having turned pinning off.
static APPLIED: OnceLock<Option<&'static str>> = OnceLock::new();
/// Whether pinning is enabled at all (the user's `gpu_pin` preference). Read by
/// `mismatch`, which must stay quiet when the user has opted out — there is nothing
/// to restart *for* if we deliberately never pinned.
static PINNING: AtomicBool = AtomicBool::new(true);

/// Decide the launch flag once, record it, and hand it back. Called from `lib.rs`
/// before the first webview is built, with the screen `monitor::initial_screen_name`
/// says the window will open on; every later builder reads `applied()`.
///
/// Idempotent: a second call returns the first decision rather than re-deciding, so
/// a display change between two window creations cannot hand two webviews different
/// environment options (which WebView2 answers by silently refusing the second).
pub fn arm(pin_enabled: bool, presenting: Option<&str>) -> Option<&'static str> {
    PINNING.store(pin_enabled, Ordering::SeqCst);
    *APPLIED.get_or_init(|| {
        if pin_enabled { decide(&enumerate_displays(), presenting) } else { None }
    })
}

/// The flag every webview in this process must be built with. `None` before `arm`,
/// which is the same answer as "no preference" and therefore safe.
pub fn applied() -> Option<&'static str> {
    APPLIED.get().copied().flatten()
}

/// True when the adapter we pinned at launch is no longer the one presenting the
/// kiosk — a display was plugged in, unplugged, or moved, and the cross-adapter frame
/// copy is back. `presenting` is the screen the window is on NOW. Only a restart can
/// change the pin, so this is what Settings → Screen reports.
///
/// Deliberately quiet in three cases: pinning turned off (we made no claim), no flag
/// applied (Chromium's own default is in charge, and its choice tracks the window),
/// and an unclassifiable target (guessing would produce a restart prompt that fixes
/// nothing).
pub fn mismatch(presenting: Option<&str>) -> bool {
    if !PINNING.load(Ordering::SeqCst) {
        return false;
    }
    let Some(applied) = applied() else { return false };
    match flag_for_target(&enumerate_displays(), presenting) {
        Some(now) => now != applied,
        None => false,
    }
}

/// Whether a see-through window on `presenting` would be drawn by the same
/// adapter that shows it. A transparent webview composed across adapters renders
/// BLANK (spotlight_window.rs), so the main window is only built see-through when
/// this holds. The rule itself lives in `see_through::drawn_where_shown`, where it
/// is tested on every platform; this only reads the machine for it.
pub fn see_through_ok(presenting: Option<&str>) -> bool {
    let displays = enumerate_displays();
    let adapters: Vec<&str> =
        displays.iter().filter(|d| !d.virtual_display).map(|d| d.gpu.as_str()).collect();
    crate::see_through::drawn_where_shown(&adapters, applied(), flag_for_target(&displays, presenting))
}
