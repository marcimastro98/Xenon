// Media: moving to a position in the track.

using System.Text.RegularExpressions;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace XenonHelper;

internal sealed partial class MediaHost
{
    private static async Task<Dictionary<string, object?>> SeekAsync(
        GlobalSystemMediaTransportControlsSession session,
        SessionInfo selected,
        double positionSeconds)
    {
        var result = new Dictionary<string, object?>
        {
            ["ok"] = false,
            // server.js uses this marker to distinguish a seek-aware helper
            // from a still-running pre-0.11.4 process during an in-app update.
            ["seekProtocol"] = 1,
            ["source"] = selected.Source,
            ["app"] = selected.App,
        };

        if (!double.IsFinite(positionSeconds) || positionSeconds < 0 ||
            positionSeconds > TimeSpan.MaxValue.TotalSeconds)
        {
            result["error"] = "bad_position";
            return result;
        }

        var playback = session.GetPlaybackInfo();
        if (!playback.Controls.IsPlaybackPositionEnabled)
        {
            result["error"] = "not_seekable";
            return result;
        }

        var timeline = session.GetTimelineProperties();
        var startTicks = timeline.StartTime.Ticks;
        var minTicks = timeline.MinSeekTime.Ticks;
        var maxTicks = timeline.MaxSeekTime.Ticks;
        if (maxTicks <= minTicks)
        {
            minTicks = startTicks;
            maxTicks = timeline.EndTime.Ticks;
        }
        if (maxTicks < minTicks)
        {
            result["error"] = "not_seekable";
            return result;
        }

        long relativeTicks;
        try
        {
            relativeTicks = checked((long)Math.Round(positionSeconds * TimeSpan.TicksPerSecond));
        }
        catch (OverflowException)
        {
            result["error"] = "bad_position";
            return result;
        }

        // Xenon positions are relative to the media timeline; WinRT wants the
        // absolute timeline timestamp. Saturate before clamping so a very long
        // (but finite) request can never overflow the addition.
        long targetTicks;
        if (relativeTicks > 0 && startTicks > long.MaxValue - relativeTicks)
            targetTicks = long.MaxValue;
        else
            targetTicks = startTicks + relativeTicks;
        targetTicks = Math.Clamp(targetTicks, minTicks, maxTicks);

        var ok = await Await(session.TryChangePlaybackPositionAsync(targetTicks));
        result["ok"] = ok;
        result["position"] = Math.Max(
            0,
            Math.Round(((double)targetTicks - startTicks) / TimeSpan.TicksPerSecond, 3));
        if (!ok) result["error"] = "not_seekable";
        return result;
    }
}
