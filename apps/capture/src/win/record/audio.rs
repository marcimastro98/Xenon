//! The sound sources of a recording, with WASAPI: the sound of the PC (the
//! default speakers, looped back), the sound of one app and its children
//! (process loopback, Windows 10 2004 and later), the microphone. Each runs on
//! a thread of its own, asks Windows for 48 kHz stereo 16-bit whatever the
//! device plays, and hands packets stamped on the recording's clock to the
//! mixer (`crate::audio`). A source that fails mid-recording turns to silence:
//! the recording goes on.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref, Result, HRESULT};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, ActivateAudioInterfaceAsync,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio::{self, Packet, CHANNELS, RATE};

const WAVE_FORMAT_PCM: u16 = 1;
const BITS: u16 = 16;
/// The device buffer: room for many polls, so a slow one never loses sound.
const BUFFER_TICKS: i64 = 2_000_000;
const POLL: Duration = Duration::from_millis(10);
/// How often a quiet source says so.
const QUIET_EVERY: Duration = Duration::from_millis(50);
/// How long Windows may take to hand over an app's sound.
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(3);
/// Not set yet: packets before the recording starts are dropped.
const NO_ORIGIN: i64 = i64::MIN;

/// Where a source's sound comes from.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    /// Everything the PC plays.
    System,
    /// What one process and its children play.
    App(u32),
    Microphone,
}

/// The sources that opened, each on its lane of the mixer.
pub struct Sources {
    pub kinds: Vec<Kind>,
    pub packets: Receiver<Packet>,
    /// The recording's start on the clock packets are stamped with.
    origin: Arc<AtomicI64>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Sources {
    /// Opens what it can of `wanted`, in order; an app whose sound cannot be
    /// taken on its own falls back to the sound of the whole PC.
    pub fn open(wanted: &[Kind]) -> Sources {
        let (tx, packets) = mpsc::channel();
        let origin = Arc::new(AtomicI64::new(NO_ORIGIN));
        let stop = Arc::new(AtomicBool::new(false));
        let mut kinds = Vec::new();
        let mut threads = Vec::new();
        for &want in wanted {
            let tries: &[Kind] = match want {
                Kind::App(_) => &[want, Kind::System],
                _ => &[want],
            };
            for &kind in tries {
                let lane = kinds.len();
                let started = start(kind, lane, &tx, &origin, &stop);
                if let Some(t) = started {
                    kinds.push(kind);
                    threads.push(t);
                    break;
                }
            }
        }
        Sources {
            kinds,
            packets,
            origin,
            stop,
            threads,
        }
    }

    /// The recording starts now: packets are stamped from this moment.
    pub fn begin(&self) {
        self.origin.store(now_ticks(), Ordering::SeqCst);
    }

    /// Stops every source; what they handed in last is still in the channel.
    pub fn close(self) -> Receiver<Packet> {
        self.stop.store(true, Ordering::SeqCst);
        for t in self.threads {
            let _ = t.join();
        }
        self.packets
    }
}

/// The performance counter in 100-ns units, the clock WASAPI stamps with.
fn now_ticks() -> i64 {
    let (mut count, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    (count as i128 * 10_000_000 / freq.max(1) as i128) as i64
}

/// Starts a source thread; None when its device cannot be opened.
fn start(
    kind: Kind,
    lane: usize,
    tx: &Sender<Packet>,
    origin: &Arc<AtomicI64>,
    stop: &Arc<AtomicBool>,
) -> Option<JoinHandle<()>> {
    let (ready_tx, ready) = mpsc::channel();
    let (tx, origin, stop) = (tx.clone(), origin.clone(), stop.clone());
    let thread = std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        match open_client(kind) {
            Ok((client, capture)) => {
                let _ = ready_tx.send(true);
                let source = Source {
                    lane,
                    tx,
                    origin,
                    stop,
                };
                source.pump(&capture);
                unsafe {
                    let _ = client.Stop();
                }
            }
            Err(_) => {
                let _ = ready_tx.send(false);
            }
        }
        unsafe { CoUninitialize() };
    });
    if ready.recv().unwrap_or(false) {
        Some(thread)
    } else {
        let _ = thread.join();
        None
    }
}

fn format() -> WAVEFORMATEX {
    let block = CHANNELS as u16 * BITS / 8;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * block as u32,
        nBlockAlign: block,
        wBitsPerSample: BITS,
        cbSize: 0,
    }
}

fn open_client(kind: Kind) -> Result<(IAudioClient, IAudioCaptureClient)> {
    let (client, loopback) = match kind {
        Kind::App(pid) => (app_client(pid)?, true),
        Kind::System => (device_client(true)?, true),
        Kind::Microphone => (device_client(false)?, false),
    };
    let mut flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if loopback {
        flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    }
    let fmt = format();
    unsafe {
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_TICKS, 0, &fmt, None)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok((client, capture))
    }
}

/// The default speakers (looped back) or the default microphone.
fn device_client(speakers: bool) -> Result<IAudioClient> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let flow = if speakers { eRender } else { eCapture };
        let device = devices.GetDefaultAudioEndpoint(flow, eConsole)?;
        device.Activate(CLSCTX_ALL, None)
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activated(Mutex<Option<Sender<()>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        if let Some(tx) = self.0.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(());
        }
        Ok(())
    }
}

/// What process `pid` and the processes it started play.
fn app_client(pid: u32) -> Result<IAudioClient> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // Never dropped: its drop calls PropVariantClear, which would free the
    // blob, and the blob is `params` on this stack.
    let mut prop = ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let v = &mut *prop.Anonymous.Anonymous;
        v.vt = VT_BLOB;
        v.Anonymous.blob = BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &params as *const _ as *mut u8,
        };
    }
    let (tx, done) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(tx))).into();
    unsafe {
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop),
            &handler,
        )?;
        done.recv_timeout(ACTIVATE_TIMEOUT)
            .map_err(|_| windows::core::Error::empty())?;
        let mut result = HRESULT(0);
        let mut unknown = None;
        op.GetActivateResult(&mut result, &mut unknown)?;
        result.ok()?;
        unknown.ok_or_else(windows::core::Error::empty)?.cast()
    }
}

struct Source {
    lane: usize,
    tx: Sender<Packet>,
    origin: Arc<AtomicI64>,
    stop: Arc<AtomicBool>,
}

impl Source {
    /// Reads packets until the recording stops; after a device error, says
    /// "quiet" instead, so the track stays as long as the video.
    fn pump(&self, capture: &IAudioCaptureClient) {
        let mut broken = false;
        let mut quiet_since = Instant::now();
        while !self.stop.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            let origin = self.origin.load(Ordering::SeqCst);
            let got = if broken {
                Ok(false)
            } else {
                self.drain(capture, origin)
            };
            match got {
                Ok(true) => quiet_since = Instant::now(),
                Ok(false) if quiet_since.elapsed() >= QUIET_EVERY && origin != NO_ORIGIN => {
                    let until = audio::frame_at(now_ticks() - origin - audio::LATENCY_TICKS);
                    let _ = self.tx.send(Packet::Quiet {
                        lane: self.lane,
                        until,
                    });
                    quiet_since = Instant::now();
                }
                Ok(false) => {}
                // Unplugged, or the format changed: silence from here on.
                Err(_) => broken = true,
            }
        }
    }

    /// Hands over every packet waiting; true when there was any sound.
    fn drain(&self, capture: &IAudioCaptureClient, origin: i64) -> Result<bool> {
        let mut any = false;
        while unsafe { capture.GetNextPacketSize()? } > 0 {
            let mut data = std::ptr::null_mut();
            let (mut frames, mut flags, mut qpc) = (0u32, 0u32, 0u64);
            unsafe {
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))?;
            }
            let n = frames as usize * CHANNELS;
            let samples = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                vec![0i16; n]
            } else {
                unsafe { std::slice::from_raw_parts(data as *const i16, n).to_vec() }
            };
            unsafe { capture.ReleaseBuffer(frames)? };
            if origin == NO_ORIGIN || frames == 0 {
                continue;
            }
            // Some sources leave the stamp out: then it is "just now".
            let at = if qpc > 0 {
                audio::frame_at(qpc as i64 - origin)
            } else {
                audio::frame_at(now_ticks() - origin) - frames as i64
            };
            let _ = self.tx.send(Packet::Sound {
                lane: self.lane,
                at,
                samples,
            });
            any = true;
        }
        Ok(any)
    }
}
