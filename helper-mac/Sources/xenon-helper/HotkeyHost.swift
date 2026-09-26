import AppKit
import Carbon.HIToolbox

// ─────────────────────────────────────────────────────────────────────────────
// `hotkey-serve <combo> [<combo> ...]` — the global shortcuts.
//
// The contract is HotkeyHost.cs's. Combos are addressed by their POSITION in
// the list, which is the server's binding table: index 0 is the Spotlight
// shortcut and the rest are whatever else it wanted bound (the dashboard page
// shortcuts). server.js reads exactly three events:
//   {"event":"ready","registered":[0,2]}                 these indices are ours
//   {"event":"hotkey","index":0}                         index 0 was pressed
//   {"event":"error","error":"hotkey_taken","index":1}   somebody else owns it
//
// RegisterEventHotKey rather than a CGEventTap on purpose. A tap would see
// every keystroke on the machine and needs the Accessibility grant to do it;
// this registers only the named combinations with the window server and is told
// when one of them is pressed, nothing else. For a feature whose whole job is to
// open a search box and flip a page, watching every key the user types is not a
// trade worth making.
// ─────────────────────────────────────────────────────────────────────────────
enum HotkeyHost {
    // The token vocabulary server.js already accepts, mapped to virtual key
    // codes. Deliberately small: a hotkey the user cannot name in Settings is a
    // hotkey nobody can take back.
    static let keyCodes: [String: Int] = [
        "space": kVK_Space, "escape": kVK_Escape, "return": kVK_Return, "enter": kVK_Return,
        "tab": kVK_Tab, "home": kVK_Home, "end": kVK_End,
        "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
        "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
        "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
        "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
        "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    ]

    struct Combo {
        let modifiers: UInt32
        let keyCode: UInt32
    }

    // "Alt+Space", "ctrl+shift+X". Alt is written the Windows way in the
    // settings the combo comes from, and it means Option here — translating the
    // name rather than asking the user to relearn it is the whole point.
    static func parse(_ raw: String) -> Combo? {
        var modifiers: UInt32 = 0
        var key: Int?
        for part in raw.lowercased().split(separator: "+") {
            switch part.trimmingCharacters(in: .whitespaces) {
            case "alt", "option", "opt": modifiers |= UInt32(optionKey)
            case "ctrl", "control": modifiers |= UInt32(controlKey)
            case "shift": modifiers |= UInt32(shiftKey)
            case "cmd", "command", "win", "meta", "super": modifiers |= UInt32(cmdKey)
            case let token:
                // Exactly one non-modifier token, or the combo is ambiguous and
                // is refused rather than half-registered.
                if key != nil { return nil }
                guard let code = keyCodes[token] else { return nil }
                key = code
            }
        }
        guard let code = key, modifiers != 0 else { return nil }
        return Combo(modifiers: modifiers, keyCode: UInt32(code))
    }

    private static func emitIndexedError(_ code: String, _ index: Int) {
        emit(.obj([("event", .s("error")), ("error", .s(code)), ("index", .i(index))]))
    }

    static var handlerRef: EventHandlerRef?
    static var hotKeyRefs: [EventHotKeyRef] = []

    static let maxCombos = 16

    // Carbon hands the handler the hotkey's own id back, which is how one
    // handler serves every combo: id = index + 1 (0 is not a usable id), so the
    // press maps straight back to the server's binding index.
    private static func firedIndex(_ event: EventRef?) -> Int? {
        guard let event = event else { return nil }
        var id = EventHotKeyID()
        let got = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                    EventParamType(typeEventHotKeyID), nil,
                                    MemoryLayout<EventHotKeyID>.size, nil, &id)
        guard got == noErr, id.id >= 1 else { return nil }
        return Int(id.id) - 1
    }

    static func run(_ args: [String]) {
        let combos = Array((args.isEmpty ? ["alt+space"] : args).prefix(maxCombos))
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        // The handler is a C function pointer, so the closure may capture
        // nothing. An unqualified `firedIndex` inside a static method is
        // `self.firedIndex` and captures the metatype, which Swift refuses here;
        // naming the type keeps it a plain static call.
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            if let index = HotkeyHost.firedIndex(event) {
                emit(.obj([("event", .s("hotkey")), ("index", .i(index))]))
            }
            return noErr
        }, 1, &eventType, nil, &handlerRef)
        if installed != noErr { emitError("handler_failed"); return }

        // A combo somebody else owns is reported against its own index and
        // skipped: losing one shortcut is not a reason to lose the rest. Only
        // when every one of them fails does the host give up, which is also
        // what the single-combo case has always done.
        var registered: [J] = []
        for (i, raw) in combos.enumerated() {
            guard let combo = parse(raw) else {
                emitIndexedError("bad_combo", i); continue
            }
            // 'XENO' as the signature; the id only has to be unique within this
            // process, so it carries the index.
            let hotKeyID = EventHotKeyID(signature: OSType(0x58454E4F), id: UInt32(i + 1))
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, hotKeyID,
                                             GetApplicationEventTarget(), 0, &ref)
            if status != noErr {
                // eventHotKeyExistsErr is the specific "somebody else owns this
                // combination" answer, which Settings shows as 'taken' so the
                // user can pick another instead of wondering why nothing happens.
                emitIndexedError(status == OSStatus(eventHotKeyExistsErr) ? "hotkey_taken" : "register_failed", i)
                continue
            }
            if let ref = ref { hotKeyRefs.append(ref) }
            registered.append(.i(i))
        }
        if registered.isEmpty { exit(1) }
        emit(.obj([("event", .s("ready")), ("registered", .arr(registered))]))
        // Stdin EOF = the parent is gone or is retiring us. server.js's
        // _stopHotkeyListener closes stdin FIRST and only escalates to a kill
        // after a 2s grace — the C# twin exits on that close, and without this
        // reader the Swift host never noticed: every stop burned the full
        // grace period, and a quick combo change could race the old process's
        // still-live registration into a false 'hotkey_taken'. Unregister on
        // the main queue (NSApplication.run pumps it), then leave.
        DispatchQueue.global(qos: .utility).async {
            while readLine(strippingNewline: false) != nil {}
            DispatchQueue.main.async {
                for ref in hotKeyRefs { UnregisterEventHotKey(ref) }
                exit(0)
            }
        }
        // NSApplication.run(), not RunLoop.run(). A Carbon hot key is delivered
        // through the Carbon event loop that AppKit's run loop pumps; a bare
        // RunLoop keeps the process alive and never dispatches the event, which
        // would look exactly like a hotkey nobody is pressing.
        // .prohibited keeps it out of the Dock and the switcher — a hot key is
        // delivered to a background process regardless.
        NSApplication.shared.setActivationPolicy(.prohibited)
        NSApplication.shared.run()
    }
}
