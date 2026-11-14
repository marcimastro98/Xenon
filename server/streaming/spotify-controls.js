'use strict';
// What can be done to the Spotify player: play and pause, skip, shuffle, repeat, volume, seek,
// like, start a playlist, move to another device, wait for this computer, and the one door
// every action comes through.

function makeControls({
  _sleep, apiRequest, classify403, apiResult, spotifyId, clampInt, getPlaylists, getDevices,
  isSaved, lastLiked, playUri,
}) {
  async function saveCurrent() {
    const q = await apiRequest('GET', '/me/player/currently-playing');
    if (q.error === 'not_connected') return { ok: false, error: 'not_connected' };
    const id = q.ok && q.data && q.data.item && q.data.item.id;
    if (!id) return { ok: false, error: 'nothing_playing' };
    return apiResult(await apiRequest('PUT', '/me/tracks?ids=' + encodeURIComponent(id)), 'save_failed', 'library');
  }

  async function playPlaylist(input) {
    const id = spotifyId(input, 'playlist');
    if (!id) return { ok: false, error: 'bad_playlist' };
    return apiResult(await apiRequest('PUT', '/me/player/play', { context_uri: 'spotify:playlist:' + id }), 'play_failed');
  }

  async function setShuffle(mode) {
    let state;
    if (mode === 'on') state = true;
    else if (mode === 'off') state = false;
    else {                                                    // toggle: read current, invert
      const p = await apiRequest('GET', '/me/player');
      state = !(p.ok && p.data && p.data.shuffle_state);
    }
    return apiResult(await apiRequest('PUT', '/me/player/shuffle?state=' + state), 'shuffle_failed');
  }

  async function transferDevice(input) {
    const name = String(input == null ? '' : input).trim().toLowerCase();
    if (!name) return { ok: false, error: 'bad_device' };
    const dv = await getDevices();
    if (!dv.ok) return { ok: false, error: dv.error || 'no_devices' };
    const match = dv.devices.find(x => x.name.toLowerCase() === name)
      || dv.devices.find(x => x.name.toLowerCase().includes(name));
    if (!match || !match.id) return { ok: false, error: 'device_not_found' };
    return transferToId(match.id);
  }

  // Transfer playback to a device by its exact id (used by the widget's device
  // list, which already knows the id). `play:true` resumes on the new device.
  async function transferToId(deviceId) {
    const id = String(deviceId == null ? '' : deviceId).trim();
    if (!id) return { ok: false, error: 'bad_device' };
    return apiResult(await apiRequest('PUT', '/me/player', { device_ids: [id], play: true }), 'transfer_failed');
  }

  // Play / pause / toggle. 'toggle' reads the live state and flips it.
  async function playPause(mode) {
    let want = mode;
    if (mode !== 'play' && mode !== 'pause') {
      const p = await apiRequest('GET', '/me/player');
      if (p.error === 'not_connected') return { ok: false, error: 'not_connected' };
      want = (p.ok && p.data && p.data.is_playing) ? 'pause' : 'play';
    }
    const r = await apiRequest('PUT', '/me/player/' + want);
    // A 404 on PLAY means there's no ACTIVE device — but Spotify is open (idle), so
    // instead of failing, wake a device and start playing. This is the common case
    // behind "No active device": the desktop app is a device but not yet active.
    if (want === 'play' && r.status === 404) return startPlayback();
    return apiResult(r, 'playback_failed');
  }

  // The Connect device that is THIS computer. On Windows and Linux the desktop
  // app names itself after the hostname, which picks it out even when a phone or
  // a speaker is listed too. A Mac uses its friendly name instead, so the
  // fallback is a computer that was not listed before the app was started.
  function thisComputer(devices, hostname, knownIds) {
    const host = String(hostname || '').trim().toLowerCase();
    const known = knownIds instanceof Set ? knownIds : new Set();
    return (host && devices.find(x => x.type === 'computer' && x.name.toLowerCase() === host))
      || devices.find(x => x.type === 'computer' && x.id && !known.has(x.id))
      || null;
  }

  // Wake an available Spotify Connect device and start playback: transfer to it with
  // play:true (which resumes the last track/context). If there is nothing to resume
  // (a cold-but-open app), fall back to starting the user's first playlist — so the
  // "Play" button always gets music going rather than erroring on no-active-device.
  // `opts.deviceId` goes first, for the "open Spotify and play" path.
  async function startPlayback(opts) {
    const dv = await getDevices();
    if (!dv.ok || !dv.devices.length) return { ok: false, error: 'no_active_device' };
    const wanted = opts && opts.deviceId;
    const target = (wanted && dv.devices.find(x => x.id === wanted))
      || dv.devices.find(x => x.active) || dv.devices.find(x => x.type === 'computer') || dv.devices[0];
    if (!target || !target.id) return { ok: false, error: 'no_active_device' };
    const r = await apiRequest('PUT', '/me/player', { device_ids: [target.id], play: true });
    if (r.ok) return { ok: true };
    if (r.status === 403) return { ok: false, error: classify403(r) };
    const pls = await getPlaylists();
    const uri = (pls.ok && Array.isArray(pls.playlists) && pls.playlists[0]) ? pls.playlists[0].uri : '';
    if (uri) return apiResult(await apiRequest('PUT', '/me/player/play?device_id=' + encodeURIComponent(target.id), { context_uri: uri }), 'play_failed');
    return apiResult(r, 'play_failed');
  }

  // The ids of the computers listed now, taken BEFORE starting the app, so
  // playWhenReady can tell the new one apart.
  async function computerIds() {
    const dv = await getDevices();
    return new Set(dv.ok ? dv.devices.filter(x => x.type === 'computer' && x.id).map(x => x.id) : []);
  }

  // After the desktop app was started on this computer: wait for it to show up as
  // a Connect device (it takes a few seconds to sign in), then play there. Gives
  // up after ~24 s with 'not_started'; a missing login ends the wait at once.
  const READY_TRIES = 12;
  const READY_INTERVAL_MS = 2000;
  async function playWhenReady(hostname, knownIds) {
    for (let i = 0; i < READY_TRIES; i++) {
      await _sleep(READY_INTERVAL_MS);
      const dv = await getDevices();
      if (!dv.ok && (dv.error === 'not_connected' || dv.error === 'forbidden')) return { ok: false, error: dv.error };
      const pc = dv.ok ? thisComputer(dv.devices, hostname, knownIds) : null;
      if (pc) return startPlayback({ deviceId: pc.id });
    }
    return { ok: false, error: 'not_started' };
  }

  // Skip to next/previous. Like PLAY, a 404 means there's no ACTIVE device even
  // though Spotify is open (idle/paused) — so instead of failing with
  // "no active device", wake a device and retry the skip. Without this, Next/Prev
  // was dead in the exact state where Play silently worked (the "can't turn on the
  // next song" report).
  async function skipTo(dir) {
    const path = '/me/player/' + dir;
    const r = await apiRequest('POST', path);
    if (r.status === 404) {
      const woke = await startPlayback();
      if (!woke.ok) return woke;
      return apiResult(await apiRequest('POST', path), 'skip_failed');
    }
    return apiResult(r, 'skip_failed');
  }
  async function skipNext() { return skipTo('next'); }
  async function skipPrev() { return skipTo('previous'); }

  // Repeat off → context → track → off. 'toggle' advances the cycle; an explicit
  // 'off'/'context'/'track' sets it directly.
  async function setRepeat(mode) {
    const CYCLE = { off: 'context', context: 'track', track: 'off' };
    let state = mode;
    if (mode !== 'off' && mode !== 'context' && mode !== 'track') {
      const p = await apiRequest('GET', '/me/player');
      const cur = (p.ok && p.data && p.data.repeat_state) || 'off';
      state = CYCLE[cur] || 'context';
    }
    return apiResult(await apiRequest('PUT', '/me/player/repeat?state=' + state), 'repeat_failed');
  }

  // Save/remove the currently-playing track from Liked Songs. 'toggle' reads the
  // current saved state and flips it.
  async function toggleLike(mode) {
    const q = await apiRequest('GET', '/me/player/currently-playing');
    if (q.error === 'not_connected') return { ok: false, error: 'not_connected' };
    const id = q.ok && q.data && q.data.item && q.data.item.id;
    if (!id) return { ok: false, error: 'nothing_playing' };
    let add;
    if (mode === 'like') add = true;
    else if (mode === 'unlike') add = false;
    else add = !(await isSaved(id));                       // toggle
    const r = apiResult(await apiRequest(add ? 'PUT' : 'DELETE', '/me/tracks?ids=' + encodeURIComponent(id)), 'like_failed', 'library');
    if (r.ok) lastLiked._likedCache = { id, liked: add };            // keep the hero heart in sync without a re-fetch
    return r;
  }

  // Set device volume. mode 'set' uses `value` (0–100); 'up'/'down' step ±10 from
  // the live volume. Requires an active device that supports volume.
  async function setVolume(mode, value) {
    let vol;
    if (mode === 'up' || mode === 'down') {
      const p = await apiRequest('GET', '/me/player');
      const cur = (p.ok && p.data && p.data.device && p.data.device.volume_percent != null) ? p.data.device.volume_percent : 50;
      vol = clampInt(cur + (mode === 'up' ? 10 : -10), 0, 100);
    } else {
      vol = clampInt(value, 0, 100);
    }
    return apiResult(await apiRequest('PUT', '/me/player/volume?volume_percent=' + vol), 'volume_failed');
  }

  // Seek to an absolute position in the current track (`ms` from the caller, which
  // already knows the duration). Deck keys can pass 0 to restart the track.
  async function seek(ms) {
    return apiResult(await apiRequest('PUT', '/me/player/seek?position_ms=' + clampInt(ms, 0, 24 * 60 * 60 * 1000)), 'seek_failed');
  }

  // Single entry the registry calls for every spotify* Deck action.
  async function runAction(action) {
    switch (action.type) {
      case 'spotifySave': return saveCurrent();
      case 'spotifyPlaylist': return playPlaylist(action.playlist);
      case 'spotifyPlayUri': return playUri(action.uri, action.contextUri);
      case 'spotifyShuffle': return setShuffle(action.mode);
      case 'spotifyDevice': return transferDevice(action.device);
      case 'spotifyPlay': return playPause(action.mode);
      case 'spotifyNext': return skipNext();
      case 'spotifyPrev': return skipPrev();
      case 'spotifyRepeat': return setRepeat(action.mode);
      case 'spotifyLike': return toggleLike(action.mode);
      case 'spotifyVolume': return setVolume(action.mode, action.value);
      case 'spotifySeek': return seek(action.value);
      default: return { ok: false, error: 'unsupported' };
    }
  }

  return {
    saveCurrent, playPlaylist, setShuffle, transferDevice, transferToId, playPause, computerIds,
    playWhenReady, skipNext, skipPrev, setRepeat, toggleLike, setVolume, seek, runAction,
  };
}

module.exports = { makeControls };
