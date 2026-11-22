// The page a pump's screen shows (pump-face.html, served at /pump-face): it says
// which screen it is (?screen=, ?shape=, ?via= from iCUE's widget, NZXT CAM or a
// browser), then draws the face the server picks for it (pump-screen/live.js) and
// what arrives over it. Asks for no web permission: iCUE reloads a widget at each
// one. Faces: face-*.js through window.PumpFaceKit. One window.PumpFace.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const Faces = window.PumpFaces;
  const SHAPES = ['round', 'square', 'wide'];
  const VIAS = ['icue', 'cam', 'monitor', 'browser'];
  const SWAP_MS = 450;
  const WEATHER_EVERY_MS = 15 * 60000;
  const OFFLINE_AFTER_MS = 8000;
  const HELLO_RETRY_MS = [1000, 2000, 5000, 10000];
  // How often the page says it is still on the pump: a screen silent for 75 s is away
  // (pump-screen/presence.js), its widget taken off in iCUE or iCUE closed.
  const BEAT_MS = 30000;

  const query = new URLSearchParams(location.search);
  const screen = (query.get('screen') || 'pump').slice(0, 64);
  // via first: a page with no ?shape= guesses it from via (NZXT CAM's address has neither).
  const via = VIAS.includes(query.get('via')) ? query.get('via') : 'browser';
  const shape = SHAPES.includes(query.get('shape')) ? query.get('shape') : guessShape();
  // The menu's picture of a pump (?preview=1): it mirrors that screen and never says
  // hello, so the pump keeps its own record of how it was seen.
  const preview = query.get('preview') === '1';

  const root = document.getElementById('pf-root');
  const stage = document.getElementById('pf-stage');
  const dim = document.getElementById('pf-dim');
  const status = document.getElementById('pf-status');
  const pageLang = readWords();
  const alerts = Kit.get('part', 'alerts')(document.getElementById('pf-alerts'));
  const colors = Kit.get('part', 'colors')(sayColours);

  const data = { system: null, media: null, weather: null };
  let id = preview ? screen : '';
  let settings = null;
  let now = null;
  let face = null;
  let faceKey = '';
  let weatherAt = 0;
  let offlineTimer = 0;
  let helloTries = 0;
  let helloTimer = 0;
  let refreshTimer = 0;

  function guessShape() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > h * 1.15 || h > w * 1.15) return 'wide';
    return via === 'icue' || via === 'cam' ? 'round' : 'square';
  }

  function readWords() {
    try {
      const raw = JSON.parse(document.getElementById('pump-strings').textContent || '{}');
      Kit.setWords(raw.words, raw.prefs);
      return raw.prefs?.lang || 'en';
    } catch { return 'en'; }
  }

  // ── The face ────────────────────────────────────────────────────────────
  function mount(show) {
    const key = JSON.stringify(show);
    if (key === faceKey) return;
    faceKey = key;
    const make = Kit.get('face', show.face);
    const layer = Kit.el('div', 'pf-face');
    stage.append(layer);
    const next = make ? make(layer, show) : null;
    const old = face;
    face = { layer, impl: next || { update() {} } };
    face.impl.update(data);
    if (old) {
      const fade = !settings || settings.look.fade;
      old.layer.classList.add('pf-face-out');
      setTimeout(() => { if (old.impl.stop) old.impl.stop(); old.layer.remove(); }, fade ? SWAP_MS : 0);
    }
    if (face.impl.wantsWeather) readWeather(false);
  }

  function showNow() {
    const mine = now?.show ? Faces.normalizeFace(now.show) : null;
    mount(mine || Faces.defaultFace('clock'));
    root.dataset.why = now?.why || 'offline';
  }

  function feed() { if (face) face.impl.update(data); }

  // ── Look: mounting, brightness, night hours ─────────────────────────────
  function minutes(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }

  function nightNow(night, at) {
    if (!night) return false;
    const from = minutes(night.from);
    const to = minutes(night.to);
    const cur = at.getHours() * 60 + at.getMinutes();
    if (from < 0 || to < 0 || from === to) return false;
    return from < to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  function applyLook() {
    const look = settings ? settings.look : { rotate: 0, dim: 100, night: null };
    stage.dataset.rotate = String(look.rotate);
    const level = nightNow(look.night, new Date()) ? Math.min(look.dim, look.night.dim) : look.dim;
    dim.style.opacity = String((1 - level / 100).toFixed(2));
  }

  // ── Talking to Xenon ────────────────────────────────────────────────────
  // beat: the half-minute "still here", which changes nothing on the face.
  async function hello(beat = false) {
    clearTimeout(helloTimer);
    const body = { screen, shape, via, w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) };
    try {
      const r = await fetch('/pump/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!d?.ok) throw new Error(d?.error || 'HTTP ' + r.status);
      helloTimer = setTimeout(() => hello(true), BEAT_MS);
      if (beat) return;
      id = d.screen;
      settings = d.settings;
      now = d.now;
      helloTries = 0;
      colors.reset();
      online(true);
      applyLook();
      showNow();
    } catch (e) {
      console.warn('[pump] hello failed, trying again:', e?.message);
      helloTimer = setTimeout(hello, HELLO_RETRY_MS[Math.min(helloTries++, HELLO_RETRY_MS.length - 1)]);
    }
  }

  // The colours of the face, for the ring of lights around the pump (face-colors.js).
  async function sayColours(list) {
    try {
      const r = await fetch('/pump/colors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: id, colors: list }) });
      return (await r.json())?.ok === true;
    } catch { return false; }
  }

  async function refresh() {
    try {
      const d = await (await fetch('/pump', { cache: 'no-store' })).json();
      if (!d?.ok) return;
      if (d.prefs && d.prefs.lang !== pageLang) { location.reload(); return; }
      Kit.setWords(null, d.prefs);
      if (!d.screens[id]) { if (!preview) hello(); return; }
      settings = d.screens[id];
      now = d.now[id] || now;
      applyLook();
      faceKey = '';
      showNow();
    } catch (e) { console.warn('[pump] settings unavailable:', e?.message); }
  }

  // A settings save can come in bursts: read them once they settle.
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 800);
  }

  async function readWeather(force) {
    if (!force && Date.now() - weatherAt < WEATHER_EVERY_MS && data.weather) { feed(); return; }
    weatherAt = Date.now();
    try {
      const w = await (await fetch('/weather?lang=' + encodeURIComponent(pageLang), { cache: 'no-store' })).json();
      data.weather = w && w.ok !== false ? { code: w.code, tempC: Number(w.tempC), condition: w.condition || '' } : null;
    } catch { data.weather = null; }
    feed();
  }

  function online(yes) {
    clearTimeout(offlineTimer);
    if (yes) { status.hidden = true; return; }
    offlineTimer = setTimeout(() => {
      status.textContent = Kit.t('pump_face_reconnecting', 'Waiting for Xenon');
      status.hidden = false;
      now = null;
      showNow();
    }, OFFLINE_AFTER_MS);
  }

  // ── What arrives over the face ──────────────────────────────────────────
  function alert(kind, info) {
    if (!settings?.alerts[kind]) return;
    const quiet = now && now.why === 'screensOff';
    const open = !settings.alerts.hideText && !now?.onAir && !quiet;
    alerts.show({ kind, ...info }, { open, seconds: settings.alerts.seconds });
  }

  function hotText(d) {
    const part = /^gpu/i.test(d.type || '') ? 'GPU' : /^cpu/i.test(d.type || '') ? 'CPU' : '';
    const r = Kit.reading('cpuTemp', { cpuTemp: Number(d.value) });
    return r && r.value != null ? `${part} ${r.text} ${r.unit}`.trim() : part;
  }

  const on = (es, name, fn) => es.addEventListener(name, (e) => {
    let d = null;
    try { d = JSON.parse(e.data); } catch { return; }
    fn(d || {});
  });

  function listen() {
    const es = new EventSource('/sse');
    es.addEventListener('open', () => { online(true); if (preview) refresh(); else hello(); });
    es.addEventListener('error', () => online(false));
    on(es, 'system', (d) => { data.system = d; feed(); });
    on(es, 'media', (d) => { data.media = d; feed(); });
    on(es, 'pump', (d) => {
      if (d.changed) { refresh(); return; }
      if (d.now?.[id]) { now = d.now[id]; showNow(); }
    });
    on(es, 'settings', refreshSoon);
    on(es, 'windows_notification', (d) => alert('notify', { app: d.app, title: d.title, body: d.body, icon: d.icon }));
    on(es, 'discord_notification', (d) => alert('discord', { title: d.title, body: d.body }));
    on(es, 'timer_done', (d) => alert('timer', { label: d.label }));
    on(es, 'guardian_alert', (d) => alert('hot', { text: hotText(d) }));
    on(es, 'calls', (d) => {
      const ringing = Array.isArray(d.calls) && d.calls.length ? d.calls[0] : null;
      alerts.calls(!!ringing);
      if (ringing && !alerts.busy()) alert('call', { caller: ringing.caller, app: ringing.app });
    });
  }

  // Once a second: the clock's hands, a song's time, the next picture, the ring's
  // colours; each minute the night hours; every quarter of an hour the weather, if shown.
  function everySecond() {
    if (face?.impl.tick) face.impl.tick();
    if (!preview && face && settings?.leds?.follow === 'screen') colors.tick(face.layer);
    else colors.reset();
    const t = new Date();
    if (t.getSeconds() === 0) {
      applyLook();
      if (face?.impl.wantsWeather) readWeather(false);
    }
  }

  root.classList.add(`pf-shape-${shape}`);
  root.dataset.via = via;
  showNow();
  online(false);
  listen();
  setTimeout(() => { everySecond(); setInterval(everySecond, 1000); }, 1000 - (Date.now() % 1000));

  window.PumpFace = {
    snapshot: () => ({ screen: id, shape, via, face: face ? JSON.parse(faceKey) : null, why: root.dataset.why, alert: alerts.busy() }),
  };
})();
