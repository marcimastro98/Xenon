import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// `lock` — lock the screen immediately, the macOS twin of Windows'
// LockWorkStation.
//
// This mode exists because the path server.js used has been REMOVED from the
// OS. `CGSession -suspend`, under
// /System/Library/CoreServices/Menu Extras/User.menu/…, was the documented
// "lock now" for a decade and is gone on macOS 26 (the Menu Extras folder
// survives, User.menu does not). execFile answered ENOENT, so the Deck key
// reported a failure and did nothing — silently, since a key that fails looks
// exactly like a key nobody pressed.
//
// SACLockScreenImmediate in login.framework is what the OS itself calls for the
// Lock Screen menu item. It is private, so it is reached through dlsym for the
// same reason the HID sensor calls in TempsTool are: a macOS release that stops
// exporting it must cost the lock key and nothing else. Linking it would mean a
// helper that will not launch at all, taking the app switcher, the index and
// the game probe down with it.
//
// The alternatives were both worse. `pmset displaysleepnow` sleeps the display
// and only locks if the user asked for a password after sleep — it is the
// server's fallback for exactly that reason, but as the primary path it would
// mean a lock key that quietly does not lock on any Mac configured the other
// way. Synthesising ⌃⌘Q through System Events needs the Accessibility grant,
// which is a second permission prompt for something the OS already exposes.
//
// Output contract: one JSON line `{"ok":true}` on success, non-zero exit
// otherwise — which is what every caller already reads as "the helper cannot do
// this", and is what makes server.js fall through to pmset.
// ─────────────────────────────────────────────────────────────────────────────
enum LockTool {
    private static let loginFramework =
        "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"

    static func run() {
        guard lockImmediately() else {
            FileHandle.standardError.write(Data("lock unavailable\n".utf8))
            exit(3)
        }
        emit(.obj([("ok", .b(true))]))
    }

    private static func lockImmediately() -> Bool {
        // The handle is deliberately not dlclose()d: the process exits right
        // after, and unloading a framework mid-call is how a crash on teardown
        // turns a working lock into a non-zero exit.
        guard let handle = dlopen(loginFramework, RTLD_LAZY) else { return false }
        guard let symbol = dlsym(handle, "SACLockScreenImmediate") else { return false }
        typealias LockFn = @convention(c) () -> Int32
        return unsafeBitCast(symbol, to: LockFn.self)() == 0
    }
}
