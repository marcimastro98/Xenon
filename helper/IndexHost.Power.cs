// The file index: keeping the background threads slow and cheap, and handing memory back.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    // ── efficiency mode for the bulk threads ──────────────────────────────────
    // The walk, the repairs and the drain are background bookkeeping nobody is
    // waiting on, so they run under EcoQoS: Windows keeps them on efficiency
    // cores and low clocks instead of boosting a performance core for them
    // while a game or the user's own work wants it. Per THREAD, not per
    // process: the request loop on the main thread answers searches and must
    // stay at full speed. EcoQoS lowers speed, never priority, so a throttled
    // thread holding the index lock still gets scheduled and cannot starve a
    // query. Unsupported (before Windows 10 1709) = plain threads, as before.
    [StructLayout(LayoutKind.Sequential)]
    private struct ThreadPowerThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }
    private const int ThreadPowerThrottlingClass = 3;      // THREAD_INFORMATION_CLASS.ThreadPowerThrottling
    private const uint PowerThrottlingExecutionSpeed = 1;  // THREAD_POWER_THROTTLING_EXECUTION_SPEED
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")]
    private static extern bool SetThreadInformation(IntPtr thread, int infoClass, ref ThreadPowerThrottlingState info, int size);

    private static void UseEfficiencyMode()
    {
        try
        {
            var state = new ThreadPowerThrottlingState
            {
                Version = 1,
                ControlMask = PowerThrottlingExecutionSpeed,
                StateMask = PowerThrottlingExecutionSpeed,
            };
            SetThreadInformation(GetCurrentThread(), ThreadPowerThrottlingClass, ref state, Marshal.SizeOf<ThreadPowerThrottlingState>());
        }
        catch { /* entry point missing on an old Windows: run unthrottled */ }
    }

    // ── heap trim ─────────────────────────────────────────────────────────────
    // An answer is garbage the moment it is written: an overview builds ~10k
    // dictionaries, a JSON string and its base64 twin, then drops them all.
    // The GC reclaims that on its next collection, but it hands the memory
    // back to Windows only gradually and only while collections keep
    // happening — and an idle host has none. Measured: a burst of five
    // overviews left the process 110 MB above its resident index for as long
    // as it sat idle. So after every ~32 MB of answers the host collects
    // aggressively, which decommits. It is cheap here: the index is a few
    // large arrays of structs and bytes with no references to trace.
    private const long TrimEveryBytes = 32L * 1024 * 1024;
    private const int TrimMinIntervalMs = 5_000;
    private static long _trimMark;
    private static long _trimAt;

    private static void TrimHeapIfDue()
    {
        var allocated = GC.GetTotalAllocatedBytes(precise: false);
        var now = Environment.TickCount64;
        if (allocated - _trimMark < TrimEveryBytes || now - _trimAt < TrimMinIntervalMs) return;
        _trimMark = allocated;
        _trimAt = now;
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
    }
}
