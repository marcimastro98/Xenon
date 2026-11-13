using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

// App-switcher window tool — a faithful one-shot port of windows.ps1, same JSON
// contracts on stdout:
//   windows list          → {"windows":[{id,title,app,path,processId,active,minimized,
//                                        bounds:{x,y,width,height},preview,icon}]}
//   windows focus <hwnd>  → {"ok":bool}
//   windows close <hwnd>  → {"ok":bool,"app":...,"path":...} | {"ok":false,"error":...}
//
// Unlike the media/foreground hosts this is NOT a resident process: the Apps
// panel is opened on demand, so a one-shot run keeps idle cost at zero while
// still skipping what made the PowerShell path slow — a full engine start plus
// an Add-Type C# compile on every single invocation (~1s before any work).
internal static partial class WindowsTool
{
    public static int Run(string[] args)
    {
        var action = args.Length > 1 ? args[1].ToLowerInvariant() : "list";
        switch (action)
        {
            case "list":
                Emit(ListPayload());
                return 0;
            case "focus":
            case "close":
                if (args.Length < 3 || !long.TryParse(args[2], out var hwnd) || hwnd <= 0)
                {
                    Emit(new Dictionary<string, object?> { ["ok"] = false, ["error"] = "Invalid window id" });
                    return 0;
                }
                Emit(action == "focus" ? FocusPayload(hwnd) : ClosePayload(hwnd));
                return 0;
            default:
                Console.Error.WriteLine("usage: xenon-helper windows list | focus <hwnd> | close <hwnd>");
                return 2;
        }
    }

    private static void Emit(Dictionary<string, object?> payload)
    {
        Console.Out.WriteLine(JsonOut.Serialize(payload));
        Console.Out.Flush();
    }

    // ── focus ─────────────────────────────────────────────────────────────────

    private static Dictionary<string, object?> FocusPayload(long hwndValue)
    {
        var hWnd = new IntPtr(hwndValue);
        ShowWindowAsync(hWnd, IsIconic(hWnd) ? SW_RESTORE : SW_SHOW);
        BringWindowToTop(hWnd);
        // The Alt tap releases the foreground lock so SetForegroundWindow is
        // honoured from a background process (same trick as the PS script).
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SwitchToThisWindow(hWnd, true);
        var ok = SetForegroundWindow(hWnd);
        return new Dictionary<string, object?> { ["ok"] = ok };
    }

    // ── close ─────────────────────────────────────────────────────────────────

    // OS-critical processes that must never be closed, even on explicit request.
    private static readonly HashSet<string> ProtectedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "csrss", "winlogon", "wininit", "services", "lsass", "smss",
        "dwm", "system", "registry", "fontdrvhost", "sihost", "ctfmon",
        "searchhost", "shellexperiencehost", "startmenuexperiencehost",
        "textinputhost", "runtimebroker", "applicationframehost",
    };

    private static Dictionary<string, object?> ClosePayload(long hwndValue)
    {
        var hWnd = new IntPtr(hwndValue);
        GetWindowThreadProcessId(hWnd, out var pid);
        if (pid == 0) return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "not_found" };
        try
        {
            using var process = Process.GetProcessById((int)pid);
            var name = string.IsNullOrWhiteSpace(process.ProcessName) ? "" : process.ProcessName;
            var path = "";
            try { path = process.MainModule?.FileName ?? ""; } catch { }
            if (ProtectedNames.Contains(name))
                return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "protected", ["app"] = name };
            // Graceful WM_CLOSE — the app may still prompt to save; never Kill.
            var closed = process.CloseMainWindow();
            return new Dictionary<string, object?> { ["ok"] = closed, ["app"] = name, ["path"] = path };
        }
        catch
        {
            return new Dictionary<string, object?> { ["ok"] = false, ["error"] = "not_found" };
        }
    }
}
