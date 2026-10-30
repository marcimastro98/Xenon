//! Puts a picked area on the clipboard as a CF_DIB bitmap, which every app that
//! pastes images reads, saved files as CF_HDROP, which Explorer, chat apps
//! and mail paste as the files themselves (the same as Copy in Explorer), and
//! text read off the screen as CF_UNICODETEXT.

use std::time::Duration;

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND, POINT};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::DROPFILES;
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP};

/// Another app may hold the clipboard for a moment; try a few times.
const OPEN_TRIES: u32 = 10;
const OPEN_PAUSE: Duration = Duration::from_millis(20);

/// `owner` must be one of our windows: with no owner Windows refuses the data.
pub fn copy(owner: HWND, dib: &[u8]) -> bool {
    put_on(owner, CF_DIB.0 as u32, dib)
}

/// The files at `paths` (absolute), as Explorer copies them. Uses a hidden
/// window of its own as the owner, gone once the data is handed over.
pub fn copy_files(paths: &[String]) -> bool {
    with_own_window(CF_HDROP.0 as u32, &drop_files(paths))
}

/// `text` as Unicode text, with a hidden window of its own as the owner.
pub fn copy_text(text: &str) -> bool {
    with_own_window(CF_UNICODETEXT.0 as u32, &wide_text(text))
}

/// UTF-16 ending in a NUL, as CF_UNICODETEXT wants it.
fn wide_text(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn with_own_window(format: u32, data: &[u8]) -> bool {
    unsafe {
        let Ok(owner) = CreateWindowExW(
            Default::default(),
            w!("STATIC"),
            None,
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) else {
            return false;
        };
        let done = put_on(owner, format, data);
        let _ = DestroyWindow(owner);
        done
    }
}

/// A DROPFILES header, then each path in UTF-16 ending in a NUL, then one more NUL.
fn drop_files(paths: &[String]) -> Vec<u8> {
    let header = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        pt: POINT::default(),
        fNC: BOOL(0),
        fWide: BOOL(1),
    };
    let mut out = unsafe {
        std::slice::from_raw_parts(
            (&header as *const DROPFILES).cast::<u8>(),
            size_of::<DROPFILES>(),
        )
    }
    .to_vec();
    for p in paths {
        for u in p.encode_utf16().chain(std::iter::once(0)) {
            out.extend_from_slice(&u.to_le_bytes());
        }
    }
    out.extend_from_slice(&[0, 0]);
    out
}

fn put_on(owner: HWND, format: u32, bytes: &[u8]) -> bool {
    let opened = (0..OPEN_TRIES).any(|_| {
        let ok = unsafe { OpenClipboard(Some(owner)) }.is_ok();
        if !ok {
            std::thread::sleep(OPEN_PAUSE);
        }
        ok
    });
    if !opened {
        return false;
    }
    let done = unsafe { put(format, bytes) };
    unsafe {
        let _ = CloseClipboard();
    }
    done
}

unsafe fn put(format: u32, dib: &[u8]) -> bool {
    if EmptyClipboard().is_err() {
        return false;
    }
    let Ok(mem) = GlobalAlloc(GMEM_MOVEABLE, dib.len()) else {
        return false;
    };
    let dst = GlobalLock(mem) as *mut u8;
    if dst.is_null() {
        let _ = GlobalFree(Some(mem));
        return false;
    }
    std::ptr::copy_nonoverlapping(dib.as_ptr(), dst, dib.len());
    let _ = GlobalUnlock(mem);
    // On success the clipboard owns the memory; on failure it is still ours.
    if SetClipboardData(format, Some(HANDLE(mem.0))).is_err() {
        let _ = GlobalFree(Some(mem));
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_wide_and_ends_in_one_nul() {
        assert_eq!(wide_text("aè"), vec![b'a', 0, 0xe8, 0, 0, 0]);
        assert_eq!(wide_text(""), vec![0, 0]);
    }

    #[test]
    fn drop_files_is_a_header_then_wide_paths_ending_in_two_nuls() {
        let data = drop_files(&[r"C:\a.mp4".into(), r"D:\è.png".into()]);
        let head = size_of::<DROPFILES>();
        assert_eq!(
            u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize,
            head
        );
        let wide: Vec<u16> = data[head..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16(&wide).unwrap();
        assert_eq!(text, "C:\\a.mp4\0D:\\è.png\0\0");
    }
}
