import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// Xenon Helper (macOS) — mode dispatch, the twin of helper/Program.cs.
//
// One binary, one mode per invocation, each speaking the SAME stdio protocol
// its Windows counterpart speaks. That is the design constraint: server.js and
// its hosts should learn a second PATH to an executable, never a second
// vocabulary.
//
// STAGED ON PURPOSE. The modes below are the ones whose APIs are public and
// well-specified. The rest of Phase 3 — per-app audio levels (Core Audio
// process taps), temperatures (IOReport) and second-screen capture
// (ScreenCaptureKit) — are not stubbed here: an unknown
// mode exits non-zero, which is exactly what every caller already treats as
// "the helper cannot do this", and is how they degrade to the osascript
// collectors today. A stub that answered emptily would look like a working
// feature reporting nothing.
// ─────────────────────────────────────────────────────────────────────────────

let argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.first ?? ""
let rest = Array(argv.dropFirst())

switch mode {
case "windows":
    WindowsTool.run(rest)

case "foreground-serve":
    ForegroundHost.run(rest)

case "hotkey-serve":
    HotkeyHost.run(rest)

case "shell-delete":
    ShellDelete.run()

case "index-serve":
    IndexHost.run(rest)

case "--version", "-v":
    // The installer and helper-update compare this against what the release
    // shipped, so it is a bare version and nothing else.
    print(helperVersion)

default:
    FileHandle.standardError.write(Data("unknown mode: \(mode)\n".utf8))
    exit(2)
}
