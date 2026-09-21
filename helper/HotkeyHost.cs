using System.Runtime.InteropServices;

namespace XenonHelper;

// Global-hotkey listener. A web page cannot register a system-wide hotkey and
// the backend has no window, so this tiny host owns a RegisterHotKey + message
// loop and pushes one line per press.
//
// Mode: hotkey-serve <combo> [<combo> ...], each combo like "alt+space",
// "ctrl+alt+k", "ctrl+shift+f1", "win+space". Combos are addressed by their
// POSITION in that list, which is the server's binding table: index 0 is the
// Spotlight shortcut and the rest are whatever else it wanted bound.
//
//   {"event":"ready","registered":[0,2]}       these indices are ours
//   {"event":"hotkey","index":0}               index 0 was pressed
//   {"event":"error","error":"hotkey_taken","index":1}   somebody else owns it
//
// One process for every combo rather than one process each: RegisterHotKey is
// per-thread, so a single message loop can hold all of them, and the server
// already supervises exactly one child here.
//
// A combo another app owns (PowerToys Run famously owns Alt+Space) is reported
// and SKIPPED — the others still register, because losing one shortcut is not a
// reason to lose the rest. Only when every combo fails does the host exit
// non-zero, which is also what the single-combo case has always done.
//
// Stdin EOF (parent gone or retiring us) posts WM_QUIT → clean unregister.
internal static class HotkeyHost
{
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
    // Hotkey ids are per-thread and ours alone; index i takes BASE + i so the
    // WM_HOTKEY wParam maps straight back to the server's binding index.
    private const int HOTKEY_ID_BASE = 0xE01;
    private const int MAX_COMBOS = 16;

    public static int Run(string[] args)
    {
        var combos = args.Length > 1 ? args[1..] : new[] { "alt+space" };
        if (combos.Length > MAX_COMBOS) combos = combos[..MAX_COMBOS];

        var mainThreadId = GetCurrentThreadId();
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            PostThreadMessage(mainThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();

        // List<object?>, not List<int>: JsonOut writes an IEnumerable<object?>
        // as an array and anything else via ToString(), and an int[] is an
        // IEnumerable<int> — value types are not covariant — so a list of ints
        // would have been emitted as the string "System.Int32[]".
        var registered = new List<object?>();
        for (var i = 0; i < combos.Length; i++)
        {
            if (!ParseCombo(combos[i], out var mods, out var vk))
            {
                Emit("error", "bad_combo", i);
                continue;
            }
            if (!RegisterHotKey(IntPtr.Zero, HOTKEY_ID_BASE + i, mods | MOD_NOREPEAT, vk))
            {
                Emit("error", "hotkey_taken", i);
                continue;
            }
            registered.Add(i);   // boxed on purpose; see the declaration
        }

        // Nothing registered: the per-index errors above already said which and
        // why, and each of them still carries the bare `error` field the server
        // has always matched on, so a single-combo setup reports exactly what it
        // used to. Exit non-zero and let the server's backoff bring us back.
        if (registered.Count == 0) return 1;

        EmitReady(registered);

        try
        {
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                if (msg.message != WM_HOTKEY) continue;
                var index = (int)msg.wParam - HOTKEY_ID_BASE;
                if (index >= 0 && index < combos.Length) Emit("hotkey", null, index);
            }
        }
        finally
        {
            foreach (var i in registered) UnregisterHotKey(IntPtr.Zero, HOTKEY_ID_BASE + (int)i!);
        }
        return 0;
    }

    // "ctrl+alt+space" → (MOD_CONTROL|MOD_ALT, VK_SPACE). Letters, digits,
    // space and F1-F24 cover every combo the Settings picker offers.
    private static bool ParseCombo(string combo, out uint mods, out uint vk)
    {
        mods = 0; vk = 0;
        foreach (var raw in combo.ToLowerInvariant().Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw)
            {
                case "ctrl": case "control": mods |= MOD_CONTROL; continue;
                case "alt": mods |= MOD_ALT; continue;
                case "shift": mods |= MOD_SHIFT; continue;
                case "win": case "super": mods |= MOD_WIN; continue;
                case "space": vk = 0x20; continue;
            }
            if (raw.Length == 1)
            {
                var c = raw[0];
                if (c >= 'a' && c <= 'z') { vk = (uint)(char.ToUpperInvariant(c)); continue; }
                if (c >= '0' && c <= '9') { vk = (uint)c; continue; }
                return false;
            }
            if (raw.Length >= 2 && raw[0] == 'f' && int.TryParse(raw.AsSpan(1), out var fn) && fn >= 1 && fn <= 24)
            { vk = (uint)(0x70 + fn - 1); continue; }
            return false;
        }
        return vk != 0 && mods != 0; // a bare unmodified key would swallow normal typing
    }

    private static void Emit(string ev, string? error, int index)
    {
        var obj = new Dictionary<string, object?> { ["event"] = ev, ["index"] = index };
        if (error != null) obj["error"] = error;
        Write(obj);
    }

    private static void EmitReady(List<object?> registered)
    {
        Write(new Dictionary<string, object?>
        {
            ["event"] = "ready",
            ["registered"] = registered,
        });
    }

    private static void Write(Dictionary<string, object?> obj)
    {
        Console.Out.WriteLine(JsonOut.Serialize(obj));
        Console.Out.Flush();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] private static extern int GetMessage(out Msg msg, IntPtr hWnd, uint msgFilterMin, uint msgFilterMax);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}
