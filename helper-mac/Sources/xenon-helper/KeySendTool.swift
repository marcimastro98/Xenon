import AppKit
import ApplicationServices
import Carbon.HIToolbox

// ─────────────────────────────────────────────────────────────────────────────
// `keys <combo>` — SEND a key combination to whatever is frontmost.
// `keys --check`  — report whether this binary can do that, WITHOUT sending.
//
// This is the macOS half of server.js's sendHotkey, which on Windows has always
// been deck-hotkey.ps1. It exists for the same two callers: the Deck's `hotkey`
// action, and answering an incoming Teams/Zoom call — both of which are "focus
// the app, then press the shortcut it documents", because those are in-app
// shortcuts and neither app exposes an API for it.
//
// Note the asymmetry with HotkeyHost, which is deliberate and is the reason
// they are separate tools. HotkeyHost RECEIVES one registered combination and
// needs no permission at all. This one SYNTHESISES keystrokes into other
// applications, which macOS gates behind Accessibility — correctly, since it is
// the same capability a keylogger would want. So:
//
//   * the grant is CHECKED, never assumed, and a missing grant is reported as
//     its own error rather than as a silent no-op. A key that vanishes with a
//     success code is indistinguishable from an app that ignored it, and the
//     user would have no way to learn that a checkbox in System Settings is
//     what stands between them and the button working;
//   * `--check` never posts anything, so the server can ask "is this possible
//     here" to decide whether to draw an Answer button, without typing into
//     whatever the user happens to have open.
//
// The combo vocabulary is HotkeyHost.parse's — one shared parser, so a combo
// that can be registered can also be sent, and `alt` keeps meaning Option.
// ─────────────────────────────────────────────────────────────────────────────
enum KeySendTool {

    // Carbon modifier bits (what the shared parser produces) → CGEventFlags
    // (what a synthesised event carries). Two different vocabularies for the
    // same four keys; mapping them in one place keeps the parser shared.
    private static func flags(for carbonModifiers: UInt32) -> CGEventFlags {
        var out: CGEventFlags = []
        if carbonModifiers & UInt32(cmdKey) != 0 { out.insert(.maskCommand) }
        if carbonModifiers & UInt32(shiftKey) != 0 { out.insert(.maskShift) }
        if carbonModifiers & UInt32(optionKey) != 0 { out.insert(.maskAlternate) }
        if carbonModifiers & UInt32(controlKey) != 0 { out.insert(.maskControl) }
        return out
    }

    static func run(_ args: [String]) {
        let first = args.first ?? ""

        if first == "--check" {
            // A capability probe, not an action. Answering `ok:true` here only
            // says the binary understands the mode; `accessibility` is the part
            // that decides whether a key would actually land.
            emit(.obj([("ok", .b(true)), ("accessibility", .b(AXIsProcessTrusted()))]))
            return
        }

        guard let combo = HotkeyHost.parse(first) else {
            emitKeyError("bad_combo")
            exit(1)
        }

        // Without the grant the events are silently dropped by the window
        // server, so refuse up front and name the reason. server.js turns this
        // into the one sentence the user can act on.
        guard AXIsProcessTrusted() else {
            emitKeyError("accessibility_denied")
            exit(1)
        }

        // .hidSystemState is the conventional source for POSTING synthetic
        // events, as opposed to reading state. The combo itself does not depend
        // on the choice: `flags` is set explicitly on both events below, which
        // is what decides which shortcut arrives.
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            emitKeyError("no_event_source")
            exit(1)
        }
        let mods = flags(for: combo.modifiers)
        let key = CGKeyCode(combo.keyCode)

        guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
            emitKeyError("event_create_failed")
            exit(1)
        }
        down.flags = mods
        up.flags = mods
        // .cghidEventTap posts at the lowest point, so the event is delivered
        // like a real keypress to whichever app is frontmost — which is what an
        // in-app shortcut needs, and why the caller focuses the window first.
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)

        emit(.obj([("ok", .b(true))]))
    }

    // `ok:false` plus a machine-readable reason, on stdout like every other
    // answer this binary gives — the caller parses one line either way.
    private static func emitKeyError(_ code: String) {
        emit(.obj([("ok", .b(false)), ("error", .s(code))]))
    }
}
