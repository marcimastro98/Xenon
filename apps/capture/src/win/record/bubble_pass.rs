//! Draws the webcam (camera.rs) into the video frame as a round bubble with
//! soft edges and a thin light ring, over the picture painter.rs drew. The
//! camera picture goes to the GPU once per new picture, not once per frame.

use windows::core::{s, Result};
use windows::Win32::Graphics::Direct3D::D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11BlendState, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_SHADER_RESOURCE, D3D11_BLEND_DESC,
    D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD, D3D11_BLEND_SRC_ALPHA,
    D3D11_BLEND_ZERO, D3D11_BUFFER_DESC, D3D11_COLOR_WRITE_ENABLE_ALL, D3D11_COMPARISON_NEVER,
    D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_RENDER_TARGET_BLEND_DESC, D3D11_SAMPLER_DESC,
    D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use super::camera::Camera;
use super::painter::{bytes, compile};
use crate::bubble::{self, Corner};

const SHADER: &str = r#"
Texture2D cam : register(t0);
SamplerState smp : register(s0);
cbuffer K : register(b0) {
    float4 box;   // the bubble: left, top, right, bottom (0..1 of the frame)
    float4 crop;  // the part of the camera picture shown (0..1 of it)
    float2 frame; // frame size in pixels
    float2 unused;
};

float4 vs(uint id : SV_VertexID) : SV_Position {
    float2 p = float2((id << 1) & 2, id & 2);
    return float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
}

float4 ps(float4 pos : SV_Position) : SV_Target {
    float2 q = (pos.xy / frame - box.xy) / (box.zw - box.xy);
    float radius = (box.z - box.x) * frame.x * 0.5;
    // Pixels inside the edge of the circle: below 0 is outside.
    float inside = (1.0 - length(q - 0.5) * 2.0) * radius;
    if (inside <= 0) discard;
    float3 c = cam.SampleLevel(smp, lerp(crop.xy, crop.zw, q), 0).rgb;
    float ring = max(radius * 0.03, 1.5);
    c = lerp(c, float3(0.92, 0.92, 0.92), saturate(ring + 0.5 - inside));
    return float4(c, saturate(inside));
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    bounds: [f32; 4],
    crop: [f32; 4],
    frame: [f32; 2],
    unused: [f32; 2],
}

struct Upload {
    texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    size: (u32, u32),
    seq: u64,
}

pub struct Bubble {
    camera: Camera,
    corner: Corner,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    blend: ID3D11BlendState,
    params: ID3D11Buffer,
    upload: Option<Upload>,
}

impl Bubble {
    pub fn new(dev: &ID3D11Device, camera: Camera, corner: Corner) -> Result<Bubble> {
        let vs_code = compile(SHADER, s!("vs"), s!("vs_4_0"))?;
        let ps_code = compile(SHADER, s!("ps"), s!("ps_4_0"))?;
        let (mut vs, mut ps, mut sampler, mut blend, mut params) = (None, None, None, None, None);
        unsafe {
            dev.CreateVertexShader(bytes(&vs_code), None, Some(&mut vs))?;
            dev.CreatePixelShader(bytes(&ps_code), None, Some(&mut ps))?;
            let smp = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                ComparisonFunc: D3D11_COMPARISON_NEVER,
                MaxLOD: f32::MAX,
                ..Default::default()
            };
            dev.CreateSamplerState(&smp, Some(&mut sampler))?;
            // Over the picture by the edge's softness; the frame stays opaque.
            let mut desc = D3D11_BLEND_DESC::default();
            desc.RenderTarget[0] = D3D11_RENDER_TARGET_BLEND_DESC {
                BlendEnable: true.into(),
                SrcBlend: D3D11_BLEND_SRC_ALPHA,
                DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
                BlendOp: D3D11_BLEND_OP_ADD,
                SrcBlendAlpha: D3D11_BLEND_ZERO,
                DestBlendAlpha: D3D11_BLEND_ONE,
                BlendOpAlpha: D3D11_BLEND_OP_ADD,
                RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
            };
            dev.CreateBlendState(&desc, Some(&mut blend))?;
            let buf = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<Params>() as u32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            dev.CreateBuffer(&buf, None, Some(&mut params))?;
        }
        let none = windows::core::Error::empty;
        Ok(Bubble {
            camera,
            corner,
            vs: vs.ok_or_else(none)?,
            ps: ps.ok_or_else(none)?,
            sampler: sampler.ok_or_else(none)?,
            blend: blend.ok_or_else(none)?,
            params: params.ok_or_else(none)?,
            upload: None,
        })
    }

    /// Brings the newest camera picture to the GPU; false when the camera has
    /// none (not yet, or unplugged): the frame goes without the bubble.
    fn refresh(&mut self, dev: &ID3D11Device, ctx: &ID3D11DeviceContext) -> bool {
        let Bubble { camera, upload, .. } = self;
        camera
            .with_latest(|p| {
                let size = (p.width, p.height);
                if upload.as_ref().map(|u| (u.size, u.seq)) == Some((size, p.seq)) {
                    return true;
                }
                if upload.as_ref().map(|u| u.size) != Some(size) {
                    *upload = texture(dev, size).ok();
                }
                let Some(up) = upload.as_mut() else {
                    return false;
                };
                if p.bgra.len() >= (size.0 * size.1 * 4) as usize {
                    unsafe {
                        ctx.UpdateSubresource(
                            &up.texture,
                            0,
                            None,
                            p.bgra.as_ptr().cast(),
                            size.0 * 4,
                            0,
                        )
                    };
                }
                up.seq = p.seq;
                true
            })
            .unwrap_or(false)
    }

    pub fn draw(
        &mut self,
        dev: &ID3D11Device,
        ctx: &ID3D11DeviceContext,
        dst: &ID3D11RenderTargetView,
        (w, h): (u32, u32),
    ) {
        if !self.refresh(dev, ctx) {
            return;
        }
        let Some(up) = self.upload.as_ref() else {
            return;
        };
        let place = bubble::place(w, h, self.corner);
        let p = Params {
            bounds: place,
            crop: bubble::crop(up.size.0, up.size.1),
            frame: [w as f32, h as f32],
            unused: [0.0; 2],
        };
        unsafe {
            ctx.UpdateSubresource(&self.params, 0, None, (&p as *const Params).cast(), 0, 0);
            ctx.IASetInputLayout(None);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.VSSetShader(&self.vs, None);
            ctx.PSSetShader(&self.ps, None);
            ctx.PSSetShaderResources(0, Some(&[Some(up.view.clone())]));
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
            ctx.OMSetRenderTargets(Some(&[Some(dst.clone())]), None);
            ctx.OMSetBlendState(&self.blend, None, 0xffff_ffff);
            // Only the bubble's square is drawn; SV_Position stays in frame pixels.
            let (fw, fh) = (w as f32, h as f32);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: place[0] * fw,
                TopLeftY: place[1] * fh,
                Width: (place[2] - place[0]) * fw,
                Height: (place[3] - place[1]) * fh,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            ctx.Draw(3, 0);
            ctx.OMSetBlendState(None, None, 0xffff_ffff);
            ctx.OMSetRenderTargets(None, None);
            ctx.PSSetShaderResources(0, Some(&[None]));
        }
    }
}

fn texture(dev: &ID3D11Device, (w, h): (u32, u32)) -> Result<Upload> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w.max(1),
        Height: h.max(1),
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        ..Default::default()
    };
    let (mut texture, mut view) = (None, None);
    unsafe {
        dev.CreateTexture2D(&desc, None, Some(&mut texture))?;
        let texture = texture.ok_or_else(windows::core::Error::empty)?;
        dev.CreateShaderResourceView(&texture, None, Some(&mut view))?;
        Ok(Upload {
            texture,
            view: view.ok_or_else(windows::core::Error::empty)?,
            size: (w, h),
            seq: 0,
        })
    }
}
