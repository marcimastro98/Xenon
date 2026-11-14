'use strict';
// Turns what Wave Link 2 and Wave Link 3 send into the same channels, mixes and outputs, with
// every volume as a percentage, and works out which mixes an action means.

// The legacy sub-mix selector: the two sliders Wave Link 2 keeps per channel.
// 'all' targets both (used by mute toggles). Deliberately narrow — a 3.x mix id
// is NOT run through this, see resolveMixTargets().
function normSlider(mix) {
  const m = String(mix == null ? 'stream' : mix).trim().toLowerCase();
  return (m === 'local' || m === 'stream' || m === 'all') ? m : 'stream';
}

// Is this getApplicationInfo answer Wave Link? The gate exists to reject some
// OTHER listener that happens to sit on :182x, so it must not also reject Wave
// Link itself under a name Elgato changed: an exact === on 'Elgato Wave Link'
// makes a rename indistinguishable from "the app is not running", and the user
// can do nothing about either. Match the product name, ignoring spacing, case
// and any vendor prefix or version suffix around it.
function isWaveLinkApp(appName) {
  if (typeof appName !== 'string') return false;
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, '').includes('wavelink');
}

// Wave Link 3 renamed the identity fields (appName/appVersion → name/version).
// Reading only the 2.x spelling meant a perfectly connected 3.x server reported
// `undefined` and was rejected as "not Wave Link" — a correct connection thrown
// away at the last step. Accept either, and let the caller ask which dialect.
function appIdentity(info) {
  const i = info && typeof info === 'object' ? info : {};
  const name = typeof i.name === 'string' ? i.name : (typeof i.appName === 'string' ? i.appName : '');
  const version = typeof i.version === 'string' ? i.version : (typeof i.appVersion === 'string' ? i.appVersion : '');
  const revision = Number.isFinite(i.interfaceRevision) ? i.interfaceRevision : 0;
  // interfaceRevision only exists on 3.x; the 2.x-only field names are the
  // fallback signal, so a future 4.x that keeps `name` still reads as modern.
  const dialect = (revision >= 2 || typeof i.name === 'string') ? 3 : 2;
  return { name, version, revision, dialect, isWaveLink: isWaveLinkApp(name) };
}

function clampVolume(v) {
  // Reject null/empty explicitly — Number('') and Number(null) are 0, which would
  // silently turn an empty "set volume" field into a mute.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 3.x carries levels as 0..1 floats; everything above the transport speaks
// 0..100 so the Deck action contract is dialect-independent. Rounding on the way
// up and NOT on the way down keeps a fader from drifting: 63 → 0.63 → 63.
function pctFromUnit(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}
function unitFromPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n / 100));
}

// A meter reading, already a percentage on the wire. Kept separate from
// pctFromUnit so the two scales cannot be confused at a call site.
function meterPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Project a raw 2.x channel (server field names) into the compact shape the
// dashboard needs — small, no icon blobs.
function compactChannel(ch) {
  if (!ch || typeof ch !== 'object') return null;
  const id = ch.mixId != null ? String(ch.mixId) : '';
  if (!id) return null;
  return {
    mixId: id,
    name: String(ch.mixerName == null ? id : ch.mixerName),
    bgColor: ch.bgColor ? String(ch.bgColor) : '',
    inputType: Number.isFinite(ch.inputType) ? ch.inputType : 0,
    localVolumeIn: Number.isFinite(ch.localVolumeIn) ? ch.localVolumeIn : 0,
    streamVolumeIn: Number.isFinite(ch.streamVolumeIn) ? ch.streamVolumeIn : 0,
    isLocalInMuted: !!ch.isLocalInMuted,
    isStreamInMuted: !!ch.isStreamInMuted,
    isAvailable: ch.isAvailable !== false,
  };
}

// The two synthetic mixes a 2.x mixer has always had, named so the UI can show
// them the same way it shows a 3.x user's own mixes.
const V2_MIX_LOCAL = 'local';
const V2_MIX_STREAM = 'stream';
function v2Mixes() {
  return [
    { id: V2_MIX_LOCAL, name: 'Local', level: 0, muted: false, icon: 'headphones' },
    { id: V2_MIX_STREAM, name: 'Stream', level: 0, muted: false, icon: 'stream' },
  ];
}

// 2.x channels → the normalised model.
function adaptV2Channels(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const c = compactChannel(item);
    if (!c) continue;
    out.push({
      id: c.mixId,
      name: c.name,
      kind: 'hardware',
      available: c.isAvailable,
      // 2.x has no per-channel master, only the two sub-mixes. Reporting the
      // stream value as a master would give the widget a fader that writes
      // nowhere, so the master is explicitly absent.
      level: null,
      muted: null,
      mixes: [
        { id: V2_MIX_LOCAL, level: c.localVolumeIn, muted: c.isLocalInMuted },
        { id: V2_MIX_STREAM, level: c.streamVolumeIn, muted: c.isStreamInMuted },
      ],
      effects: [],
      hasIcon: false,
    });
  }
  return out;
}

// 3.x channels → the normalised model. `image.imgData` is deliberately dropped:
// it is a base64 PNG per channel and this object is broadcast over SSE. Whether
// one EXISTS is kept, so the widget can ask for it once by URL.
function adaptV3Channels(raw) {
  const out = [];
  for (const ch of Array.isArray(raw) ? raw : []) {
    if (!ch || typeof ch !== 'object' || ch.id == null) continue;
    const mixes = [];
    for (const m of Array.isArray(ch.mixes) ? ch.mixes : []) {
      if (!m || m.id == null) continue;
      mixes.push({ id: String(m.id), level: pctFromUnit(m.level), muted: !!m.isMuted });
    }
    const effects = [];
    for (const e of Array.isArray(ch.effects) ? ch.effects : []) {
      if (!e || e.id == null) continue;
      effects.push({ id: String(e.id), name: String(e.name == null ? e.id : e.name), enabled: !!e.isEnabled });
    }
    out.push({
      id: String(ch.id),
      name: String(ch.name == null ? ch.id : ch.name),
      kind: String(ch.type || '').toLowerCase() === 'software' ? 'software' : 'hardware',
      available: true,
      level: pctFromUnit(ch.level),
      muted: !!ch.isMuted,
      mixes,
      effects,
      hasIcon: !!(ch.image && typeof ch.image.imgData === 'string' && ch.image.imgData.length > 0),
    });
  }
  return out;
}

function adaptV3Mixes(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || m.id == null) continue;
    out.push({
      id: String(m.id),
      name: String(m.name == null ? m.id : m.name),
      level: pctFromUnit(m.level),
      muted: !!m.isMuted,
      icon: m.image && typeof m.image.name === 'string' ? m.image.name : '',
    });
  }
  return out;
}

function adaptV3Outputs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const devices = [];
  for (const d of Array.isArray(r.outputDevices) ? r.outputDevices : []) {
    if (!d || d.id == null) continue;
    const outs = [];
    for (const o of Array.isArray(d.outputs) ? d.outputs : []) {
      if (!o || o.id == null) continue;
      outs.push({ id: String(o.id), name: String(o.name == null ? o.id : o.name), level: pctFromUnit(o.level), muted: !!o.isMuted, mixId: String(o.mixId || '') });
    }
    devices.push({ id: String(d.id), name: String(d.name == null ? d.id : d.name), kind: String(d.deviceType || ''), outputs: outs });
  }
  // The main output can name a device the list does not contain — measured on a
  // real 3.2.9, where mainOutput pointed at an id none of the four listed
  // devices carried. So BOTH identifiers travel: a consumer that highlights the
  // active device has to be able to match on either, and has to accept that
  // sometimes neither matches rather than showing a row with nothing lit and no
  // explanation.
  const mainId = r.mainOutput && r.mainOutput.outputDeviceId != null ? String(r.mainOutput.outputDeviceId) : '';
  const mainOutputId = r.mainOutput && r.mainOutput.outputId != null ? String(r.mainOutput.outputId) : '';
  const listed = devices.some((d) => d.id === mainId || d.outputs.some((o) => o.id === mainOutputId));
  return { mainId, mainOutputId, mainListed: listed, devices };
}

// 3.x notifications carry ONLY the fields that changed — `channelChanged` for a
// volume move arrives as {id, name, type, level} with no mixes and no effects.
// Replacing the cached record with that patch silently deletes the rest of the
// channel, which reads on screen as a mixer that loses its faders whenever you
// touch one. Merge, and merge the nested mix list BY ID for the same reason.
function mergeChannelPatch(prev, patch) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = Object.assign({}, base);
  for (const k of Object.keys(p)) {
    if (k === 'mixes') continue;
    if (p[k] !== undefined) next[k] = p[k];
  }
  if (Array.isArray(p.mixes)) {
    const byId = new Map((Array.isArray(base.mixes) ? base.mixes : []).map((m) => [String(m.id), m]));
    for (const m of p.mixes) {
      if (!m || m.id == null) continue;
      const id = String(m.id);
      byId.set(id, Object.assign({}, byId.get(id) || { id }, m));
    }
    next.mixes = Array.from(byId.values());
  }
  return next;
}

// Which mix ids does a Deck action mean? The action contract predates 3.x, where
// `mix` could only be 'local' | 'stream' | 'all'. On 3.x the user's mixes are
// named and there can be any number, so those three words are resolved BY
// POSITION (first mix is the personal/local one, second is the stream one) and
// anything else is taken as an explicit mix id.
//
// An id that no longer exists returns nothing rather than falling back to a
// default: a Deck key pointing at a deleted mix must fail visibly, not quietly
// move a fader the user did not mean.
function resolveMixTargets(mixes, selector) {
  const list = (Array.isArray(mixes) ? mixes : []).map((m) => String(m && m.id != null ? m.id : '')).filter(Boolean);
  if (!list.length) return [];
  const raw = selector == null ? 'stream' : String(selector).trim();
  const lower = raw.toLowerCase();
  if (lower === 'all') return list.slice();
  if (lower === 'local') return [list[0]];
  if (lower === 'stream') return [list.length > 1 ? list[1] : list[0]];
  return list.includes(raw) ? [raw] : [];
}

module.exports = {
  normSlider, isWaveLinkApp, appIdentity, clampVolume, pctFromUnit, unitFromPct, meterPct,
  compactChannel, V2_MIX_LOCAL, V2_MIX_STREAM, v2Mixes, adaptV2Channels, adaptV3Channels,
  adaptV3Mixes, adaptV3Outputs, mergeChannelPatch, resolveMixTargets,
};
