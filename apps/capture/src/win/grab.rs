//! One frame of a monitor or a window through Windows.Graphics.Capture, as
//! tight 24-bit BGR. An HDR monitor is read in half floats and tone mapped
//! (tonemap.rs); everything else is read as 8-bit BGRA.

use std::time::{Duration, Instant};

use windows::core::{Interface, Result};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::d3d::Device;
use crate::region::Crop;
use crate::tonemap;

/// The first frame normally arrives in a few milliseconds; a window being
/// destroyed or a locked session never sends one.
pub const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(3);

pub enum Target {
    Monitor(HMONITOR),
    Window(HWND),
}

pub struct Image {
    pub width: u32,
    pub height: u32,
    pub bgr: Vec<u8>,
}

/// `hdr_white`: Some(SDR white in scRGB units) to read an HDR monitor in half floats.
/// `crop`: only that part of the frame (a window cut out of its monitor).
/// `wait`: how long to wait for the first frame.
#[derive(Clone, Copy)]
pub struct Options {
    pub hdr_white: Option<f32>,
    pub cursor: bool,
    pub crop: Option<Crop>,
    pub wait: Duration,
}

pub fn supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

pub(super) fn item_for(target: &Target) -> Result<GraphicsCaptureItem> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe {
        match *target {
            Target::Monitor(h) => interop.CreateForMonitor(h),
            Target::Window(h) => interop.CreateForWindow(h),
        }
    }
}

/// Copies the frame texture to CPU memory and converts the `crop` part of it.
fn read_texture(
    dev: &Device,
    tex: &ID3D11Texture2D,
    crop: Crop,
    hdr_white: Option<f32>,
) -> Result<Image> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { tex.GetDesc(&mut desc) };
    let (x, y0) = (crop.x.min(desc.Width - 1), crop.y.min(desc.Height - 1));
    let (w, h) = (
        crop.width.min(desc.Width - x).max(1),
        crop.height.min(desc.Height - y0).max(1),
    );
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    unsafe { dev.d3d.CreateTexture2D(&desc, None, Some(&mut staging))? };
    let staging = staging.ok_or_else(windows::core::Error::empty)?;
    unsafe { dev.ctx.CopyResource(&staging, tex) };
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        dev.ctx
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?
    };
    let bpp = if hdr_white.is_some() { 8 } else { 4 };
    let pitch = mapped.RowPitch as usize;
    let all =
        unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, pitch * (y0 + h) as usize) };
    let row = |y: u32| {
        let start = (y0 + y) as usize * pitch + (x * bpp) as usize;
        &all[start..start + (w * bpp) as usize]
    };
    let bgr = match hdr_white {
        Some(white) => {
            let peak = in_bands(h, |ys| {
                ys.fold(0.0f32, |acc, y| {
                    acc.max(tonemap::peak_fp16_row(row(y), white))
                })
            })
            .into_iter()
            .fold(0.0f32, f32::max);
            in_bands(h, |ys| {
                let mut out = Vec::with_capacity(ys.len() * (w * 3) as usize);
                ys.for_each(|y| tonemap::row_fp16_to_bgr(row(y), white, peak, &mut out));
                out
            })
            .concat()
        }
        None => {
            let mut out = Vec::with_capacity((w * h * 3) as usize);
            (0..h).for_each(|y| tonemap::row_bgra_to_bgr(row(y), &mut out));
            out
        }
    };
    unsafe { dev.ctx.Unmap(&staging, 0) };
    Ok(Image {
        width: w,
        height: h,
        bgr,
    })
}

/// Runs `work` on bands of rows `0..rows`, one per core (up to 8), and returns
/// the results top band first. Tone mapping a 4K HDR frame on one core takes
/// over half a second; the area picker waits for it.
fn in_bands<T: Send>(rows: u32, work: impl Fn(std::ops::Range<u32>) -> T + Sync) -> Vec<T> {
    let cores = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(8) as u32;
    let band = rows.div_ceil(cores.max(1)).max(1);
    let work = &work;
    std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..rows)
            .step_by(band as usize)
            .map(|y| scope.spawn(move || work(y..(y + band).min(rows))))
            .collect();
        jobs.into_iter()
            .map(|j| j.join().expect("tone mapping band"))
            .collect()
    })
}

pub fn grab(dev: &Device, target: &Target, opts: &Options) -> Result<Image> {
    let item = item_for(target)?;
    let format = if opts.hdr_white.is_some() {
        DirectXPixelFormat::R16G16B16A16Float
    } else {
        DirectXPixelFormat::B8G8R8A8UIntNormalized
    };
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&dev.winrt, format, 1, item.Size()?)?;
    let session = pool.CreateCaptureSession(&item)?;
    // Both are newer than the capture API itself: an older Windows draws its
    // border and the cursor, which is still a screenshot.
    let _ = session.SetIsCursorCaptureEnabled(opts.cursor);
    let _ = session.SetIsBorderRequired(false);
    session.StartCapture()?;
    let started = Instant::now();
    let frame = loop {
        if let Ok(f) = pool.TryGetNextFrame() {
            break Ok(f);
        }
        if started.elapsed() > opts.wait {
            break Err(windows::core::Error::empty());
        }
        std::thread::sleep(Duration::from_millis(4));
    };
    let result = frame.and_then(|frame| {
        let size = frame.ContentSize()?;
        let whole = Crop {
            x: 0,
            y: 0,
            width: size.Width.max(1) as u32,
            height: size.Height.max(1) as u32,
        };
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let image = read_texture(dev, &tex, opts.crop.unwrap_or(whole), opts.hdr_white);
        let _ = frame.Close();
        image
    });
    let _ = session.Close();
    let _ = pool.Close();
    result
}

#[cfg(test)]
mod tests {
    use super::in_bands;

    #[test]
    fn bands_cover_every_row_once_in_order() {
        for rows in [0u32, 1, 7, 2160, 2161] {
            let got: Vec<u32> = in_bands(rows, |ys| ys.collect::<Vec<_>>()).concat();
            assert_eq!(got, (0..rows).collect::<Vec<_>>(), "{rows} rows");
        }
    }
}
