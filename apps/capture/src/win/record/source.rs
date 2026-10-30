//! The live picture of a monitor or a window. Windows.Graphics.Capture sends
//! a frame only when something changed; the newest one is kept in a texture
//! of our own, so the recording can repeat it at a steady frame rate.

use windows::core::{Interface, Result};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

use super::super::d3d::Device;
use super::super::grab::{self, Target};

/// Frames the capture may hold while one is copied.
const POOL_FRAMES: i32 = 2;

struct Latest {
    texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    width: u32,
    height: u32,
}

pub struct Source {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    format: DirectXPixelFormat,
    pool_size: SizeInt32,
    start: (u32, u32),
    latest: Option<Latest>,
    /// The part of `latest` that holds the picture.
    content: (u32, u32),
    target: Target,
}

impl Source {
    /// `room`: the size the capture buffers start at when the picture is
    /// smaller (a window: its monitor). A frame larger than its buffer arrives
    /// cut, and a still window sends no other until it changes; with room to
    /// grow into, a window made larger is whole at once.
    pub fn open(dev: &Device, target: Target, hdr: bool, room: (u32, u32)) -> Result<Source> {
        let item: GraphicsCaptureItem = grab::item_for(&target)?;
        let format = if hdr {
            DirectXPixelFormat::R16G16B16A16Float
        } else {
            DirectXPixelFormat::B8G8R8A8UIntNormalized
        };
        let size = item.Size()?;
        let pool_size = SizeInt32 {
            Width: size.Width.max(room.0 as i32),
            Height: size.Height.max(room.1 as i32),
        };
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &dev.winrt,
            format,
            POOL_FRAMES,
            pool_size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(true);
        let _ = session.SetIsBorderRequired(false);
        session.StartCapture()?;
        Ok(Source {
            pool,
            session,
            format,
            pool_size,
            start: (size.Width.max(1) as u32, size.Height.max(1) as u32),
            latest: None,
            content: (size.Width.max(1) as u32, size.Height.max(1) as u32),
            target,
        })
    }

    /// The size of the picture when the recording started.
    pub fn size(&self) -> (u32, u32) {
        self.start
    }

    /// The window was closed, or the monitor unplugged. Asked directly: the
    /// capture item's Closed event never came in testing (no message loop here).
    pub fn closed(&self) -> bool {
        unsafe {
            match self.target {
                Target::Window(h) => !IsWindow(Some(h)).as_bool(),
                Target::Monitor(h) => {
                    let mut mi = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    !GetMonitorInfoW(h, &mut mi).as_bool()
                }
            }
        }
    }

    /// Takes the newest frame, if a new one came, into the kept texture.
    pub fn refresh(&mut self, dev: &Device) -> Result<()> {
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(old) = newest.replace(f) {
                let _ = old.Close();
            }
        }
        let Some(frame) = newest else {
            return Ok(());
        };
        let copied = self.keep(dev, &frame);
        let size = frame.ContentSize();
        let _ = frame.Close();
        // A window grown past the buffers: the next frames get room for it.
        // Buffers never shrink; a smaller picture uses part of them.
        if let Ok(size) = size {
            if size.Width > self.pool_size.Width || size.Height > self.pool_size.Height {
                let grown = SizeInt32 {
                    Width: size.Width.max(self.pool_size.Width),
                    Height: size.Height.max(self.pool_size.Height),
                };
                self.pool
                    .Recreate(&dev.winrt, self.format, POOL_FRAMES, grown)?;
                self.pool_size = grown;
            }
        }
        copied
    }

    fn keep(&mut self, dev: &Device, frame: &Direct3D11CaptureFrame) -> Result<()> {
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut desc) };
        let fits = self
            .latest
            .as_ref()
            .is_some_and(|l| l.width == desc.Width && l.height == desc.Height);
        if !fits {
            self.latest = Some(make_latest(dev, desc)?);
        }
        let latest = self.latest.as_ref().expect("kept texture");
        unsafe { dev.ctx.CopyResource(&latest.texture, &tex) };
        let size = frame.ContentSize()?;
        self.content = (
            (size.Width.max(1) as u32).min(desc.Width),
            (size.Height.max(1) as u32).min(desc.Height),
        );
        Ok(())
    }

    /// The kept picture: its view, its size, and the share of the texture it fills.
    pub fn picture(&self) -> Option<(&ID3D11ShaderResourceView, (u32, u32), [f32; 2])> {
        self.latest.as_ref().map(|l| {
            let (w, h) = self.content;
            let scale = [w as f32 / l.width as f32, h as f32 / l.height as f32];
            (&l.view, self.content, scale)
        })
    }
}

fn make_latest(dev: &Device, mut desc: D3D11_TEXTURE2D_DESC) -> Result<Latest> {
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = 0;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    let (mut texture, mut view) = (None, None);
    unsafe {
        dev.d3d.CreateTexture2D(&desc, None, Some(&mut texture))?;
        let texture = texture.as_ref().ok_or_else(windows::core::Error::empty)?;
        dev.d3d
            .CreateShaderResourceView(texture, None, Some(&mut view))?;
    }
    let none = windows::core::Error::empty;
    Ok(Latest {
        texture: texture.ok_or_else(none)?,
        view: view.ok_or_else(none)?,
        width: desc.Width,
        height: desc.Height,
    })
}

impl Drop for Source {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
