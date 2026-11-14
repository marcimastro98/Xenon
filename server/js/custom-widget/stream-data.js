// What the host does to a stream's data before a frame gets it: the last minutes it keeps for a
// chart, and the names the user gave the fans.
'use strict';

(() => {
  // Streams whose widgets draw the recent PAST, not only the present. For these
  // the host keeps the last minutes of payloads and hands them to a frame as one
  // `history` message when it starts and when it comes back into view, so a chart
  // opens full instead of filling up while the user watches (WIDGET_SDK.md,
  // `processes`). The first mount on a fresh page seeds the ring from the
  // server, which kept the same readings while this page did not exist.
  const HISTORY_STREAMS = { processes: { maxAgeMs: 5 * 60 * 1000, maxItems: 160, url: '/api/processes/history' } };
  const streamHistory = {};         // stream → [{ t, data }] oldest first, host clock
  const historySeed = {};           // stream → 'pending' | 'done'

  // The user's own fan names (Fans widget → tap to rename, persisted in settings
  // as fanLabels) must reach sandboxed widgets too: the board only ever says
  // "Fan #1", so a widget seeing the raw sensor name shows a different label than
  // every builtin surface for the same fan — and loses the ONE clue that a header
  // drives a pump rather than a case fan (which is how a widget ends up painting
  // a healthy AIO pump at permanent redline). Copy-on-write: the payload is
  // shared with the builtin tiles, so it is never mutated in place.
  function withFanLabels(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.fans)) return payload;
    const labels = (typeof window.getFanLabels === 'function') ? window.getFanLabels() : null;
    if (!labels) return payload;
    let touched = false;
    const fans = payload.fans.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const custom = labels[(f.kind || 'mb') + '|' + String(f.name)];
      if (typeof custom !== 'string' || !custom) return f;
      touched = true;
      return { ...f, name: custom };
    });
    return touched ? { ...payload, fans } : payload;
  }

  function historyPrune(stream, now) {
    const cfg = HISTORY_STREAMS[stream];
    const ring = streamHistory[stream];
    if (!cfg || !ring) return;
    while (ring.length && now - ring[0].t > cfg.maxAgeMs) ring.shift();
    while (ring.length > cfg.maxItems) ring.shift();
  }

  function historyPush(stream, data, t) {
    const ring = streamHistory[stream] || (streamHistory[stream] = []);
    const last = ring[ring.length - 1];
    if (last && t < last.t) ring.length = 0;   // the clock stepped back: start over
    ring.push({ t, data });
    historyPrune(stream, t);
  }

  window.CustomWidgetStreamData = {
    HISTORY_STREAMS, streamHistory, historySeed, withFanLabels, historyPrune, historyPush,
  };
})();
