// Windows: the attached displays and the graphics card that drives each one, read from Win32.

use super::is_virtual_adapter;

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
pub(super) struct Display {
    /// The adapter's `DeviceString`, e.g. "AMD Radeon RX 9070 XT".
    pub(super) gpu: String,
    /// The GDI device name, e.g. `\\.\DISPLAY1`.
    pub(super) name: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) primary: bool,
    /// Driven by a virtual/phantom adapter rather than real hardware.
    pub(super) virtual_display: bool,
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Enumerate every attached display with the GPU that drives it and its resolution.
pub(super) fn enumerate_displays() -> Vec<Display> {
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
