// App sound levels: finding the apps that play sound, reading their level and sending it.

using System.Diagnostics;
using System.Runtime.InteropServices;

namespace XenonHelper;

internal static partial class AudioHost
{
    // Meter is a raw IAudioMeterInformation pointer we own a reference on, so it
    // must be Released in Release(); it is never handed to the marshaller.
    private sealed record Session(string Proc, IntPtr Meter);

    private static void Trace(string msg)
    {
        if (Debug) Console.Error.WriteLine("[audio] " + msg);
    }

    private static List<Session>? Enumerate()
    {
        try
        {
            var clsid = CLSID_MMDeviceEnumerator;
            var enumIid = IID_IMMDeviceEnumerator;
            var hr = CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_ALL, ref enumIid, out var enumerator);
            if (hr != 0 || enumerator == IntPtr.Zero) { Trace($"CoCreateInstance hr=0x{hr:X8}"); return null; }

            try
            {
                hr = CallGetDefaultAudioEndpoint(enumerator, eRender, eConsole, out var device);
                if (hr != 0 || device == IntPtr.Zero) { Trace($"GetDefaultAudioEndpoint hr=0x{hr:X8}"); return null; }

                var iid = IID_IAudioSessionManager2;
                IntPtr managerPtr;
                try { hr = CallActivate(device, ref iid, out managerPtr); }
                finally { Marshal.Release(device); }
                if (hr != 0 || managerPtr == IntPtr.Zero) { Trace($"Activate(IAudioSessionManager2) hr=0x{hr:X8}"); return null; }

                IntPtr sessionEnum;
                try { hr = CallGetSessionEnumerator(managerPtr, out sessionEnum); }
                finally { Marshal.Release(managerPtr); }
                if (hr != 0 || sessionEnum == IntPtr.Zero) { Trace($"GetSessionEnumerator hr=0x{hr:X8}"); return null; }

                try
                {
                    return ReadSessions(sessionEnum);
                }
                finally { Marshal.Release(sessionEnum); }
            }
            finally
            {
                Marshal.Release(enumerator);
            }
        }
        catch (Exception ex)
        {
            // A failed enumeration is normal while the audio service restarts or
            // a device is swapped. Keep the previous session list and try again.
            Trace("exception: " + ex.Message);
            return null;
        }
    }

    private static List<Session>? ReadSessions(IntPtr sessionEnum)
    {
        var hr = CallGetCount(sessionEnum, out var count);
        if (hr != 0) { Trace($"GetCount hr=0x{hr:X8}"); return null; }
        Trace($"sessions={count}");

        var list = new List<Session>(count);
        for (var i = 0; i < count; i++)
        {
            hr = CallGetSession(sessionEnum, i, out var ctlPtr);
            if (hr != 0 || ctlPtr == IntPtr.Zero) { Trace($"[{i}] GetSession hr=0x{hr:X8}"); continue; }

            var ctl2 = QueryInterface(ctlPtr, IID_IAudioSessionControl2);
            var meter = QueryInterface(ctlPtr, IID_IAudioMeterInformation);
            Marshal.Release(ctlPtr);
            if (ctl2 == IntPtr.Zero || meter == IntPtr.Zero)
            {
                Trace($"[{i}] QI failed (ctl2={ctl2 != IntPtr.Zero}, meter={meter != IntPtr.Zero})");
                if (ctl2 != IntPtr.Zero) Marshal.Release(ctl2);
                if (meter != IntPtr.Zero) Marshal.Release(meter);
                continue;
            }

            hr = CallGetProcessId(ctl2, out var pid);
            Marshal.Release(ctl2);
            // AUDCLNT_S_NO_SINGLE_PROCESS (0x0889000D) is the system-sounds
            // session: a real session with no single owning process. Skipping it
            // is correct, not a failure.
            if (hr != 0 || pid == 0)
            { Trace($"[{i}] GetProcessId hr=0x{hr:X8} pid={pid}"); Marshal.Release(meter); continue; }

            var proc = ProcName(pid);
            if (proc.Length == 0) { Trace($"[{i}] no proc name for pid={pid}"); Marshal.Release(meter); continue; }
            Trace($"[{i}] {proc} (pid {pid})");
            list.Add(new Session(proc, meter));
        }
        return list;
    }

    private static void EmitTick(List<Session> sessions, long stamp)
    {
        var peaks = new Dictionary<string, object?>();
        foreach (var s in sessions)
        {
            float peak;
            try { if (CallGetPeakValue(s.Meter, out peak) != 0) continue; }
            catch { continue; }              // session died between ticks
            if (peak <= 0.0009f) continue;   // digital silence — not worth a line
            // Several sessions can share one process (browser tabs). The loudest
            // wins: that is the one a person hears.
            if (peaks.TryGetValue(s.Proc, out var prev) && prev is double d && d >= peak) continue;
            peaks[s.Proc] = Math.Round((double)peak, 3);
        }

        var line = JsonOut.Serialize(new Dictionary<string, object?>
        {
            ["t"] = stamp,
            ["s"] = peaks,
        });
        lock (OutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static string ProcName(uint pid)
    {
        if (NameCache.TryGetValue(pid, out var cached)) return cached;
        var name = "";
        try
        {
            using var p = Process.GetProcessById((int)pid);
            name = p.ProcessName.ToLowerInvariant();
        }
        catch { /* exited between enumeration and lookup */ }
        if (NameCache.Count >= NameCacheMax) NameCache.Clear();
        NameCache[pid] = name;
        return name;
    }

    private static void Release(List<Session> sessions)
    {
        foreach (var s in sessions) { if (s.Meter != IntPtr.Zero) Marshal.Release(s.Meter); }
        sessions.Clear();
    }
}
