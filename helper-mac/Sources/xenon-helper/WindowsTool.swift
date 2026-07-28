import AppKit
import CoreGraphics

// ─────────────────────────────────────────────────────────────────────────────
// `windows list | focus <pid> | close <pid>` — the app switcher.
//
// The contract is WindowsTool.cs's, which darwin-collectors.js already mirrors
// with osascript:
//   list  → {"windows":[{id,title,app,path,active,minimized,icon}]}
//   focus → {"ok":bool}
//   close → {"ok":bool, app, path} | {"ok":false,"error":"protected"|"not_found"}
//
// Why this exists when osascript already answers: the osascript path needs the
// AUTOMATION permission, which macOS asks for per target application, so the
// list stays empty until the user has approved each app individually. Reading
// NSWorkspace needs no permission at all, and the window TITLES come from the
// window server's own list rather than from scripting each app.
// ─────────────────────────────────────────────────────────────────────────────
enum WindowsTool {
    // Quitting any of these logs the user out or takes the desktop down. Same
    // list darwin-collectors.js keeps, and for the same reason.
    static let protectedApps: Set<String> = [
        "Finder", "System Events", "loginwindow", "Dock", "SystemUIServer",
        "WindowManager", "ControlCenter", "NotificationCenter", "Xenon",
    ]

    static let maxWindows = 24

    // Titles of on-screen windows, by owning pid. CGWindowListCopyWindowInfo is
    // public API and needs no permission for the window LIST; the titles come
    // back only when Screen Recording has been granted, so a nil title is a
    // normal outcome and falls back to the application name.
    static func frontWindowTitles() -> [pid_t: String] {
        var byPid: [pid_t: String] = [:]
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return byPid
        }
        for entry in list {
            guard let pid = entry[kCGWindowOwnerPID as String] as? pid_t else { continue }
            // Layer 0 is an ordinary application window; menus, panels and the
            // Dock live on higher layers and are not what the switcher shows.
            if let layer = entry[kCGWindowLayer as String] as? Int, layer != 0 { continue }
            guard let name = entry[kCGWindowName as String] as? String, !name.isEmpty else { continue }
            // The window list is front-to-back, so the first hit per pid is the
            // frontmost window of that application.
            if byPid[pid] == nil { byPid[pid] = name }
        }
        return byPid
    }

    struct Entry {
        let pid: pid_t
        let app: String
        let path: String
        let active: Bool
        let title: String
    }

    static func entries(includeProtected: Bool) -> [Entry] {
        let titles = frontWindowTitles()
        var out: [Entry] = []
        for app in NSWorkspace.shared.runningApplications {
            // .regular is "has a Dock icon": the agents and daemons that make up
            // most of the process table are not applications a user switches to.
            guard app.activationPolicy == .regular else { continue }
            let name = (app.localizedName ?? "").trimmingCharacters(in: .whitespaces)
            if name.isEmpty { continue }
            if !includeProtected && protectedApps.contains(name) { continue }
            out.append(Entry(
                pid: app.processIdentifier,
                app: name,
                path: app.bundleURL?.path ?? "",
                active: app.isActive,
                title: titles[app.processIdentifier] ?? name
            ))
            if out.count >= maxWindows && !includeProtected { break }
        }
        return out
    }

    static func run(_ args: [String]) {
        let action = args.first ?? "list"
        switch action {
        case "focus":
            guard let pid = parsePid(args.dropFirst().first) else {
                emit(.obj([("ok", .b(false)), ("error", .s("not_found"))])); return
            }
            let app = NSRunningApplication(processIdentifier: pid)
            let ok = app?.activate(options: [.activateIgnoringOtherApps]) ?? false
            emit(.obj([("ok", .b(ok))]))

        case "close":
            guard let pid = parsePid(args.dropFirst().first) else {
                emit(.obj([("ok", .b(false)), ("error", .s("not_found"))])); return
            }
            // Look through the UNFILTERED list: a quit aimed at Finder has to be
            // able to answer "protected", and it cannot if the row was dropped.
            guard let hit = entries(includeProtected: true).first(where: { $0.pid == pid }) else {
                emit(.obj([("ok", .b(false)), ("error", .s("not_found"))])); return
            }
            if protectedApps.contains(hit.app) {
                emit(.obj([("ok", .b(false)), ("error", .s("protected")), ("app", .s(hit.app))])); return
            }
            // terminate(), never forceTerminate(): the app gets to prompt about
            // unsaved work, which is what the Windows path's WM_CLOSE does.
            let ok = NSRunningApplication(processIdentifier: pid)?.terminate() ?? false
            emit(.obj([("ok", .b(ok)), ("app", .s(hit.app)), ("path", .s(hit.path))]))

        default:
            let items: [J] = entries(includeProtected: false).map { e in
                .obj([
                    ("id", .s(String(e.pid))),   // a digit string: server.js validates /^\d{1,24}$/
                    ("title", .s(e.title)),
                    ("app", .s(e.app)),
                    ("path", .s(e.path)),
                    ("active", .b(e.active)),
                    ("minimized", .b(false)),    // needs Accessibility; never guessed
                    ("icon", .null),
                ])
            }
            emit(.obj([("windows", .arr(items))]))
        }
    }

    // Digits only, and it must fit a pid_t. The value arrives from an HTTP
    // request that server.js has already shape-checked, but this binary is a
    // separate trust boundary and re-checks rather than assuming.
    static func parsePid(_ raw: String?) -> pid_t? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty,
              raw.allSatisfy({ $0.isASCII && $0.isNumber }), raw.count <= 24,
              let value = Int32(raw), value > 0 else { return nil }
        return pid_t(value)
    }
}
