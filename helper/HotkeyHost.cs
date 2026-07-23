using System.Runtime.InteropServices;

namespace XenonHelper;

// Global-hotkey listener for the Spotlight popup. A web page cannot register a
// system-wide hotkey and the backend has no window, so this tiny host owns a
// RegisterHotKey + message loop and pushes one line per press:
//   {"event":"hotkey"}
// The server reacts by opening/focusing the /spotlight window on the main PC.
//
// Mode: hotkey-serve <combo>, combo like "alt+space", "ctrl+alt+k",
// "ctrl+shift+f1", "win+space". If the combo is already taken by another app
// (PowerToys Run famously owns Alt+Space) registration fails and the host
// reports {"event":"error","error":"hotkey_taken"} and exits — the server
// surfaces that in Settings instead of silently doing nothing.
//
// Stdin EOF (parent gone or retiring us) posts WM_QUIT → clean unregister.
internal static class HotkeyHost
{
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
    private const int HOTKEY_ID = 0xE01;

    public static int Run(string[] args)
    {
        var combo = args.Length > 1 ? args[1] : "alt+space";
        if (!ParseCombo(combo, out var mods, out var vk))
        {
            Emit("error", "bad_combo");
            return 2;
        }

        var mainThreadId = GetCurrentThreadId();
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            PostThreadMessage(mainThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();

        if (!RegisterHotKey(IntPtr.Zero, HOTKEY_ID, mods | MOD_NOREPEAT, vk))
        {
            Emit("error", "hotkey_taken");
            return 1;
        }
        Emit("ready", null);

        try
        {
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                if (msg.message == WM_HOTKEY && msg.wParam == (IntPtr)HOTKEY_ID)
                    Emit("hotkey", null);
            }
        }
        finally
        {
            UnregisterHotKey(IntPtr.Zero, HOTKEY_ID);
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

    private static void Emit(string ev, string? error)
    {
        var obj = new Dictionary<string, object?> { ["event"] = ev };
        if (error != null) obj["error"] = error;
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
