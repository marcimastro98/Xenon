//! Bit on the desktop on macOS (Beta; built here, not yet run on a real Mac):
//! one borderless non-activating panel, so a tap or a drag never takes the
//! keyboard from the app in front, at the status-bar level over the Dock, on
//! every Space but not in a full-screen app's own Space (no
//! `FullScreenAuxiliary`), which is how it stays out of games and videos with
//! no "covered" check. It stands on top of the Dock (state.rs `ground`), whose
//! middle is full of icons. Not hidden by Cmd+H, never in the window cycle.
//! macOS decides from the window's pixels whether a click reaches it; at worst
//! the small box around Bit takes it.
//!
//! One NSTimer at a time, scheduled for the next tick only (state.rs
//! `wait_ms`): the walk's pace, the next frame of a clip, else the idle beat
//! for the watchdog, so a still Bit wakes every 2 s and draws nothing. The
//! picture is the layer's contents, set with implicit animations off.
//!
//! Main thread only; the state is a thread-local borrowed with
//! `try_borrow_mut`, like glow_macos.rs.

use std::cell::RefCell;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSEvent, NSResponder, NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior,
    NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::super::glow_macos::{image::image, main_height};
use super::state::{now, Desk};
use super::{tell, Area, Plan};

#[derive(Default)]
struct Mac {
    window: Option<Retained<NSWindow>>,
    layer: Option<Retained<AnyObject>>,
    ticker: Option<Retained<Ticker>>,
    timer: Option<Retained<AnyObject>>,
    desk: Desk,
}

thread_local! {
    static MAC: RefCell<Mac> = RefCell::new(Mac::default());
}

define_class!(
    // The NSTimer's target: one tick of Bit's clock.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XenonBitDeskTicker"]
    struct Ticker;

    impl Ticker {
        #[unsafe(method(tick:))]
        fn tick(&self, _timer: &AnyObject) {
            tick();
        }
    }
);

define_class!(
    // The panel's view: the mouse on Bit. AppKit sends the drag and the
    // release to the view that took the press, wherever the cursor goes.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XenonBitDeskView"]
    struct BitView;

    impl BitView {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            with(|m| {
                let c = cursor(&m.desk);
                m.desk.press(c);
            });
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, _event: &NSEvent) {
            with(|m| {
                let c = cursor(&m.desk);
                if m.desk.drag_to(c) {
                    render(m);
                }
            });
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            let mut said = None;
            with(|m| {
                let window = m.window.clone();
                said = m.desk.release(true, |_| window.as_deref().and_then(areas_of));
            });
            if let Some(call) = said {
                tell(call);
            }
        }
    }
);

fn with(f: impl FnOnce(&mut Mac)) {
    MAC.with(|cell| {
        if let Ok(mut m) = cell.try_borrow_mut() {
            f(&mut m);
        }
    });
}

/// Physical pixels from the top-left of the main display, as Tauri reports the
/// screens, from AppKit's points counted up from its bottom-left.
fn physical(d: &Desk, p: NSPoint) -> (i32, i32) {
    ((p.x * d.scale).round() as i32, ((main_height() - p.y) * d.scale).round() as i32)
}

fn cursor(d: &Desk) -> (i32, i32) {
    physical(d, NSEvent::mouseLocation())
}

/// The screen the window is on now: its whole frame and the part the menu bar and the Dock leave.
fn areas_of(window: &NSWindow) -> Option<(Area, Area)> {
    let screen: Option<Retained<AnyObject>> = unsafe { msg_send![window, screen] };
    let screen = screen?;
    let (frame, visible, scale): (NSRect, NSRect, f64) =
        unsafe { (msg_send![&*screen, frame], msg_send![&*screen, visibleFrame], msg_send![&*screen, backingScaleFactor]) };
    let main = main_height();
    let area = |r: NSRect| Area {
        l: (r.origin.x * scale).round() as i32,
        t: ((main - r.origin.y - r.size.height) * scale).round() as i32,
        r: ((r.origin.x + r.size.width) * scale).round() as i32,
        b: ((main - r.origin.y) * scale).round() as i32,
    };
    Some((area(frame), area(visible)))
}

/// A borderless panel that never activates the app nor hides with it, over
/// the Dock, on every Space but a full-screen app's, its view hosting `layer`.
fn create(mtm: MainThreadMarker) -> Option<(Retained<NSWindow>, Retained<AnyObject>)> {
    let layer: Retained<AnyObject> = unsafe { msg_send![AnyClass::get(c"CALayer")?, layer] };
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0));
    let alloc: Allocated<AnyObject> = unsafe { msg_send![AnyClass::get(c"NSPanel")?, alloc] };
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
    let panel: Option<Retained<AnyObject>> = unsafe {
        msg_send![alloc, initWithContentRect: rect, styleMask: style, backing: NSBackingStoreType::Buffered, defer: false]
    };
    // SAFETY: NSPanel is a subclass of NSWindow.
    let window: Retained<NSWindow> = unsafe { Retained::cast_unchecked(panel?) };
    unsafe {
        window.setReleasedWhenClosed(false);
        let _: () = msg_send![&*window, setHidesOnDeactivate: false];
        let _: () = msg_send![&*window, setBecomesKeyOnlyIfNeeded: true];
    }
    window.setOpaque(false);
    window.setHasShadow(false);
    if let Some(clear) = AnyClass::get(c"NSColor").and_then(|c| unsafe { msg_send![c, clearColor] }) {
        let clear: Retained<AnyObject> = clear;
        let _: () = unsafe { msg_send![&*window, setBackgroundColor: &*clear] };
    }
    window.setLevel(NSStatusWindowLevel);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    window.setCanHide(false);
    let view: Retained<BitView> = unsafe { msg_send![BitView::alloc(mtm), initWithFrame: rect] };
    // A layer-hosting view: the layer is set before `wantsLayer`, so AppKit leaves its contents to us.
    let _: () = unsafe { msg_send![&*view, setLayer: &*layer] };
    view.setWantsLayer(true);
    window.setContentView(Some(&view));
    Some((window, layer))
}

fn close(m: &mut Mac) {
    if let Some(timer) = m.timer.take() {
        let _: () = unsafe { msg_send![&*timer, invalidate] };
    }
    if let Some(window) = m.window.take() {
        window.orderOut(None);
        window.close();
    }
    let ticker = m.ticker.take();
    *m = Mac { ticker, ..Mac::default() };
}

/// The frame on show as the layer's picture, and the panel where Bit stands.
fn render(m: &Mac) -> bool {
    let (Some(window), Some(layer)) = (&m.window, &m.layer) else { return false };
    let d = &m.desk;
    let ((w, h), (x, y)) = (d.size(), d.at());
    let Some(img) = d.pixels().and_then(|px| image(&px, w as usize, h as usize)) else { return false };
    let s = d.scale.max(0.5);
    let frame = NSRect::new(
        NSPoint::new(f64::from(x) / s, main_height() - f64::from(y + h) / s),
        NSSize::new(f64::from(w) / s, f64::from(h) / s),
    );
    let Some(tx) = AnyClass::get(c"CATransaction") else { return false };
    unsafe {
        // A new frame replaces the last one at once: no cross-fade.
        let _: () = msg_send![tx, begin];
        let _: () = msg_send![tx, setDisableActions: true];
        let _: () = msg_send![&**layer, setContents: img.0.cast::<AnyObject>()];
        let _: () = msg_send![&**layer, setContentsScale: s];
        let _: () = msg_send![tx, commit];
    }
    window.setFrame_display(frame, false);
    true
}

/// The next tick, and only that one.
fn arm(m: &mut Mac, mtm: MainThreadMarker, t: u64) {
    if let Some(old) = m.timer.take() {
        let _: () = unsafe { msg_send![&*old, invalidate] };
    }
    let Some(timer_class) = AnyClass::get(c"NSTimer") else { return };
    let ticker = m.ticker.get_or_insert_with(|| unsafe { msg_send![Ticker::alloc(mtm), init] });
    let none: Option<&AnyObject> = None;
    // The run loop keeps the timer, and the timer its target, until it fires or is invalidated.
    m.timer = unsafe {
        msg_send![
            timer_class,
            scheduledTimerWithTimeInterval: m.desk.wait_ms(t) as f64 / 1000.0,
            target: &**ticker,
            selector: sel!(tick:),
            userInfo: none,
            repeats: false
        ]
    };
}

pub fn apply(plan: Plan) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    with(|m| {
        if !plan.spec.on {
            return close(m);
        }
        let fresh = m.window.is_none();
        if fresh {
            let Some((window, layer)) = create(mtm) else { return };
            m.window = Some(window);
            m.layer = Some(layer);
        }
        let t = now();
        m.desk.take(plan, t);
        if !render(m) {
            return close(m);
        }
        if fresh {
            if let Some(window) = &m.window {
                window.orderFrontRegardless();
            }
        }
        arm(m, mtm, t);
    });
}

fn tick() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let mut arrived = false;
    with(|m| {
        m.timer = None;
        let t = now();
        if m.window.is_none() || m.desk.stale(t) {
            return close(m);
        }
        let (dirty, came) = m.desk.tick(t);
        arrived = came;
        if dirty {
            render(m);
        }
        arm(m, mtm, t);
    });
    if arrived {
        tell("arrived()".into());
    }
}
