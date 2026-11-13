// Media: reading what is playing, its app, its cover and the list of players.

using System.Text.RegularExpressions;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace XenonHelper;

internal sealed partial class MediaHost
{
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
        var durationMs = 0.0;
        var positionMs = 0.0;
        var rate = 1.0;
        var readAt = DateTimeOffset.UtcNow;
        try
        {
            durationMs = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalMilliseconds);
            positionMs = Math.Max(0, (timeline.Position - timeline.StartTime).TotalMilliseconds);
            duration = (int)Math.Round(durationMs / 1000);
            // Spotify (and a few other apps) only push a fresh SMTC timeline on
            // events (play/pause/seek/track change), so the raw Position goes stale
            // mid-song. While playing, project it forward by the wall-clock time
            // since the app's own LastUpdatedTime stamp, scaled by the playback
            // rate. A missing stamp (default epoch → absurd elapsed) skips the
            // projection rather than inventing a position, and so does a zero
            // duration (live streams/radio): with nothing to clamp against the
            // projection would grow without bound — same rule as server.js
            // liveMediaSnapshot.
            // Rounded once, at the end: rounding the read and the projection
            // separately put the position up to a second off.
            if (status == "Playing" && duration > 0)
            {
                var elapsed = (readAt - timeline.LastUpdatedTime).TotalMilliseconds;
                if (elapsed > 0 && elapsed < 86400000)
                {
                    rate = playback.PlaybackRate ?? 1.0;
                    if (rate <= 0 || rate > 16) rate = 1.0;
                    positionMs += elapsed * rate;
                }
                positionMs = Math.Min(positionMs, durationMs);
            }
            position = (int)Math.Round(positionMs / 1000);
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
            PositionMs = positionMs,
            DurationMs = durationMs,
            Rate = rate,
            ReadAt = readAt,
            ThumbnailRef = props.Thumbnail,
        };
    }
    private static string ImageContentType(string? raw)
    {
        var first = string.IsNullOrEmpty(raw) ? "" : raw.Split(',')[0].Trim();
        return ImageMimeRe.IsMatch(first) ? first : "image/jpeg";
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
                thumbnail = "data:" + ImageContentType(stream.ContentType) + ";base64," + Convert.ToBase64String(bytes);
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
}
