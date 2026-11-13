// Windows recording sound: opening the system sound, a microphone or one app's sound.

use std::mem::ManuallyDrop;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::mpsc::{self, Sender};
use windows::core::{HRESULT, implement, Interface, Ref, Result};
use windows::Win32::Media::Audio::{ActivateAudioInterfaceAsync, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, eCapture, eConsole, eRender, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX};
use windows::Win32::System::Com::{BLOB, CLSCTX_ALL, CoCreateInstance};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;
use crate::audio::{CHANNELS, Packet, RATE};
use super::{ACTIVATE_TIMEOUT, BITS, BUFFER_TICKS, Kind, WAVE_FORMAT_PCM};

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

pub(super) fn open_client(kind: Kind) -> Result<(IAudioClient, IAudioCaptureClient)> {
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

pub(super) struct Source {
    pub(super) lane: usize,
    pub(super) tx: Sender<Packet>,
    pub(super) origin: Arc<AtomicI64>,
    pub(super) stop: Arc<AtomicBool>,
}
