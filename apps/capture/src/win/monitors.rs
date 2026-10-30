//! The monitors, in the order Windows enumerates them, with whether each one
//! is in HDR and the user's SDR white level on it.

use windows::core::{Interface, BOOL};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{LPARAM, RECT, WIN32_ERROR};
use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

/// Windows' default SDR content brightness, in scRGB units (200 nits / 80).
pub const DEFAULT_WHITE: f32 = 2.5;

pub struct Monitor {
    pub handle: HMONITOR,
    pub index: usize,
    pub rect: RECT,
    pub primary: bool,
    pub name: String,
    pub hdr: bool,
    /// SDR white in scRGB units (nits / 80); only meaningful when `hdr`.
    pub white: f32,
}

unsafe extern "system" fn collect(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<HMONITOR>);
    list.push(h);
    BOOL(1)
}

fn wide_to_string(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

fn info(h: HMONITOR) -> Option<(RECT, bool, String)> {
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe { GetMonitorInfoW(h, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO) };
    if !ok.as_bool() {
        return None;
    }
    let primary = mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0;
    Some((
        mi.monitorInfo.rcMonitor,
        primary,
        wide_to_string(&mi.szDevice),
    ))
}

/// HMONITOR of every output DXGI reports as HDR10 (PQ, BT.2020).
fn hdr_monitors() -> Vec<HMONITOR> {
    let mut out = Vec::new();
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return out;
    };
    let mut a = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        let mut o = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            if let Ok(o6) = output.cast::<IDXGIOutput6>() {
                if let Ok(desc) = unsafe { o6.GetDesc1() } {
                    if desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 {
                        out.push(desc.Monitor);
                    }
                }
            }
            o += 1;
        }
        a += 1;
    }
    out
}

/// The SDR white level of the display whose GDI name is `gdi_name`, in scRGB units.
fn sdr_white(gdi_name: &str) -> Option<f32> {
    let (mut np, mut nm) = (0u32, 0u32);
    if unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) }
        != WIN32_ERROR(0)
    {
        return None;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
    let rc = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            None,
        )
    };
    if rc != WIN32_ERROR(0) {
        return None;
    }
    for p in paths.iter().take(np as usize) {
        let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: p.sourceInfo.adapterId,
                id: p.sourceInfo.id,
            },
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut src.header) } != 0
            || wide_to_string(&src.viewGdiDeviceName) != gdi_name
        {
            continue;
        }
        let mut w = DISPLAYCONFIG_SDR_WHITE_LEVEL {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                size: std::mem::size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32,
                adapterId: p.targetInfo.adapterId,
                id: p.targetInfo.id,
            },
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut w.header) } != 0 {
            return None;
        }
        // SDRWhiteLevel is in thousandths of 80 nits, i.e. already scRGB x1000.
        let white = w.SDRWhiteLevel as f32 / 1000.0;
        return (1.0..=50.0).contains(&white).then_some(white);
    }
    None
}

pub fn list() -> Vec<Monitor> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        );
    }
    let hdr = hdr_monitors();
    handles
        .into_iter()
        .filter_map(|h| info(h).map(|i| (h, i)))
        .enumerate()
        .map(|(index, (handle, (rect, primary, name)))| {
            let is_hdr = hdr.contains(&handle);
            let white = if is_hdr {
                sdr_white(&name).unwrap_or(DEFAULT_WHITE)
            } else {
                DEFAULT_WHITE
            };
            Monitor {
                handle,
                index,
                rect,
                primary,
                name,
                hdr: is_hdr,
                white,
            }
        })
        .collect()
}
