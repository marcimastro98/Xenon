// The Fans tile's line about Airflow: who drives these fans and why, one tap away from the
// Fans section of the Xenon menu. Seeded from GET /airflow and kept current by the SSE
// 'airflow' event ({ state, why, check }, sent only when one of them changes), which
// js/grid/data-stream.js passes on as 'xenon-menu-changed'; the tile never polls for it.
// Where Xenon cannot reach the fans (a Mac, a laptop) the line is not drawn: there is
// nothing true to say about Airflow there.
'use strict';

(() => {
  const el = makeEl;        // shared DOM factory (utils)
  const api = apiJson;      // fetch → JSON, null on failure (utils)
  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);

  // The states worth a line, and the reason codes it can put into words. A mirror of
  // server/airflow/reasons.js PRIORITY (airflow-fans-line.test.mjs keeps them equal);
  // a code missing here is left unsaid rather than shown raw.
  const STATES = Object.freeze(['off', 'checking', 'watching', 'pc', 'driving']);
  const WHYS = Object.freeze([
    'hot', 'stall', 'sensor', 'brain', 'impossible', 'game-prepare', 'heat-gpu', 'heat-cpu',
    'call-quiet', 'night-quiet', 'spike-ignored', 'learning', 'idle',
  ]);
  const WARN = Object.freeze(['hot', 'stall', 'sensor', 'brain', 'impossible']);

  let air = null;           // { state, why, progress } or null = no line
  let inflight = false;

  function take(d) {
    if (!d || typeof d !== 'object' || !STATES.includes(d.state)) { air = null; return; }
    const p = d.check && typeof d.check === 'object' ? Number(d.check.progress) : NaN;
    air = {
      state: d.state,
      why: WHYS.includes(d.why) ? d.why : null,
      progress: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null,
    };
  }

  // The words: the state as the menu names it, then the reason while Xenon drives or watches.
  function words(a) {
    const live = a.state === 'driving' || a.state === 'watching';
    let sub = '';
    if (live) sub = t('airflow_why_' + (a.why || 'idle').replace(/-/g, '_'));
    else if (a.state === 'checking' && a.progress != null) sub = Math.round(a.progress * 100) + '%';
    const tone = live && WARN.includes(a.why) ? 'is-warn' : live || a.state === 'checking' ? 'is-on' : 'is-idle';
    return { title: t('airflow_state_' + a.state), sub, tone };
  }

  function fill(slot) {
    if (!air) { slot.replaceChildren(); return; }
    const { title, sub, tone } = words(air);
    const opens = !!(window.XenonMenuPanel && typeof window.XenonMenuPanel.open === 'function');
    const line = el(opens ? 'button' : 'div', 'fanw-air ' + tone);
    if (opens) {
      line.type = 'button';
      line.addEventListener('click', () => window.XenonMenuPanel.open('airflow'));
    }
    const text = el('span', 'fanw-air-text');
    text.append(el('span', 'fanw-air-title', title));
    if (sub) text.append(el('span', 'fanw-air-sub', sub));
    line.append(el('span', 'fanw-air-dot'), text);
    if (opens) {
      const go = el('span', 'fanw-air-go', '›');
      go.setAttribute('aria-hidden', 'true');
      line.append(go);
    }
    slot.replaceChildren(line);
  }

  function refresh() {
    document.querySelectorAll('.fanw-air-slot').forEach(fill);
  }

  async function seed() {
    if (inflight) return;
    inflight = true;
    try {
      const d = await api('/airflow');
      take(d && d.ok === true ? d : null);
    } finally { inflight = false; }
    refresh();
  }

  function onSSE(d) {
    take(d);
    refresh();
  }

  window.addEventListener('xenon-menu-changed', (e) => {
    if (e.detail?.name !== 'airflow' || !document.querySelector('.fanw-air-slot')) return;
    try { onSSE(JSON.parse(e.detail.data)); } catch { /* a garbled event leaves the line as it was */ }
  });

  window.FansAirflowLine = { fill, seed, onSSE };
})();
