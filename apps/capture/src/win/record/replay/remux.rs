//! Saving a clip: the segments' H.264 is copied as it is into one MP4 (no
//! re-encoding: a save takes a moment and costs no quality), and the sound is
//! encoded once from the PCM files, so it has no joints. The index is moved
//! to the front afterwards (`crate::faststart`).

use std::path::Path;

use windows::core::{Error, Result, HSTRING};
use windows::Win32::Media::MediaFoundation::{
    IMFSinkWriter, IMFSourceReader, MFCreateFile, MFCreateSinkWriterFromURL,
    MFCreateSourceReaderFromURL, MFTranscodeContainerType_MPEG4, MF_ACCESSMODE_WRITE,
    MF_FILEFLAGS_NONE, MF_OPENMODE_DELETE_IF_EXIST, MF_SINK_WRITER_DISABLE_THROTTLING,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_TRANSCODE_CONTAINERTYPE,
};

use super::super::encoder::{add_sound, attributes, write_pcm};
use super::pcm;
use crate::ring::{self, Segment};

const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

pub struct Clip<'a> {
    pub dir: &'a Path,
    pub segs: &'a [Segment],
    pub fps: u32,
    pub tracks: usize,
}

/// Writes the clip to `out`; answers its length in 100-ns units.
pub fn save(clip: &Clip, out: &str) -> Result<i64> {
    let first = clip.segs.first().ok_or_else(Error::empty)?;
    let (t0, _) = first.span(clip.fps);
    let (a0, _) = first.sound_span(clip.fps);
    let reader = open(clip.dir, first.id).map_err(|e| at("open", e))?;
    let vtype = unsafe { reader.GetCurrentMediaType(VIDEO)? };

    let attrs = attributes(3)?;
    let writer: IMFSinkWriter = unsafe {
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        // Not a live source: the writer may take samples as fast as they come.
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        let file = MFCreateFile(
            MF_ACCESSMODE_WRITE,
            MF_OPENMODE_DELETE_IF_EXIST,
            MF_FILEFLAGS_NONE,
            &HSTRING::from(out),
        )
        .map_err(|e| at("file", e))?;
        MFCreateSinkWriterFromURL(None, &file, &attrs).map_err(|e| at("writer", e))?
    };
    let video = unsafe {
        let s = writer.AddStream(&vtype)?;
        writer.SetInputMediaType(s, &vtype, None)?;
        s
    };
    let sound = (0..clip.tracks)
        .map(|_| add_sound(&writer))
        .collect::<Result<Vec<_>>>()?;
    unsafe { writer.BeginWriting().map_err(|e| at("begin", e))? };

    let mut reader = Some(reader);
    let mut length = 0;
    // A segment at a time, its sound right after: the writer interleaves
    // without holding the whole clip in memory.
    for seg in clip.segs {
        let r = match reader.take() {
            Some(r) => r,
            None => open(clip.dir, seg.id)?,
        };
        let (ts, te) = seg.span(clip.fps);
        copy_video(&r, &writer, video, ts - t0).map_err(|e| at("video", e))?;
        drop(r);
        let (sa, sb) = seg.sound_span(clip.fps);
        for (track, &stream) in sound.iter().enumerate() {
            let samples = pcm::read(clip.dir, seg.id, track, sb - sa);
            write_pcm(&writer, stream, sa - a0, &samples).map_err(|e| at("sound", e))?;
        }
        length = te - t0;
    }
    unsafe { writer.Finalize().map_err(|e| at("finalize", e))? };
    Ok(length)
}

/// Names the step that failed, for the server log.
fn at(step: &str, e: Error) -> Error {
    Error::new(e.code(), format!("{step}: {}", e.message()))
}

/// A reader of segment `id` handing out its H.264 as it is stored.
fn open(dir: &Path, id: u64) -> Result<IMFSourceReader> {
    let path = dir.join(ring::video_name(id));
    unsafe {
        let r = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_path()), None)?;
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        r.SetStreamSelection(VIDEO, true)?;
        let native = r.GetNativeMediaType(VIDEO, 0)?;
        r.SetCurrentMediaType(VIDEO, None, &native)?;
        Ok(r)
    }
}

/// Every frame of a segment, moved to where the segment sits in the clip.
fn copy_video(r: &IMFSourceReader, w: &IMFSinkWriter, stream: u32, offset: i64) -> Result<()> {
    loop {
        let mut flags = 0u32;
        let mut sample = None;
        unsafe {
            r.ReadSample(VIDEO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            if let Some(s) = sample {
                s.SetSampleTime(s.GetSampleTime()? + offset)?;
                w.WriteSample(stream, &s)?;
            }
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Ok(());
        }
    }
}
