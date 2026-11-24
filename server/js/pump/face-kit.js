// What every pump face borrows (pump-face.html): the words the server put in the
// page, the readings as a face writes them, SVG rings, and the list the faces
// and the moving pictures join when their file loads. One window.PumpFaceKit.
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const parts = { face: new Map(), art: new Map(), part: new Map() };
  let words = {};
  let prefs = { lang: 'en', tempUnit: 'c', hwTempUnit: 'c', clockFormat: 'auto', accent: '#6ee787' };
  // The unit the face on show asked for ('c', 'f'), over the one of Settings; '' = Settings'.
  let faceUnit = '';

  // Each reading: its word, how it is read off the `system` event, and the
  // range its ring fills. Temperatures arrive in °C and are written in the
  // unit chosen in Settings; 80/90 °C mark warm and hot.
  const READINGS = Object.freeze({
    cpuTemp: { key: 'pump_reading_cpu_temp', en: 'CPU temp', temp: true, read: (s) => s.cpuTemp },
    gpuTemp: { key: 'pump_reading_gpu_temp', en: 'GPU temp', temp: true, read: (s) => s.gpuTemp },
    cpu: { key: 'pump_reading_cpu', en: 'CPU load', unit: '%', max: 100, read: (s) => s.cpu },
    gpu: { key: 'pump_reading_gpu', en: 'GPU load', unit: '%', max: 100, read: (s) => s.gpu },
    ram: { key: 'pump_reading_ram', en: 'RAM', unit: '%', max: 100, read: (s) => s.memory?.percent },
    vram: { key: 'pump_reading_vram', en: 'VRAM', unit: '%', max: 100, read: (s) => (s.vramTotal > 0 ? (s.vramUsed / s.vramTotal) * 100 : null) },
    power: { key: 'pump_reading_power', en: 'Power', unit: 'W', max: 600, read: (s) => s.power?.total },
    fps: { key: 'pump_reading_fps', en: 'FPS', unit: '', max: 240, read: (s) => s.fps },
    cpuClock: { key: 'pump_reading_cpu_clock', en: 'CPU clock', unit: 'GHz', max: 6000, ghz: true, read: (s) => s.cpuClockMHz },
    gpuClock: { key: 'pump_reading_gpu_clock', en: 'GPU clock', unit: 'GHz', max: 3500, ghz: true, read: (s) => s.gpuClockMHz },
  });
  const WARM_C = 80;
  const HOT_C = 90;

  // `next` null keeps the words: a settings refresh brings new units, never new words
  // (a new language reloads the page).
  function setWords(next, nextPrefs) {
    if (next && typeof next === 'object') words = next;
    if (nextPrefs && typeof nextPrefs === 'object') prefs = { ...prefs, ...nextPrefs };
  }

  // The face's look may write temperatures in a unit of its own (pump-faces.js `units`).
  function useUnits(units) { faceUnit = units === 'c' || units === 'f' ? units : ''; }
  const shownPrefs = () => (faceUnit ? { ...prefs, tempUnit: faceUnit, hwTempUnit: faceUnit } : prefs);

  function t(key, fallback) {
    const v = words[key];
    return typeof v === 'string' && v ? v : fallback;
  }

  function locale() { return t('locale', 'en-US'); }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function svg(tag, attrs = {}) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  // A reading as a face shows it: { label, value, text, unit, fraction (0..1), tone }.
  // value null = this PC gives no such number now, said in words, never as 0.
  function reading(name, system) {
    const def = READINGS[name];
    if (!def) return null;
    const raw = Number(system ? def.read(system) : NaN);
    const known = system && def.read(system) != null && Number.isFinite(raw);
    const label = t(def.key, def.en);
    // Before the first reading arrives (the page just opened, Xenon is starting): nothing
    // written yet, never "No reading" for a PC that has not answered.
    if (!system) return { name, label, value: null, text: '', unit: '', fraction: 0, tone: 'none' };
    if (!known) return { name, label, value: null, text: t('pump_face_no_reading', 'No reading'), unit: '', fraction: 0, tone: 'none' };
    if (def.temp) {
      const f = shownPrefs().hwTempUnit === 'f';
      const shown = Math.round(f ? raw * 9 / 5 + 32 : raw);
      const tone = raw >= HOT_C ? 'hot' : raw >= WARM_C ? 'warm' : 'ok';
      return { name, label, value: raw, text: String(shown), unit: f ? '°F' : '°C', fraction: clamp01(raw / 100), tone };
    }
    const text = def.ghz ? (raw / 1000).toFixed(1) : String(Math.round(raw));
    return { name, label, value: raw, text, unit: def.unit, fraction: clamp01(raw / def.max), tone: 'ok' };
  }

  // How hard a reading works, 0..1, or null with no reading: a temperature from 30 °C to 95 °C, the
  // frame rate the other way round (a low one is the strain, 120 and over none), the rest its scale.
  const STRAIN_FPS = 120;
  function strain(r) {
    if (!r || r.value == null) return null;
    if (r.name === 'fps') return clamp01(1 - r.value / STRAIN_FPS);
    return READINGS[r.name]?.temp ? clamp01((r.value - 30) / 65) : r.fraction;
  }

  // Where the song is now, in seconds: the event's position plus the time since it came.
  function songAt(m, at) {
    const base = Number.isFinite(m.positionMs) ? m.positionMs / 1000 : Number(m.position) || 0;
    return m.playbackStatus === 'Playing' ? base + (Date.now() - at) / 1000 : base;
  }

  function clamp01(v) { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }

  // An arc on a 100x100 box: from `start` degrees (0 = top, clockwise) for `sweep`.
  function arcPath(r, start, sweep) {
    const at = (deg) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      return `${(50 + r * Math.cos(rad)).toFixed(3)} ${(50 + r * Math.sin(rad)).toFixed(3)}`;
    };
    const large = sweep > 180 ? 1 : 0;
    return `M ${at(start)} A ${r} ${r} 0 ${large} 1 ${at(start + sweep)}`;
  }

  // A gauge arc: a dim track and a value laid over it. set(fraction, tone).
  function gauge(parent, { r, width, start = 225, sweep = 270, slot = 1 }) {
    const d = arcPath(r, start, sweep);
    const track = svg('path', { d, class: 'pf-track', 'stroke-width': width, pathLength: 100 });
    const fill = svg('path', { d, class: `pf-fill pf-slot-${slot}`, 'stroke-width': width, pathLength: 100, 'stroke-dasharray': '0 100' });
    parent.append(track, fill);
    return {
      set(fraction, tone) {
        const v = (clamp01(fraction) * 100).toFixed(2);
        fill.setAttribute('stroke-dasharray', `${v} 100`);
        fill.dataset.tone = tone || 'ok';
        // A zero-length dash still draws its round caps: two dots on an empty ring.
        fill.toggleAttribute('data-empty', Number(v) <= 0);
      },
      /** The one ring the middle is reading now, when they take turns. */
      mark(on) { fill.toggleAttribute('data-on', on); },
    };
  }

  function add(kind, name, impl) {
    if (!parts[kind]) throw new Error('unknown kind ' + kind);
    parts[kind].set(name, impl);
  }

  function get(kind, name) { return parts[kind] ? parts[kind].get(name) || null : null; }

  // The time as Settings writes it: 24 h, 12 h, or the language's habit.
  function hour12() {
    if (prefs.clockFormat === '12') return true;
    if (prefs.clockFormat === '24') return false;
    return locale().toLowerCase().startsWith('en');
  }

  // A picture the face may load: our own upload, or a cover the player gave.
  function safeImage(url) {
    if (typeof url !== 'string') return '';
    if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(url)) return url;
    if (/^https:\/\/[^\s"'<>]+$/i.test(url)) return url;
    if (/^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,110}\.[A-Za-z0-9]{2,5}$/.test(url)) return url;
    return '';
  }

  // The page loads again when the engine names another run than the one that served it (an
  // update while iCUE kept the page open would leave the old code drawing). Once per run: the
  // address keeps the run it went for, so a page a cache serves old never loads round and round.
  function reloadForRun(served, run, place = location) {
    if (!served || typeof run !== 'string' || !run || run === served) return false;
    const url = new URL(place.href);
    if (url.searchParams.get('run') === run) return false;
    url.searchParams.set('run', run);
    place.replace(url.href);
    return true;
  }

  window.PumpFaceKit = {
    READINGS, setWords, useUnits, t, locale, prefs: shownPrefs, el, svg, reading, strain, arcPath, gauge, add, get, hour12, safeImage, clamp01, songAt,
    reloadForRun,
  };
})();
