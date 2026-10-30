// xenon-client.js: a small helper for Xenon dashboard widgets.
//
// Copy this file into your widget package and load it before your own script:
//   <script src="xenon-client.js"></script>
//   <script src="widget.js"></script>
//
// It wraps the bridge protocol described in docs/WIDGET_SDK.md in promises, so
// code written for a normal web page needs fewer changes:
//
//   xenon.ready                     resolves with the host's `init` message
//   xenon.on(type, fn)              host messages: 'data', 'theme', 'size',
//                                   'visibility', ... fn(payload, message),
//                                   where payload is the theme, the stream's
//                                   data, the language...; the current theme,
//                                   lang, tempUnit and placement arrive at once
//                                   from init;
//                                   returns an unsubscribe
//   xenon.fetch(url, options)       the proxied fetch: needs the host in your
//                                   manifest `hosts`; resolves with
//                                   { ok, status, contentType, encoding, body,
//                                   error, json() }
//   xenon.store.get/set/delete/keys the persistent store (`"storage": true`)
//   xenon.assetUrl(url)             an <img> src for a picture on a declared host
//   xenon.ai(prompt, options)       a question to the AI the user chose for Bit
//                                   (`"ai": true`); options { system, maxTokens,
//                                   json }; resolves with { ok, text, left, error }
//
// The helper sends the `hello` handshake itself: do not send your own.
//
// Nothing here gives your widget more than the bridge already does: every call
// is the same message you could post yourself, and the host enforces the same
// grants. Requests are sent one at a time and spaced out, because the host
// refuses a fetch that comes less than a second after the previous one and a
// store write that comes less than 100 ms after the previous one.
(function () {
  'use strict';
  if (window.xenon) return;

  const FETCH_GAP_MS = 1100;
  const STORE_WRITE_GAP_MS = 140;
  const REPLY_TIMEOUT_MS = 30000;
  // An answer can take a while: a local model, or the user's Claude/ChatGPT plan.
  const AI_TIMEOUT_MS = 180000;

  let nextId = 1;
  const pending = new Map();      // id -> { resolve, timer }
  const listeners = new Map();    // type -> Set of handlers
  // The latest push of each STATE kind (one 'data' per stream, 'theme',
  // 'size'...), replayed to a handler that subscribes after it arrived. One-off
  // events (hooks, deck handler calls) are never replayed: they would run twice.
  const REPLAYED = new Set(['data', 'theme', 'size', 'visibility', 'shape', 'lang', 'tempUnit', 'placement', 'notice']);
  // The field a handler receives as its first argument; other kinds get `data`,
  // or the whole message when they have none (size, shape).
  const PAYLOAD_FIELD = { theme: 'theme', lang: 'lang', tempUnit: 'tempUnit', placement: 'placement', visibility: 'visible', notice: 'active' };
  // init carries the starting theme, language, unit and placement; they are seeded as if
  // pushed, so on('theme', fn) paints once without waiting for a change.
  const SEEDED_FROM_INIT = ['theme', 'lang', 'tempUnit', 'placement'];
  const latest = new Map();
  let init = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function send(msg) {
    window.parent.postMessage(Object.assign({ xenonSdk: 1 }, msg), '*');
  }

  // One request/reply round-trip. Never rejects: a missing reply resolves as
  // { ok: false, error: 'timeout' } so callers handle one shape.
  function ask(type, fields, timeoutMs) {
    const id = 'xc' + (nextId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs || REPLY_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      send(Object.assign({ type, id }, fields));
    });
  }

  // A queue that runs one task at a time with at least `gapMs` between starts,
  // and retries a task the host refused with 'rate_limited' once.
  function makeQueue(gapMs) {
    let chain = Promise.resolve();
    let lastStart = 0;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    async function runSpaced(task) {
      const delay = lastStart + gapMs - Date.now();
      if (delay > 0) await wait(delay);
      lastStart = Date.now();
      return task();
    }
    return function enqueue(task) {
      const run = chain.then(async () => {
        const res = await runSpaced(task);
        return res && res.error === 'rate_limited' ? runSpaced(task) : res;
      });
      chain = run.catch(() => {});
      return run;
    };
  }
  const fetchQueue = makeQueue(FETCH_GAP_MS);
  // The host answers one question per widget at a time ('busy' otherwise).
  const aiQueue = makeQueue(0);
  const writeQueue = makeQueue(STORE_WRITE_GAP_MS);

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1 || typeof m.type !== 'string') return;
    if (m.type === 'init') {
      init = m;
      resolveReady(m);
      SEEDED_FROM_INIT.forEach((k) => {
        if (m[k] === undefined) return;
        const seed = { xenonSdk: 1, type: k, [k]: m[k] };
        if (k === 'tempUnit') seed.hwTempUnit = m.hwTempUnit;
        publish(seed);
      });
      return;
    }
    if (/_result$/.test(m.type) && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    }
    if (/_result$/.test(m.type)) return;
    publish(m);
  });

  function publish(m) {
    if (REPLAYED.has(m.type)) latest.set(m.type === 'data' ? 'data|' + m.stream : m.type, m);
    const set = listeners.get(m.type);
    if (set) set.forEach((fn) => deliver(fn, m));
  }

  function deliver(fn, m) {
    const field = PAYLOAD_FIELD[m.type];
    const payload = field ? m[field] : (m.data !== undefined ? m.data : m);
    try { fn(payload, m); } catch (err) { console.error(err); }
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    // Replayed on the next turn, and only if nothing newer arrived meanwhile:
    // that one already reached fn, and an older replay after it would leave the
    // widget showing the stale value.
    latest.forEach((m, key) => {
      if (m.type === type) setTimeout(() => { if (latest.get(key) === m) deliver(fn, m); }, 0);
    });
    return () => listeners.get(type).delete(fn);
  }

  function request(url, options) {
    const o = options || {};
    return fetchQueue(() => ask('fetch', {
      url: String(url),
      method: o.method || 'GET',
      headers: o.headers || { Accept: 'application/json' },
      body: o.body,
    })).then((r) => Object.assign(r, {
      json() {
        if (!r.ok) throw new Error(r.error || ('HTTP ' + r.status));
        return JSON.parse(r.encoding === 'base64' ? atob(r.body) : r.body);
      },
    }));
  }

  const store = {
    get: (key) => ask('store', { op: { op: 'get', key } }).then((r) => (r.ok ? r.value : null)),
    keys: () => ask('store', { op: { op: 'keys' } }).then((r) => (r.ok ? r.keys : [])),
    set: (key, value) => writeQueue(() => ask('store', { op: { op: 'set', key, value } })),
    delete: (key) => writeQueue(() => ask('store', { op: { op: 'delete', key } })),
  };

  function assetUrl(url) {
    if (!init || !init.pkgId) throw new Error('xenon.assetUrl: wait for xenon.ready first');
    return '/sdk/asset/' + encodeURIComponent(init.pkgId) + '?u=' + encodeURIComponent(String(url));
  }

  // Each question counts toward the daily number the user allows a widget, so
  // ask when the person does something, not on a timer.
  function ai(prompt, options) {
    const o = options || {};
    return aiQueue(() => ask('ai', { prompt: String(prompt), system: o.system, maxTokens: o.maxTokens, json: o.json === true }, AI_TIMEOUT_MS));
  }

  window.xenon = { ready, on, fetch: request, store, assetUrl, ai, send };
  // Say hello once the page's own scripts (deferred ones too) have run, so
  // their handlers are in place before the host starts talking.
  const hello = () => send({ type: 'hello' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello);
  else setTimeout(hello, 0);
})();
