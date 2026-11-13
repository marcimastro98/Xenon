// Screen mirror: turning a touch or a key from the tile into mouse and keyboard input.

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace XenonHelper;

internal static partial class ScreenHost
{
    // ── Input injection (SendInput onto the virtual desktop) ────────────────────
    //
    // The tile sends fractional coordinates (0..1 across the displayed frame); we
    // map them onto the captured monitor's pixel rect, then normalize to the whole
    // virtual desktop (0..65535) for MOUSEEVENTF_ABSOLUTE|VIRTUALDESK. Everything
    // stays in the same (process-DPI) coordinate space the capture uses, so clicks
    // land where they appear. Never throws — a bad event is dropped silently.
    private static void HandleInput(JsonElement root)
    {
        try
        {
            var kind = ReadString(root, "kind");
            if (kind == "key")
            {
                var subtype = ReadString(root, "subtype");
                if (subtype == "char")
                {
                    var cp = ReadInt(root, "cp", 0);
                    if (cp > 0 && cp <= 0xFFFF) { SendUnicode((ushort)cp, false); SendUnicode((ushort)cp, true); }
                    return;
                }
                var vk = ReadInt(root, "vk", 0);
                if (vk > 0) SendKey((ushort)vk, subtype == "up");
                return;
            }

            MonitorInfo? mon;
            lock (CaptureLock) { mon = _active?.Target; }
            if (mon == null) return;

            var fx = ReadDouble(root, "fx", 0);
            var fy = ReadDouble(root, "fy", 0);
            var (nx, ny) = ToVirtualDesktopNormalized(mon, fx, fy);

            if (kind == "wheel")
            {
                var delta = ReadInt(root, "delta", 0);
                SendMouse(MOUSEEVENTF_WHEEL | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE, nx, ny, unchecked((uint)delta));
                return;
            }
            if (kind == "mouse")
            {
                var subtype = ReadString(root, "subtype");
                var button = ReadString(root, "button");
                uint flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE;
                if (subtype == "down") flags |= button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
                else if (subtype == "up") flags |= button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
                SendMouse(flags, nx, ny, 0);
            }
        }
        catch { /* drop the event */ }
    }

    private static (int nx, int ny) ToVirtualDesktopNormalized(MonitorInfo mon, double fx, double fy)
    {
        fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
        fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
        var mx = mon.X + fx * mon.Width;
        var my = mon.Y + fy * mon.Height;
        int vsX = GetSystemMetrics(SM_XVIRTUALSCREEN), vsY = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vsW = GetSystemMetrics(SM_CXVIRTUALSCREEN), vsH = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        int nx = (int)Math.Round((mx - vsX) * 65535.0 / Math.Max(1, vsW - 1));
        int ny = (int)Math.Round((my - vsY) * 65535.0 / Math.Max(1, vsH - 1));
        return (Clamp(nx, 0, 65535), Clamp(ny, 0, 65535));
    }

    private static void SendMouse(uint flags, int nx, int ny, uint mouseData)
    {
        var inp = new INPUT { type = INPUT_MOUSE };
        inp.U.mi = new MOUSEINPUT { dx = nx, dy = ny, mouseData = mouseData, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void SendKey(ushort vk, bool up)
    {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }

    private static void SendUnicode(ushort codepoint, bool up)
    {
        var inp = new INPUT { type = INPUT_KEYBOARD };
        inp.U.ki = new KEYBDINPUT { wVk = 0, wScan = codepoint, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u), time = 0, dwExtraInfo = IntPtr.Zero };
        SendInput(1, new[] { inp }, Marshal.SizeOf<INPUT>());
    }
}
