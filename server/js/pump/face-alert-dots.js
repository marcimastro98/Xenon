// The title of a pump alert in dots, like a lit sign (face-alerts.js), over a style that asked for
// them (manifest pumpAlerts "dots"): each line is written small on a canvas of its own, then every
// pixel of it that is mostly ink lights one dot on the screen, in the line's colour read off the
// card. The title only: the app's name and a message's own words stay in plain type around it,
// where small letters still read. Joins window.PumpFaceKit as the part "alertDots"; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  // Screen pixels from one dot to the next: a 480 px pump gets dots 3 px apart.
  const SIDE_PER_PITCH = 160;
  // Each line's height in dots, the room between lines, and how much of a pixel must be ink.
  const TITLE_DOTS = 12;
  const GAP_DOTS = 2;
  const INK = 110;
  const TITLE_LINES = 2;
  const FONT = '"Sofia Sans Semi Condensed", "Sofia Sans", system-ui, sans-serif';

  // Words into at most `most` lines no wider than `max`; a word too long breaks where it must
  // (and a language without spaces breaks anywhere). The last line ends in "…" when words are left.
  function wrap(ctx, text, max, most) {
    const fits = (s) => ctx.measureText(s).width <= max;
    const chars = [...String(text).replace(/\s+/g, ' ').trim()];
    const lines = [];
    let line = '';
    let i = 0;
    for (; i < chars.length && lines.length < most; i += 1) {
      const next = line + chars[i];
      if (fits(next) || !line) { line = next; continue; }
      const cut = chars[i] !== ' ' && line.includes(' ') ? line.lastIndexOf(' ') : line.length;
      lines.push(line.slice(0, cut).trimEnd());
      line = (line.slice(cut) + chars[i]).trimStart();
    }
    if (lines.length < most) return line ? [...lines, line] : lines;
    if (line || i < chars.length) {
      let last = lines[most - 1];
      // Whole words go first, so the line ends on one; a single long word loses letters.
      while (last && !fits(last + '…')) last = last.includes(' ') ? last.slice(0, last.lastIndexOf(' ')) : last.slice(0, -1);
      lines[most - 1] = last.trimEnd() + '…';
    }
    return lines;
  }

  // One canvas of dots for the lines given, in one colour.
  function sign(lines, colour, width, pitch) {
    const lw = Math.max(1, Math.floor(width / pitch));
    const lh = lines.length * (TITLE_DOTS + GAP_DOTS) - GAP_DOTS;
    const low = document.createElement('canvas');
    low.width = lw;
    low.height = Math.max(1, lh);
    const lc = low.getContext('2d', { willReadFrequently: true });
    lc.textAlign = 'center';
    lc.textBaseline = 'middle';
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const out = Kit.el('canvas', 'pf-alert-dots');
    out.width = lw * pitch * dpr;
    out.height = low.height * pitch * dpr;
    out.setAttribute('aria-hidden', 'true');
    // Its size on screen set to the dots' own, so no dot is ever stretched or blurred.
    out.style.width = lw * pitch + 'px';
    out.style.height = low.height * pitch + 'px';
    const oc = out.getContext('2d');
    oc.scale(dpr, dpr);
    const dot = pitch >= 3 ? pitch - 1 : pitch;
    const size = TITLE_DOTS;
    lc.font = `800 ${Math.round(size * 1.3)}px ${FONT}`;
    oc.fillStyle = colour;
    let y = 0;
    for (const text of lines) {
      lc.clearRect(0, 0, lw, low.height);
      lc.fillStyle = '#fff';
      lc.fillText(text, lw / 2, y + size / 2);
      const ink = lc.getImageData(0, y, lw, size).data;
      for (let i = 3; i < ink.length; i += 4) {
        if (ink[i] < INK) continue;
        const p = (i - 3) / 4;
        oc.fillRect((p % lw) * pitch, (y + Math.floor(p / lw)) * pitch, dot, dot);
      }
      y += size + GAP_DOTS;
    }
    return out;
  }

  // Puts the title in dots on `card`; false when there is no room to (plain type then).
  function draw(card, title) {
    const css = getComputedStyle(card);
    // The card's room inside its padding (narrower on a round screen, set in PumpFace.css).
    const width = card.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    if (!(width > 0)) return false;
    // Pitch from the screen the alerts cover (the window, on the pump's own page).
    const box = card.parentNode;
    const side = Math.min(box?.clientWidth || 0, box?.clientHeight || 0) || Math.min(window.innerWidth, window.innerHeight);
    const pitch = Math.max(2, Math.round(side / SIDE_PER_PITCH));
    const max = Math.floor(width / pitch);
    const ink = (name) => css.getPropertyValue(name).trim() || '#ffffff';
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `800 ${Math.round(TITLE_DOTS * 1.3)}px ${FONT}`;
    const colour = card.classList.contains('pf-alert-hot') ? ink('--pf-hot') : ink('--pf-c1');
    card.append(sign(wrap(measure, title, max, TITLE_LINES), colour, width, pitch));
    return true;
  }

  Kit.add('part', 'alertDots', draw);
})();
