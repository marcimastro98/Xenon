// Windows: the small picture of a saved video or screenshot.

use windows::core::{Error, HSTRING, Interface, Result};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Graphics::Imaging::{GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, GUID_WICPixelFormat32bppBGR, IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand};
use windows::Win32::Media::MediaFoundation::{MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READERF_ENDOFSTREAM, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Video, MFVideoFormat_RGB32};
use super::{factory, rows, seek, THUMB_AT_S, TICKS, VIDEO};

/// A JPEG `width` pixels wide (never wider than the source) of the picture or
/// video at `src`. Answers the source's size.
pub fn thumb(src: &str, out: &str, width: u32, video: bool) -> Result<(u32, u32)> {
    let wic = factory()?;
    let (source, w, h) = if video {
        let (bgrx, w, h) = video_frame(src)?;
        let bitmap = unsafe {
            wic.CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGR, w * 4, &bgrx)?
        };
        (bitmap.cast::<IWICBitmapSource>()?, w, h)
    } else {
        unsafe {
            let decoder = wic.CreateDecoderFromFilename(
                &HSTRING::from(src),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = decoder.GetFrame(0)?;
            let (mut w, mut h) = (0, 0);
            frame.GetSize(&mut w, &mut h)?;
            (frame.cast::<IWICBitmapSource>()?, w, h)
        }
    };
    if w == 0 || h == 0 {
        return Err(Error::empty());
    }
    let tw = width.clamp(16, w.max(16)).min(w);
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    write_jpeg(&wic, &source, tw, th, out)?;
    Ok((w, h))
}

/// A JPEG of a picture in memory (tight 24-bit BGR rows), scaled down to
/// `max_width` when wider. Answers the size written.
pub fn jpeg(bgr: &[u8], w: u32, h: u32, max_width: u32, out: &str) -> Result<(u32, u32)> {
    if w == 0 || h == 0 || bgr.len() < (w * h * 3) as usize {
        return Err(Error::empty());
    }
    let wic = factory()?;
    let bitmap =
        unsafe { wic.CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat24bppBGR, w * 3, bgr)? };
    let source = bitmap.cast::<IWICBitmapSource>()?;
    let tw = w.min(max_width.max(16));
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    write_jpeg(&wic, &source, tw, th, out)?;
    Ok((tw, th))
}

/// Scales `source` to `tw` x `th` and writes it to `out` as a JPEG.
fn write_jpeg(
    wic: &IWICImagingFactory,
    source: &IWICBitmapSource,
    tw: u32,
    th: u32,
    out: &str,
) -> Result<()> {
    unsafe {
        let scaler = wic.CreateBitmapScaler()?;
        scaler.Initialize(source, tw, th, WICBitmapInterpolationModeFant)?;
        let bgr = wic.CreateFormatConverter()?;
        bgr.Initialize(
            &scaler,
            &GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let stream = wic.CreateStream()?;
        stream.InitializeFromFilename(&HSTRING::from(out), GENERIC_WRITE.0)?;
        let encoder = wic.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(Error::empty)?;
        frame.Initialize(props.as_ref())?;
        frame.SetSize(tw, th)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        frame.WriteSource(&bgr, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
    }
    Ok(())
}

/// One decoded frame near THUMB_AT_S (the first one in a shorter clip), as
/// tight 32-bit BGRX rows.
fn video_frame(src: &str) -> Result<(Vec<u8>, u32, u32)> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.ok_or_else(Error::empty)?;
        // The reader converts to RGB itself (decoder + colour converter).
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(src), &attrs)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(VIDEO, true)?;
        let want = MFCreateMediaType()?;
        want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        reader.SetCurrentMediaType(VIDEO, None, &want)?;
        let size = reader
            .GetCurrentMediaType(VIDEO)?
            .GetUINT64(&MF_MT_FRAME_SIZE)?;
        let (w, h) = ((size >> 32) as u32, size as u32);
        seek(&reader, (THUMB_AT_S * TICKS) as i64);
        let mut last = None;
        loop {
            let mut flags = 0u32;
            let mut sample = None;
            reader.ReadSample(VIDEO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            if let Some(s) = sample {
                last = Some(s);
                break;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        // A clip shorter than the seek point: its first frame instead.
        let sample = match last {
            Some(s) => s,
            None => {
                seek(&reader, 0);
                let mut sample = None;
                reader.ReadSample(VIDEO, 0, None, None, None, Some(&mut sample))?;
                sample.ok_or_else(Error::empty)?
            }
        };
        Ok((rows(&sample, w, h)?, w, h))
    }
}
