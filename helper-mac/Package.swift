// swift-tools-version:5.9
import PackageDescription

// ─────────────────────────────────────────────────────────────────────────────
// Xenon Helper (macOS) — the twin of helper/ (C#, Windows).
//
// One binary, one mode per argv[0], each speaking the SAME stdio protocol its
// Windows counterpart already speaks. That is the whole design constraint:
// server.js and its hosts should not learn a second vocabulary, they should
// only learn a second path to the executable.
//
// Build (from the repo root):
//   swift build -c release --package-path helper-mac \
//     --arch arm64 --arch x86_64
// and copy .build/apple/Products/Release/xenon-helper into server/helper/.
//
// Optional by design, exactly like the Windows exe: everything degrades to the
// osascript collectors when it is absent (see darwin-collectors.js).
// ─────────────────────────────────────────────────────────────────────────────
let package = Package(
    name: "xenon-helper",
    platforms: [.macOS(.v11)],
    targets: [
        .executableTarget(
            name: "xenon-helper",
            path: "Sources/xenon-helper",
            linkerSettings: [
                // Carbon carries RegisterEventHotKey, which is still the only
                // way to take a system-wide hotkey without an Accessibility
                // grant. AppKit and CoreGraphics do the rest.
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreGraphics"),
                // IOKit carries the accelerator registry (public) and, at
                // runtime, the HID sensor entry points the `temps` mode
                // resolves by dlsym rather than by linking — see TempsTool.
                .linkedFramework("IOKit"),
            ]
        )
    ]
)
