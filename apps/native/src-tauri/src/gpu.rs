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
//! Pure Win32 FFI (no `windows` crate) to keep the tiny, dependency-free binary,
//! matching the style in `monitor.rs`.

// Native panel resolution of the CORSAIR Xeneon Edge — the reliable signal for
// which display is the Edge (mirrors `monitor::is_edge`).
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

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

struct Display {
    gpu: String,
    width: u32,
    height: u32,
    primary: bool,
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// A GPU name that belongs to an integrated adapter (Intel iGPU, or an AMD APU's
/// "Radeon(TM) Graphics"). Checked AFTER `is_discrete` so Intel Arc (discrete) wins.
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
            gpu,
            width,
            height,
            primary: dd.state_flags & DISPLAY_DEVICE_PRIMARY_DEVICE != 0,
        });
    }
    out
}

/// The Chromium flag that pins WebView2 to the GPU presenting the kiosk window, or
/// `None` when no flag is warranted (single-GPU rig, dual-discrete, or the target
/// GPU can't be classified — in which case Chromium's own default is left alone).
///
/// Only acts on genuine integrated+discrete hybrids, which is exactly where the
/// cross-adapter frame copy occurs. The target is the Edge when it is connected
/// (matched by its 2560×720 panel), else the primary display — i.e. wherever the
/// kiosk actually lands (see `monitor::place_now`).
pub fn webview_gpu_flag() -> Option<&'static str> {
    let displays = enumerate_displays();

    // Not a hybrid iGPU+dGPU machine → the render and present GPUs already agree;
    // forcing an adapter here could only pick the wrong one, so leave the default.
    let has_integrated = displays.iter().any(|d| is_integrated(&d.gpu));
    let has_discrete = displays.iter().any(|d| is_discrete(&d.gpu));
    if !(has_integrated && has_discrete) {
        return None;
    }

    let target = displays
        .iter()
        .find(|d| d.width == EDGE_WIDTH && d.height == EDGE_HEIGHT)
        .or_else(|| displays.iter().find(|d| d.primary))
        .or_else(|| displays.first())?;

    // Match the flag to the target display's GPU (discrete check first so Intel Arc
    // is not misread as integrated).
    if is_discrete(&target.gpu) {
        Some("--force_high_performance_gpu")
    } else if is_integrated(&target.gpu) {
        Some("--force_low_power_gpu")
    } else {
        None
    }
}
