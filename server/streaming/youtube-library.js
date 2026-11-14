'use strict';
// What a signed-in viewer can browse on YouTube: liked videos, the videos of a playlist, the
// feed of subscriptions, a search, the channels followed, a channel's videos and playlists, and
// the address a playlist opens at.

function makeLibrary({
  getAccessToken, apiRequest, apiReason, PLAYLIST_ID_RE, LIST_TTL_MS, FEED_TTL_MS, SEARCH_TTL_MS,
  UPLOADS_TTL_MS, FEED_CHANNELS, FEED_PER_CHANNEL, cacheGet, cacheSet, thumb, VIDEO_ID_RE,
  CHANNEL_ID_RE, pageArg, pageQs, nextToken, detailsFor, videoDetail, mapVideo, SUB_ORDERS,
}) {
  // The videos the user liked. videos.list?myRating=like returns snippet AND
  // contentDetails in one request, so this is a single quota unit — and it works
  // where the "LL" playlist doesn't (that playlist is private and several
  // accounts refuse it through playlistItems).
  async function likedVideos() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const hit = cacheGet('liked', LIST_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/videos?part=snippet,contentDetails,status&myRating=like&maxResults=25');
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const videos = items.filter(v => v && v.id).map(v => mapVideo(v.id, v.snippet, videoDetail(v)));
    return cacheSet('liked', { ok: true, videos });
  }

  // The videos inside one playlist. Durations need a second (batched) call —
  // playlistItems doesn't carry them.
  async function playlistVideos(id, pageToken) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const pid = String(id == null ? '' : id).trim();
    if (!PLAYLIST_ID_RE.test(pid)) return { ok: false, error: 'bad_id' };
    // A page token is opaque to us and comes back from a widget, so it is checked
    // against the alphabet Google actually uses before it is pasted into a query.
    // An unusable token is refused rather than silently dropped: dropping it would
    // hand back page one under the name of page two, which is a paging loop.
    const tok = pageArg(pageToken);
    if (tok === null) return { ok: false, error: 'bad_page' };
    // The key carries the page, or page two would be served from page one's entry.
    // No token keeps the ORIGINAL key, so the builtin widget's cache is untouched.
    const key = 'pl:' + pid + (tok ? '@' + tok : '');
    const hit = cacheGet(key, LIST_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/playlistItems?part=snippet,contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=50' + pageQs(tok));
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const rows = items.map(it => {
      const vid = (it && it.contentDetails && it.contentDetails.videoId)
        || (it && it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId) || '';
      return VIDEO_ID_RE.test(vid) ? { vid, snippet: it.snippet } : null;
    }).filter(Boolean);
    const det = await detailsFor(rows.map(r2 => r2.vid));
    const videos = rows.map(r2 => mapVideo(r2.vid, r2.snippet, det.get(r2.vid)));
    return cacheSet(key, { ok: true, videos, nextPageToken: nextToken(r.data) });
  }

  // Latest uploads from the channels the user is subscribed to. There is no
  // "home feed" in the Data API, so it is rebuilt: subscriptions (1 unit) →
  // their uploads playlist ids in one batch (1 unit) → the newest few of each
  // (1 unit per channel). Capped at FEED_CHANNELS and cached for 15 minutes so
  // a whole day of use stays well inside the default 10,000-unit quota.
  async function subscriptionsFeed() {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const hit = cacheGet('subs', FEED_TTL_MS);
    if (hit) return hit;
    const s = await apiRequest('GET', '/subscriptions?part=snippet&mine=true&order=relevance&maxResults=50');
    if (!s.ok || !s.data) return { ok: false, error: apiReason(s) };
    const chIds = (Array.isArray(s.data.items) ? s.data.items : [])
      .map(it => it && it.snippet && it.snippet.resourceId && it.snippet.resourceId.channelId)
      .filter(id => PLAYLIST_ID_RE.test(String(id || '')))
      .slice(0, FEED_CHANNELS);
    if (!chIds.length) return cacheSet('subs', { ok: true, videos: [] });
    const c = await apiRequest('GET', '/channels?part=contentDetails&id=' + encodeURIComponent(chIds.join(',')) + '&maxResults=50');
    const uploads = ((c.ok && c.data && Array.isArray(c.data.items)) ? c.data.items : [])
      .map(ch => ch && ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads)
      .filter(pid => PLAYLIST_ID_RE.test(String(pid || '')));
    const pages = await Promise.all(uploads.map(pid =>
      apiRequest('GET', '/playlistItems?part=snippet,contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=' + FEED_PER_CHANNEL)));
    const rows = [];
    pages.forEach(p => {
      const items = (p.ok && p.data && Array.isArray(p.data.items)) ? p.data.items : [];
      items.forEach(it => {
        const vid = (it && it.contentDetails && it.contentDetails.videoId) || '';
        if (VIDEO_ID_RE.test(vid)) rows.push({ vid, snippet: it.snippet });
      });
    });
    rows.sort((a, b) => String((b.snippet && b.snippet.publishedAt) || '').localeCompare(String((a.snippet && a.snippet.publishedAt) || '')));
    const top = rows.slice(0, 30);
    const det = await detailsFor(top.map(r2 => r2.vid));
    const videos = top.map(r2 => mapVideo(r2.vid, r2.snippet, det.get(r2.vid)));
    return cacheSet('subs', { ok: true, videos });
  }

  // Search. This is the one expensive call in the widget (100 quota units of a
  // 10,000/day default), so it only ever runs on an explicit search and the
  // result is cached for half an hour per query.
  async function searchVideos(q, pageToken) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const query = String(q == null ? '' : q).trim().slice(0, 100);
    if (query.length < 2) return { ok: false, error: 'empty' };
    const tok = pageArg(pageToken);
    if (tok === null) return { ok: false, error: 'bad_page' };
    const key = 'q:' + query.toLowerCase() + (tok ? '@' + tok : '');
    const hit = cacheGet(key, SEARCH_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/search?part=snippet&type=video&maxResults=25&q=' + encodeURIComponent(query) + pageQs(tok));
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const rows = (Array.isArray(r.data.items) ? r.data.items : []).map(it => {
      const vid = it && it.id && it.id.videoId;
      return VIDEO_ID_RE.test(String(vid || '')) ? { vid, snippet: it.snippet } : null;
    }).filter(Boolean);
    const det = await detailsFor(rows.map(r2 => r2.vid));
    const videos = rows.map(r2 => mapVideo(r2.vid, r2.snippet, det.get(r2.vid)));
    return cacheSet(key, { ok: true, videos, nextPageToken: nextToken(r.data) });
  }

  async function subscriptionChannels(pageToken, order) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const tok = pageArg(pageToken);
    if (tok === null) return { ok: false, error: 'bad_page' };
    const ord = (order == null || order === '') ? 'alphabetical' : String(order);
    if (!SUB_ORDERS.includes(ord)) return { ok: false, error: 'bad_order' };
    // The order is part of the key: the same page number in two orders is two
    // different lists, and sharing one entry would serve whichever was asked for
    // first under both names.
    const key = 'subch:' + ord + (tok ? '@' + tok : '');
    const hit = cacheGet(key, FEED_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/subscriptions?part=snippet&mine=true&order=' + ord + '&maxResults=50' + pageQs(tok));
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const channels = (Array.isArray(r.data.items) ? r.data.items : []).map(it => {
      const sn = it && it.snippet;
      const id = sn && sn.resourceId && sn.resourceId.channelId;
      return CHANNEL_ID_RE.test(String(id || '')) ? { id, title: (sn && sn.title) || '', image: thumb(sn && sn.thumbnails) } : null;
    }).filter(Boolean);
    return cacheSet(key, { ok: true, channels, nextPageToken: nextToken(r.data) });
  }

  // A channel's uploads. Every channel's uploads are a playlist, so this is the
  // cheap route: resolve the playlist id once (cached for the day — a channel's
  // uploads playlist id never changes) and then page it like any other playlist.
  async function channelVideos(id, pageToken) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const cid = String(id == null ? '' : id).trim();
    if (!CHANNEL_ID_RE.test(cid)) return { ok: false, error: 'bad_id' };
    let uploads = cacheGet('up:' + cid, UPLOADS_TTL_MS);
    if (!uploads) {
      const c = await apiRequest('GET', '/channels?part=contentDetails&id=' + encodeURIComponent(cid));
      if (!c.ok || !c.data) return { ok: false, error: apiReason(c) };
      const first = Array.isArray(c.data.items) ? c.data.items[0] : null;
      const pid = first && first.contentDetails && first.contentDetails.relatedPlaylists && first.contentDetails.relatedPlaylists.uploads;
      if (!PLAYLIST_ID_RE.test(String(pid || ''))) return { ok: false, error: 'not_found' };
      uploads = cacheSet('up:' + cid, pid);
    }
    return playlistVideos(uploads, pageToken);
  }

  // A channel's public playlists. Same shape listPlaylists returns for your own,
  // so a widget can draw one list component for both.
  async function channelPlaylists(id, pageToken) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const cid = String(id == null ? '' : id).trim();
    if (!CHANNEL_ID_RE.test(cid)) return { ok: false, error: 'bad_id' };
    const tok = pageArg(pageToken);
    if (tok === null) return { ok: false, error: 'bad_page' };
    const key = 'chpl:' + cid + (tok ? '@' + tok : '');
    const hit = cacheGet(key, LIST_TTL_MS);
    if (hit) return hit;
    const r = await apiRequest('GET', '/playlists?part=snippet,contentDetails&channelId=' + encodeURIComponent(cid) + '&maxResults=50' + pageQs(tok));
    if (!r.ok || !r.data) return { ok: false, error: apiReason(r) };
    const playlists = (Array.isArray(r.data.items) ? r.data.items : []).filter(Boolean).map(pl => ({
      id: pl.id || '',
      title: (pl.snippet && pl.snippet.title) || '',
      count: (pl.contentDetails && pl.contentDetails.itemCount != null) ? pl.contentDetails.itemCount : null,
      image: thumb(pl.snippet && pl.snippet.thumbnails),
    })).filter(pl => pl.id);
    return cacheSet(key, { ok: true, playlists, nextPageToken: nextToken(r.data) });
  }

  // Playlist id → the URL the client should open. A watch URL on the first video
  // autoplays the whole playlist; when the first video can't be read (private
  // video, or the special LL liked-videos id some accounts refuse via the API)
  // fall back to the playlist page rather than failing — opening a page the
  // user's browser can render is never worse than an error.
  async function resolvePlaylistUrl(id) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const pid = String(id == null ? '' : id).trim();
    if (!PLAYLIST_ID_RE.test(pid)) return { ok: false, error: 'bad_id' };
    const r = await apiRequest('GET', '/playlistItems?part=contentDetails&playlistId=' + encodeURIComponent(pid) + '&maxResults=1');
    const first = r.ok && r.data && Array.isArray(r.data.items) && r.data.items[0];
    const vid = first && first.contentDetails && first.contentDetails.videoId;
    const url = vid
      ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid) + '&list=' + encodeURIComponent(pid)
      : 'https://www.youtube.com/playlist?list=' + encodeURIComponent(pid);
    return { ok: true, url };
  }

  return {
    likedVideos, playlistVideos, subscriptionsFeed, searchVideos, subscriptionChannels, channelVideos,
    channelPlaylists, resolvePlaylistUrl,
  };
}

module.exports = { makeLibrary };
