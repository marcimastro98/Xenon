using System.Text.RegularExpressions;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace XenonHelper;

// SMTC (Windows.Media.Control) host — a faithful port of media.ps1, so the
// JSON payloads are byte-for-byte compatible and server.js cannot tell the two
// hosts apart. On top of the request/response contract it subscribes to the
// session manager's change events and raises a debounced callback, which
// Program.cs turns into "media-changed" push frames.
internal sealed class MediaHost
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
        public IRandomAccessStreamReference? ThumbnailRef;
    }

    // One full request: session enumeration, scoring/selection, then either the
    // control action or the info payload. Never throws, so the serve loop
    // survives any per-request failure.
    public async Task<Dictionary<string, object?>> HandleRequestAsync(string action, string preferredSource)
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
                return EmptyPayload(preferredSource, "Closed", null);
            }

            var summaries = candidates
                .OrderByDescending(c => c.Score)
                .Select(c => SessionSummary(c, selected.Source))
                .Cast<object?>()
                .ToList();

            if (action != "info")
            {
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
            return EmptyPayload(preferredSource, "Unavailable", ex.Message);
        }
    }

    private async Task<GlobalSystemMediaTransportControlsSessionManager> GetManagerAsync()
    {
        var manager = _manager;
        if (manager != null) return manager;
        manager = await Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        _manager = manager;
        HookManager(manager);
        return manager;
    }

    private async Task<SessionInfo> GetSessionInfoAsync(GlobalSystemMediaTransportControlsSession session, bool isCurrent)
    {
        var props = await Await(session.TryGetMediaPropertiesAsync());
        var playback = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();
        var source = session.SourceAppUserModelId ?? "";
        var status = playback.PlaybackStatus.ToString();
        var title = props.Title ?? "";
        var artist = props.Artist ?? "";
        var album = props.AlbumTitle ?? "";
        var app = GetAppName(source, title, album);

        if (app == "Spotify" && string.IsNullOrWhiteSpace(artist))
        {
            var m = Regex.Match(title, @"^(.+?)\s+-\s+(.+)$");
            if (m.Success)
            {
                artist = m.Groups[1].Value.Trim();
                title = m.Groups[2].Value.Trim();
            }
        }

        var score = 0;
        if (status == "Playing") score += 1000;
        else if (status == "Paused") score += 300;
        else if (status == "Stopped") score += 50;
        if (!string.IsNullOrEmpty(title)) score += 120;
        if (!string.IsNullOrEmpty(artist)) score += 40;
        if (Regex.IsMatch(app, "Spotify|YouTube|Browser", Rx)) score += 80;
        if (isCurrent) score += 15;
        if (Regex.IsMatch(source, "ShellExperienceHost|System|Windows", Rx)) score -= 500;
        if (Regex.IsMatch(title, "Microsoft|Windows|Operating System", Rx)) score -= 500;

        var duration = 0;
        var position = 0;
        try
        {
            duration = Math.Max(0, (int)Math.Round((timeline.EndTime - timeline.StartTime).TotalSeconds));
            position = Math.Max(0, (int)Math.Round((timeline.Position - timeline.StartTime).TotalSeconds));
        }
        catch { }

        return new SessionInfo
        {
            Session = session,
            Score = score,
            Source = source,
            App = app,
            Title = title,
            Artist = artist,
            Album = album,
            PlaybackStatus = status,
            Position = position,
            Duration = duration,
            ThumbnailRef = props.Thumbnail,
        };
    }

    private static string GetAppName(string source, string title, string album)
    {
        if (Regex.IsMatch(source, "Spotify", Rx)) return "Spotify";
        if (Regex.IsMatch(title, "YouTube", Rx) || Regex.IsMatch(album, "YouTube", Rx)) return "YouTube";
        if (Regex.IsMatch(source, "Chrome|MSEdge|Firefox|Brave|Opera", Rx)) return "YouTube";
        if (Regex.IsMatch(source, "ZuneMusic|ZuneVideo|MicrosoftMediaPlayer|WindowsMediaPlayer", Rx)) return "Lettore Multimediale";
        if (Regex.IsMatch(source, "Music", Rx)) return "Music";
        if (string.IsNullOrWhiteSpace(source)) return "Media";
        // Strip Windows package format: Publisher.Name_hash!AppId → Name
        var match = Regex.Match(source, "^(?:[^.]+\\.)+([^._!]+)[_!]", Rx);
        if (match.Success) return match.Groups[1].Value;
        return source;
    }

    private static Dictionary<string, object?> SessionSummary(SessionInfo info, string selectedSource)
    {
        return new Dictionary<string, object?>
        {
            ["source"] = info.Source,
            ["app"] = info.App,
            ["title"] = info.Title,
            ["artist"] = info.Artist,
            ["album"] = info.Album,
            ["playbackStatus"] = info.PlaybackStatus,
            ["activePlayback"] = info.PlaybackStatus == "Playing" && !string.IsNullOrWhiteSpace(info.Title + info.Artist + info.App),
            ["position"] = info.Position,
            ["duration"] = info.Duration,
            ["score"] = info.Score,
            ["selected"] = info.Source == selectedSource,
        };
    }

    private static Dictionary<string, object?> EmptyPayload(string preferredSource, string status, string? error)
    {
        var payload = new Dictionary<string, object?>
        {
            ["active"] = false,
            ["app"] = "",
            ["source"] = "",
            ["title"] = "",
            ["artist"] = "",
            ["album"] = "",
            ["playbackStatus"] = status,
            ["thumbnail"] = null,
            ["position"] = 0,
            ["duration"] = 0,
            ["sessions"] = new List<object?>(),
            ["preferredSource"] = preferredSource,
            ["selectionMode"] = "auto",
        };
        if (error != null) payload["error"] = error;
        return payload;
    }

    private async Task<string?> ReadThumbnailAsync(SessionInfo selected)
    {
        if (selected.ThumbnailRef == null) return null;
        var cacheKey = selected.Source + "|" + selected.Title + "|" + selected.Artist + "|" + selected.Album;
        if (cacheKey == _thumbCacheKey) return _thumbCacheValue;

        string? thumbnail = null;
        try
        {
            // using-disposal releases the WinRT/COM handles in reverse order;
            // leaking them accumulates dangling references in the system media
            // broker until it starts refusing new SMTC sessions.
            using var stream = await Await(selected.ThumbnailRef.OpenReadAsync());
            if (stream.Size > 0 && (long)stream.Size < MaxThumbnailBytes)
            {
                using var inputStream = stream.GetInputStreamAt(0);
                using var reader = new DataReader(inputStream);
                await Await(reader.LoadAsync((uint)stream.Size));
                var bytes = new byte[(int)stream.Size];
                reader.ReadBytes(bytes);
                var contentType = string.IsNullOrEmpty(stream.ContentType) ? "image/jpeg" : stream.ContentType;
                thumbnail = "data:" + contentType + ";base64," + Convert.ToBase64String(bytes);
            }
        }
        catch
        {
            thumbnail = null;
        }

        if (thumbnail != null)
        {
            _thumbCacheKey = cacheKey;
            _thumbCacheValue = thumbnail;
        }
        return thumbnail;
    }

    // ── Change events → debounced push notification ──────────────────────────

    private void HookManager(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        _managerCurrentChanged = (_, _) => OnMediaEvent();
        _managerSessionsChanged = (_, _) =>
        {
            HookSessions(manager);
            OnMediaEvent();
        };
        manager.CurrentSessionChanged += _managerCurrentChanged;
        manager.SessionsChanged += _managerSessionsChanged;
        HookSessions(manager);
    }

    // Detach the handlers HookManager attached before forgetting the cached
    // manager, so the replaced instance is actually collectable (see the field
    // comment above) instead of accumulating one live hooked manager per drop.
    private void DropManager()
    {
        var manager = _manager;
        _manager = null;
        if (manager != null)
        {
            try
            {
                if (_managerCurrentChanged != null) manager.CurrentSessionChanged -= _managerCurrentChanged;
                if (_managerSessionsChanged != null) manager.SessionsChanged -= _managerSessionsChanged;
            }
            catch { }
        }
        _managerCurrentChanged = null;
        _managerSessionsChanged = null;
    }

    // Per-session events are what fire on track/playback changes; the session
    // list itself changes rarely, so on every SessionsChanged the old hooks are
    // dropped and the current sessions re-hooked. TimelineProperties events are
    // deliberately NOT subscribed: they fire continuously during playback.
    private void HookSessions(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        lock (_hookLock)
        {
            foreach (var session in _hookedSessions)
            {
                try
                {
                    session.MediaPropertiesChanged -= OnSessionMediaProperties;
                    session.PlaybackInfoChanged -= OnSessionPlaybackInfo;
                }
                catch { }
            }
            _hookedSessions.Clear();

            IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions;
            try { sessions = manager.GetSessions(); }
            catch { return; }

            foreach (var session in sessions)
            {
                try
                {
                    session.MediaPropertiesChanged += OnSessionMediaProperties;
                    session.PlaybackInfoChanged += OnSessionPlaybackInfo;
                    _hookedSessions.Add(session);
                }
                catch { }
            }
        }
    }

    private void OnSessionMediaProperties(GlobalSystemMediaTransportControlsSession sender, MediaPropertiesChangedEventArgs args) => OnMediaEvent();

    private void OnSessionPlaybackInfo(GlobalSystemMediaTransportControlsSession sender, PlaybackInfoChangedEventArgs args) => OnMediaEvent();

    private void OnMediaEvent()
    {
        // Coalesce event bursts (a track change fires several events at once)
        // into a single push frame after a short quiet period.
        try { _changeDebounce.Change(EventDebounceMs, Timeout.Infinite); } catch { }
    }

    private void SafeNotify()
    {
        try { _notifyChanged(); } catch { }
    }

    private static Task<T> Await<T>(Windows.Foundation.IAsyncOperation<T> operation)
    {
        return operation.AsTask().WaitAsync(TimeSpan.FromMilliseconds(WinRtTimeoutMs));
    }
}
