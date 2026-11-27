// A ring at the door, from a UniFi Protect doorbell or a Home Assistant doorbell, made into one
// card on every open dashboard (SSE `home_ring`) and, while the person keeps it on, a push to
// the paired phone. Only the path of the camera's picture travels, never the picture itself;
// the card fetches it through the loopback camera proxies (routes-cameras.js).
'use strict';

const { broadcastSSE } = require('../http/sse-clients.js');
const { readHubSettings } = require('../settings/read.js');
const { normalizeHome } = require('./home-settings.js');
const homeLog = require('./home-events.js');

const RING_WAIT_MS = 20000;     // one card per doorbell while someone keeps pressing
const HA_FRESH_MS = 120000;     // older than this, HA is catching up after a restart, not ringing
const DOORBELLS_MAX = 32;
const UNIFI_CAM = /^[A-Za-z0-9]{4,64}$/;
const HA_CAMERA = /^camera\.[a-z0-9_]+$/;

// The lock screen is a public surface: the push says only that someone rang.
const PUSH_BODY = Object.freeze({
  it: 'Suonano alla porta', en: 'Someone rang the doorbell', es: 'Llaman a la puerta',
  fr: 'On sonne à la porte', de: 'Es hat an der Tür geklingelt', pt: 'Tocaram à campainha',
  nl: 'Er wordt aangebeld', ru: 'В дверь звонят', ja: '玄関のチャイムが鳴りました',
  ko: '초인종이 울렸습니다', zh: '有人按门铃',
});

const lastRing = new Map();     // doorbell id -> ms of its last card
const state = { push: null, last: null };

/** server.js hands over its one push funnel (webPushNotify). */
function usePush(fn) { state.push = typeof fn === 'function' ? fn : null; }

/** The latest ring, for Bit ("who rang?"): { id, name, pic, source, at } or null. */
function latest() { return state.last; }

/**
 * A Home Assistant state_changed that is a doorbell being pressed: an `event` entity of the
 * doorbell class whose time moved on, and recently. A doorbell coming back from unavailable
 * carries its old time and is not a ring.
 * @returns {{ id: string, name: string } | null}
 */
function haRing(data, now = Date.now()) {
  const id = data?.entity_id;
  if (typeof id !== 'string' || !id.startsWith('event.')) return null;
  const next = data.new_state;
  const prev = data.old_state;
  if (!next || !prev || prev.state === 'unavailable' || next.state === prev.state) return null;
  const attrs = next.attributes || {};
  if (attrs.device_class !== 'doorbell') return null;
  const at = Date.parse(next.state);
  if (!Number.isFinite(at) || Math.abs(now - at) > HA_FRESH_MS) return null;
  return { id, name: String(attrs.friendly_name || '').slice(0, 80) };
}

/** The camera of a HA doorbell: the one on the same device, else the one its id starts with. */
function haDoorCamera(entityId, entities) {
  const list = Array.isArray(entities) ? entities : [];
  const cams = list.filter((e) => e && typeof e.id === 'string' && HA_CAMERA.test(e.id));
  const bell = list.find((e) => e && e.id === entityId);
  const same = bell?.device ? cams.find((c) => c.device === bell.device) : null;
  if (same) return same;
  const stem = String(entityId).slice(String(entityId).indexOf('.') + 1);
  const named = cams.filter((c) => c.id.length >= 11 && stem.startsWith(c.id.slice(7)));
  return named.sort((a, b) => b.id.length - a.id.length)[0] || null;
}

function remember(id, now) {
  lastRing.set(id, now);
  if (lastRing.size > DOORBELLS_MAX) lastRing.delete(lastRing.keys().next().value);
}

/**
 * One ring. 'shown' when the card went out, 'waiting' inside the wait after the last one,
 * 'off' when the person switched the doorbell card off.
 */
async function ring({ id, name, pic, source }) {
  const now = Date.now();
  if (now - (lastRing.get(id) || 0) < RING_WAIT_MS) return 'waiting';
  remember(id, now);
  homeLog.record({ kind: 'ring', place: name }, now).catch(() => {});
  const settings = (await readHubSettings().catch(() => null)) || {};
  const home = normalizeHome(settings.home);
  if (!home.doorbell) return 'off';
  const event = { id, name: String(name || '').slice(0, 80), pic: pic || '', source, at: now };
  state.last = event;
  broadcastSSE('home_ring', event);
  if (home.doorbellPush && state.push) {
    const lang = String(settings.language || '').slice(0, 2).toLowerCase();
    Promise.resolve(state.push({ title: 'Xenon', body: PUSH_BODY[lang] || PUSH_BODY.en, tag: 'door', url: '/' }, { urgency: 'high', ttl: 60 }))
      .catch(() => {});
  }
  return 'shown';
}

/** A UniFi Protect detection that carries a ring (unifi-detections.js). */
function fromUnifi(det) {
  if (!det || !UNIFI_CAM.test(String(det.camId || ''))) return Promise.resolve('off');
  return ring({ id: 'unifi:' + det.camId, name: det.name || '', pic: '/api/unifiprotect/snapshot/' + det.camId, source: 'unifi' });
}

/** Any HA state change; only a doorbell's goes on (ha-live-state.js). */
async function fromHa(data, deckHa) {
  const hit = haRing(data);
  if (!hit) return 'off';
  const entities = await deckHa.listEntities().catch(() => []);
  const cam = haDoorCamera(hit.id, entities);
  return ring({
    id: 'ha:' + hit.id,
    name: cam?.name || hit.name,
    pic: cam ? '/api/ha/camera/snapshot/' + cam.id : '',
    source: 'ha',
  });
}

module.exports = { usePush, latest, haRing, haDoorCamera, fromUnifi, fromHa, RING_WAIT_MS, _lastRing: lastRing };
