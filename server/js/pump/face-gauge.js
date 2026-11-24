// Strumento (pump-faces.js SCREEN_STYLES 'gauge'): a screen's faces drawn as an instrument.
// Sensors and game put their first reading on a dial with a needle and the second above it,
// music puts the song's time on it, the clock is a dial of its own. The needle and the arc
// glide by CSS, so nothing is drawn between readings. Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  // Degrees from the top, clockwise: the dial opens at the bottom, where the number sits.
  const START = 225;
  const SWEEP = 270;
  const R_ARC = 44.6;
  // Steps a reading's dial is cut in, each in four (Kit.READINGS max; temperatures to 100 °C).
  const STEPS = Object.freeze({ fps: 6, power: 6, cpuClock: 6, gpuClock: 7 });
  // A temperature's last tenth is marked red, as a car's last revs are.
  const RED_FROM = 0.9;

  const angle = (f) => START + Kit.clamp01(f) * SWEEP;
  function at(deg, r) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [(50 + r * Math.cos(rad)).toFixed(2), (50 + r * Math.sin(rad)).toFixed(2)];
  }
  const line = (deg, from, to, cls) => {
    const [x1, y1] = at(deg, from);
    const [x2, y2] = at(deg, to);
    return Kit.svg('line', { x1, y1, x2, y2, class: cls });
  };

  // The marks of a dial cut in `steps`: { f, major, label }.
  function marks(steps, label) {
    const out = [];
    for (let i = 0; i <= steps * 4; i += 1) out.push({ f: i / (steps * 4), major: i % 4 === 0, label: i % 4 === 0 ? label(i / 4) : '' });
    return out;
  }

  // A reading's marks, written in the unit the face shows (°F too) and GHz for a clock speed.
  function readingMarks(name) {
    const def = Kit.READINGS[name] || {};
    const max = def.temp ? 100 : def.max || 100;
    const steps = STEPS[name] || 5;
    const f = Kit.prefs().hwTempUnit === 'f';
    return marks(steps, (i) => {
      const u = (max / steps) * i;
      if (def.temp) return String(Math.round(f ? u * 9 / 5 + 32 : u));
      return def.ghz ? String(Number((u / 1000).toFixed(1))) : String(u);
    });
  }

  // A song's marks: one a minute (every 2, 5 or 10 for a long one), its length the end.
  function songMarks(length) {
    const step = [60, 120, 300, 600].find((s) => length / s <= 8) || 900;
    const out = [];
    for (let u = 0; u <= length; u += step / 4) out.push({ f: u / length, major: u % step === 0, label: u % step === 0 ? String(u / 60) : '' });
    return out;
  }

  const clockText = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // The dial: its marks and numbers, the arc that fills up to the needle, and the needle.
  // scale(marks, redline) redraws the marks when they change; set(fraction, tone) moves the rest.
  function dial(root, gauge) {
    const svg = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-g-dial', 'aria-hidden': 'true' });
    const arc = gauge.arc ? Kit.gauge(svg, { r: R_ARC, width: 2.1, start: START, sweep: SWEEP }) : null;
    const ticks = Kit.svg('g', { class: 'pf-g-ticks' });
    const needle = Kit.svg('g', { class: 'pf-g-needle' });
    needle.append(Kit.svg('polygon', { points: '48.9,55.4 49.7,13 50.3,13 51.1,55.4' }), Kit.svg('circle', { cx: 50, cy: 50, r: 2.6 }),
      Kit.svg('circle', { cx: 50, cy: 50, r: 0.9, class: 'pf-g-pin' }));
    svg.append(ticks);
    if (gauge.needle) svg.append(needle);
    root.append(svg);
    let shown = '';
    return {
      scale(list, redline) {
        const key = JSON.stringify(list) + redline;
        if (key === shown) return;
        shown = key;
        ticks.replaceChildren(...list.flatMap((m) => {
          const cls = 'pf-g-tick' + (m.major ? ' pf-g-major' : '') + (redline && m.f >= RED_FROM ? ' pf-g-redline' : '');
          const mark = line(angle(m.f), m.major ? 35.8 : 39.2, 41.7, cls);
          if (!m.label) return [mark];
          const [x, y] = at(angle(m.f), 30.6);
          const num = Kit.svg('text', { x, y, class: 'pf-g-num' });
          num.textContent = m.label;
          return [mark, num];
        }));
      },
      set(fraction, tone) {
        if (arc) arc.set(fraction, tone);
        needle.style.setProperty('--pf-g-turn', `${angle(fraction).toFixed(2)}deg`);
      },
    };
  }

  // The words around the dial: a line above the needle, the number below it, its name under.
  function words(root) {
    const top = Kit.el('div', 'pf-g-line pf-g-top');
    const big = Kit.el('div', 'pf-g-big');
    const num = Kit.el('span', 'pf-num');
    const unit = Kit.el('span', 'pf-unit');
    const label = Kit.el('div', 'pf-g-line pf-g-label');
    big.append(num, unit);
    root.append(top, big, label);
    return {
      top, label,
      // { text, unit, tone, value }: value null writes the words small, as every face does, and
      // rests the needle. Three digits or more stay their size: wider, they would meet the end marks.
      big(r) {
        num.textContent = r.text;
        unit.textContent = r.value == null ? '' : r.unit || '';
        big.dataset.tone = r.tone || 'ok';
        big.dataset.digits = String(Math.min(4, (String(r.text).match(/\d/g) || []).length));
        big.classList.toggle('pf-none', r.value == null);
        root.classList.toggle('pf-g-rest', r.value == null);
      },
    };
  }

  function readingsFace(root, opts, dialOf, say) {
    const [first, second] = opts.readings || [];
    return {
      update(data) {
        const main = Kit.reading(first, data.system);
        const next = second ? Kit.reading(second, data.system) : null;
        if (!main) return;
        dialOf.scale(readingMarks(first), !!Kit.READINGS[first].temp);
        dialOf.set(main.fraction, main.tone);
        say.big(main);
        say.top.textContent = next && next.value != null ? `${next.label} ${next.text}${next.unit}` : '';
        say.label.textContent = main.label;
        root.classList.toggle('pf-g-hot', main.tone === 'hot');
      },
    };
  }

  function songFace(dialOf, say) {
    let media = null;
    let at0 = 0;
    function paint() {
      const length = media ? Number(media.duration) : 0;
      const pos = media ? Math.max(0, Kit.songAt(media, at0)) : 0;
      dialOf.scale(length > 0 ? songMarks(length) : marks(5, () => ''), false);
      dialOf.set(length > 0 ? pos / length : 0, 'ok');
      say.big(media ? { text: clockText(length > 0 ? Math.min(pos, length) : pos), value: pos } : { text: Kit.t('pump_face_nothing_playing', 'Nothing playing'), value: null });
      say.top.textContent = media ? media.artist || '' : '';
      say.label.textContent = media ? media.title : '';
    }
    return {
      update(data) {
        // An app heard with only its name (a browser tab's sound) is no song to show.
        const m = data.media?.fallback === true && data.media.title === data.media.app ? null : data.media;
        const song = m?.title ? m : null;
        if (song !== media) { media = song; at0 = Date.now(); }
        paint();
      },
      tick: paint,
    };
  }

  // The clock as an instrument: sixty marks, two hands (three with seconds), the date below.
  function clockFace(root, opts) {
    const svg = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-g-dial', 'aria-hidden': 'true' });
    for (let i = 0; i < 60; i += 1) svg.append(line(i * 6, i % 5 === 0 ? 34 : 37.5, 41.7, i % 5 === 0 ? 'pf-g-tick pf-g-major' : 'pf-g-tick'));
    const hand = (cls, len, w) => Kit.svg('rect', { x: 50 - w / 2, y: 50 - len, width: w, height: len + 3.3, rx: w / 2, class: cls });
    const h = hand('pf-g-hour', 23, 2.4);
    const m = hand('pf-g-min', 35, 1.3);
    const s = opts.seconds ? hand('pf-g-sec', 38, 0.5) : null;
    svg.append(h, m, ...(s ? [s] : []), Kit.svg('circle', { cx: 50, cy: 50, r: 1.9, class: 'pf-g-hub' }));
    let sky = Kit.el('div', 'pf-weather');
    const date = Kit.el('div', 'pf-g-line pf-g-date');
    root.append(sky, date, svg);
    let seen = '';
    const paint = (now) => {
      const min = now.getMinutes() + now.getSeconds() / 60;
      h.setAttribute('transform', `rotate(${(((now.getHours() % 12) + min / 60) * 30).toFixed(2)} 50 50)`);
      m.setAttribute('transform', `rotate(${(min * 6).toFixed(2)} 50 50)`);
      if (s) s.setAttribute('transform', `rotate(${now.getSeconds() * 6} 50 50)`);
      date.textContent = opts.date ? new Intl.DateTimeFormat(Kit.locale(), { weekday: 'short', day: 'numeric', month: 'short' }).format(now) : '';
    };
    return {
      wantsWeather: !!opts.weather,
      update(data) {
        paint(new Date());
        const w = opts.weather ? data.weather : null;
        const key = w ? `${w.code}|${w.tempC}|${Kit.prefs().tempUnit}` : '';
        if (key === seen) return;
        seen = key;
        const next = Kit.get('part', 'weather')(w);
        sky.replaceWith(next);
        sky = next;
      },
      tick() { paint(new Date()); },
    };
  }

  Kit.add('face', 'gauge', (root, opts) => {
    root.classList.add('pf-face-gauge', 'pf-g-' + opts.face);
    // The language lets two lines of words break where a phrase does (Japanese has no spaces).
    root.lang = Kit.locale();
    const gauge = opts.gauge || { needle: true, arc: true };
    if (opts.face === 'clock') return clockFace(root, opts);
    const say = words(root);
    const dialOf = dial(root, gauge);
    return opts.face === 'music' ? songFace(dialOf, say) : readingsFace(root, opts, dialOf, say);
  });
})();
