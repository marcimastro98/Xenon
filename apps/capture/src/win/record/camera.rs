//! The webcam in a recording: a thread of its own reads the first camera with
//! Media Foundation and keeps only its latest picture, as BGRA rows, for the
//! painter to draw in a bubble. The camera is opened only when the user asked
//! for it on this recording, and let go (its light off) when the recording ends.
//!
//! Built with the `test-camera` feature, a moving test picture stands in for
//! the camera, so a recording with the bubble can be checked on a machine
//! without turning a real camera on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// How long the camera may take to hand its first picture before the
/// recording goes on without it.
const OPEN_TIMEOUT: Duration = Duration::from_secs(4);

/// The tallest camera picture asked for: the bubble is a few hundred pixels,
/// a larger one only costs decoding.
#[cfg_attr(feature = "test-camera", allow(dead_code))]
const MAX_HEIGHT: u32 = 720;

pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    /// Goes up with every new picture, so the painter uploads each one once.
    pub seq: u64,
}

pub struct Camera {
    latest: Arc<Mutex<Option<Picture>>>,
    stop: Arc<AtomicBool>,
}

impl Camera {
    /// The camera, once it handed its first picture; None when there is no
    /// camera, another app holds it, or it did not answer in time.
    pub fn open() -> Option<Camera> {
        let latest = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready, rx) = mpsc::channel();
        let (l, s) = (latest.clone(), stop.clone());
        std::thread::spawn(move || read(l, s, ready));
        match rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(true) => Some(Camera { latest, stop }),
            _ => {
                stop.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// Runs `f` on the latest picture, if the camera still has one.
    pub fn with_latest<R>(&self, f: impl FnOnce(&Picture) -> R) -> Option<R> {
        let guard = self.latest.lock().ok()?;
        guard.as_ref().map(f)
    }
}

impl Drop for Camera {
    /// The thread ends after the picture it is waiting for (a frame time);
    /// nothing waits on it, so a camera that stalls never holds up the file.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn keep(latest: &Mutex<Option<Picture>>, width: u32, height: u32, bgra: Vec<u8>) {
    if let Ok(mut slot) = latest.lock() {
        let seq = slot.as_ref().map_or(1, |p| p.seq + 1);
        *slot = Some(Picture {
            width,
            height,
            bgra,
            seq,
        });
    }
}

#[cfg(feature = "test-camera")]
fn read(latest: Arc<Mutex<Option<Picture>>>, stop: Arc<AtomicBool>, ready: mpsc::Sender<bool>) {
    // A 640x480 gradient with a white bar that crosses it once a second.
    let (w, h) = (640u32, 480u32);
    let mut n = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let bar = (n % 30) * w / 30;
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let lit = x >= bar && x < bar + 24;
                px[i] = if lit { 255 } else { (y * 255 / h) as u8 };
                px[i + 1] = if lit { 255 } else { 90 };
                px[i + 2] = if lit { 255 } else { (x * 255 / w) as u8 };
                px[i + 3] = 255;
            }
        }
        keep(&latest, w, h, px);
        if n == 0 {
            let _ = ready.send(true);
        }
        n += 1;
        std::thread::sleep(Duration::from_millis(33));
    }
}

#[cfg(not(feature = "test-camera"))]
fn read(latest: Arc<Mutex<Option<Picture>>>, stop: Arc<AtomicBool>, ready: mpsc::Sender<bool>) {
    let _worker = crate::win::edit::Worker::start();
    let Ok((source, reader, (w, h))) = device::open() else {
        let _ = ready.send(false);
        return;
    };
    let mut first = true;
    while !stop.load(Ordering::SeqCst) {
        match device::next(&reader, w, h) {
            Ok(Some(px)) => {
                keep(&latest, w, h, px);
                if first {
                    first = false;
                    let _ = ready.send(true);
                }
            }
            Ok(None) => {}
            Err(_) => break,
        }
    }
    if first {
        let _ = ready.send(false);
    }
    // Unplugged or stopped: no picture left to draw, the camera let go.
    if let Ok(mut slot) = latest.lock() {
        *slot = None;
    }
    drop(reader);
    unsafe {
        let _ = source.Shutdown();
    }
}

#[cfg(not(feature = "test-camera"))]
mod device {
    use windows::core::{Error, Interface, Result};
    use windows::Win32::Media::MediaFoundation::{
        IMF2DBuffer, IMFActivate, IMFMediaSource, IMFMediaType, IMFSourceReader,
        MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromMediaSource,
        MFEnumDeviceSources, MFMediaType_Video, MFVideoFormat_RGB32,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_ENDOFSTREAM,
        MF_SOURCE_READERF_ERROR, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
        MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    };
    use windows::Win32::System::Com::CoTaskMemFree;

    const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

    /// The first camera, read as RGB32 at the size picked by `best`.
    pub fn open() -> Result<(IMFMediaSource, IMFSourceReader, (u32, u32))> {
        unsafe {
            let source = first_camera()?;
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 1)?;
            let attrs = attrs.ok_or_else(Error::empty)?;
            // The reader decodes (MJPG) and converts (YUY2, NV12) to RGB itself.
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
            let reader = match MFCreateSourceReaderFromMediaSource(&source, &attrs) {
                Ok(r) => r,
                Err(e) => {
                    let _ = source.Shutdown();
                    return Err(e);
                }
            };
            if let Some(native) = best(&reader) {
                let _ = reader.SetCurrentMediaType(VIDEO, None, &native);
            }
            let want = MFCreateMediaType()?;
            want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            reader.SetCurrentMediaType(VIDEO, None, &want)?;
            let size = reader
                .GetCurrentMediaType(VIDEO)?
                .GetUINT64(&MF_MT_FRAME_SIZE)?;
            Ok((source, reader, ((size >> 32) as u32, size as u32)))
        }
    }

    unsafe fn first_camera() -> Result<IMFMediaSource> {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.ok_or_else(Error::empty)?;
        attrs.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )?;
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFEnumDeviceSources(&attrs, &mut list, &mut count)?;
        let all: Vec<Option<IMFActivate>> = (0..count as usize)
            .map(|i| std::ptr::read(list.add(i)))
            .collect();
        CoTaskMemFree(Some(list as *const _));
        let first = all.into_iter().flatten().next().ok_or_else(Error::empty)?;
        first.ActivateObject::<IMFMediaSource>()
    }

    /// The camera's own format with the tallest picture up to MAX_HEIGHT
    /// (its first format when none fits).
    unsafe fn best(reader: &IMFSourceReader) -> Option<IMFMediaType> {
        let mut pick: Option<(u32, IMFMediaType)> = None;
        for i in 0..64 {
            let Ok(t) = reader.GetNativeMediaType(VIDEO, i) else {
                break;
            };
            let h = t.GetUINT64(&MF_MT_FRAME_SIZE).map_or(0, |s| s as u32);
            let fits = h <= super::MAX_HEIGHT;
            let better = match &pick {
                None => true,
                Some((ph, _)) => fits && (*ph > super::MAX_HEIGHT || h > *ph),
            };
            if better {
                pick = Some((h, t));
            }
        }
        pick.map(|(_, t)| t)
    }

    /// The next picture as tight top-down BGRA rows; None when the camera
    /// had nothing this time, an error when it is gone.
    pub fn next(reader: &IMFSourceReader, w: u32, h: u32) -> Result<Option<Vec<u8>>> {
        unsafe {
            let mut flags = 0u32;
            let mut sample = None;
            reader.ReadSample(VIDEO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            let end = MF_SOURCE_READERF_ENDOFSTREAM.0 | MF_SOURCE_READERF_ERROR.0;
            if flags & end as u32 != 0 {
                return Err(Error::empty());
            }
            let Some(sample) = sample else {
                return Ok(None);
            };
            let buffer = sample.ConvertToContiguousBuffer()?;
            let row = (w * 4) as usize;
            let mut out = vec![0u8; row * h as usize];
            if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
                let mut line = std::ptr::null_mut();
                let mut pitch = 0i32;
                b2.Lock2D(&mut line, &mut pitch)?;
                if pitch.unsigned_abs() as usize >= row {
                    for y in 0..h as isize {
                        let from = line.offset(y * pitch as isize);
                        std::ptr::copy_nonoverlapping(
                            from,
                            out.as_mut_ptr().add(y as usize * row),
                            row,
                        );
                    }
                }
                b2.Unlock2D()?;
            } else {
                let mut data = std::ptr::null_mut();
                let mut len = 0u32;
                buffer.Lock(&mut data, None, Some(&mut len))?;
                let n = out.len().min(len as usize);
                std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
                buffer.Unlock()?;
            }
            Ok(Some(out))
        }
    }
}
