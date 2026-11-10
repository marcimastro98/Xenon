//! A recording's sound as a 16 kHz mono WAV for the server's speech
//! recognition (whisper.cpp): the first audio track (the mix when a recording
//! has several) decoded by Media Foundation, then downmixed and resampled in
//! `crate::speech` as it streams. Runs as a gallery job on a thread of its own.

use std::io::{Seek, SeekFrom, Write};

use serde_json::{json, Value};
use windows::core::{Error, HSTRING};
use windows::Win32::Media::MediaFoundation::{
    IMFSourceReader, MFAudioFormat_Float, MFCreateMediaType, MFCreateSourceReaderFromURL,
    MFMediaType_Audio, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM,
};

use super::edit::{self, Jobs};
use crate::proto::{Fail, Notify};
use crate::speech::{self, Resampler};

const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

enum Failed {
    NoAudio,
    Other,
}

impl From<Error> for Failed {
    fn from(_: Error) -> Failed {
        Failed::Other
    }
}

impl From<std::io::Error> for Failed {
    fn from(_: std::io::Error) -> Failed {
        Failed::Other
    }
}

/// The reader on the first audio track, decoding to 32-bit float, with that
/// track's sample rate and channel count.
fn open(src: &str) -> std::result::Result<(IMFSourceReader, u32, usize), Failed> {
    unsafe {
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(src), None)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        // A video without sound has no audio stream to select.
        reader
            .SetStreamSelection(AUDIO, true)
            .map_err(|_| Failed::NoAudio)?;
        let want = MFCreateMediaType()?;
        want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        want.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
        reader.SetCurrentMediaType(AUDIO, None, &want)?;
        let got = reader.GetCurrentMediaType(AUDIO)?;
        let rate = got.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?;
        let channels = got.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)? as usize;
        if rate == 0 || channels == 0 {
            return Err(Failed::Other);
        }
        Ok((reader, rate, channels))
    }
}

/// Writes `src`'s sound to `out` as a 16 kHz mono WAV. Answers its length in
/// seconds and whether it was cut at `speech::MAX_SECONDS`.
fn convert(src: &str, out: &str) -> std::result::Result<(f64, bool), Failed> {
    let (reader, rate, channels) = open(src)?;
    let mut file = std::io::BufWriter::new(std::fs::File::create(out)?);
    file.write_all(&speech::wav_header(0))?;
    let mut resampler = Resampler::new(rate);
    let mut mono = Vec::new();
    let mut pcm: Vec<i16> = Vec::new();
    let mut written: u64 = 0;
    let max = speech::MAX_SECONDS as u64 * speech::RATE as u64;
    let mut cut = false;
    loop {
        let mut flags = 0u32;
        let mut sample = None;
        unsafe { reader.ReadSample(AUDIO, 0, None, Some(&mut flags), None, Some(&mut sample))? };
        if let Some(s) = sample {
            let buffer = unsafe { s.ConvertToContiguousBuffer()? };
            let mut data = std::ptr::null_mut();
            let mut len = 0u32;
            unsafe { buffer.Lock(&mut data, None, Some(&mut len))? };
            let floats =
                unsafe { std::slice::from_raw_parts(data as *const f32, len as usize / 4) };
            mono.clear();
            speech::downmix(floats, channels, &mut mono);
            unsafe { buffer.Unlock()? };
            pcm.clear();
            resampler.push(&mono, &mut pcm);
            let room = (max - written) as usize;
            if pcm.len() >= room {
                pcm.truncate(room);
                cut = true;
            }
            for v in &pcm {
                file.write_all(&v.to_le_bytes())?;
            }
            written += pcm.len() as u64;
            if cut {
                break;
            }
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
    }
    if written == 0 {
        return Err(Failed::NoAudio);
    }
    let mut file = file.into_inner().map_err(|_| Failed::Other)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&speech::wav_header((written * 2) as u32))?;
    file.flush()?;
    Ok((written as f64 / speech::RATE as f64, cut))
}

/// `{ src, out, token }`: the sound of a saved video as a 16 kHz mono WAV at
/// `out` (through `out.part`). Answers the event `speech_done` with `seconds`
/// (and `cut` when it stopped at the length limit), or `error`: `no_audio`
/// (a recording made without sound) or `speech_failed`.
pub fn start(req: &Value, notify: Notify, jobs: &Jobs) -> std::result::Result<Value, Fail> {
    let src = edit::text(req, "src")?;
    let out = edit::text(req, "out")?;
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    edit::spawn(jobs, notify, "speech_done", token, move || {
        let part = format!("{out}.part");
        let made = convert(&src, &part).and_then(|r| {
            std::fs::rename(&part, &out)?;
            Ok(r)
        });
        match made {
            Ok((seconds, cut)) => json!({ "seconds": seconds, "cut": cut }),
            Err(f) => {
                let _ = std::fs::remove_file(&part);
                let code = match f {
                    Failed::NoAudio => "no_audio",
                    Failed::Other => "speech_failed",
                };
                json!({ "error": code })
            }
        }
    })
}
