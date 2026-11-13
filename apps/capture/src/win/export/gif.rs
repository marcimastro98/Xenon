// Windows export: the GIF copy.

use std::mem::ManuallyDrop;
use windows::core::{Error, HSTRING, PCWSTR, Result, w};
use windows::Win32::Foundation::GENERIC_WRITE;
use windows::Win32::Graphics::Imaging::{GUID_ContainerFormatGif, GUID_WICPixelFormat32bppBGR, GUID_WICPixelFormat8bppIndexed, IWICBitmapEncoder, IWICImagingFactory, IWICMetadataQueryWriter, IWICStream, WICBitmapDitherTypeErrorDiffusion, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom};
use windows::Win32::System::Com::StructuredStorage::{CAUB, PROPVARIANT};
use windows::Win32::System::Variant::{VARENUM, VT_UI1, VT_UI2, VT_VECTOR};
use crate::reframe::{self, Crop, Pace};
use super::{GIF_MAX_BYTES, Out, Stop};
use super::copies::{even, within};
use super::encode::{read, Scaler};
use super::source::open;
use super::super::edit::{factory, TICKS};

/// A looping GIF, written frame by frame with a palette of its own each.
struct Gif {
    wic: IWICImagingFactory,
    encoder: IWICBitmapEncoder,
    _stream: IWICStream,
}

fn put(meta: &IWICMetadataQueryWriter, name: PCWSTR, value: &PROPVARIANT) -> Result<()> {
    unsafe { meta.SetMetadataByName(name, value) }
}

/// A byte-vector value that borrows `data`: never dropped, since clearing it
/// would hand Rust's memory to CoTaskMemFree.
fn bytes_value(data: &mut [u8]) -> ManuallyDrop<PROPVARIANT> {
    let mut pv = ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let v = &mut *pv.Anonymous.Anonymous;
        v.vt = VARENUM(VT_VECTOR.0 | VT_UI1.0);
        v.Anonymous.caub = CAUB {
            cElems: data.len() as u32,
            pElems: data.as_mut_ptr(),
        };
    }
    pv
}

impl Gif {
    fn create(out: &str) -> Result<Gif> {
        let wic = factory()?;
        unsafe {
            let stream = wic.CreateStream()?;
            stream.InitializeFromFilename(&HSTRING::from(out), GENERIC_WRITE.0)?;
            let encoder = wic.CreateEncoder(&GUID_ContainerFormatGif, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            // The NETSCAPE block: play again and again, as people expect a GIF to.
            let meta = encoder.GetMetadataQueryWriter()?;
            let mut app = *b"NETSCAPE2.0";
            put(&meta, w!("/appext/Application"), &bytes_value(&mut app))?;
            let mut forever = [3u8, 1, 0, 0, 0];
            put(&meta, w!("/appext/Data"), &bytes_value(&mut forever))?;
            Ok(Gif {
                wic,
                encoder,
                _stream: stream,
            })
        }
    }

    pub(super) fn frame(&self, bgrx: &[u8], (w, h): (u32, u32)) -> Result<()> {
        unsafe {
            let bitmap =
                self.wic
                    .CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGR, w * 4, bgrx)?;
            let palette = self.wic.CreatePalette()?;
            palette.InitializeFromBitmap(&bitmap, 256, false)?;
            let indexed = self.wic.CreateFormatConverter()?;
            indexed.Initialize(
                &bitmap,
                &GUID_WICPixelFormat8bppIndexed,
                WICBitmapDitherTypeErrorDiffusion,
                &palette,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let (mut frame, mut props) = (None, None);
            self.encoder.CreateNewFrame(&mut frame, &mut props)?;
            let frame = frame.ok_or_else(Error::empty)?;
            frame.Initialize(props.as_ref())?;
            frame.SetSize(w, h)?;
            let mut format = GUID_WICPixelFormat8bppIndexed;
            frame.SetPixelFormat(&mut format)?;
            frame.SetPalette(&palette)?;
            let mut delay = PROPVARIANT::default();
            let v = &mut *delay.Anonymous.Anonymous;
            v.vt = VT_UI2;
            v.Anonymous.uiVal = reframe::GIF_DELAY_CS;
            put(
                &frame.GetMetadataQueryWriter()?,
                w!("/grctlext/Delay"),
                &delay,
            )?;
            frame.WriteSource(&indexed, std::ptr::null())?;
            frame.Commit()
        }
    }

    fn finish(self) -> Result<()> {
        unsafe { self.encoder.Commit() }
    }
}

pub(super) fn gif(src: &str, part: &str, progress: &mut dyn FnMut(f64)) -> Out<(u32, u32)> {
    let s = open(src, false)?;
    let size = even(reframe::gif_size(s.visible.w, s.visible.h));
    let scaler = Scaler::new(
        s.frame,
        &[(
            within(s.visible, Crop::whole(s.visible.w, s.visible.h)),
            size,
        )],
    );
    let mut nv12 = vec![0u8; scaler.len()];
    let luma = (size.0 * size.1) as usize;
    let out = Gif::create(part)?;
    let mut pace = Pace::new(reframe::GIF_DELAY_CS as i64 * 100_000);
    let total = (s.seconds * TICKS).max(1.0);
    let mut base: Option<i64> = None;
    let mut frames = 0u32;
    loop {
        let (_, sample, ended) = read(&s.reader, s.video)?;
        if let Some(sample) = sample {
            let t = unsafe { sample.GetSampleTime()? };
            let t = t - *base.get_or_insert(t);
            if t >= 0 && pace.take(t) {
                scaler.run(&sample, &mut nv12)?;
                let (y, uv) = nv12.split_at(luma);
                out.frame(&reframe::nv12_to_bgrx(y, uv, size, s.yuv), size)?;
                frames += 1;
                progress(t as f64 / total);
                if frames.is_multiple_of(25)
                    && std::fs::metadata(part).map_or(0, |m| m.len()) > GIF_MAX_BYTES
                {
                    return Err(Stop::TooBig);
                }
            }
        }
        if ended {
            break;
        }
    }
    if frames == 0 {
        return Err(Stop::Failed);
    }
    out.finish()?;
    Ok(size)
}
