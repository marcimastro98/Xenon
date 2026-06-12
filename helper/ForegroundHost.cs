using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

// Foreground full-screen probe — the reliable "is a game running" signal.
// Faithful port of foreground.ps1, same output contract: one bare JSON line
//   {"fullscreen":bool,"process":"name","pid":N}
// per interval on stdout, read by gamedetect.js.
//
// A real game owns the foreground window and covers its entire monitor
// (exclusive or borderless full-screen) WITHOUT a title bar. Comparing the
// window rect to the FULL monitor rect (rcMonitor, not the work area) and
// requiring no WS_CAPTION cleanly separates full-screen games from maximized
// apps. Needs no admin rights and never false-positives on perpetual
// presenters (iCUE, the dashboard's own browser) the way PresentMon does.
//
// On top of the PS contract: a Win32 event hook (EVENT_SYSTEM_FOREGROUND)
// emits an extra line the instant the foreground window changes, so game mode
// reacts immediately instead of on the next 2s tick. The hook is best-effort;
// the interval loop alone preserves the original behaviour (and still catches
// fullscreen toggles that change no focus, e.g. windowed → borderless).
internal static class ForegroundHost
{
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint WINEVENT_OUTOFCONTEXT = 0;
    private const int GWL_STYLE = -16;
    private const int WS_CAPTION = 0x00C00000;
    private const int MONITOR_DEFAULTTONEAREST = 2;

    private static readonly object OutLock = new();
    private static readonly AutoResetEvent Poke = new(false);
    private static readonly ManualResetEventSlim ExitRequested = new(false);

    // Keeps the hook callback delegate alive: a GC'd delegate behind a live
    // Win32 hook is a use-after-free crash.
    private static WinEventDelegate? _hookDelegate;

    public static int Run(int intervalMs)
    {
        // Parent-death watch: the server never writes to stdin; EOF means the
        // parent is gone (or retiring us) — exit cleanly like the PS probe.
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            ExitRequested.Set();
            Poke.Set();
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();

        // Win32 event hooks deliver through a message loop, so the hook lives
        // on its own pumping thread.
        new Thread(HookThread) { IsBackground = true, Name = "winevent-pump" }.Start();

        while (!ExitRequested.IsSet)
        {
            EmitProbe();
            Poke.WaitOne(intervalMs);
        }
        return 0;
    }

    private static void HookThread()
    {
        try
        {
            _hookDelegate = (_, _, _, _, _, _, _) => Poke.Set();
            var hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                IntPtr.Zero, _hookDelegate, 0, 0, WINEVENT_OUTOFCONTEXT);
            if (hook == IntPtr.Zero) return; // no events; the interval loop still works
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch { }
    }

    private static void EmitProbe()
    {
        Dictionary<string, object?> payload;
        try { payload = Probe(); }
        catch { payload = Payload(false, "", 0); }
        var json = JsonOut.Serialize(payload);
        lock (OutLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private static Dictionary<string, object?> Probe()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return Payload(false, "", 0);

        var cls = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        var className = cls.ToString();
        if (className is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Button")
            return Payload(false, "", 0);

        if (!GetWindowRect(hwnd, out var w)) return Payload(false, "", 0);

        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        var mi = new MonitorInfo { cbSize = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref mi)) return Payload(false, "", 0);

        const int tol = 2; // borderless games match the monitor exactly; allow a hair
        var coversMonitor =
            w.Left <= mi.rcMonitor.Left + tol &&
            w.Top <= mi.rcMonitor.Top + tol &&
            w.Right >= mi.rcMonitor.Right - tol &&
            w.Bottom >= mi.rcMonitor.Bottom - tol;

        var style = GetWindowLong(hwnd, GWL_STYLE);
        var hasCaption = (style & WS_CAPTION) == WS_CAPTION;
        var fullscreen = coversMonitor && !hasCaption;

        GetWindowThreadProcessId(hwnd, out var pid);
        var name = "";
        try { using var p = Process.GetProcessById((int)pid); name = p.ProcessName; } catch { }

        return Payload(fullscreen, name, pid);
    }

    private static Dictionary<string, object?> Payload(bool fullscreen, string process, uint pid)
    {
        return new Dictionary<string, object?>
        {
            ["fullscreen"] = fullscreen,
            ["process"] = process,
            ["pid"] = (long)pid,
        };
    }

    // ── Win32 ─────────────────────────────────────────────────────────────────

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int cbSize; public Rect rcMonitor; public Rect rcWork; public uint dwFlags; }

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

    private delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate proc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] private static extern int GetMessage(out Msg msg, IntPtr hWnd, uint msgFilterMin, uint msgFilterMax);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Msg msg);
}
