//! Reading what ScreenCaptureKit and the microphone hand in: the samples of
//! a sound buffer in the mixer's format (pcm.rs), and the host clock both
//! stamp their buffers with.

use std::ptr::{null_mut, NonNull};

use objc2_core_audio_types::AudioBufferList;
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMClock, CMSampleBuffer,
};

use super::ffi;
use crate::pcm;

/// kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment
const ASSURE_ALIGNMENT: u32 = 1;

/// Now on the host clock, in 100-ns units: the clock ScreenCaptureKit and the
/// capture session stamp their buffers with.
pub fn host_now() -> i64 {
    let now = unsafe { CMClock::host_time_clock().time() };
    ffi::ticks_of_time(now).unwrap_or(0)
}

/// The sound in a buffer as interleaved stereo at `audio::RATE`, with the
/// host time its first sample was taken. None for a format it cannot read.
pub fn sound_of(buffer: &CMSampleBuffer) -> Option<(i64, Vec<i16>)> {
    let format = unsafe { buffer.format_description() }?;
    let basic = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format) };
    let basic = unsafe { basic.as_ref() }?;
    let layout = pcm::Layout::from_description(
        basic.mFormatID,
        basic.mFormatFlags,
        basic.mSampleRate,
        basic.mChannelsPerFrame,
        basic.mBitsPerChannel,
    )?;
    let frames = usize::try_from(unsafe { buffer.num_samples() }).ok()?;
    let at = ffi::ticks_of_time(unsafe { buffer.presentation_time_stamp() })?;
    let data = bytes_of(buffer)?;
    let stereo = pcm::stereo(&layout, frames, &data);
    Some((at, pcm::resample(&stereo, layout.rate)))
}

/// Every buffer of a sound buffer's list, one after the other: frames for a
/// packed format, one channel after the other for a planar one.
fn bytes_of(buffer: &CMSampleBuffer) -> Option<Vec<u8>> {
    let mut needed = 0usize;
    unsafe {
        buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed,
            null_mut(),
            0,
            None,
            None,
            ASSURE_ALIGNMENT,
            null_mut(),
        )
    };
    if needed < std::mem::size_of::<AudioBufferList>() {
        return None;
    }
    // u64 words: the list holds pointers, so it needs their alignment.
    let mut store = vec![0u64; needed.div_ceil(8)];
    let list = store.as_mut_ptr().cast::<AudioBufferList>();
    let mut block: *mut CMBlockBuffer = null_mut();
    let status = unsafe {
        buffer.audio_buffer_list_with_retained_block_buffer(
            null_mut(),
            list,
            needed,
            None,
            None,
            ASSURE_ALIGNMENT,
            &mut block,
        )
    };
    // The list points into this block; it is released once copied out.
    let _block = NonNull::new(block).map(|b| unsafe { CFRetained::from_raw(b) });
    if status != 0 {
        return None;
    }
    let count = unsafe { (*list).mNumberBuffers } as usize;
    let first = unsafe { std::ptr::addr_of!((*list).mBuffers) }.cast::<objc2_core_audio_types::AudioBuffer>();
    let mut out = Vec::new();
    for i in 0..count {
        let b = unsafe { &*first.add(i) };
        if b.mData.is_null() {
            continue;
        }
        let part = unsafe { std::slice::from_raw_parts(b.mData.cast::<u8>(), b.mDataByteSize as usize) };
        out.extend_from_slice(part);
    }
    Some(out)
}
