//! The steps recorder's ears on macOS: a listen-only CoreGraphics event tap
//! for left and right presses and key presses, on a run loop thread of its
//! own. It never changes or holds an event. A press goes to the recorder with
//! where it landed and the window under it; a key press only raises the
//! "typed" flag, the key itself is never read. Listening to the keyboard is
//! the system's Input Monitoring grant: without it the tap is refused.

use std::cell::OnceCell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_core_foundation::{kCFRunLoopDefaultMode, CFMachPort, CFRetained, CFRunLoop, CFRunLoopRunResult};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType, CGPreflightListenEventAccess, CGRequestListenEventAccess,
};

use super::steps_plan::{self, Press};
use crate::proto::Fail;

/// How long the tap may take to open (the server waits 10 s for the answer).
const READY: Duration = Duration::from_secs(3);
/// How often the run loop looks at the stop flag.
const SPIN: f64 = 0.25;

/// What the tap hands the recorder.
pub struct Feed {
    pub presses: mpsc::Receiver<Press>,
    /// Raised by any key press, lowered by the recorder at each step.
    pub typed: Arc<AtomicBool>,
}

/// The tap's thread; dropping it removes the tap.
pub struct Tap {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Tap {
    /// The tap listening, or `hook_failed` when macOS refused it.
    pub fn open() -> Result<(Tap, Feed), Fail> {
        let (tx, presses) = mpsc::channel();
        let typed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready) = mpsc::channel();
        let (thread_typed, thread_stop) = (typed.clone(), stop.clone());
        let thread = std::thread::Builder::new()
            .name("steps-tap".into())
            .spawn(move || listen(tx, thread_typed, &ready_tx, &thread_stop))
            .map_err(|e| Fail::new("hook_failed", e))?;
        let mut tap = Tap { stop, thread: Some(thread) };
        match ready.recv_timeout(READY) {
            Ok(true) => Ok((tap, Feed { presses, typed })),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Left to end by itself: it sees the stop flag once it runs.
                tap.stop.store(true, Ordering::SeqCst);
                tap.thread = None;
                Err(Fail::code("hook_failed"))
            }
            _ => Err(Fail::code("hook_failed")),
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// What the callback reaches, on the tap's own thread only.
struct Hook {
    tx: mpsc::Sender<Press>,
    typed: Arc<AtomicBool>,
    start: Instant,
    /// The tap, to turn it back on when macOS turned it off.
    port: OnceCell<CFRetained<CFMachPort>>,
}

/// The tap's thread: opens the tap, runs its run loop until told to stop,
/// then removes it. Dropping the hook closes the channel, so a tap that
/// ends by itself ends the recording ("failed").
fn listen(tx: mpsc::Sender<Press>, typed: Arc<AtomicBool>, ready: &mpsc::Sender<bool>, stop: &AtomicBool) {
    if !CGPreflightListenEventAccess() {
        // The system's own prompt; this tap is refused until it is allowed.
        CGRequestListenEventAccess();
    }
    let hook = Box::new(Hook {
        tx,
        typed,
        start: Instant::now(),
        port: OnceCell::new(),
    });
    let user = (&*hook as *const Hook).cast_mut().cast::<c_void>();
    // SAFETY: `on_event` only reads `user` as the Hook, which outlives the
    // tap (it is dropped after the tap is invalidated below).
    let port = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            steps_plan::mask(),
            Some(on_event),
            user,
        )
    };
    let Some(port) = port else {
        let _ = ready.send(false);
        return;
    };
    let mode = unsafe { kCFRunLoopDefaultMode };
    let (Some(source), Some(run_loop)) = (
        CFMachPort::new_run_loop_source(None, Some(&port), 0),
        CFRunLoop::current(),
    ) else {
        port.invalidate();
        let _ = ready.send(false);
        return;
    };
    run_loop.add_source(Some(&source), mode);
    CGEvent::tap_enable(&port, true);
    let _ = hook.port.set(port.clone());
    let _ = ready.send(true);
    while !stop.load(Ordering::SeqCst) {
        if CFRunLoop::run_in_mode(mode, SPIN, false).0 == CFRunLoopRunResult::Finished.0 {
            break;
        }
    }
    CGEvent::tap_enable(&port, false);
    source.invalidate();
    port.invalidate();
    drop(hook);
}

/// The tap's callback. Listen-only: the event goes on as it came whatever
/// this returns.
unsafe extern "C-unwind" fn on_event(
    _proxy: CGEventTapProxy,
    kind: CGEventType,
    event: NonNull<CGEvent>,
    user: *mut c_void,
) -> *mut CGEvent {
    // SAFETY: `user` is the Hook `listen` keeps alive while the tap exists.
    let hook = unsafe { &*user.cast::<Hook>() };
    if kind.0 == CGEventType::TapDisabledByTimeout.0 || kind.0 == CGEventType::TapDisabledByUserInput.0 {
        if let Some(port) = hook.port.get() {
            CGEvent::tap_enable(port, true);
        }
        return event.as_ptr();
    }
    match steps_plan::kind(kind.0) {
        Some(Some(right)) => {
            let ev = unsafe { event.as_ref() };
            let at = CGEvent::location(Some(ev));
            let field = |f| u32::try_from(CGEvent::integer_value_field(Some(ev), f)).unwrap_or(0);
            let window = match field(CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent) {
                0 => field(CGEventField::MouseEventWindowUnderMousePointer),
                w => w,
            };
            let time = u64::try_from(hook.start.elapsed().as_millis()).unwrap_or(u64::MAX);
            let _ = hook.tx.send(Press { right, x: at.x, y: at.y, time, window });
        }
        Some(None) => hook.typed.store(true, Ordering::SeqCst),
        None => {}
    }
    event.as_ptr()
}
