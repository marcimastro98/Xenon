import AppKit
import CoreGraphics

// ─────────────────────────────────────────────────────────────────────────────
// `foreground-serve <intervalMs>` — the game probe.
//
// The contract is ForegroundHost.cs's, and gamedetect.js reads exactly three
// fields per line: {fullscreen, process, pid}. Nothing else is consumed, so
// nothing else is emitted.
//
// "Fullscreen" here means what game mode needs it to mean: the frontmost
// application owns a layer-0 window that covers an entire display. That is
// deliberately not the same as macOS' own full-screen Spaces flag — a game
// running borderless at display size is the case that matters, and it never
// sets that flag.
// ─────────────────────────────────────────────────────────────────────────────
enum ForegroundHost {
    static func run(_ args: [String]) {
        let intervalMs = max(250, min(10_000, Int(args.first ?? "") ?? 1000))
        // A push on focus change AND a slow poll: the notification is what makes
        // alt-tabbing into a game feel instant, the poll is what catches a game
        // going borderless-fullscreen without ever changing focus.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { _ in report() }

        Timer.scheduledTimer(withTimeInterval: Double(intervalMs) / 1000.0, repeats: true) { _ in
            report()
        }
        report()
        // Same reason as HotkeyHost: the NSWorkspace notification is an AppKit
        // one, and AppKit's own run loop is what reliably delivers it. The
        // timer would fire under a bare RunLoop, the focus-change push would
        // not — and that push is what makes alt-tabbing into a game instant.
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApplication.shared.run()
    }

    static func report() {
        guard let front = NSWorkspace.shared.frontmostApplication else {
            emit(.obj([("fullscreen", .b(false)), ("process", .s("")), ("pid", .i(0))]))
            return
        }
        let pid = front.processIdentifier
        // gamedetect.js lowercases and compares against an executable name, so
        // the executable's own name is the right value — not the localised
        // display name, which changes with the user's language.
        let procName = front.executableURL?.lastPathComponent
            ?? front.localizedName
            ?? ""
        emit(.obj([
            ("fullscreen", .b(isFullscreen(pid: pid))),
            ("process", .s(procName)),
            ("pid", .i(Int(pid))),
        ]))
    }

    static func isFullscreen(pid: pid_t) -> Bool {
        let screens = NSScreen.screens.map { $0.frame }
        if screens.isEmpty { return false }
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        for entry in list {
            guard let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { continue }
            if let layer = entry[kCGWindowLayer as String] as? Int, layer != 0 { continue }
            guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            for screen in screens {
                // A few points of slack: a window can miss the frame by a pixel
                // through scaling and still be, to the user, fullscreen. The
                // menu bar is the thing this must NOT count, and it is far
                // taller than the tolerance.
                if abs(rect.width - screen.width) <= 2 && abs(rect.height - screen.height) <= 2 {
                    return true
                }
            }
        }
        return false
    }
}
