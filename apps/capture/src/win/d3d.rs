//! The Direct3D 11 device Windows.Graphics.Capture hands frames on.

use windows::core::{Interface, Result};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_FLAG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

pub struct Device {
    pub d3d: ID3D11Device,
    pub ctx: ID3D11DeviceContext,
    pub winrt: IDirect3DDevice,
}

fn create_with(driver: D3D_DRIVER_TYPE, flags: D3D11_CREATE_DEVICE_FLAG) -> Result<Device> {
    let mut d3d = None;
    let mut ctx = None;
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            flags,
            None,
            D3D11_SDK_VERSION,
            Some(&mut d3d),
            None,
            Some(&mut ctx),
        )?;
    }
    let d3d: ID3D11Device = d3d.ok_or_else(windows::core::Error::empty)?;
    let ctx = ctx.ok_or_else(windows::core::Error::empty)?;
    let dxgi: IDXGIDevice = d3d.cast()?;
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    Ok(Device { d3d, ctx, winrt })
}

/// The GPU first; WARP (software) when there is none usable, e.g. over RDP.
pub fn create() -> Result<Device> {
    let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    create_with(D3D_DRIVER_TYPE_HARDWARE, flags)
        .or_else(|_| create_with(D3D_DRIVER_TYPE_WARP, flags))
}

/// A GPU device the video encoder can share. Media Foundation uses it from its
/// own threads, so every call on it is serialized.
pub fn create_for_video() -> Result<Device> {
    let dev = create_with(
        D3D_DRIVER_TYPE_HARDWARE,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    )?;
    let mt: ID3D11Multithread = dev.ctx.cast()?;
    unsafe {
        let _ = mt.SetMultithreadProtected(true);
    }
    Ok(dev)
}
