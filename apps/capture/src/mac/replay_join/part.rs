// macOS replay: one short file being read back, and its times moved onto the clip's clock.

use std::path::Path;
use std::ptr::{NonNull, null_mut};
use objc2::AllocAnyThread;
use objc2_av_foundation::{AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVMediaTypeVideo, AVURLAsset};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMFormatDescription, CMItemCount, CMSampleBuffer, CMSampleTimingInfo, CMTime};
use objc2_foundation::NSURL;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use crate::proto::Fail;
use crate::ring::{self};
use super::TIME_VALID;

/// One segment's video, read as stored.
pub(super) struct Part {
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
    pub(super) format: Retained<AnyObject>,
}

impl Part {
    pub(super) fn open(dir: &Path, id: u64) -> Option<Part> {
        let url = NSURL::from_file_path(dir.join(ring::video_name(id)))?;
        let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
        let track = super::reader::tracks(&asset, unsafe { AVMediaTypeVideo }?).firstObject()?;
        let format = unsafe { track.formatDescriptions() }.firstObject()?;
        let reader = unsafe { AVAssetReader::initWithAsset_error(AVAssetReader::alloc(), &asset) }.ok()?;
        let output = unsafe {
            AVAssetReaderTrackOutput::initWithTrack_outputSettings(AVAssetReaderTrackOutput::alloc(), &track, None)
        };
        unsafe { output.setAlwaysCopiesSampleData(false) };
        if !unsafe { reader.canAddOutput(&output) } {
            return None;
        }
        unsafe { reader.addOutput(&output) };
        unsafe { reader.startReading() }.then_some(Part { reader, output, format })
    }

    pub(super) fn format(&self) -> &CMFormatDescription {
        // formatDescriptions holds CMFormatDescriptionRefs.
        unsafe { &*Retained::as_ptr(&self.format).cast::<CMFormatDescription>() }
    }

    /// The next sample; None at the end, an error when the file cannot be read.
    pub(super) fn next(&self) -> Result<Option<Retained<CMSampleBuffer>>, Fail> {
        match unsafe { self.output.copyNextSampleBuffer() } {
            Some(s) => Ok(Some(s)),
            None if unsafe { self.reader.status() } == AVAssetReaderStatus::Failed => {
                Err(Fail::new("save_failed", "segment unreadable"))
            }
            None => Ok(None),
        }
    }
}

impl Drop for Part {
    fn drop(&mut self) {
        if unsafe { self.reader.status() } == AVAssetReaderStatus::Reading {
            unsafe { self.reader.cancelReading() };
        }
    }
}

/// A copy of `sample` shown `by` later (its decode time too, when it has one).
pub(super) fn shifted(sample: &CMSampleBuffer, by: CMTime) -> Option<CFRetained<CMSampleBuffer>> {
    let mut needed: CMItemCount = 0;
    unsafe { sample.sample_timing_info_array(0, null_mut(), &mut needed) };
    let count = usize::try_from(needed).ok().filter(|&n| n > 0)?;
    let zero = unsafe { CMTime::new(0, 1) };
    let mut timing = vec![
        CMSampleTimingInfo { duration: zero, presentationTimeStamp: zero, decodeTimeStamp: zero };
        count
    ];
    if unsafe { sample.sample_timing_info_array(needed, timing.as_mut_ptr(), null_mut()) } != 0 {
        return None;
    }
    let shift = |t: CMTime| if t.flags.0 & TIME_VALID != 0 { unsafe { t.add(by) } } else { t };
    for t in &mut timing {
        t.presentationTimeStamp = shift(t.presentationTimeStamp);
        t.decodeTimeStamp = shift(t.decodeTimeStamp);
    }
    let mut out: *mut CMSampleBuffer = null_mut();
    let status = unsafe {
        CMSampleBuffer::create_copy_with_new_timing(None, sample, needed, timing.as_ptr(), NonNull::from(&mut out))
    };
    let out = NonNull::new(out).map(|b| unsafe { CFRetained::from_raw(b) })?;
    (status == 0).then_some(out)
}
