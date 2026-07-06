using Windows.Storage.Streams;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace XenonHelper;

// Windows notification mirror — reads the toasts currently in Action Center via
// the WinRT UserNotificationListener and streams NEW ones to the server as bare
// JSON lines (the foreground-serve framing):
//
//   {"event":"status","status":"allowed"|"denied"|"unavailable"}
//   {"event":"seed","items":[item,...]}          // newest first, once at start
//   {"event":"notification","item":{...}}        // each new toast afterwards
//
// item = {id, app, aumid, title, body, at, icon} — lengths capped here so the
// server never has to defend against a runaway payload (projection invariant).
//
// Polling, not events: NotificationChanged is documented-broken for apps
// without package identity (0x80070490), while RequestAccessAsync +
// GetNotificationsAsync work fine unpackaged on Win10 1809+/Win11 (verified on
// a live system). Ids are session-monotonic, so "new" is simply id > maxSeen.
// On builds where even the read path demands identity, the first call throws
// and we report "unavailable" — the tile degrades, never a hard failure.
internal static class NotificationHost
{
    private const int WinRtTimeoutMs = 4000;
    private const int SeedMax = 30;
    private const int TitleMax = 200;
    private const int BodyMax = 400;
    private const int MaxLogoBytes = 96 * 1024;
    private const int IconCacheMax = 64;
    private const int DeniedRecheckMs = 5000;

    private static readonly object OutLock = new();
    private static readonly ManualResetEventSlim ExitRequested = new(false);
    // Per-app logo as a data: URI (or null for "tried, none") — re-decoding the
    // same logo on every toast from the same app is pure waste.
    private static readonly Dictionary<string, string?> IconCache = new();

    public static async Task<int> RunAsync(int intervalMs)
    {
        // Parent-death watch: the server never writes to stdin; EOF means the
        // parent is gone (or retiring us) — exit cleanly like the other hosts.
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            ExitRequested.Set();
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();

        UserNotificationListener listener;
        try { listener = UserNotificationListener.Current; }
        catch { EmitStatus("unavailable"); return 1; }

        var status = await ProbeAccessAsync(listener);
        EmitStatus(status);
        if (status == "unavailable") return 1;   // identity-gated build: nothing will ever work

        long maxSeen = -1;                        // -1 = seed not sent yet
        while (!ExitRequested.IsSet)
        {
            try
            {
                if (status != "allowed")
                {
                    // Denied: the user can grant access in Windows Settings at any
                    // time — keep re-checking cheaply so the feed self-heals.
                    var s = ProbeAccessSync(listener);
                    if (s != status) { status = s; EmitStatus(s); }
                    if (s != "allowed") { ExitRequested.Wait(DeniedRecheckMs); continue; }
                }

                var current = await ReadAllAsync(listener);
                if (maxSeen < 0)
                {
                    // First successful read: seed with what's in Action Center now
                    // (newest first, capped) instead of flooding one event per line.
                    var seed = current.OrderByDescending(i => i.Id).Take(SeedMax).ToList();
                    var items = new List<object?>();
                    foreach (var it in seed) items.Add(await ProjectAsync(it));
                    Emit(new Dictionary<string, object?> { ["event"] = "seed", ["items"] = items });
                    maxSeen = current.Count > 0 ? current.Max(i => i.Id) : 0;
                }
                else
                {
                    foreach (var it in current.Where(i => i.Id > maxSeen).OrderBy(i => i.Id))
                    {
                        Emit(new Dictionary<string, object?> { ["event"] = "notification", ["item"] = await ProjectAsync(it) });
                        maxSeen = it.Id;
                    }
                }
            }
            catch
            {
                // Transient WinRT hiccup (e.g. the notification platform restarting):
                // keep the loop alive, the next tick retries. If access was revoked
                // the status probe above will notice and report it.
                status = ProbeAccessSync(listener);
            }
            ExitRequested.Wait(intervalMs);
        }
        return 0;
    }

    // ── Access probing ─────────────────────────────────────────────────────────

    private static async Task<string> ProbeAccessAsync(UserNotificationListener listener)
    {
        try
        {
            var s = await Await(listener.RequestAccessAsync());
            return s == UserNotificationListenerAccessStatus.Allowed ? "allowed" : "denied";
        }
        catch { return ProbeAccessSync(listener); }
    }

    private static string ProbeAccessSync(UserNotificationListener listener)
    {
        try
        {
            return listener.GetAccessStatus() == UserNotificationListenerAccessStatus.Allowed
                ? "allowed" : "denied";
        }
        catch { return "unavailable"; }
    }

    // ── Read + project ─────────────────────────────────────────────────────────

    private readonly record struct Snapshot(long Id, UserNotification Raw);

    private static async Task<List<Snapshot>> ReadAllAsync(UserNotificationListener listener)
    {
        var raw = await Await(listener.GetNotificationsAsync(NotificationKinds.Toast));
        var list = new List<Snapshot>(raw.Count);
        foreach (var n in raw) list.Add(new Snapshot(n.Id, n));
        return list;
    }

    private static async Task<Dictionary<string, object?>> ProjectAsync(Snapshot snap)
    {
        var n = snap.Raw;
        string app = "", aumid = "";
        try { app = n.AppInfo?.DisplayInfo?.DisplayName ?? ""; } catch { }
        try { aumid = n.AppInfo?.AppUserModelId ?? ""; } catch { }

        string title = "", body = "";
        try
        {
            var binding = n.Notification?.Visual?.GetBinding(KnownNotificationBindings.ToastGeneric);
            if (binding != null)
            {
                var texts = binding.GetTextElements()
                    .Select(t => (t.Text ?? "").Trim())
                    .Where(t => t.Length > 0)
                    .ToList();
                title = texts.Count > 0 ? texts[0] : "";
                body = texts.Count > 1 ? string.Join("\n", texts.Skip(1)) : "";
            }
        }
        catch { }

        long at = 0;
        try { at = n.CreationTime.ToUnixTimeMilliseconds(); } catch { }

        return new Dictionary<string, object?>
        {
            ["id"] = snap.Id,
            ["app"] = Cap(app, TitleMax),
            ["aumid"] = Cap(aumid, TitleMax),
            ["title"] = Cap(title, TitleMax),
            ["body"] = Cap(body, BodyMax),
            ["at"] = at,
            ["icon"] = await AppIconAsync(aumid, n),
        };
    }

    private static string Cap(string s, int max) => s.Length <= max ? s : s[..max];

    private static async Task<string?> AppIconAsync(string aumid, UserNotification n)
    {
        if (aumid.Length == 0) return null;
        lock (IconCache) { if (IconCache.TryGetValue(aumid, out var cached)) return cached; }

        string? icon = null;
        try
        {
            var logoRef = n.AppInfo?.DisplayInfo?.GetLogo(new Windows.Foundation.Size(48, 48));
            if (logoRef != null)
            {
                // using-disposal releases the WinRT/COM handles in reverse order
                // (same discipline as the SMTC thumbnail reader).
                using var stream = await Await(logoRef.OpenReadAsync());
                if (stream.Size > 0 && (long)stream.Size < MaxLogoBytes)
                {
                    using var inputStream = stream.GetInputStreamAt(0);
                    using var reader = new DataReader(inputStream);
                    await Await(reader.LoadAsync((uint)stream.Size));
                    var bytes = new byte[(int)stream.Size];
                    reader.ReadBytes(bytes);
                    var contentType = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
                    icon = "data:" + contentType + ";base64," + Convert.ToBase64String(bytes);
                }
            }
        }
        catch { icon = null; }

        lock (IconCache)
        {
            // Failures are cached too (null): a logo that won't decode now won't
            // decode on the next toast either. The cap only matters if the user
            // somehow receives toasts from 64+ distinct apps in one session.
            if (IconCache.Count >= IconCacheMax) IconCache.Clear();
            IconCache[aumid] = icon;
        }
        return icon;
    }

    // ── Output ─────────────────────────────────────────────────────────────────

    private static void EmitStatus(string status)
    {
        Emit(new Dictionary<string, object?> { ["event"] = "status", ["status"] = status });
    }

    private static void Emit(Dictionary<string, object?> payload)
    {
        var json = JsonOut.Serialize(payload);
        lock (OutLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private static Task<T> Await<T>(Windows.Foundation.IAsyncOperation<T> operation)
    {
        return operation.AsTask().WaitAsync(TimeSpan.FromMilliseconds(WinRtTimeoutMs));
    }
}
