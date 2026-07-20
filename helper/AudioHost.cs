using System.Diagnostics;
using System.Runtime.InteropServices;

namespace XenonHelper;

// Per-application audio PEAK metering — the one audio fact Xenon could never
// read. SoundVolumeView reports volume and mute but exports no meter column, so
// before this host nothing in the product knew how loud anything actually was.
//
// Output contract: one bare JSON line per tick on stdout, read by audio-levels.js
//   {"t":1737,"s":{"discord":0.42,"spotify":0.81}}
// `t` is a monotonic millisecond stamp (Environment.TickCount64, for staleness
// checks on the reader side), `s` maps process name (lower-case, no .exe) to the
// session's peak in 0..1. Sessions at digital silence are omitted rather than
// sent as 0 — a mixer with twenty idle apps should not pay for twenty zeroes at
// 12Hz. A tick with nothing playing is still emitted (empty `s`) so the reader
// can tell "silent" from "host died".
//
// Why raw COM and not a library: the helper is published trimmed and
// self-contained and must never load external .NET assemblies. Every call here
// is a direct vtable invocation through a function pointer — no [ComImport]
// interfaces, no RCWs, no reflection — so trimming has nothing to break.
//
// Peak is what the Windows volume mixer itself draws. It is a sample peak over
// the interval since the previous read, already normalised by the session's own
// volume — so a quiet app reads quiet, which is what a meter should show.
internal static class AudioHost
{
    // ── COM plumbing ─────────────────────────────────────────────────────────

    private static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid IID_IMMDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid IID_IAudioSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    // Activated through CoCreateInstance rather than Activator.CreateInstance on
    // Type.GetTypeFromCLSID: the latter trips IL2072 under PublishTrimmed because
    // the returned Type carries no constructor annotation. This is the same
    // explicit-interop shape WindowsTool already uses.
    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        ref Guid clsid, IntPtr outer, int clsContext, ref Guid iid, out IntPtr instance);

    private const int eRender = 0;
    private const int eConsole = 0;
    private const int CLSCTX_ALL = 23;

    // The ENTIRE WASAPI chain is called through its vtable by hand, with no
    // [ComImport] interfaces at all. This is not stylistic: reached through the
    // interop marshaller these interfaces answered E_POINTER on
    // GetSessionEnumerator and S_OK-with-pid-0 on GetProcessId — wrong-slot
    // answers, one of them wearing a success code — and GetDefaultAudioEndpoint
    // only behaved when some other call had run first. A function pointer removes
    // the marshaller from the question. Slot numbers count from IUnknown:
    //   IUnknown              0 QueryInterface, 1 AddRef, 2 Release
    //   IMMDeviceEnumerator   3 EnumAudioEndpoints, 4 GetDefaultAudioEndpoint
    //   IMMDevice             3 Activate
    //   IAudioSessionManager  3 GetAudioSessionControl, 4 GetSimpleAudioVolume
    //   IAudioSessionManager2 5 GetSessionEnumerator
    //   IAudioSessionEnumerator 3 GetCount, 4 GetSession
    //   IAudioSessionControl  3 GetState .. 11 UnregisterAudioSessionNotification
    //   IAudioSessionControl2 12 GetSessionIdentifier, 13 GetSessionInstanceIdentifier,
    //                         14 GetProcessId
    //   IAudioMeterInformation 3 GetPeakValue
    private const int SlotGetDefaultAudioEndpoint = 4;
    private const int SlotActivate = 3;
    private const int SlotGetSessionEnumerator = 5;
    private const int SlotGetCount = 3;
    private const int SlotGetSession = 4;
    private const int SlotGetProcessId = 14;
    private const int SlotGetPeakValue = 3;

    private static readonly Guid IID_IAudioSessionControl2 = new("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");
    private static readonly Guid IID_IAudioMeterInformation = new("C02216F6-8C67-4B5B-9D00-D008E73E0064");

    private static unsafe IntPtr Slot(IntPtr obj, int index) => (*(IntPtr**)obj)[index];

    private static unsafe int CallGetDefaultAudioEndpoint(IntPtr enumerator, int dataFlow, int role, out IntPtr device)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, int, out IntPtr, int>)Slot(enumerator, SlotGetDefaultAudioEndpoint);
        return fn(enumerator, dataFlow, role, out device);
    }

    private static unsafe int CallActivate(IntPtr device, ref Guid iid, out IntPtr iface)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, Guid*, int, IntPtr, out IntPtr, int>)Slot(device, SlotActivate);
        fixed (Guid* pIid = &iid) return fn(device, pIid, CLSCTX_ALL, IntPtr.Zero, out iface);
    }

    private static unsafe int CallGetSessionEnumerator(IntPtr manager, out IntPtr sessionEnum)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, out IntPtr, int>)Slot(manager, SlotGetSessionEnumerator);
        return fn(manager, out sessionEnum);
    }

    private static unsafe int CallGetCount(IntPtr sessionEnum, out int count)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, out int, int>)Slot(sessionEnum, SlotGetCount);
        return fn(sessionEnum, out count);
    }

    private static unsafe int CallGetSession(IntPtr sessionEnum, int index, out IntPtr session)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, int, out IntPtr, int>)Slot(sessionEnum, SlotGetSession);
        return fn(sessionEnum, index, out session);
    }

    private static unsafe int CallGetProcessId(IntPtr ctl2, out uint pid)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, out uint, int>)Slot(ctl2, SlotGetProcessId);
        return fn(ctl2, out pid);
    }

    private static unsafe int CallGetPeakValue(IntPtr meter, out float peak)
    {
        var fn = (delegate* unmanaged[Stdcall]<IntPtr, out float, int>)Slot(meter, SlotGetPeakValue);
        return fn(meter, out peak);
    }

    private static IntPtr QueryInterface(IntPtr unknown, Guid iid)
    {
        return Marshal.QueryInterface(unknown, in iid, out var result) == 0 ? result : IntPtr.Zero;
    }

    // IAudioSessionControl2 and IAudioMeterInformation are deliberately NOT
    // declared as [ComImport] interfaces: every attempt to reach them through the
    // marshaller answered S_OK with an empty result (a wrong-slot answer wearing
    // a success code). They are reached by QueryInterface on the raw session
    // pointer and called through the vtable helpers above.

    // ── Host ─────────────────────────────────────────────────────────────────

    private static readonly object OutLock = new();
    private static readonly ManualResetEventSlim ExitRequested = new(false);

    // pid → process name, so the per-tick loop never pays for a Process lookup.
    // Bounded: a machine with more than this many distinct audio pids over one
    // run is pathological, and dropping the cache costs one lookup each.
    private const int NameCacheMax = 256;
    private static readonly Dictionary<uint, string> NameCache = new();

    public static int Run(int intervalMs)
    {
        // Parent-death watch: the server never writes to stdin, so EOF means the
        // parent is gone. Same contract as the other hosts.
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            ExitRequested.Set();
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();

        // The session list is rebuilt on a slow cadence, not every tick:
        // enumerating is far more expensive than reading a meter, and a device
        // captured once is stale forever (apps open and close). Same shape as
        // the lighting bridge's bounded re-enumeration.
        var sessions = new List<Session>();
        var lastEnum = 0L;
        const long ReenumerateEveryMs = 2000;

        while (!ExitRequested.IsSet)
        {
            var now = Environment.TickCount64;
            if (now - lastEnum >= ReenumerateEveryMs || sessions.Count == 0)
            {
                lastEnum = now;
                var fresh = Enumerate();
                if (fresh != null) { Release(sessions); sessions = fresh; }
            }

            EmitTick(sessions, now);
            if (ExitRequested.Wait(intervalMs)) break;
        }

        Release(sessions);
        return 0;
    }

    // Meter is a raw IAudioMeterInformation pointer we own a reference on, so it
    // must be Released in Release(); it is never handed to the marshaller.
    private sealed record Session(string Proc, IntPtr Meter);

    // COM failures here are silent by design (a device swap mid-enumeration is
    // normal), which makes a real breakage invisible. Set XENON_AUDIO_DEBUG=1 to
    // trace the HRESULTs to stderr without touching the stdout line protocol.
    private static readonly bool Debug =
        Environment.GetEnvironmentVariable("XENON_AUDIO_DEBUG") == "1";

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
