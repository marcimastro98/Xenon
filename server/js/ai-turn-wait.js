// The wait on a long AI turn. A creation on Sonnet or Opus takes minutes, and
// three dots for minutes read as a hang: the chat asks the server how far the
// turn has got (GET /api/ai/turn, server/ai-turns.js) and says it, with the time
// spent. The turn id also stays in localStorage until its answer is handled, so
// a chat that reloaded, or lost the connection on the way, picks the answer up
// from the server and the widget it made still lands on the page.
(function () {
  const STORE_KEY = 'xenon.aiPendingTurn';
  const FIRST_LOOK_MS = 4000;
  const LOOK_EVERY_MS = 2500;
  // Past this the chat says a creation can take minutes and may be closed.
  const LONG_SECS = 25;
  // The server keeps an answer this long (ai-turns.js KEEP_MS).
  const KEEP_MS = 15 * 60 * 1000;
  const REFERENCE_TOOLS = new Set(['sdk_reference', 'preset_reference', 'deck_action_catalog', 'marketplace_search']);

  const tr = (k) => (typeof t === 'function' ? t(k) : k);

  function newId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes); // also on a paired phone over plain http, unlike randomUUID
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function remember(id) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* private mode: no recovery, the wait still shows */ }
  }

  function forget(id) {
    try {
      const saved = pending();
      if (!saved || saved.id === id) localStorage.removeItem(STORE_KEY);
    } catch { /* nothing kept */ }
  }

  function pending() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!v || typeof v.id !== 'string' || !/^[a-f0-9]{32}$/.test(v.id) || !Number.isFinite(v.at)) return null;
      return Date.now() - v.at < KEEP_MS ? v : null;
    } catch { return null; }
  }

  async function look(id) {
    try {
      const res = await fetch(SERVER + '/api/ai/turn?id=' + encodeURIComponent(id), { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // What the turn is doing, in words.
  function label(st) {
    if (!st) return tr('ai_wait_thinking');
    if (st.stage === 'tool') {
      if (st.tool === 'create_widget') return tr('ai_wait_installing');
      if (st.tool === 'create_preset') return tr('ai_wait_packing');
      if (REFERENCE_TOOLS.has(st.tool)) return tr('ai_wait_reading');
      return tr('ai_wait_working');
    }
    if (st.stage === 'creating') return tr('ai_wait_creating');
    if (st.stage === 'refining') return tr('ai_wait_refining');
    return tr('ai_wait_thinking');
  }

  const clock = (secs) => Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');

  // {text, time, long} for the status line, from the server's answer.
  function describe(st) {
    const secs = st && Number.isFinite(st.secs) ? Math.max(0, st.secs) : 0;
    return { text: label(st), time: clock(secs), long: secs >= LONG_SECS };
  }

  // Polls a turn while the chat waits on it; `onStatus` gets each running
  // status. Returns the function that stops it.
  function watch(id, onStatus) {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      const st = await look(id);
      if (stopped) return;
      if (st && st.state === 'running') onStatus(st);
      timer = setTimeout(tick, LOOK_EVERY_MS);
    };
    timer = setTimeout(tick, FIRST_LOOK_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }

  // Waits for the answer of a turn the chat lost (a reload, a dropped
  // connection) and hands it to `apply(data, ok)`. Gives up when the server no
  // longer knows the turn. Returns the function that stops it.
  function recover(id, apply, onStatus) {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      const st = await look(id);
      if (stopped) return;
      if (st && st.state === 'done') {
        forget(id);
        let data = {};
        try { data = JSON.parse(st.body || '{}'); } catch { /* an empty answer */ }
        apply(data, st.status >= 200 && st.status < 300);
        return;
      }
      if (st && st.state === 'unknown') { forget(id); apply(null, false); return; }
      if (st && st.state === 'running' && onStatus) onStatus(st);
      timer = setTimeout(tick, LOOK_EVERY_MS);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }

  window.AiTurnWait = { newId, remember, forget, pending, watch, recover, describe, LONG_SECS };
})();
