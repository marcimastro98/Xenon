//! Draws the captured picture into a video frame on the GPU: scaled to the
//! frame with its shape kept (black around it), and an HDR picture brought to
//! SDR with the curve the screenshots use (tonemap.rs): SDR white stays white.

use windows::core::{s, Result};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER,
    D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_SAMPLER_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};

/// One triangle that covers the frame; the pixel shader does the rest.
const SHADER: &str = r#"
Texture2D src : register(t0);
SamplerState smp : register(s0);
cbuffer K : register(b0) {
    float4 box;      // where the picture goes: left, top, right, bottom (0..1 of the frame)
    float2 uv_scale; // the part of the source texture that holds the picture
    float2 frame;    // frame size in pixels
    float white;     // SDR white in scRGB units
    float peak;      // brightest level kept, in SDR whites
    float hdr;       // 1: the source is scRGB half floats
    float unused;
};

float4 vs(uint id : SV_VertexID) : SV_Position {
    float2 p = float2((id << 1) & 2, id & 2);
    return float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
}

static const float KNEE = 0.75;

float roll_off(float m) {
    if (peak <= 1.0 || m <= KNEE) return m;
    float s = (peak - KNEE) / (1.0 - KNEE);
    float x = min((m - KNEE) / (peak - KNEE), 1.0);
    return KNEE + (1.0 - KNEE) * (s * x / (1.0 + (s - 1.0) * x));
}

float3 srgb(float3 v) {
    v = saturate(v);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

float4 ps(float4 pos : SV_Position) : SV_Target {
    float2 uv = pos.xy / frame;
    if (uv.x < box.x || uv.y < box.y || uv.x >= box.z || uv.y >= box.w) return float4(0, 0, 0, 1);
    float4 c = src.SampleLevel(smp, (uv - box.xy) / (box.zw - box.xy) * uv_scale, 0);
    if (hdr < 0.5) return float4(c.rgb, 1);
    float3 rgb = max(c.rgb, 0);
    float m = max(rgb.r, max(rgb.g, rgb.b)) / white;
    // NaN and infinity (garbage in the capture) become black, as in screenshots.
    if (!(m > 0) || m > 65504) return float4(0, 0, 0, 1);
    // Channels scale together, so a highlight past white keeps its colour.
    return float4(srgb(rgb * (min(roll_off(m), 1.0) / m / white)), 1);
}
"#;

/// The shader's constants, laid out as the cbuffer above.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Params {
    pub bounds: [f32; 4],
    pub uv_scale: [f32; 2],
    pub frame: [f32; 2],
    pub white: f32,
    pub peak: f32,
    pub hdr: f32,
    pub unused: f32,
}

pub struct Painter {
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    params: ID3D11Buffer,
}

pub(super) fn compile(
    source: &str,
    entry: windows::core::PCSTR,
    target: windows::core::PCSTR,
) -> Result<ID3DBlob> {
    let mut code = None;
    unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            s!("record"),
            None,
            None,
            entry,
            target,
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            None,
        )?;
    }
    code.ok_or_else(windows::core::Error::empty)
}

pub(super) fn bytes(blob: &ID3DBlob) -> &[u8] {
    unsafe { std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize()) }
}

impl Painter {
    pub fn new(dev: &ID3D11Device) -> Result<Painter> {
        let vs_code = compile(SHADER, s!("vs"), s!("vs_4_0"))?;
        let ps_code = compile(SHADER, s!("ps"), s!("ps_4_0"))?;
        let (mut vs, mut ps, mut sampler, mut params) = (None, None, None, None);
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
            let buf = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<Params>() as u32,
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            dev.CreateBuffer(&buf, None, Some(&mut params))?;
        }
        let none = windows::core::Error::empty;
        Ok(Painter {
            vs: vs.ok_or_else(none)?,
            ps: ps.ok_or_else(none)?,
            sampler: sampler.ok_or_else(none)?,
            params: params.ok_or_else(none)?,
        })
    }

    /// `src` None draws a black frame (nothing captured yet).
    pub fn paint(
        &self,
        ctx: &ID3D11DeviceContext,
        src: Option<&ID3D11ShaderResourceView>,
        dst: &ID3D11RenderTargetView,
        p: &Params,
    ) {
        unsafe {
            if src.is_none() {
                ctx.ClearRenderTargetView(dst, &[0.0, 0.0, 0.0, 1.0]);
                return;
            }
            ctx.UpdateSubresource(&self.params, 0, None, (p as *const Params).cast(), 0, 0);
            ctx.IASetInputLayout(None);
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.VSSetShader(&self.vs, None);
            ctx.PSSetShader(&self.ps, None);
            ctx.PSSetShaderResources(0, Some(&[src.cloned()]));
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));
            ctx.OMSetRenderTargets(Some(&[Some(dst.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: p.frame[0],
                Height: p.frame[1],
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            ctx.Draw(3, 0);
            // Let go of the views so the encoder can use the frame.
            ctx.OMSetRenderTargets(None, None);
            ctx.PSSetShaderResources(0, Some(&[None]));
        }
    }
}
