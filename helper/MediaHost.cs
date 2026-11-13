using System.Text.RegularExpressions;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace XenonHelper;

// SMTC (Windows.Media.Control) host — a faithful port of media.ps1, so the
// JSON payloads are byte-for-byte compatible and server.js cannot tell the two
// hosts apart. On top of the request/response contract it subscribes to the
// session manager's change events and raises a debounced callback, which
// Program.cs turns into "media-changed" push frames.
internal sealed partial class MediaHost
{
    private const int WinRtTimeoutMs = 4000;
    private const long MaxThumbnailBytes = 5242880;
    private const int EventDebounceMs = 300;
    private const RegexOptions Rx = RegexOptions.IgnoreCase; // PowerShell -match is case-insensitive
    private const int EmptyReacquireStreak = 3; // empty enumerations before re-acquiring the manager (#80)
    private const long ReacquireCooldownMs = 60000; // floor between streak-triggered re-acquires

    private readonly Action _notifyChanged;
    private readonly Timer _changeDebounce;
    private readonly object _hookLock = new();
    private readonly List<GlobalSystemMediaTransportControlsSession> _hookedSessions = new();

    // Acquired lazily and cached for the lifetime of the process. On any
    // request failure it is dropped so the next request re-acquires a fresh
    // one (the media broker RPC goes away on logon/lock/broker restart).
    private GlobalSystemMediaTransportControlsSessionManager? _manager;

    // The handlers HookManager attached to _manager, kept so DropManager can
    // detach them again. Without the unhook the SessionsChanged lambda (which
    // captures the manager) forms a CCW/RCW cycle CsWinRT cannot collect, and
    // every re-acquire would leak another live, hooked manager.
    private Windows.Foundation.TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, CurrentSessionChangedEventArgs>? _managerCurrentChanged;
    private Windows.Foundation.TypedEventHandler<GlobalSystemMediaTransportControlsSessionManager, SessionsChangedEventArgs>? _managerSessionsChanged;

    // Consecutive enumerations that saw zero sessions. A wedged media broker
    // (after logon/lock/broker restart) makes GetSessions() return an empty list
    // WITHOUT throwing, so the exception-drop below never fires and the cached
    // _manager stays blind forever — the reported cause of #80. After a short
    // streak we drop _manager so the next request re-acquires a fresh one, exactly
    // as the one-shot media.ps1 reader does on every call; that un-wedges the
    // enumeration. A genuinely idle machine (zero sessions is its normal state)
    // trips the streak on every few polls, so re-acquires are floored by
    // ReacquireCooldownMs — a wedged broker still heals within ~a minute.
    private int _emptyEnumerations;
    private long _lastEmptyReacquireTick;

    // Single-slot per-track album-art cache: the art only changes with the
    // track, so re-reading the WinRT stream and re-encoding ~50-100KB of
    // base64 on every poll is pure waste. Failed reads are NOT cached.
    private string? _thumbCacheKey;
    private string? _thumbCacheValue;

    public MediaHost(Action notifyChanged)
    {
        _notifyChanged = notifyChanged;
        _changeDebounce = new Timer(_ => SafeNotify(), null, Timeout.Infinite, Timeout.Infinite);
    }

    private sealed class SessionInfo
    {
        public GlobalSystemMediaTransportControlsSession Session = null!;
        public int Score;
        public string Source = "";
        public string App = "";
        public string Title = "";
        public string Artist = "";
        public string Album = "";
        public string PlaybackStatus = "";
        public int Position;
        public int Duration;
        public double PositionMs;
        public double DurationMs;
        public double Rate = 1.0;
        public DateTimeOffset ReadAt;
        public IRandomAccessStreamReference? ThumbnailRef;

        // The unrounded position at the moment the payload is written: the
        // timeline read plus the time spent since (scoring, thumbnail), so the
        // lyrics clock is not set back by our own work.
        public long PositionMsNow()
        {
            var ms = PositionMs;
            if (PlaybackStatus == "Playing" && DurationMs > 0)
                ms = Math.Min(DurationMs, ms + (DateTimeOffset.UtcNow - ReadAt).TotalMilliseconds * Rate);
            return (long)Math.Round(Math.Max(0, ms));
        }
    }

    // One full request: session enumeration, scoring/selection, then either the
    // control action or the info payload. Never throws, so the serve loop
    // survives any per-request failure.
    public async Task<Dictionary<string, object?>> HandleRequestAsync(
        string action,
        string preferredSource,
        double positionSeconds = double.NaN)
    {
        preferredSource ??= "";
        try
        {
            var manager = await GetManagerAsync();
            var currentSession = manager.GetCurrentSession();
            var currentSource = currentSession != null ? (currentSession.SourceAppUserModelId ?? "") : null;

            var candidates = new List<SessionInfo>();
            foreach (var session in manager.GetSessions())
            {
                try
                {
                    var source = session.SourceAppUserModelId ?? "";
                    candidates.Add(await GetSessionInfoAsync(session, currentSource != null && source == currentSource));
                }
                catch { }
            }

            // Self-heal a wedged broker: an empty enumeration doesn't throw, so the
            // cached _manager would otherwise stay blind forever (#80). Drop it after
            // a short streak so the next request re-acquires a fresh manager; reset
            // the moment we see any session again.
            if (candidates.Count > 0) _emptyEnumerations = 0;
            else if (++_emptyEnumerations >= EmptyReacquireStreak)
            {
                _emptyEnumerations = 0;
                var now = Environment.TickCount64;
                if (now - _lastEmptyReacquireTick >= ReacquireCooldownMs)
                {
                    _lastEmptyReacquireTick = now;
                    DropManager();
                }
            }

            var activeCandidates = candidates
                .Where(c => c.PlaybackStatus == "Playing" && !string.IsNullOrWhiteSpace(c.Title + c.Artist + c.App))
                .ToList();

            SessionInfo? selected = null;
            var selectionMode = "auto";
            if (!string.IsNullOrWhiteSpace(preferredSource))
            {
                selected = activeCandidates
                    .Where(c => c.Source == preferredSource)
                    .OrderByDescending(c => c.Score)
                    .FirstOrDefault();
                if (selected != null) selectionMode = "preferred";
            }
            selected ??= candidates.OrderByDescending(c => c.Score).FirstOrDefault();

            var session2 = selected != null ? selected.Session : currentSession;
            if (session2 == null || selected == null)
            {
                if (action == "seek")
                {
                    return new Dictionary<string, object?>
                    {
                        ["ok"] = false,
                        ["error"] = "not_seekable",
                        ["seekProtocol"] = 1,
                        ["source"] = "",
                        ["app"] = "",
                    };
                }
                return EmptyPayload(preferredSource, "Closed", null);
            }

            var summaries = candidates
                .OrderByDescending(c => c.Score)
                .Select(c => SessionSummary(c, selected.Source))
                .Cast<object?>()
                .ToList();

            if (action != "info")
            {
                if (action == "seek")
                    return await SeekAsync(session2, selected, positionSeconds);

                var ok = false;
                switch (action)
                {
                    case "playpause": ok = await Await(session2.TryTogglePlayPauseAsync()); break;
                    case "next": ok = await Await(session2.TrySkipNextAsync()); break;
                    case "previous": ok = await Await(session2.TrySkipPreviousAsync()); break;
                }
                return new Dictionary<string, object?>
                {
                    ["ok"] = ok,
                    ["source"] = selected.Source,
                    ["app"] = selected.App,
                };
            }

            var thumbnail = await ReadThumbnailAsync(selected);

            return new Dictionary<string, object?>
            {
                ["active"] = true,
                ["app"] = selected.App,
                ["source"] = selected.Source,
                ["title"] = selected.Title,
                ["artist"] = selected.Artist,
                ["album"] = selected.Album,
                ["playbackStatus"] = selected.PlaybackStatus,
                ["thumbnail"] = thumbnail,
                ["position"] = selected.Position,
                ["positionMs"] = selected.PositionMsNow(),
                ["duration"] = selected.Duration,
                ["score"] = selected.Score,
                ["sessions"] = summaries,
                ["preferredSource"] = preferredSource,
                ["selectionMode"] = selectionMode,
            };
        }
        catch (Exception ex)
        {
            // Drop the cached manager: if the media broker RPC went away the
            // next request must re-acquire instead of failing forever.
            DropManager();
            if (action == "seek")
            {
                return new Dictionary<string, object?>
                {
                    ["ok"] = false,
                    ["error"] = "unavailable",
                    ["seekProtocol"] = 1,
                    ["source"] = "",
                    ["app"] = "",
                };
            }
            return EmptyPayload(preferredSource, "Unavailable", ex.Message);
        }
    }

    // A thumbnail's ContentType can be a comma-separated LIST of equivalent
    // types — Apple Music reports "image/jpeg,image/jpe,image/jpg". In a data
    // URI the first comma ends the media type, so passing that through whole
    // gives the browser a media type of "image/jpeg" and leaves the rest,
    // base64 payload included, to be read as ordinary text. It never decodes:
    // a valid JPEG lost to a punctuation mark (issue #128). Take the first
    // type, and only when it is an image MIME.
    private static readonly Regex ImageMimeRe = new Regex(@"^image/[A-Za-z0-9][A-Za-z0-9.+\-]*$", RegexOptions.Compiled);
}
