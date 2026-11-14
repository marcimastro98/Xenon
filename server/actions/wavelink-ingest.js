'use strict';
// What Wave Link sends, kept: the levels, a partial change merged into a channel's record, the
// channels of either dialect turned into the one list the dashboard shows.

const {
  meterPct, adaptV2Channels, adaptV3Channels, mergeChannelPatch,
} = require('./wavelink-shape.js');

function makeIngest({ v2Raw, channels, icons, meters }) {
  const v3Raw = new Map();

  // Meters arrive bucketed by kind. Anything we did not subscribe to is ignored
  // rather than stored: an unbounded map keyed by whatever the server names is
  // exactly the growth the codebase avoids elsewhere.
  // The wire field is named `levelLeftPercentage`, so it is read as 0..100 and
  // clamped. Every frame observed on a live 3.2.9 carried 0 (nothing was routed
  // into Wave Link on that machine), so the SCALE is the one thing here taken
  // from the field's name rather than from a measurement: if a future build
  // turns out to send 0..1, meterPct is the single line to change.
  function ingestMeters(params) {
    const p = params && typeof params === 'object' ? params : {};
    for (const [bucket, kind] of [['channels', 'channel'], ['mixes', 'mix']]) {
      for (const m of Array.isArray(p[bucket]) ? p[bucket] : []) {
        if (!m || m.id == null) continue;
        meters.set(kind + ':' + String(m.id), [meterPct(m.levelLeftPercentage), meterPct(m.levelRightPercentage)]);
      }
    }
  }

  function mergeV3Raw(id, patch) {
    const merged = mergeChannelPatch(v3Raw.get(id) || { id }, patch);
    v3Raw.set(id, merged);
    return merged;
  }

  function reindexV2() {
    channels.clear();
    for (const ch of adaptV2Channels(Array.from(v2Raw.values()))) channels.set(ch.id, ch);
  }

  function ingestV2Channels(list) {
    if (!Array.isArray(list)) return;
    v2Raw.clear();
    for (const ch of list) { if (ch && ch.mixId != null) v2Raw.set(String(ch.mixId), ch); }
    reindexV2();
  }

  function ingestV3Channels(list) {
    if (!Array.isArray(list)) return;
    v3Raw.clear(); channels.clear(); icons.clear();
    for (const ch of list) {
      if (!ch || ch.id == null) continue;
      const id = String(ch.id);
      v3Raw.set(id, ch);
      if (ch.image && typeof ch.image.imgData === 'string' && ch.image.imgData) icons.set(id, ch.image.imgData);
    }
    for (const ch of adaptV3Channels(list)) channels.set(ch.id, ch);
  }

  return { ingestMeters, mergeV3Raw, reindexV2, ingestV2Channels, ingestV3Channels };
}

module.exports = { makeIngest };
