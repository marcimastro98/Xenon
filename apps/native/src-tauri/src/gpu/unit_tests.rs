// Tests of which graphics card the app asks for.

use super::{decide, EDGE_HEIGHT, EDGE_WIDTH, FLAG_DISCRETE, flag_for_target, FLAG_INTEGRATED, integrated_only, is_discrete, is_edge_size, is_virtual_adapter};
use super::displays::Display;

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
        assert_eq!(decide(&[d(RADEON, 2560, 1440, true)], None), None);
    }

    #[test]
    fn single_integrated_gpu_is_left_alone() {
        assert_eq!(decide(&[d(IGPU, 1920, 1080, true)], None), None);
    }

    #[test]
    fn dual_discrete_is_left_alone() {
        assert_eq!(
            decide(&[d(NVIDIA, 2560, 1440, true), d(RADEON, 1920, 1080, false)], None),
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
            decide(&[d(ARC, 2560, 1440, true), d(NVIDIA, 1920, 1080, false)], None),
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
            ], None),
            Some(FLAG_INTEGRATED)
        );
    }

    #[test]
    fn edge_on_the_discrete_card_pins_to_the_discrete_adapter() {
        assert_eq!(
            decide(&[
                d(INTEL_IGPU, 1920, 1080, true),
                d(NVIDIA, EDGE_WIDTH, EDGE_HEIGHT, false),
            ], None),
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
            ], None),
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
            decide(&[d(NVIDIA, 2560, 1440, true), d(INTEL_IGPU, 1920, 1080, false)], None),
            Some(FLAG_DISCRETE)
        );
        assert_eq!(
            decide(&[d(INTEL_IGPU, 1920, 1080, true), d(NVIDIA, 2560, 1440, false)], None),
            Some(FLAG_INTEGRATED)
        );
    }

    // ── the screen the user chose ───────────────────────────────────────
    fn on(gpu: &str, w: u32, h: u32, primary: bool, name: &str) -> Display {
        Display { name: name.to_string(), ..d(gpu, w, h, primary) }
    }

    /// Main monitor on the graphics card, a spare screen on the motherboard output
    /// chosen for Xenon. Judging by "primary" pinned the webview to the card while
    /// the window was on the iGPU's screen: every frame copied across adapters.
    #[test]
    fn a_chosen_screen_on_the_igpu_pins_to_the_integrated_adapter() {
        let displays = [
            on(NVIDIA, 2560, 1440, true, "\\\\.\\DISPLAY1"),
            on(IGPU, 1920, 1080, false, "\\\\.\\DISPLAY2"),
        ];
        assert_eq!(decide(&displays, Some("\\\\.\\DISPLAY2")), Some(FLAG_INTEGRATED));
        assert_eq!(decide(&displays, None), Some(FLAG_DISCRETE));
    }

    /// The chosen screen beats an Edge that is attached but not where the window is.
    #[test]
    fn a_chosen_screen_beats_an_attached_edge() {
        let displays = [
            on(RADEON, 2560, 1440, true, "\\\\.\\DISPLAY1"),
            on(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false, "\\\\.\\DISPLAY2"),
        ];
        assert_eq!(decide(&displays, Some("\\\\.\\DISPLAY1")), Some(FLAG_DISCRETE));
    }

    /// A name that is not attached, or names a virtual display, falls back to the
    /// old guess instead of producing no opinion.
    #[test]
    fn an_unknown_or_virtual_presenting_name_falls_back() {
        let displays = [
            on(RADEON, 2560, 1440, true, "\\\\.\\DISPLAY1"),
            on(VDD, 1920, 1080, false, "\\\\.\\DISPLAY3"),
            on(IGPU, EDGE_WIDTH, EDGE_HEIGHT, false, "\\\\.\\DISPLAY2"),
        ];
        assert_eq!(decide(&displays, Some("\\\\.\\DISPLAY9")), Some(FLAG_INTEGRATED));
        assert_eq!(decide(&displays, Some("\\\\.\\DISPLAY3")), Some(FLAG_INTEGRATED));
    }

    /// The window moved to a screen on the other adapter after launch: the pin
    /// is now wrong and Settings must say so.
    #[test]
    fn moving_the_window_to_the_other_adapter_is_a_mismatch() {
        let displays = [
            on(NVIDIA, 2560, 1440, true, "\\\\.\\DISPLAY1"),
            on(INTEL_IGPU, 1920, 1080, false, "\\\\.\\DISPLAY2"),
        ];
        let launched = decide(&displays, Some("\\\\.\\DISPLAY1"));
        assert_ne!(launched, flag_for_target(&displays, Some("\\\\.\\DISPLAY2")));
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
        assert_eq!(decide(&displays, None), Some(FLAG_DISCRETE));
    }

    /// A virtual adapter is neither integrated nor discrete, so it must not be able
    /// to make a single-GPU machine look like a hybrid.
    #[test]
    fn a_virtual_display_cannot_create_a_hybrid() {
        assert_eq!(
            decide(&[d(RADEON, 2560, 1440, true), d(VDD, EDGE_WIDTH, EDGE_HEIGHT, false)], None),
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
            ], None),
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
        assert_eq!(flag_for_target(&after, None), Some(FLAG_DISCRETE));
        // decide() alone would now say None (no longer a hybrid), which is exactly
        // why mismatch asks flag_for_target instead.
        assert_eq!(decide(&after, None), None);
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
        assert_eq!(decide(&before, None), Some(FLAG_DISCRETE));
        assert_eq!(flag_for_target(&after, None), Some(FLAG_INTEGRATED));
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
        assert_eq!(decide(&before, None), flag_for_target(&after, None));
    }

    /// An unclassifiable adapter yields no flag, and therefore no restart prompt.
    #[test]
    fn an_unknown_adapter_produces_no_opinion() {
        assert_eq!(flag_for_target(&[d("Generic PnP Adapter", 1920, 1080, true)], None), None);
    }
}
