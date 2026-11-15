// macOS: which app was in front, so the screensaver can give the keyboard back to it.

use objc2::{MainThreadMarker, msg_send};
use objc2_app_kit::{NSApplication, NSWindow};
use objc2_foundation::NSArray;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use super::{find, State, STATE};
use super::super::spec::Kind;

/// The front app when it is not Xenon, by message: NSWorkspace may be used
/// off the main thread.
pub(super) fn front_app() -> Option<(Retained<AnyObject>, i32)> {
    let workspace: Retained<AnyObject> =
        unsafe { msg_send![AnyClass::get(c"NSWorkspace")?, sharedWorkspace] };
    let app: Option<Retained<AnyObject>> = unsafe { msg_send![&*workspace, frontmostApplication] };
    let app = app?;
    let pid: i32 = unsafe { msg_send![&*app, processIdentifier] };
    (pid != std::process::id() as i32).then_some((app, pid))
}

/// A screensaver takes the keyboard for as long as it is up, the menu only when
/// it opens: the user may then click on another app under it, and a later sync
/// must not pull the keyboard back. The app it was taken from gets it back when
/// the last one is gone, if the user did not go somewhere else meanwhile.
pub(super) fn saver_focus(st: &mut State, all: &NSArray<NSWindow>, mtm: MainThreadMarker, menu_opened: bool) {
    let saver = st.entries.iter().find(|e| matches!(e.kind, Kind::Saver | Kind::Draw)).map(|e| e.handle);
    let menu = st.entries.iter().find(|e| e.kind == Kind::Menu).map(|e| e.handle);
    if saver.is_none() && menu.is_some() && !menu_opened {
        return;
    }
    match saver.or(menu).and_then(|h| find(all, h)) {
        Some(w) if !w.isKeyWindow() => {
            if st.before_saver.is_none() {
                st.before_saver = front_app().map(|(app, _)| app);
            }
            // Deprecated in macOS 14, and the call that works on every version.
            #[allow(deprecated)]
            NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            w.makeKeyAndOrderFront(None);
        }
        Some(_) => {}
        None => {
            if let Some(app) = st.before_saver.take().filter(|_| front_app().is_none()) {
                let _: bool = unsafe { msg_send![&*app, activateWithOptions: 0usize] };
            }
        }
    }
}

pub fn forget_return_focus() {
    STATE.with(|cell| {
        if let Ok(mut st) = cell.try_borrow_mut() {
            st.before_saver = None;
        }
    });
}
