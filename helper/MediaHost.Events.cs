// Media: listening for changes in Windows and telling the server.

using System.Text.RegularExpressions;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace XenonHelper;

internal sealed partial class MediaHost
{
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
