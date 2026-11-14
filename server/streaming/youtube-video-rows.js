'use strict';
// How the YouTube lists are read: the cache of a list, a thumbnail that must be https, a
// duration in seconds, the token of a page, and one video or channel made into the row the
// dashboard shows.

function makeVideoRows({ apiRequest, listCache, VIDEO_ID_RE, CHANNEL_ID_RE, PAGE_TOKEN_RE }) {
  function cacheGet(key, ttl) {
    const e = listCache.get(key);
    return (e && Date.now() - e.at < ttl) ? e.data : null;
  }
  function cacheSet(key, data) {
    if (listCache.size >= 40) listCache.clear();
    listCache.set(key, { at: Date.now(), data });
    return data;
  }

  // Thumbnails are painted as CSS background-images by the client, so the scheme
  // is allowlisted here at the boundary rather than trusted from the API.
  function thumb(th) {
    const raw = (th && ((th.medium && th.medium.url) || (th.default && th.default.url) || (th.high && th.high.url))) || '';
    return /^https:\/\//.test(raw) ? raw : '';
  }
  // "PT1H2M3S" → 3723. Anything unparseable stays null and the client just omits
  // the duration chip rather than showing a wrong one.
  function isoSeconds(s) {
    const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  }

  function pageArg(v) {
    if (v == null || v === '') return '';
    const t = String(v);
    return PAGE_TOKEN_RE.test(t) ? t : null;
  }
  function pageQs(tok) { return tok ? '&pageToken=' + encodeURIComponent(tok) : ''; }
  // Only a token we would accept back is worth handing out.
  function nextToken(data) {
    const t = data && data.nextPageToken;
    return (typeof t === 'string' && PAGE_TOKEN_RE.test(t)) ? t : '';
  }

  // One batched videos.list for a whole page (1 quota unit): the durations, and
  // whether YouTube will let each video play anywhere other than youtube.com.
  // videos.list costs the same unit whatever parts are asked for, so the second
  // answer is free — and it is the one that turns "tap it and find out" into
  // something the list can say up front.
  async function detailsFor(ids) {
    const clean = ids.filter(id => VIDEO_ID_RE.test(id)).slice(0, 50);
    const out = new Map();
    if (!clean.length) return out;
    const r = await apiRequest('GET', '/videos?part=contentDetails,status&id=' + encodeURIComponent(clean.join(',')));
    const items = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    items.forEach(v => { if (v && v.id) out.set(v.id, videoDetail(v)); });
    return out;
  }

  // An explicit `false` is the only value worth acting on. A missing status block —
  // an answer that came back partial, a video the batch didn't cover — has to read
  // as "nothing says otherwise", never as "refuse this one": marking a playable
  // video as YouTube-only hides something that works, while missing a mark costs a
  // tap and the player explains itself anyway.
  function videoDetail(v) {
    const st = v && v.status;
    return {
      seconds: isoSeconds(v && v.contentDetails && v.contentDetails.duration),
      embeddable: !(st && st.embeddable === false),
    };
  }

  // Which channel a row belongs to. The order matters and is a real trap: on a
  // playlistItem, `channelId` is the PLAYLIST OWNER's channel, while
  // `videoOwnerChannelId` is the one that uploaded the video. Reading the first
  // would send someone tapping a channel name in a playlist to whoever made the
  // playlist. Same order as the title above, for the same reason.
  // Validated here so a widget can hand it straight back to channelVideos: an id
  // that would be refused there is better as an empty string, which a widget can
  // test, than as a value that fails one call later.
  function channelIdOf(snippet) {
    const id = (snippet && (snippet.videoOwnerChannelId || snippet.channelId)) || '';
    return CHANNEL_ID_RE.test(String(id)) ? String(id) : '';
  }

  function mapVideo(id, snippet, det) {
    return {
      id,
      title: (snippet && snippet.title) || '',
      channel: (snippet && (snippet.videoOwnerChannelTitle || snippet.channelTitle)) || '',
      channelId: channelIdOf(snippet),
      image: thumb(snippet && snippet.thumbnails),
      seconds: (det && det.seconds != null) ? det.seconds : null,
      embeddable: !(det && det.embeddable === false),
      published: (snippet && snippet.publishedAt) || '',
    };
  }

  return { cacheGet, cacheSet, thumb, pageArg, pageQs, nextToken, detailsFor, videoDetail, mapVideo };
}

module.exports = { makeVideoRows };
