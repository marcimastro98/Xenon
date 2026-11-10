'use strict';

// Home Assistant READS for SDK widgets: the recent history of a few entities and
// one camera frame. Both are bounded to the entities the user already chose in
// Settings → Home Assistant — a widget can never name anything else — and both
// go through the connection `createHomeAssistant` owns, so the token never leaves
// the server.
//
// History prefers the recorder's long-term statistics (hourly mean/max, cheap for
// HA to answer) and falls back to the raw state history for entities that have
// none (no state_class). Either way the widget gets the same shape:
//   { ok, hours, series: { "<entity_id>": { source, points: [{ t, avg, max }] } } }

const { isEntityId, isCameraEntity, isMediaPlayerEntity } = require('./home-assistant');

const HISTORY_MAX_IDS = 12;
const HISTORY_MAX_HOURS = 72;
const HISTORY_DEFAULT_HOURS = 24;
const HISTORY_BUCKETS = 48;
const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const HISTORY_CACHE_MAX = 200;
// A recorder query over three days of many sensors can take longer than the
// 8 s a service call is given; a widget would rather wait than get nothing.
const HISTORY_TIMEOUT_MS = 20 * 1000;
const CAMERA_MAX_BYTES = 2 * 1024 * 1024;

const ARTWORK_CACHE_MAX = 16;

// The image formats a cover may come back in, told by their magic bytes rather
// than HA's Content-Type, so nothing else ever becomes a data: URL.
function imageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return '';
}

// Validate a widget's request against the user's selection. Returns
// { ids, hours, skipped } or { error }. Only ids present in `allowed` survive:
// one the user has since unticked is left out and named in `skipped` (Home
// Assistant is never asked about it), so a widget keeps the rest of its charts.
function normalizeHistoryRequest(rawIds, rawHours, allowed) {
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  const list = Array.isArray(rawIds) ? rawIds : String(rawIds == null ? '' : rawIds).split(',');
  const ids = [];
  const skipped = [];
  for (const raw of list) {
    const id = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!isEntityId(id) || ids.includes(id) || skipped.includes(id)) continue;
    if (allow.has(id)) ids.push(id); else skipped.push(id);
  }
  if (!ids.length) return { error: skipped.length ? 'not_selected' : 'bad_ids' };
  if (ids.length + skipped.length > HISTORY_MAX_IDS) return { error: 'too_many_ids' };
  const h = rawHours == null || rawHours === '' ? HISTORY_DEFAULT_HOURS : Number(rawHours);
  if (!Number.isInteger(h) || h < 1 || h > HISTORY_MAX_HOURS) return { error: 'bad_hours' };
  return { ids, hours: h, skipped };
}

// HA has sent statistic timestamps both as ISO strings and as epoch ms.
function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v == null ? '' : v));
  return Number.isFinite(t) ? t : null;
}

const round = (n) => Math.round(n * 1000) / 1000;

// recorder/statistics_during_period → points, one per period row.
function pointsFromStatistics(rows) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || typeof r !== 'object') continue;
    const t = toMs(r.start);
    const avg = Number.isFinite(r.mean) ? r.mean : (Number.isFinite(r.state) ? r.state : null);
    if (t == null || avg == null) continue;
    out.push({ t, avg: round(avg), max: round(Number.isFinite(r.max) ? r.max : avg) });
  }
  return out;
}

// A state as a number: numeric sensors as they are, on/off style binary states
// as 1/0 so a door's evening reads as a trace too. Anything else is skipped.
function stateValue(s) {
  if (s === 'on' || s === 'open' || s === 'home' || s === 'detected') return 1;
  if (s === 'off' || s === 'closed' || s === 'not_home' || s === 'clear') return 0;
  const n = Number(s);
  return s !== '' && s != null && Number.isFinite(n) ? n : null;
}

// history/history_during_period (minimal_response, compressed: { s, lu | lc } in
// epoch SECONDS) → HISTORY_BUCKETS evenly spaced buckets over [now-hours, now].
// A state holds until the next change, so an empty bucket carries the previous
// value forward rather than dropping to nothing.
function pointsFromHistory(rows, hours, now) {
  const end = now;
  const start = end - hours * 3600 * 1000;
  const size = (end - start) / HISTORY_BUCKETS;
  const changes = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || typeof r !== 'object') continue;
    const sec = Number.isFinite(r.lu) ? r.lu : (Number.isFinite(r.lc) ? r.lc : null);
    const v = stateValue(r.s);
    if (sec == null || v == null) continue;
    changes.push({ t: Math.max(start, sec * 1000), v });
  }
  if (!changes.length) return [];
  changes.sort((a, b) => a.t - b.t);
  const out = [];
  let ci = 0;
  let current = null;
  for (let b = 0; b < HISTORY_BUCKETS; b++) {
    const b0 = start + b * size;
    const b1 = b0 + size;
    let sum = 0; let n = 0; let max = -Infinity;
    if (current != null) { sum += current; n++; max = current; }
    while (ci < changes.length && changes[ci].t < b1) {
      current = changes[ci].v; ci++;
      sum += current; n++; if (current > max) max = current;
    }
    if (n) out.push({ t: Math.round(b0), avg: round(sum / n), max: round(max) });
  }
  return out;
}

function createHaQuery(ha) {
  const cache = new Map(); // "<id>|<hours>" → { at, series }

  function cached(id, hours, now) {
    const hit = cache.get(id + '|' + hours);
    return hit && now - hit.at < HISTORY_CACHE_TTL_MS ? hit.series : null;
  }
  function remember(id, hours, series, now) {
    if (cache.size >= HISTORY_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(id + '|' + hours, { at: now, series });
  }

  async function fetchStatistics(ids, startIso) {
    try {
      const r = await ha.request('recorder/statistics_during_period', {
        start_time: startIso, statistic_ids: ids, period: 'hour', types: ['mean', 'max', 'state'],
      }, HISTORY_TIMEOUT_MS);
      return r && typeof r === 'object' ? r : {};
    } catch (e) { return {}; }
  }
  async function fetchHistory(ids, startIso) {
    const r = await ha.request('history/history_during_period', {
      start_time: startIso, entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
    }, HISTORY_TIMEOUT_MS);
    return r && typeof r === 'object' ? r : {};
  }

  // ids/hours already validated by normalizeHistoryRequest.
  async function history(ids, hours) {
    const now = Date.now();
    const series = {};
    const missing = [];
    for (const id of ids) {
      const hit = cached(id, hours, now);
      if (hit) series[id] = hit; else missing.push(id);
    }
    if (missing.length) {
      const startIso = new Date(now - hours * 3600 * 1000).toISOString();
      const stats = await fetchStatistics(missing, startIso);
      const rest = [];
      for (const id of missing) {
        const points = pointsFromStatistics(stats[id]);
        if (points.length) { series[id] = { source: 'statistics', points }; remember(id, hours, series[id], now); } else rest.push(id);
      }
      if (rest.length) {
        const hist = await fetchHistory(rest, startIso);
        for (const id of rest) {
          series[id] = { source: 'history', points: pointsFromHistory(hist[id], hours, now) };
          remember(id, hours, series[id], now);
        }
      }
    }
    return { ok: true, hours, series };
  }

  // One camera frame as a data: URL — the widget frame's CSP allows `img-src
  // data:` and nothing on the network, so this is the only way it can show one.
  async function cameraFrame(entityId, allowed) {
    const id = String(entityId == null ? '' : entityId).trim().toLowerCase();
    if (!isCameraEntity(id)) return { ok: false, error: 'bad_camera' };
    if (!(Array.isArray(allowed) && allowed.includes(id))) return { ok: false, error: 'not_selected' };
    const jpeg = await ha.cameraSnapshot(id);
    if (!Buffer.isBuffer(jpeg) || !jpeg.length) return { ok: false, error: 'no_frame' };
    if (jpeg.length > CAMERA_MAX_BYTES) return { ok: false, error: 'frame_too_large' };
    return { ok: true, src: 'data:image/jpeg;base64,' + jpeg.toString('base64'), at: Date.now() };
  }

  // A media player's cover art, as a data: URL for the same CSP reason as a
  // camera frame. Cached per player until HA's entity_picture changes (it carries
  // a hash of the art), so a playing track costs one fetch, not one per second.
  const artCache = new Map(); // id → { key, result }
  async function artwork(entityId, allowed) {
    const id = String(entityId == null ? '' : entityId).trim().toLowerCase();
    if (!isMediaPlayerEntity(id)) return { ok: false, error: 'bad_media_player' };
    if (!(Array.isArray(allowed) && allowed.includes(id))) return { ok: false, error: 'not_selected' };
    const key = ha.artworkKey(id);
    if (!key) return { ok: false, error: 'no_artwork' };
    const hit = artCache.get(id);
    if (hit && hit.key === key) return hit.result;
    const img = await ha.mediaArtwork(id);
    if (!Buffer.isBuffer(img) || !img.length) return { ok: false, error: 'no_artwork' };
    if (img.length > CAMERA_MAX_BYTES) return { ok: false, error: 'artwork_too_large' };
    const mime = imageMime(img);
    if (!mime) return { ok: false, error: 'bad_image' };
    const result = { ok: true, src: 'data:' + mime + ';base64,' + img.toString('base64'), at: Date.now() };
    artCache.delete(id);
    if (artCache.size >= ARTWORK_CACHE_MAX) artCache.delete(artCache.keys().next().value);
    artCache.set(id, { key, result });
    return result;
  }

  return { history, cameraFrame, artwork };
}

module.exports = {
  createHaQuery,
  normalizeHistoryRequest,
  imageMime,
  pointsFromStatistics,
  pointsFromHistory,
  HISTORY_MAX_IDS,
  HISTORY_MAX_HOURS,
  HISTORY_BUCKETS,
};
