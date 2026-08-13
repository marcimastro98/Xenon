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

const ENUM_CURRENT_SETTINGS: u32 = 0xFFFF_FFFF;
const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP: u32 = 0x0000_0001;
const DISPLAY_DEVICE_PRIMARY_DEVICE: u32 = 0x0000_0004;

#[repr(C)]
#[derive(Clone, Copy)]
struct DisplayDeviceW {
    cb: u32,
    device_name: [u16; 32],
    device_string: [u16; 128],
    state_flags: u32,
    device_id: [u16; 128],
    device_key: [u16; 128],
}

// Standard DEVMODEW (display variant of the union). We only read dmPelsWidth/Height,
// but the full 220-byte layout must be exact so `dmSize` is right and the fields sit
// at their true offsets.
#[repr(C)]
#[derive(Clone, Copy)]
struct DevModeW {
    dm_device_name: [u16; 32],
    dm_spec_version: u16,
    dm_driver_version: u16,
    dm_size: u16,
    dm_driver_extra: u16,
    dm_fields: u32,
    dm_position: [i32; 2],
    dm_display_orientation: u32,
    dm_display_fixed_output: u32,
    dm_color: i16,
    dm_duplex: i16,
    dm_y_resolution: i16,
    dm_tt_option: i16,
    dm_collate: i16,
    dm_form_name: [u16; 32],
    dm_log_pixels: u16,
    dm_bits_per_pel: u32,
    dm_pels_width: u32,
    dm_pels_height: u32,
    dm_display_flags: u32,
    dm_display_frequency: u32,
    dm_icm_method: u32,
    dm_icm_intent: u32,
    dm_media_type: u32,
    dm_dither_type: u32,
    dm_reserved1: u32,
    dm_reserved2: u32,
    dm_panning_width: u32,
    dm_panning_height: u32,
}

#[link(name = "user32")]
extern "system" {
    fn EnumDisplayDevicesW(
        lp_device: *const u16,
        i_dev_num: u32,
        lp_display_device: *mut DisplayDeviceW,
        dw_flags: u32,
    ) -> i32;
    fn EnumDisplaySettingsW(
        lpsz_device_name: *const u16,
        i_mode_num: u32,
        lp_dev_mode: *mut DevModeW,
    ) -> i32;
}

/// One attached display and the adapter driving it. Built from Win32 in
/// `enumerate_displays`, and by hand in the tests — every rule below reads this
/// struct and nothing else, which is what makes the decision testable off a real
/// hybrid machine.
struct Display {
    /// The adapter's `DeviceString`, e.g. "AMD Radeon RX 9070 XT".
    gpu: String,
    /// The GDI device name, e.g. `\\.\DISPLAY1`.
    name: String,
    width: u32,
    height: u32,
    primary: bool,
    /// Driven by a virtual/phantom adapter rather than real hardware.
    virtual_display: bool,
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

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

/// Enumerate every attached display with the GPU that drives it and its resolution.
fn enumerate_displays() -> Vec<Display> {
    let mut out = Vec::new();
    let mut i = 0u32;
    loop {
        let mut dd: DisplayDeviceW = unsafe { std::mem::zeroed() };
        dd.cb = std::mem::size_of::<DisplayDeviceW>() as u32;
        // NULL device → enumerate display adapters; DeviceString is the GPU name,
        // DeviceName is "\\.\DISPLAYn".
        if unsafe { EnumDisplayDevicesW(std::ptr::null(), i, &mut dd, 0) } == 0 {
            break;
        }
        i += 1;
        if dd.state_flags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP == 0 {
            continue; // an inactive output — not presenting anything
        }
        let gpu = wide_to_string(&dd.device_string);
        let mut dm: DevModeW = unsafe { std::mem::zeroed() };
        dm.dm_size = std::mem::size_of::<DevModeW>() as u16;
        let (width, height) =
            if unsafe { EnumDisplaySettingsW(dd.device_name.as_ptr(), ENUM_CURRENT_SETTINGS, &mut dm) } != 0 {
                (dm.dm_pels_width, dm.dm_pels_height)
            } else {
                (0, 0)
            };
        out.push(Display {
            virtual_display: is_virtual_adapter(&gpu),
            gpu,
            name: wide_to_string(&dd.device_name),
            width,
            height,
            primary: dd.state_flags & DISPLAY_DEVICE_PRIMARY_DEVICE != 0,
        });
    }
    out
}

/// GDI device names ("\\\\.\\DISPLAYn") of attached displays driven by a virtual
/// display adapter rather than real hardware. Used by `monitor::find_edge` to skip
/// them; shares this module's single enumeration and single definition of "virtual"
/// so the two callers can never disagree about which screens are real.
pub fn virtual_display_names() -> Vec<String> {
    enumerate_displays()
        .into_iter()
        .filter(|d| d.virtual_display)
        .map(|d| d.name)
        .collect()
}

/// The display the kiosk will present on: the Edge when it is connected (matched by
/// its panel size in either orientation), else the primary, else whatever is first —
/// i.e. wherever `monitor::place_now` lands the window.
///
/// Virtual displays are excluded by the caller, not here, so this reads exactly like
/// `monitor::find_edge`: same panel size, same preference order, same skip.
fn target<'a>(real: &'a [&'a Display]) -> Option<&'a Display> {
    real.iter()
        .find(|d| is_edge_size(d.width, d.height))
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
fn flag_for_target(displays: &[Display]) -> Option<&'static str> {
    let real: Vec<&Display> = displays.iter().filter(|d| !d.virtual_display).collect();
    let t = target(&real)?;
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
fn decide(displays: &[Display]) -> Option<&'static str> {
    if !hybrid(displays) {
        // The render and present GPUs already agree; forcing an adapter here could
        // only pick the wrong one, so leave Chromium's default.
        return None;
    }
    flag_for_target(displays)
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
/// before the first webview is built; every later builder reads `applied()`.
///
/// Idempotent: a second call returns the first decision rather than re-deciding, so
/// a display change between two window creations cannot hand two webviews different
/// environment options (which WebView2 answers by silently refusing the second).
pub fn arm(pin_enabled: bool) -> Option<&'static str> {
    PINNING.store(pin_enabled, Ordering::SeqCst);
    *APPLIED.get_or_init(|| if pin_enabled { decide(&enumerate_displays()) } else { None })
}

/// The flag every webview in this process must be built with. `None` before `arm`,
/// which is the same answer as "no preference" and therefore safe.
pub fn applied() -> Option<&'static str> {
    APPLIED.get().copied().flatten()
}

/// True when the adapter we pinned at launch is no longer the one presenting the
/// kiosk — a display was plugged in, unplugged, or moved, and the cross-adapter frame
/// copy is back. Only a restart can change the pin, so this is what the tray's
/// Restart entry reports.
///
/// Deliberately quiet in three cases: pinning turned off (we made no claim), no flag
/// applied (Chromium's own default is in charge, and its choice tracks the window),
/// and an unclassifiable target (guessing would produce a restart prompt that fixes
/// nothing).
pub fn mismatch() -> bool {
    if !PINNING.load(Ordering::SeqCst) {
        return false;
    }
    let Some(applied) = applied() else { return false };
    match flag_for_target(&enumerate_displays()) {
        Some(now) => now != applied,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(gpu: &str, w: u32, h: u32, primary: bool) -> Display {
        Display {
            virtual_display: is_virtual_adapter(gpu),
            gpu: gpu.to_string(),
            name: "\\\\.\\DISPLAY1".to_string(),
            width: w,
            height: h,
            primary,
        }
    }

    const IGPU: &str = "AMD Radeon(TM) Graphics";
    const RADEON: &str = "AMD Radeon RX 9070 XT";
    const NVIDIA: &str = "NVIDIA GeForce RTX 5080";
    const INTEL_IGPU: &str = "Intel(R) UHD Graphics 770";
    const ARC: &str = "Intel(R) Arc (TM) A770 Graphics";
    const VDD: &str = "Virtual Display Driver";

    // ── not a hybrid → no opinion ───────────────────────────────────────
    #[test]
    fn single_discrete_gpu_is_left_alone() {
        assert_eq!(decide(&[d(RADEON, 2560, 1440, true)]), None);
    }

    #[test]
    fn single_integrated_gpu_is_left_alone() {
        assert_eq!(decide(&[d(IGPU, 1920, 1080, true)]), None);
    }

    #[test]
    fn dual_discrete_is_left_alone() {
        assert_eq!(
            decide(&[d(NVIDIA, 2560, 1440, true), d(RADEON, 1920, 1080, false)]),
            None
        );
    }

    /// An Intel Arc is discrete and its name contains "intel". Judging with
    /// `is_integrated` alone made an Arc + NVIDIA rig look like a hybrid and pinned
    /// the webview to the Arc as the "low power" adapter.
    #[test]
    fn intel_arc_is_not_an_integrated_gpu() {
        assert!(is_discrete(ARC));
        assert!(!integrated_only(ARC));
        assert_eq!(
            decide(&[d(ARC, 2560, 1440, true), d(NVIDIA, 1920, 1080, false)]),
            None
        );
    }

    // ── the real case: iGPU + dGPU ──────────────────────────────────────
    /// Rashid's machine: the Edge on the motherboard USB-C (so on the APU's
    /// integrated graphics) plus a monitor on the discrete card.
    #[test]
    fn edge_on_the_igpu_pins_to_the_integrated_adapter() {
        assert_eq!(
            decide(&[
                d(RADEON, 2560, 1440, true),
                d(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false),
            ]),
            Some(FLAG_INTEGRATED)
        );
    }

    #[test]
    fn edge_on_the_discrete_card_pins_to_the_discrete_adapter() {
        assert_eq!(
            decide(&[
                d(INTEL_IGPU, 1920, 1080, true),
                d(NVIDIA, EDGE_WIDTH, EDGE_HEIGHT, false),
            ]),
            Some(FLAG_DISCRETE)
        );
    }

    /// A panel MOUNTED VERTICALLY reports its rotated mode, so the same Edge
    /// answers 720×2560. `monitor.rs` recognises that now, and this module has to
    /// agree or the pin aims at the adapter driving a screen the window is not on
    /// — the same split the virtual-display test below exists for.
    #[test]
    fn a_vertically_mounted_edge_is_still_the_target() {
        assert_eq!(
            decide(&[
                d(RADEON, 2560, 1440, true),
                d(IGPU, EDGE_HEIGHT, EDGE_WIDTH, false),
            ]),
            Some(FLAG_INTEGRATED)
        );
        assert!(is_edge_size(EDGE_HEIGHT, EDGE_WIDTH));
        assert!(is_edge_size(EDGE_WIDTH, EDGE_HEIGHT));
        // …and rotation must not widen the signature into "either dimension".
        assert!(!is_edge_size(EDGE_WIDTH, EDGE_WIDTH));
        assert!(!is_edge_size(EDGE_HEIGHT, EDGE_HEIGHT));
        assert!(!is_edge_size(1920, 1080));
    }

    /// No Edge attached: the kiosk lands on the primary, so the flag follows it.
    #[test]
    fn without_an_edge_the_primary_display_decides() {
        assert_eq!(
            decide(&[d(NVIDIA, 2560, 1440, true), d(INTEL_IGPU, 1920, 1080, false)]),
            Some(FLAG_DISCRETE)
        );
        assert_eq!(
            decide(&[d(INTEL_IGPU, 1920, 1080, true), d(NVIDIA, 2560, 1440, false)]),
            Some(FLAG_INTEGRATED)
        );
    }

    // ── virtual displays ────────────────────────────────────────────────
    /// The second-screen VDD advertises 2560×720, the Edge's exact panel size. Before
    /// it was excluded, it won the target search and pinned the webview to a phantom
    /// adapter — while `monitor::find_edge`, which does skip it, put the window on the
    /// real Edge. The two modules disagreeing is the whole bug.
    #[test]
    fn a_virtual_display_never_becomes_the_target() {
        let displays = [
            d(RADEON, 2560, 1440, true),
            d(VDD, EDGE_WIDTH, EDGE_HEIGHT, false),
            d(IGPU, 1920, 1080, false),
        ];
        // The real Edge is absent, so the primary (discrete) decides — not the VDD.
        assert_eq!(decide(&displays), Some(FLAG_DISCRETE));
    }

    /// A virtual adapter is neither integrated nor discrete, so it must not be able
    /// to make a single-GPU machine look like a hybrid.
    #[test]
    fn a_virtual_display_cannot_create_a_hybrid() {
        assert_eq!(
            decide(&[d(RADEON, 2560, 1440, true), d(VDD, EDGE_WIDTH, EDGE_HEIGHT, false)]),
            None
        );
    }

    /// With both present, the real Edge wins over the phantom of the same size.
    #[test]
    fn the_real_edge_wins_over_a_virtual_display_of_the_same_size() {
        assert_eq!(
            decide(&[
                d(RADEON, 2560, 1440, true),
                d(VDD, EDGE_WIDTH, EDGE_HEIGHT, false),
                d(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false),
            ]),
            Some(FLAG_INTEGRATED)
        );
    }

    #[test]
    fn virtual_names_are_reported_for_the_monitor_module() {
        assert!(is_virtual_adapter("Virtual Display Driver"));
        assert!(is_virtual_adapter("MttVDD"));
        assert!(is_virtual_adapter("IddSampleDriver Device"));
        assert!(!is_virtual_adapter(RADEON));
        assert!(!is_virtual_adapter(IGPU));
    }

    // ── mismatch: what the tray reports ─────────────────────────────────
    /// The Edge is unplugged after launch. We are still rendering on the integrated
    /// adapter while the kiosk now presents on the discrete one — the cross-adapter
    /// copy is back, and only a restart can undo it.
    #[test]
    fn unplugging_the_edge_leaves_the_pin_pointing_at_the_wrong_adapter() {
        let after = [d(RADEON, 2560, 1440, true)];
        assert_eq!(flag_for_target(&after), Some(FLAG_DISCRETE));
        // decide() alone would now say None (no longer a hybrid), which is exactly
        // why mismatch asks flag_for_target instead.
        assert_eq!(decide(&after), None);
    }

    /// The Edge arrives after launch: launched on the primary (discrete), now
    /// presenting on the integrated adapter.
    #[test]
    fn plugging_the_edge_in_after_launch_is_a_mismatch() {
        let before = [d(NVIDIA, 2560, 1440, true), d(INTEL_IGPU, 1920, 1080, false)];
        let after = [
            d(NVIDIA, 2560, 1440, true),
            d(INTEL_IGPU, EDGE_WIDTH, EDGE_HEIGHT, false),
        ];
        assert_eq!(decide(&before), Some(FLAG_DISCRETE));
        assert_eq!(flag_for_target(&after), Some(FLAG_INTEGRATED));
    }

    /// Moving a second monitor around must not be reported: the target is unchanged,
    /// so a restart would fix nothing and the prompt would be noise.
    #[test]
    fn an_unrelated_display_change_is_not_a_mismatch() {
        let before = [
            d(RADEON, 2560, 1440, true),
            d(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false),
        ];
        let after = [
            d(RADEON, 2560, 1440, true),
            d(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false),
            d(RADEON, 1920, 1080, false),
        ];
        assert_eq!(decide(&before), flag_for_target(&after));
    }

    /// An unclassifiable adapter yields no flag, and therefore no restart prompt.
    #[test]
    fn an_unknown_adapter_produces_no_opinion() {
        assert_eq!(flag_for_target(&[d("Generic PnP Adapter", 1920, 1080, true)]), None);
    }
}
