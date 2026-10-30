//! What was clicked, read with UI Automation on a thread of its own: the name
//! and kind of the element under the click, and the app it belongs to. It
//! starts the moment the click arrives, beside the capture, so a menu that
//! closes on the release is still there to be read. Values typed into fields
//! are never read, only an element's name (its label).

use std::sync::mpsc;
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomation2};

use crate::steps;

/// An app that does not answer in this time is described by its name only.
const UIA_TIMEOUT_MS: u32 = 800;

#[derive(Default, Clone)]
pub struct Described {
    pub name: String,
    pub role: &'static str,
}

/// The thread that reads the element under a point; dropping it ends the thread.
pub struct Describer {
    jobs: Option<mpsc::Sender<(POINT, mpsc::Sender<Described>)>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Describer {
    pub fn start() -> Describer {
        let (jobs, rx) = mpsc::channel::<(POINT, mpsc::Sender<Described>)>();
        let thread = std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let uia = automation();
            for (pt, reply) in rx {
                let found = uia.as_ref().map(|u| element_at(u, pt)).unwrap_or_default();
                let _ = reply.send(found);
            }
            drop(uia);
            unsafe { CoUninitialize() };
        });
        Describer {
            jobs: Some(jobs),
            thread: Some(thread),
        }
    }

    /// Starts reading the element at `pt`; the answer comes on the receiver.
    pub fn ask(&self, pt: POINT) -> Option<mpsc::Receiver<Described>> {
        let (tx, rx) = mpsc::channel();
        self.jobs.as_ref()?.send((pt, tx)).ok()?;
        Some(rx)
    }
}

impl Drop for Describer {
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The answer to `ask`, or nothing if it takes longer than `wait`.
pub fn answer(rx: Option<mpsc::Receiver<Described>>, wait: Duration) -> Described {
    rx.and_then(|r| r.recv_timeout(wait).ok())
        .unwrap_or_default()
}

fn automation() -> Option<IUIAutomation> {
    let uia: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
    // A frozen app must not hold the next step up for the default 20 s.
    if let Ok(two) = uia.cast::<IUIAutomation2>() {
        unsafe {
            let _ = two.SetConnectionTimeout(UIA_TIMEOUT_MS);
            let _ = two.SetTransactionTimeout(UIA_TIMEOUT_MS);
        }
    }
    Some(uia)
}

fn element_at(uia: &IUIAutomation, pt: POINT) -> Described {
    let Ok(el) = (unsafe { uia.ElementFromPoint(pt) }) else {
        return Described::default();
    };
    let kind = unsafe { el.CurrentControlType() }.map(|t| t.0).unwrap_or(0);
    let name = if steps::names_the_click(kind) {
        unsafe { el.CurrentName() }
            .map(|b| steps::clean_name(&b.to_string()))
            .unwrap_or_default()
    } else {
        String::new()
    };
    Described {
        name,
        role: steps::role(kind),
    }
}
