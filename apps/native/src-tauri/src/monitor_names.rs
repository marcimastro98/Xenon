//! The name a person knows a screen by: the model the monitor reports. Windows only
//! hands the shell a device path (`\\.\DISPLAY2`), which says nothing about which
//! screen it is, so there the model comes from the display configuration.

#[cfg(not(windows))]
use std::collections::HashMap;

use tauri::Monitor;

/// The model name of each monitor, in the same order. Empty when the system has none:
/// a laptop panel or a dock often reports nothing, and the menu then falls back on a
/// number and the size.
pub fn model_names(monitors: &[Monitor]) -> Vec<String> {
    let models = models_by_device();
    monitors
        .iter()
        .map(|m| {
            let os = m.name().map(String::as_str).unwrap_or("");
            models.get(os).cloned().unwrap_or_else(|| os.to_owned())
        })
        .collect()
}

/// What the menu shows for a screen. A device path is not a name; the Edge panel is
/// known by its size even when its EDID says nothing.
pub fn display_name(found: &str, edge: bool) -> String {
    let name = found.trim();
    if !name.is_empty() && !name.starts_with(r"\\.\") {
        return name.to_owned();
    }
    if edge {
        "Xeneon Edge".to_owned()
    } else {
        String::new()
    }
}

#[cfg(not(windows))]
fn models_by_device() -> HashMap<String, String> {
    HashMap::new()
}

#[cfg(windows)]
use win::models_by_device;

/// Hand-written bindings for the three display-configuration calls: the shell has no
/// `windows` crate, and the sizes below are the Win32 ABI (checked at compile time).
#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::mem::size_of;
    use std::ptr::null_mut;

    const QDC_ONLY_ACTIVE_PATHS: u32 = 2;
    const GET_SOURCE_NAME: u32 = 1;
    const GET_TARGET_NAME: u32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Luid {
        low: u32,
        high: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct PathSource {
        adapter: Luid,
        id: u32,
        mode: u32,
        status: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct PathTarget {
        adapter: Luid,
        id: u32,
        mode: u32,
        technology: u32,
        rotation: u32,
        scaling: u32,
        refresh: [u32; 2],
        scanline: u32,
        available: i32,
        status: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct PathInfo {
        source: PathSource,
        target: PathTarget,
        flags: u32,
    }

    #[repr(C, align(8))]
    #[derive(Clone, Copy)]
    struct ModeInfo([u8; 64]);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Header {
        kind: u32,
        size: u32,
        adapter: Luid,
        id: u32,
    }

    #[repr(C)]
    struct SourceName {
        header: Header,
        device: [u16; 32],
    }

    #[repr(C)]
    struct TargetName {
        header: Header,
        flags: u32,
        technology: u32,
        edid_maker: u16,
        edid_product: u16,
        connector: u32,
        friendly: [u16; 64],
        path: [u16; 128],
    }

    const _: () = assert!(size_of::<PathInfo>() == 72);
    const _: () = assert!(size_of::<ModeInfo>() == 64);
    const _: () = assert!(size_of::<Header>() == 20);
    const _: () = assert!(size_of::<SourceName>() == 84);
    const _: () = assert!(size_of::<TargetName>() == 420);

    #[link(name = "user32")]
    extern "system" {
        fn GetDisplayConfigBufferSizes(flags: u32, paths: *mut u32, modes: *mut u32) -> i32;
        fn QueryDisplayConfig(
            flags: u32,
            path_count: *mut u32,
            paths: *mut PathInfo,
            mode_count: *mut u32,
            modes: *mut ModeInfo,
            topology: *mut u32,
        ) -> i32;
        fn DisplayConfigGetDeviceInfo(header: *mut Header) -> i32;
    }

    fn wide(s: &[u16]) -> String {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf16_lossy(&s[..end])
    }

    fn source_device(p: &PathInfo) -> Option<String> {
        let mut name = SourceName {
            header: Header {
                kind: GET_SOURCE_NAME,
                size: size_of::<SourceName>() as u32,
                adapter: p.source.adapter,
                id: p.source.id,
            },
            device: [0; 32],
        };
        let rc = unsafe { DisplayConfigGetDeviceInfo(&mut name.header) };
        (rc == 0).then(|| wide(&name.device))
    }

    fn target_model(p: &PathInfo) -> Option<String> {
        let mut name = TargetName {
            header: Header {
                kind: GET_TARGET_NAME,
                size: size_of::<TargetName>() as u32,
                adapter: p.target.adapter,
                id: p.target.id,
            },
            flags: 0,
            technology: 0,
            edid_maker: 0,
            edid_product: 0,
            connector: 0,
            friendly: [0; 64],
            path: [0; 128],
        };
        let rc = unsafe { DisplayConfigGetDeviceInfo(&mut name.header) };
        (rc == 0).then(|| wide(&name.friendly))
    }

    /// Device path to model, for every active screen. Empty on any failure: the menu
    /// then says a number, which is what it said before.
    pub fn models_by_device() -> HashMap<String, String> {
        let (mut path_count, mut mode_count) = (0u32, 0u32);
        let sized = unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        };
        if sized != 0 {
            return HashMap::new();
        }
        let mut paths = vec![PathInfo::default(); path_count as usize];
        let mut modes = vec![ModeInfo([0; 64]); mode_count as usize];
        let rc = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                null_mut(),
            )
        };
        if rc != 0 {
            return HashMap::new();
        }
        paths
            .iter()
            .take(path_count as usize)
            .filter_map(|p| Some((source_device(p)?, target_model(p)?)))
            .filter(|(_, model)| !model.is_empty())
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reads_the_active_screens_without_failing() {
            for (device, model) in models_by_device() {
                assert!(device.starts_with(r"\\.\"), "{device}");
                assert!(!model.is_empty());
            }
        }

        #[test]
        fn stops_at_the_terminator() {
            assert_eq!(wide(&[0x44, 0x45, 0, 0x46]), "DE");
            assert_eq!(wide(&[0x44, 0x45]), "DE");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::display_name;

    #[test]
    fn a_model_is_kept_as_it_is() {
        assert_eq!(display_name("  DELL U2720Q ", false), "DELL U2720Q");
        assert_eq!(display_name("XENEON EDGE", true), "XENEON EDGE");
    }

    #[test]
    fn a_device_path_is_not_a_name() {
        assert_eq!(display_name(r"\\.\DISPLAY2", false), "");
        assert_eq!(display_name("", false), "");
    }

    #[test]
    fn the_edge_is_named_when_nothing_says_so() {
        assert_eq!(display_name(r"\\.\DISPLAY3", true), "Xeneon Edge");
        assert_eq!(display_name("", true), "Xeneon Edge");
    }
}
