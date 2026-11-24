// The Clock face (pump-face.html): digital on the drop (face-drop.js) or with hands, the date and
// the weather outside if asked. Also the face a pump shows while the PC's screens
// are off. Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;

  // Weather codes (server/weather/forecast-shape.js) to the few shapes drawn here.
  const SKY = { 113: 'sun', 116: 'partly', 119: 'cloud', 248: 'fog', 266: 'rain', 302: 'rain', 356: 'rain', 338: 'snow', 200: 'storm' };
  const CLOUD = 'M7 17h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.6A3.2 3.2 0 0 0 7 17z';
  const SHAPES = {
    sun: [['circle', { cx: 12, cy: 12, r: 4.2 }], ['path', { d: 'M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8' }]],
    partly: [['path', { d: 'M8.5 3.5v1.6M3.5 8.5h1.6M5 5l1.1 1.1M12 5l-1.1 1.1M6.2 10.6a3 3 0 1 1 5.2-2.8' }], ['path', { d: CLOUD }]],
    cloud: [['path', { d: CLOUD }]],
    fog: [['path', { d: 'M4 9h16M6 13h12M4 17h16' }]],
    rain: [['path', { d: CLOUD }], ['path', { d: 'M9 20l-1 2M13 20l-1 2M17 20l-1 2' }]],
    snow: [['path', { d: CLOUD }], ['path', { d: 'M9 21h.01M13 21h.01M17 21h.01' }]],
    storm: [['path', { d: CLOUD }], ['path', { d: 'M12.5 17l-2 3.2h3l-2 3' }]],
  };

  function weatherIcon(code) {
    const shape = SHAPES[SKY[code]] || SHAPES.cloud;
    const box = Kit.svg('svg', { viewBox: '0 0 24 24', class: 'pf-sky', 'aria-hidden': 'true' });
    for (const [tag, attrs] of shape) box.append(Kit.svg(tag, attrs));
    return box;
  }

  function weatherLine(w) {
    const line = Kit.el('div', 'pf-weather');
    if (!w || !Number.isFinite(w.tempC)) return line;
    const f = Kit.prefs().tempUnit === 'f';
    const temp = Math.round(f ? w.tempC * 9 / 5 + 32 : w.tempC);
    line.append(weatherIcon(w.code), Kit.el('span', 'pf-weather-temp', `${temp}°`));
    if (w.condition) line.title = w.condition;
    return line;
  }

  // Strumento's clock (face-gauge.js) writes the weather the same way.
  Kit.add('part', 'weather', weatherLine);

  function dateText(now) {
    return new Intl.DateTimeFormat(Kit.locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  }

  // How much smaller the time must be to stay inside a round screen: a two-digit
  // hour is wider, and the seconds and AM/PM beside it take more room still.
  function fitStep(hm, extras) {
    const digits = (hm.match(/\d/g) || []).length;
    return digits < 4 ? 0 : 1 + extras;
  }

  // Each style returns { paint(now), place }: place holds the weather line.
  function digital(root, opts) {
    Kit.get('part', 'drop')(root);
    const mid = Kit.el('div', 'pf-clock-mid pf-drop-ink');
    const time = Kit.el('div', 'pf-time');
    const hm = Kit.el('span', 'pf-time-hm');
    const sec = Kit.el('span', 'pf-time-s');
    const ampm = Kit.el('span', 'pf-time-ampm');
    time.append(hm, sec, ampm);
    const date = Kit.el('div', 'pf-date');
    mid.append(time, date);
    root.append(mid);
    const paint = (now) => {
      const parts = new Intl.DateTimeFormat(Kit.locale(), { hour: 'numeric', minute: '2-digit', hour12: Kit.hour12() }).formatToParts(now);
      hm.textContent = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
      ampm.textContent = parts.find((p) => p.type === 'dayPeriod')?.value || '';
      sec.textContent = opts.seconds ? String(now.getSeconds()).padStart(2, '0') : '';
      date.textContent = opts.date ? dateText(now) : '';
      time.dataset.fit = String(fitStep(hm.textContent, [sec, ampm].filter((n) => n.textContent).length));
    };
    return { paint, place: mid };
  }

  function analog(root, opts) {
    const dial = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-dial', 'aria-hidden': 'true' });
    for (let i = 0; i < 60; i += 1) {
      const major = i % 5 === 0;
      dial.append(Kit.svg('line', {
        x1: 50, y1: major ? 4.5 : 5, x2: 50, y2: major ? 10 : 7,
        class: major ? 'pf-tick pf-tick-major' : 'pf-tick', transform: `rotate(${i * 6} 50 50)`,
      }));
    }
    const hand = (cls, y2) => Kit.svg('line', { x1: 50, y1: 54, x2: 50, y2, class: `pf-hand ${cls}` });
    const h = hand('pf-hand-h', 27);
    const m = hand('pf-hand-m', 13);
    const s = opts.seconds ? hand('pf-hand-s', 10) : null;
    dial.append(h, m);
    if (s) dial.append(s);
    dial.append(Kit.svg('circle', { cx: 50, cy: 50, r: 1.8, class: 'pf-hub' }));
    const date = Kit.el('div', 'pf-date pf-date-dial');
    root.append(dial, date);
    const paint = (now) => {
      const sec = now.getSeconds();
      const min = now.getMinutes() + sec / 60;
      h.setAttribute('transform', `rotate(${((now.getHours() % 12) + min / 60) * 30} 50 50)`);
      m.setAttribute('transform', `rotate(${min * 6} 50 50)`);
      if (s) s.setAttribute('transform', `rotate(${sec * 6} 50 50)`);
      date.textContent = opts.date ? new Intl.DateTimeFormat(Kit.locale(), { weekday: 'short', day: 'numeric' }).format(now) : '';
    };
    return { paint, place: root };
  }

  Kit.add('face', 'clock', (root, opts) => {
    root.classList.add('pf-face-clock', `pf-style-${opts.style}`);
    const { paint, place } = opts.style === 'analog' ? analog(root, opts) : digital(root, opts);
    let sky = Kit.el('div', 'pf-weather');
    place.prepend(sky);
    let seen = '';
    return {
      wantsWeather: !!opts.weather,
      update(data) {
        paint(new Date());
        const w = opts.weather ? data.weather : null;
        const key = w ? `${w.code}|${w.tempC}|${Kit.prefs().tempUnit}` : '';
        if (key === seen) return;
        seen = key;
        const next = weatherLine(w);
        sky.replaceWith(next);
        sky = next;
      },
      tick() { paint(new Date()); },
    };
  });
})();
