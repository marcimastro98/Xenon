// macOS: the window that carries the glow: made, painted, made to breathe.

use objc2::{MainThreadMarker, MainThreadOnly, msg_send};
use objc2_app_kit::{NSBackingStoreType, NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask};
use objc2_foundation::{NSPoint, NSRect};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use super::{BREATH_KEY, ns_number, ns_string, Screen, Win};
use super::image::image;
use super::super::glow::{self, State};

/// A window over the whole screen that nothing reaches: no mouse, no focus,
/// no capture, no Cmd+H, on every Space and over full-screen apps.
pub(super) fn create(mtm: MainThreadMarker, s: &Screen) -> Option<Win> {
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
pub(super) fn paint(w: &Win, state: State, rgb: [u8; 3]) -> bool {
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
pub(super) fn breathe(layer: &AnyObject, period: u32, still: bool) {
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
