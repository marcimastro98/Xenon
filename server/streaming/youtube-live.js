'use strict';
// The creator's broadcast on YouTube: found, its status and health read, made, started, ended,
// renamed, cancelled, its privacy set and its stream key read.

function makeLive({ getAccessToken, apiRequest, apiReason, onAir, PRIVACY }) {
  // ── Phase 4: live broadcast control + status ──────────────────────────────
  // The user's most relevant broadcast: an active one first, else an upcoming one.
  async function findBroadcast() {
    const a = await apiRequest('GET', '/liveBroadcasts?part=id,status,snippet&broadcastStatus=active&maxResults=1');
    if (a.ok && a.data && Array.isArray(a.data.items) && a.data.items[0]) return a.data.items[0];
    const u = await apiRequest('GET', '/liveBroadcasts?part=id,status,snippet&broadcastStatus=upcoming&maxResults=1');
    if (u.ok && u.data && Array.isArray(u.data.items) && u.data.items[0]) return u.data.items[0];
    return null;
  }

  // Ingestion health (is OBS reaching YouTube?): '', 'good', 'ok', 'bad', 'noData'.
  async function streamHealth() {
    const r = await apiRequest('GET', '/liveStreams?part=status&mine=true&maxResults=1');
    const item = r.ok && r.data && Array.isArray(r.data.items) && r.data.items[0];
    const h = item && item.status && item.status.healthStatus && item.status.healthStatus.status;
    return typeof h === 'string' ? h : '';
  }

  // Live status for the widget: { ok, live, viewers, title, health }. Quota note:
  // stream health is only queried when a broadcast exists (live or upcoming) — an
  // idle account skips it.
  async function broadcastStatus() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const b = await findBroadcast();
    if (!b) { onAir.liveCtx = { id: '', chatId: '' }; return { ok: true, live: false, health: '' }; }
    onAir.liveCtx = { id: b.id, chatId: (b.snippet && b.snippet.liveChatId) || '' };
    const live = !!(b.status && b.status.lifeCycleStatus === 'live');
    const out = {
      ok: true, live, title: (b.snippet && b.snippet.title) || '', health: await streamHealth(),
      id: b.id,
      privacy: (b.status && b.status.privacyStatus) || '',
      chat: !!onAir.liveCtx.chatId,
    };
    if (live) {
      // One call gets concurrent viewers (liveStreamingDetails) + total views/likes
      // (statistics) — cheaper than two requests.
      const v = await apiRequest('GET', '/videos?part=liveStreamingDetails,statistics&id=' + encodeURIComponent(b.id));
      const item = v.ok && v.data && Array.isArray(v.data.items) && v.data.items[0];
      const cv = item && item.liveStreamingDetails && item.liveStreamingDetails.concurrentViewers;
      out.viewers = (cv != null) ? Number(cv) : null;
      const stats = item && item.statistics;
      out.totalViews = (stats && stats.viewCount != null) ? Number(stats.viewCount) : null;
      out.likes = (stats && stats.likeCount != null) ? Number(stats.likeCount) : null;
    }
    return out;
  }

  // Rename the current/upcoming broadcast (liveBroadcasts.update needs title +
  // scheduledStartTime in the snippet, so we preserve the existing start time).
  async function updateBroadcastTitle(title) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const ttl = String(title == null ? '' : title).trim().slice(0, 100);
    if (!ttl) return { ok: false, error: 'empty' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    const snippet = { title: ttl };
    if (b.snippet && b.snippet.scheduledStartTime) snippet.scheduledStartTime = b.snippet.scheduledStartTime;
    const r = await apiRequest('PUT', '/liveBroadcasts?part=snippet', { id: b.id, snippet });
    return r.ok ? { ok: true, title: ttl } : { ok: false, error: apiReason(r) };
  }

  // Start / stop / toggle the broadcast via liveBroadcasts.transition. The
  // broadcast must already exist (scheduled) and its stream be receiving data to
  // go live — otherwise YouTube refuses with a reason we surface verbatim.
  async function transitionBroadcast(mode) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    let want;
    if (mode === 'start') want = 'live';
    else if (mode === 'stop') want = 'complete';
    else want = (b.status && b.status.lifeCycleStatus === 'live') ? 'complete' : 'live';   // toggle
    const r = await apiRequest('POST', '/liveBroadcasts/transition?part=status&broadcastStatus=' + want + '&id=' + encodeURIComponent(b.id));
    return r.ok ? { ok: true } : { ok: false, error: apiReason(r) };
  }

  // The channel's reusable ingestion endpoint — its RTMP address and stream key.
  // Every channel that has ever streamed has one; a channel that has not gets one
  // made here, which is what lets a stream start without a trip to YouTube Studio.
  async function ensureStream(title) {
    const r = await apiRequest('GET', '/liveStreams?part=id,cdn,status&mine=true&maxResults=5');
    const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    if (items[0]) return { ok: true, stream: items[0] };
    if (!r.ok) return { ok: false, error: apiReason(r) };
    const c = await apiRequest('POST', '/liveStreams?part=snippet,cdn,contentDetails', {
      snippet: { title: title || 'Xenon' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable: true },
    });
    if (!c.ok || !c.data || !c.data.id) return { ok: false, error: apiReason(c) };
    return { ok: true, stream: c.data };
  }

  // Create a broadcast and bind it to that endpoint. `enableAutoStart` is the
  // important part: YouTube takes the broadcast live by itself the moment the
  // encoder starts pushing, so nothing here has to guess when OBS is ready. The
  // old Go live button could not — it could only transition a broadcast somebody
  // had already made in Studio, and it failed until the encoder was up.
  async function createBroadcast(title, privacy) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const ttl = String(title == null ? '' : title).trim().slice(0, 100) || 'Live';
    const priv = PRIVACY.includes(privacy) ? privacy : 'unlisted';
    if (await findBroadcast()) return { ok: false, error: 'already_exists' };
    const st = await ensureStream(ttl);
    if (!st.ok) return st;
    const b = await apiRequest('POST', '/liveBroadcasts?part=snippet,status,contentDetails', {
      // A minute out: YouTube rejects a start time in the past, and clocks drift.
      snippet: { title: ttl, scheduledStartTime: new Date(Date.now() + 60000).toISOString() },
      status: { privacyStatus: priv, selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true },
    });
    if (!b.ok || !b.data || !b.data.id) return { ok: false, error: apiReason(b) };
    const bind = await apiRequest('POST', '/liveBroadcasts/bind?part=id,contentDetails&id=' +
      encodeURIComponent(b.data.id) + '&streamId=' + encodeURIComponent(st.stream.id));
    if (!bind.ok) return { ok: false, error: apiReason(bind) };
    onAir.liveCtx = { id: b.data.id, chatId: '' };
    return { ok: true, id: b.data.id, title: ttl, privacy: priv };
  }

  // Throw away a broadcast that has not started. Refused once it is live: ending
  // a stream is `transitionBroadcast('stop')`, and deleting one mid-air would
  // lose the recording.
  async function cancelBroadcast() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    if (b.status && b.status.lifeCycleStatus === 'live') return { ok: false, error: 'is_live' };
    const r = await apiRequest('DELETE', '/liveBroadcasts?id=' + encodeURIComponent(b.id));
    if (!r.ok) return { ok: false, error: apiReason(r) };
    onAir.liveCtx = { id: '', chatId: '' };
    return { ok: true };
  }

  async function setPrivacy(privacy) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    if (!PRIVACY.includes(privacy)) return { ok: false, error: 'bad_privacy' };
    const b = await findBroadcast();
    if (!b) return { ok: false, error: 'no_broadcast' };
    const r = await apiRequest('PUT', '/liveBroadcasts?part=status', { id: b.id, status: { privacyStatus: privacy } });
    return r.ok ? { ok: true, privacy } : { ok: false, error: apiReason(r) };
  }

  // The RTMP address and stream key to paste into OBS. This is a real credential:
  // anyone holding it can broadcast to the channel, so it never rides along with
  // the status poll — it is a separate read, made only when the user asks, and
  // server.js keeps the route off the paired-device door.
  async function streamKey() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const r = await apiRequest('GET', '/liveStreams?part=cdn&mine=true&maxResults=1');
    if (!r.ok) return { ok: false, error: apiReason(r) };
    const item = r.data && Array.isArray(r.data.items) && r.data.items[0];
    const info = item && item.cdn && item.cdn.ingestionInfo;
    if (!info) return { ok: false, error: 'no_stream' };
    return { ok: true, url: String(info.ingestionAddress || ''), key: String(info.streamName || '') };
  }

  return {
    findBroadcast, broadcastStatus, updateBroadcastTitle, transitionBroadcast, createBroadcast,
    cancelBroadcast, setPrivacy, streamKey,
  };
}

module.exports = { makeLive };
