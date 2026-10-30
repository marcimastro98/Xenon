//! Saving an Instant Replay clip on macOS, as on Windows (remux.rs): the
//! segments' H.264 is copied as it is into one MP4 (no re-encoding: a save
//! takes a moment and costs no quality), each sample moved to where its
//! segment sits in the clip, and the sound is encoded once from the PCM files
//! (replay_pcm.rs), so it has no joints. Not in real time: each input says
//! when it takes more, and AVFoundation interleaves them.

use std::path::Path;
use std::ptr::{null_mut, NonNull};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetWriter,
    AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeVideo, AVURLAsset,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMFormatDescription, CMItemCount, CMSampleBuffer, CMSampleTimingInfo, CMTime};
use objc2_foundation::NSURL;

use super::ffi::time_of_ticks;
use super::replay_pcm;
use super::replay_plan as plan;
use super::writer::{failure, sample_buffer, sound_inputs};
use crate::audio::CHANNELS;
use crate::proto::Fail;
use crate::ring::{self, Segment};

/// The longest the file may take to be finished.
const FINISH_WAIT: Duration = Duration::from_secs(60);
/// No input taking anything for this long: the save failed.
const STALL: Duration = Duration::from_secs(10);
const IDLE: Duration = Duration::from_millis(2);
/// CMTime's kCMTimeFlags_Valid.
const TIME_VALID: u32 = 1;

pub struct Clip<'a> {
    pub dir: &'a Path,
    pub segs: &'a [Segment],
    pub fps: u32,
    pub tracks: usize,
}

/// One segment's video, read as stored.
struct Part {
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
    format: Retained<AnyObject>,
}

impl Part {
    fn open(dir: &Path, id: u64) -> Option<Part> {
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

    fn format(&self) -> &CMFormatDescription {
        // formatDescriptions holds CMFormatDescriptionRefs.
        unsafe { &*Retained::as_ptr(&self.format).cast::<CMFormatDescription>() }
    }

    /// The next sample; None at the end, an error when the file cannot be read.
    fn next(&self) -> Result<Option<Retained<CMSampleBuffer>>, Fail> {
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
fn shifted(sample: &CMSampleBuffer, by: CMTime) -> Option<CFRetained<CMSampleBuffer>> {
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

/// The clip's video, segment after segment.
struct Video<'a> {
    clip: &'a Clip<'a>,
    next: usize,
    part: Option<(Part, CMTime)>,
    done: bool,
}

impl Video<'_> {
    /// The next sample, already moved to its place; None once every segment is read.
    fn sample(&mut self) -> Result<Option<CFRetained<CMSampleBuffer>>, Fail> {
        loop {
            if let Some((part, by)) = &self.part {
                if let Some(s) = part.next()? {
                    return shifted(&s, *by).map(Some).ok_or(Fail::new("save_failed", "retime failed"));
                }
            }
            let Some(seg) = self.clip.segs.get(self.next) else {
                return Ok(None);
            };
            self.next += 1;
            let part = Part::open(self.clip.dir, seg.id).ok_or(Fail::new("save_failed", "segment unreadable"))?;
            let by = time_of_ticks(plan::offset_in_clip(seg, &self.clip.segs[0], self.clip.fps));
            self.part = Some((part, by));
        }
    }
}

/// A segment's sound being fed: where it starts on the clip's timeline, its
/// samples, and its pieces still to go (last first).
struct Feeding {
    start: u64,
    samples: Vec<i16>,
    left: Vec<(u64, u64)>,
}

/// One sound track of the clip, read from the PCM files a piece at a time.
struct Sound<'a> {
    clip: &'a Clip<'a>,
    track: usize,
    next: usize,
    current: Option<Feeding>,
    done: bool,
}

impl Sound<'_> {
    /// The next piece: where it starts on the clip's sound timeline, and its samples.
    fn piece(&mut self) -> Option<(u64, Vec<i16>)> {
        loop {
            if let Some(f) = &mut self.current {
                if let Some((at, len)) = f.left.pop() {
                    let a = at as usize * CHANNELS;
                    return Some((f.start + at, f.samples[a..a + len as usize * CHANNELS].to_vec()));
                }
            }
            let seg = self.clip.segs.get(self.next)?;
            self.next += 1;
            let (sa, sb) = seg.sound_span(self.clip.fps);
            let a0 = self.clip.segs[0].sound_span(self.clip.fps).0;
            let samples = replay_pcm::read(self.clip.dir, seg.id, self.track, sb - sa);
            let mut left = plan::pieces(sb - sa, plan::SOUND_PIECE);
            left.reverse();
            self.current = Some(Feeding { start: sa - a0, samples, left });
        }
    }
}

/// Writes the clip to `out` (which must not exist); answers its length in 100-ns units.
pub fn save(clip: &Clip, out: &Path) -> Result<i64, Fail> {
    let first = clip.segs.first().ok_or(Fail::code("too_short"))?;
    let format = Part::open(clip.dir, first.id).ok_or(Fail::new("save_failed", "segment unreadable"))?;
    let url = NSURL::from_file_path(out).ok_or(Fail::code("bad_request"))?;
    let mp4 = unsafe { AVFileTypeMPEG4 }.ok_or(Fail::code("no_encoder"))?;
    let writer = unsafe { AVAssetWriter::initWithURL_fileType_error(AVAssetWriter::alloc(), &url, mp4) }
        .map_err(|e| failure(Some(e)))?;
    unsafe { writer.setShouldOptimizeForNetworkUse(true) };
    let kind = unsafe { AVMediaTypeVideo }.ok_or(Fail::code("no_encoder"))?;
    let video = unsafe {
        AVAssetWriterInput::initWithMediaType_outputSettings_sourceFormatHint(
            AVAssetWriterInput::alloc(),
            kind,
            None,
            Some(format.format()),
        )
    };
    drop(format);
    if !unsafe { writer.canAddInput(&video) } {
        return Err(Fail::code("no_encoder"));
    }
    unsafe { writer.addInput(&video) };
    let (sound, pcm) = sound_inputs(&writer, clip.tracks, false)?;
    if !unsafe { writer.startWriting() } {
        return Err(failure(unsafe { writer.error() }));
    }
    unsafe { writer.startSessionAtSourceTime(time_of_ticks(0)) };
    let fed = feed(clip, &writer, &video, &sound, pcm.as_deref());
    if let Err(f) = fed {
        unsafe { writer.cancelWriting() };
        return Err(f);
    }
    let length = plan::clip_length(clip.segs, clip.fps);
    unsafe { writer.endSessionAtSourceTime(time_of_ticks(length)) };
    finish(&writer)?;
    Ok(length)
}

/// Every sample in, each input when it takes more.
fn feed(
    clip: &Clip,
    writer: &AVAssetWriter,
    video: &AVAssetWriterInput,
    sound: &[Retained<AVAssetWriterInput>],
    pcm: Option<&CMFormatDescription>,
) -> Result<(), Fail> {
    let mut frames = Video { clip, next: 0, part: None, done: false };
    let mut tracks: Vec<Sound> = (0..sound.len())
        .map(|track| Sound { clip, track, next: 0, current: None, done: false })
        .collect();
    let mut busy_since = Instant::now();
    while !(frames.done && tracks.iter().all(|t| t.done)) {
        if unsafe { writer.status() } == AVAssetWriterStatus::Failed {
            return Err(failure(unsafe { writer.error() }));
        }
        let moved = autoreleasepool(|_| -> Result<bool, Fail> {
            let mut moved = false;
            if !frames.done && unsafe { video.isReadyForMoreMediaData() } {
                moved = true;
                match frames.sample()? {
                    Some(s) if !unsafe { video.appendSampleBuffer(&s) } => {
                        return Err(failure(unsafe { writer.error() }));
                    }
                    Some(_) => {}
                    None => {
                        frames.done = true;
                        unsafe { video.markAsFinished() };
                    }
                }
            }
            for (t, input) in tracks.iter_mut().zip(sound) {
                if t.done || !unsafe { input.isReadyForMoreMediaData() } {
                    continue;
                }
                moved = true;
                let piece = t.piece();
                let (Some((at, samples)), Some(format)) = (piece, pcm) else {
                    t.done = true;
                    unsafe { input.markAsFinished() };
                    continue;
                };
                let buffer = sample_buffer(format, at, &samples).ok_or(Fail::code("encoder_failed"))?;
                if !unsafe { input.appendSampleBuffer(&buffer) } {
                    return Err(failure(unsafe { writer.error() }));
                }
            }
            Ok(moved)
        })?;
        if moved {
            busy_since = Instant::now();
        } else if busy_since.elapsed() > STALL {
            return Err(Fail::new("save_failed", "writer stalled"));
        } else {
            std::thread::sleep(IDLE);
        }
    }
    Ok(())
}

fn finish(writer: &AVAssetWriter) -> Result<(), Fail> {
    let (tx, rx) = mpsc::channel::<()>();
    let done = RcBlock::new(move || {
        let _ = tx.send(());
    });
    unsafe { writer.finishWritingWithCompletionHandler(&done) };
    if rx.recv_timeout(FINISH_WAIT).is_err() {
        return Err(Fail::new("save_failed", "finish timed out"));
    }
    match unsafe { writer.status() } {
        AVAssetWriterStatus::Completed => Ok(()),
        _ => Err(failure(unsafe { writer.error() })),
    }
}
