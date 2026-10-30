//! H.264 into a fragmented MP4 with Media Foundation. Fragmented, so the file
//! is playable up to the last fragment even when the PC crashes mid-recording.
//! Frames are GPU textures from a sample allocator: the encoder (hardware when
//! the GPU has one, Windows' own otherwise) reads them without a copy to the CPU.
//! Sound goes in as AAC tracks next to the video (`crate::audio` lines it up).

use windows::core::{Interface, Result, GUID, HSTRING};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_High, IMFAttributes, IMFDXGIBuffer, IMFDXGIDeviceManager, IMFMediaType,
    IMFSample, IMFSinkWriter, IMFVideoSampleAllocatorEx, MFAudioFormat_AAC, MFAudioFormat_PCM,
    MFCreateAttributes, MFCreateDXGIDeviceManager, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MFCreateVideoSampleAllocatorEx, MFMediaType_Audio,
    MFMediaType_Video, MFNominalRange_0_255, MFNominalRange_16_235,
    MFTranscodeContainerType_FMPEG4, MFVideoFormat_ARGB32, MFVideoFormat_H264,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
    MFVideoTransFunc_sRGB, MFVideoTransferMatrix_BT709, MF_E_SAMPLEALLOCATOR_EMPTY,
    MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE,
    MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SA_D3D11_BINDFLAGS, MF_SA_D3D11_USAGE, MF_SINK_WRITER_D3D_MANAGER,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_TRANSCODE_CONTAINERTYPE,
};

use crate::{audio, video};

/// Frames waiting for the encoder at most. When all are taken the encoder is
/// behind and the next frame is dropped instead of piling up in memory.
const MAX_FRAMES_IN_FLIGHT: u32 = 8;

/// AAC at 192 kbit/s, the highest rate Windows' encoder takes: music and
/// game sound stay clean, and it is small next to the video.
const AAC_BYTES_PER_SECOND: u32 = 24_000;

/// A frame to draw into, then hand back with `write`.
pub struct Frame {
    pub sample: IMFSample,
    pub texture: ID3D11Texture2D,
    pub subresource: u32,
}

pub struct Encoder {
    writer: IMFSinkWriter,
    allocator: IMFVideoSampleAllocatorEx,
    // The writer and the allocator only borrow the device through it.
    _manager: IMFDXGIDeviceManager,
    stream: u32,
    /// One per sound track, in the mixer's order.
    sound: Vec<u32>,
    fps: u32,
}

fn pack(hi: u32, lo: u32) -> u64 {
    (hi as u64) << 32 | lo as u64
}

pub(in crate::win) fn attributes(count: u32) -> Result<IMFAttributes> {
    let mut a = None;
    unsafe { MFCreateAttributes(&mut a, count)? };
    a.ok_or_else(windows::core::Error::empty)
}

pub(in crate::win) fn video_type(
    subtype: &GUID,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<IMFMediaType> {
    let t = unsafe { MFCreateMediaType()? };
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
    }
    Ok(t)
}

fn audio_type(subtype: &GUID) -> Result<IMFMediaType> {
    let t = unsafe { MFCreateMediaType()? };
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, audio::RATE)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, audio::CHANNELS as u32)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
    }
    Ok(t)
}

/// A sound track: AAC out, the mixer's 16-bit PCM in.
pub(super) fn add_sound(writer: &IMFSinkWriter) -> Result<u32> {
    let out = audio_type(&MFAudioFormat_AAC)?;
    let block = audio::CHANNELS as u32 * 2;
    let input = audio_type(&MFAudioFormat_PCM)?;
    unsafe {
        out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
        // Raw AAC, what an MP4 holds.
        out.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
        let stream = writer.AddStream(&out)?;
        input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block)?;
        input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, audio::RATE * block)?;
        input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        writer.SetInputMediaType(stream, &input, None)?;
        Ok(stream)
    }
}

/// The video says it is BT.709 in limited range, which is what the converter
/// writes: untagged, players guess, and a guess of BT.601 shifts every colour.
pub(in crate::win) fn tag_bt709(t: &IMFMediaType) -> Result<()> {
    unsafe {
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
    }
    Ok(())
}

/// 16-bit PCM for sound stream `stream`, starting at timeline frame `at`.
pub(super) fn write_pcm(
    writer: &IMFSinkWriter,
    stream: u32,
    at: u64,
    samples: &[i16],
) -> Result<()> {
    let bytes = std::mem::size_of_val(samples);
    if bytes == 0 {
        return Ok(());
    }
    let frames = (samples.len() / audio::CHANNELS) as u64;
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes as u32)?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None)?;
        std::ptr::copy_nonoverlapping(samples.as_ptr() as *const u8, data, bytes);
        buffer.Unlock()?;
        buffer.SetCurrentLength(bytes as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        let start = audio::ticks_at(at);
        sample.SetSampleTime(start)?;
        sample.SetSampleDuration(audio::ticks_at(at + frames) - start)?;
        writer.WriteSample(stream, &sample)
    }
}

impl Encoder {
    /// `width` and `height` must be even (video::encode_size); `sound_tracks`
    /// AAC tracks follow the video.
    pub fn create(
        device: &ID3D11Device,
        path: &str,
        (width, height): (u32, u32),
        fps: u32,
        bitrate: u32,
        sound_tracks: usize,
    ) -> Result<Encoder> {
        let mut token = 0u32;
        let mut manager = None;
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager)? };
        let manager = manager.ok_or_else(windows::core::Error::empty)?;
        unsafe { manager.ResetDevice(device, token)? };

        let attrs = attributes(4)?;
        unsafe {
            attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &manager)?;
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            attrs.SetGUID(
                &MF_TRANSCODE_CONTAINERTYPE,
                &MFTranscodeContainerType_FMPEG4,
            )?;
            // Never block the frame clock: the allocator bounds what waits.
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        }
        let writer = unsafe { MFCreateSinkWriterFromURL(&HSTRING::from(path), None, &attrs)? };

        let out = video_type(&MFVideoFormat_H264, width, height, fps)?;
        unsafe {
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
        }
        tag_bt709(&out)?;
        let stream = unsafe { writer.AddStream(&out)? };

        let input = video_type(&MFVideoFormat_ARGB32, width, height, fps)?;
        unsafe {
            // Positive stride: rows top first, as Direct3D draws them.
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width * 4)?;
            input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            // What the painter draws: sRGB, full range.
            input.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_sRGB.0 as u32)?;
            input.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255.0 as u32)?;
            input.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            writer.SetInputMediaType(stream, &input, None)?;
        }

        let sound = (0..sound_tracks)
            .map(|_| add_sound(&writer))
            .collect::<Result<Vec<_>>>()?;

        let allocator: IMFVideoSampleAllocatorEx = unsafe {
            let mut raw = std::ptr::null_mut();
            MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut raw)?;
            IMFVideoSampleAllocatorEx::from_raw(raw)
        };
        let pool = attributes(2)?;
        unsafe {
            pool.SetUINT32(
                &MF_SA_D3D11_BINDFLAGS,
                (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            )?;
            pool.SetUINT32(&MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT.0 as u32)?;
            allocator.SetDirectXManager(&manager)?;
            allocator.InitializeSampleAllocatorEx(2, MAX_FRAMES_IN_FLIGHT, &pool, &input)?;
            writer.BeginWriting()?;
        }
        Ok(Encoder {
            writer,
            allocator,
            _manager: manager,
            stream,
            sound,
            fps,
        })
    }

    /// A free frame, or None when the encoder still holds every one.
    pub fn frame(&self) -> Result<Option<Frame>> {
        let sample = match unsafe { self.allocator.AllocateSample() } {
            Ok(s) => s,
            Err(e) if e.code() == MF_E_SAMPLEALLOCATOR_EMPTY => return Ok(None),
            Err(e) => return Err(e),
        };
        let buffer = unsafe { sample.GetBufferByIndex(0)? };
        let dxgi: IMFDXGIBuffer = buffer.cast()?;
        let texture: ID3D11Texture2D = unsafe {
            let mut raw = std::ptr::null_mut();
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)?;
            ID3D11Texture2D::from_raw(raw)
        };
        let subresource = unsafe { dxgi.GetSubresourceIndex()? };
        unsafe { buffer.SetCurrentLength(buffer.GetMaxLength()?)? };
        Ok(Some(Frame {
            sample,
            texture,
            subresource,
        }))
    }

    /// Frame number `index` of the recording (its time comes from the index).
    pub fn write(&self, frame: Frame, index: u64) -> Result<()> {
        let start = video::frame_time(index, self.fps);
        unsafe {
            frame.sample.SetSampleTime(start)?;
            frame
                .sample
                .SetSampleDuration(video::frame_time(index + 1, self.fps) - start)?;
            self.writer.WriteSample(self.stream, &frame.sample)
        }
    }

    /// A piece of sound track `track` starting at timeline frame `at`.
    pub fn write_sound(&self, track: usize, at: u64, samples: &[i16]) -> Result<()> {
        let Some(&stream) = self.sound.get(track) else {
            return Ok(());
        };
        write_pcm(&self.writer, stream, at, samples)
    }

    /// Writes what the encoder still holds and closes the file.
    pub fn finish(self) -> Result<()> {
        unsafe { self.writer.Finalize() }
    }
}
