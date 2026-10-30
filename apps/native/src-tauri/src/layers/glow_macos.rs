//! The edge glow windows on macOS (built here, not yet run on a real Mac),
//! with the contract of glow_win32.rs: one borderless, transparent window per
//! monitor at the status-bar level, on every Space and next to full-screen
//! apps, that ignores the mouse, never becomes key or main and is left out of
//! screenshots and recordings (`sharingType = none`). They exist only while
//! the glow is on.
//!
//! The pixels are glow::paint's, made once per look and size, as the contents
//! of a layer the window's view hosts. The breathing is a Core Animation on
//! that layer's opacity, run by the window server, so nothing in Xenon ticks
//! for it. One NSTimer, every few seconds, switches the glow off when the page
//! stops re-sending it, so a reloaded or crashed page never leaves it lit.
//!
//! Main thread only: the state is a thread-local, borrowed with
//! `try_borrow_mut`, like glow_win32.rs.
#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::ffi::{c_void, CStr};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
    NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::glow::{self, State};

/// The page re-sends the state at least every 20 s while it lasts.
const STALE: Duration = Duration::from_secs(60);
/// How often the watchdog looks; the breathing needs no tick at all.
const WATCH_EVERY_S: f64 = 5.0;
const BREATH_KEY: &CStr = c"xenonBreath";
/// kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little: premultiplied
/// B, G, R, A in memory, the byte order glow::paint writes.
const BGRA_PREMULTIPLIED: u32 = 2 | (2 << 12);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
    fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
    fn CGColorSpaceRelease(space: *mut c_void);
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: *mut c_void,
        info: u32,
    ) -> *mut c_void;
    fn CGBitmapContextGetData(context: *mut c_void) -> *mut c_void;
    fn CGBitmapContextGetBytesPerRow(context: *mut c_void) -> usize;
    fn CGBitmapContextCreateImage(context: *mut c_void) -> *mut c_void;
    fn CGContextRelease(context: *mut c_void);
    fn CGImageRelease(image: *mut c_void);
}

pub struct Screen {
    /// Points, AppKit's coordinates: from the bottom-left of the main display.
    frame: NSRect,
    /// The backing pixels the glow is painted at.
    px: (usize, usize),
    scale: f64,
}

impl Screen {
    /// The whole monitor. Tauri counts from the top-left of the main display
    /// in physical pixels; AppKit from its bottom-left, in points. Core
    /// Graphics may be asked from any thread.
    pub fn of(m: &tauri::Monitor) -> Self {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        let main_height = unsafe { CGDisplayBounds(CGMainDisplayID()) }.size.height;
        Screen {
            frame: NSRect::new(NSPoint::new(p.x, main_height - p.y - s.height), NSSize::new(s.width, s.height)),
            px: (m.size().width as usize, m.size().height as usize),
            scale,
        }
    }
}

pub struct Plan {
    pub state: State,
    pub rgb: [u8; 3],
    pub still: bool,
    pub screens: Vec<Screen>,
}

struct Win {
    window: Retained<NSWindow>,
    /// The layer the window's view hosts: AppKit leaves its opacity alone.
    layer: Retained<AnyObject>,
    frame: NSRect,
    px: (usize, usize),
    scale: f64,
}

#[derive(Default)]
struct Glow {
    wins: Vec<Win>,
    /// What the pixels show: the state's look and the accent.
    look: Option<(bool, [u8; 3])>,
    /// What the animation does: the period and reduced motion.
    breath: Option<(u32, bool)>,
    touched: Option<Instant>,
    timer: Option<Retained<AnyObject>>,
}

thread_local! {
    static GLOW: RefCell<Glow> = RefCell::new(Glow::default());
}

define_class!(
    // The NSTimer's target: switches a glow off whose page went quiet.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XenonGlowWatchdog"]
    struct Watchdog;

    impl Watchdog {
        #[unsafe(method(check:))]
        fn check(&self, _timer: &AnyObject) {
            GLOW.with(|cell| {
                let Ok(mut g) = cell.try_borrow_mut() else { return };
                if !g.touched.is_some_and(|t| t.elapsed() <= STALE) {
                    off(&mut g);
                }
            });
        }
    }
);

/// An NSString from a C string, by message.
fn ns_string(text: &CStr) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSString")?;
    unsafe { msg_send![class, stringWithUTF8String: text.as_ptr()] }
}

fn ns_number(value: f64) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSNumber")?;
    unsafe { msg_send![class, numberWithDouble: value] }
}

/// A CGImage, released with this value.
struct Image(*mut c_void);

impl Drop for Image {
    fn drop(&mut self) {
        unsafe { CGImageRelease(self.0) };
    }
}

/// glow::paint's rows (premultiplied BGRA, top row first) as a CGImage. Core
/// Graphics owns the bitmap the rows are copied into, so the image never
/// points at a buffer of ours.
fn image(pixels: &[u8], w: usize, h: usize) -> Option<Image> {
    unsafe {
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            return None;
        }
        let ctx = CGBitmapContextCreate(std::ptr::null_mut(), w, h, 8, 0, space, BGRA_PREMULTIPLIED);
        CGColorSpaceRelease(space);
        if ctx.is_null() {
            return None;
        }
        let data = CGBitmapContextGetData(ctx).cast::<u8>();
        let stride = CGBitmapContextGetBytesPerRow(ctx);
        let mut made = std::ptr::null_mut();
        if !data.is_null() && stride >= w * 4 {
            for (y, row) in pixels.chunks_exact(w * 4).take(h).enumerate() {
                std::ptr::copy_nonoverlapping(row.as_ptr(), data.add(y * stride), row.len());
            }
            made = CGBitmapContextCreateImage(ctx);
        }
        CGContextRelease(ctx);
        (!made.is_null()).then_some(Image(made))
    }
}

/// A window over the whole screen that nothing reaches: no mouse, no focus,
/// no capture, no Cmd+H, on every Space and over full-screen apps.
fn create(mtm: MainThreadMarker, s: &Screen) -> Option<Win> {
    let layer: Retained<AnyObject> = unsafe { msg_send![AnyClass::get(c"CALayer")?, layer] };
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            s.frame,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // `Win` owns the window: AppKit must not release it again on close.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setOpaque(false);
    window.setHasShadow(false);
    if let Some(clear) = AnyClass::get(c"NSColor").and_then(|c| unsafe { msg_send![c, clearColor] }) {
        let clear: Retained<AnyObject> = clear;
        let _: () = unsafe { msg_send![&*window, setBackgroundColor: &*clear] };
    }
    window.setIgnoresMouseEvents(true);
    window.setLevel(NSStatusWindowLevel);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    window.setSharingType(NSWindowSharingType::None);
    window.setCanHide(false);
    // A layer-hosting view: the layer is set before `wantsLayer`, so AppKit
    // leaves its contents and opacity to us.
    let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::new(NSPoint::new(0.0, 0.0), s.frame.size));
    let _: () = unsafe { msg_send![&*view, setLayer: &*layer] };
    view.setWantsLayer(true);
    window.setContentView(Some(&view));
    Some(Win { window, layer, frame: s.frame, px: s.px, scale: s.scale })
}

/// The glow's pixels as the layer's contents, at the screen's backing scale.
fn paint(w: &Win, state: State, rgb: [u8; 3]) -> bool {
    let (cx, cy) = w.px;
    if cx == 0 || cy == 0 {
        return false;
    }
    let Some(img) = image(&glow::paint(cx, cy, w.scale, state, rgb), cx, cy) else {
        return false;
    };
    let contents = img.0.cast::<AnyObject>();
    unsafe {
        let _: () = msg_send![&*w.layer, setContents: contents];
        let _: () = msg_send![&*w.layer, setContentsScale: w.scale];
    }
    true
}

/// `xn-edge-breathe` on the layer's opacity, or the steady opacity for
/// reduced motion. Replaces the running animation.
fn breathe(layer: &AnyObject, period: u32, still: bool) {
    let Some(key) = ns_string(BREATH_KEY) else { return };
    unsafe {
        let _: () = msg_send![layer, removeAnimationForKey: &*key];
        let model = if still { glow::STILL_OPACITY } else { glow::BREATH_LOW };
        let _: () = msg_send![layer, setOpacity: model as f32];
    }
    if still {
        return;
    }
    let parts = (
        AnyClass::get(c"CABasicAnimation"),
        AnyClass::get(c"CAMediaTimingFunction"),
        ns_string(c"opacity"),
        ns_string(c"easeInEaseOut"),
        ns_number(glow::BREATH_LOW),
        ns_number(glow::BREATH_HIGH),
    );
    let (Some(anim_class), Some(timing_class), Some(path), Some(ease), Some(from), Some(to)) = parts else {
        return;
    };
    unsafe {
        let anim: Retained<AnyObject> = msg_send![anim_class, animationWithKeyPath: &*path];
        let timing: Retained<AnyObject> = msg_send![timing_class, functionWithName: &*ease];
        let _: () = msg_send![&*anim, setFromValue: &*from];
        let _: () = msg_send![&*anim, setToValue: &*to];
        // One way is half the period: it comes back on its own.
        let _: () = msg_send![&*anim, setDuration: f64::from(period.max(1)) / 2000.0];
        let _: () = msg_send![&*anim, setAutoreverses: true];
        let _: () = msg_send![&*anim, setRepeatCount: f32::INFINITY];
        let _: () = msg_send![&*anim, setTimingFunction: &*timing];
        let _: () = msg_send![layer, addAnimation: &*anim, forKey: &*key];
    }
}

fn close(w: Win) {
    w.window.orderOut(None);
    w.window.close();
}

fn off(g: &mut Glow) {
    for w in g.wins.drain(..) {
        close(w);
    }
    g.look = None;
    g.breath = None;
    if let Some(timer) = g.timer.take() {
        let _: () = unsafe { msg_send![&*timer, invalidate] };
    }
}

/// The watchdog, once while the glow is on.
fn watch(g: &mut Glow, mtm: MainThreadMarker) {
    if g.timer.is_some() {
        return;
    }
    let Some(timer_class) = AnyClass::get(c"NSTimer") else { return };
    let dog: Retained<Watchdog> = unsafe { msg_send![Watchdog::alloc(mtm), init] };
    let none: Option<&AnyObject> = None;
    // The run loop keeps the timer, and the timer its target, until `invalidate`.
    let timer: Option<Retained<AnyObject>> = unsafe {
        msg_send![
            timer_class,
            scheduledTimerWithTimeInterval: WATCH_EVERY_S,
            target: &*dog,
            selector: sel!(check:),
            userInfo: none,
            repeats: true
        ]
    };
    g.timer = timer;
}

/// Show the plan: windows for its screens only, painted when the look or the
/// size changed, the animation reset when the breathing changed.
pub fn apply(plan: Plan) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    GLOW.with(|cell| {
        let Ok(mut g) = cell.try_borrow_mut() else { return };
        if plan.state == State::Off || plan.screens.is_empty() {
            return off(&mut g);
        }
        g.touched = Some(Instant::now());
        let look = Some((plan.state == State::Speaking, glow::colour(plan.state, plan.rgb)));
        let relook = g.look != look;
        g.look = look;
        let breath = (glow::period_ms(plan.state), plan.still);
        let rebreathe = g.breath != Some(breath);
        g.breath = Some(breath);
        let mut old = std::mem::take(&mut g.wins);
        for s in plan.screens {
            if g.wins.iter().any(|w| w.frame == s.frame) {
                continue;
            }
            let (win, fresh) = match old.iter().position(|w| w.frame == s.frame && w.px == s.px) {
                Some(i) => (old.swap_remove(i), false),
                None => match create(mtm, &s) {
                    Some(w) => (w, true),
                    None => continue,
                },
            };
            if (fresh || relook) && !paint(&win, plan.state, plan.rgb) {
                close(win);
                continue;
            }
            if fresh || rebreathe {
                breathe(&win.layer, breath.0, breath.1);
            }
            win.window.orderFrontRegardless();
            g.wins.push(win);
        }
        for w in old {
            close(w);
        }
        if g.wins.is_empty() {
            return off(&mut g);
        }
        watch(&mut g, mtm);
    });
}
