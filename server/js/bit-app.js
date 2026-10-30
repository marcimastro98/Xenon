'use strict';

// Bit in the dashboard: mounts the shared engine (shared/src/bit*.js) where the
// app shows Bit, feeds it the moment (hour, weather, music, a game running) and
// holds every live Bit while the dashboard stands still. One body-class
// observer covers all of them; a Bit whose host left the page is let go on the
// next mount or sweep.
(function () {
  // Tile-level Bits stop under every dashboard freeze (invariants-rendering-gpu:
  // overlay-frozen, ambient-idle, game-mode, low-power-gpu, perf-mode). A Bit
  // that lives ON an overlay passes its own list without overlay-frozen.
  const TILE_HOLD = ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu', 'perf-mode'];
  const HOT_C = 28;
  const COLD_C = 3;
  const RECENT_LINES = 6;
  const ICON_PAD = 0.5;

  const players = new Map(); // host -> { player, hold }
  const recentLines = [];
  let observer = null;

  const engine = () => (window.Xenon && window.Xenon.bit && window.Xenon.bitPlayer ? window.Xenon : null);

  function held(hold) {
    const c = document.body.classList;
    return hold.some((name) => c.contains(name));
  }

  function syncHolds() {
    for (const [host, entry] of players) {
      if (!host.isConnected) { entry.player.destroy(); players.delete(host); continue; }
      entry.player.hold(held(entry.hold));
    }
  }

  function watchBody() {
    if (observer || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(syncHolds);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  function weatherKind() {
    const wd = typeof weatherData !== 'undefined' && weatherData && weatherData.ok ? weatherData : null;
    if (!wd || typeof classifyWeatherState !== 'function' || typeof weatherStateIcon !== 'function') return { kind: '', tempC: null };
    return { kind: weatherStateIcon(classifyWeatherState(wd)), tempC: Number.isFinite(wd.tempC) ? wd.tempC : null };
  }

  // The moment, in the shape bit.fits() reads.
  function context(now = new Date()) {
    const w = weatherKind();
    const X = engine();
    return {
      hour: now.getHours(),
      weather: w.kind,
      season: X ? X.bit.seasonOf(now) : '',
      hot: w.tempC != null && w.tempC >= HOT_C,
      cold: w.tempC != null && w.tempC <= COLD_C,
      music: typeof hasActiveMedia === 'function' && !!hasActiveMedia(),
      gaming: document.body.classList.contains('game-mode'),
    };
  }

  /**
   * A live Bit in `host` (emptied first: a cloned tile carries a stale copy).
   * @param {Element} host
   * @param {{ mood?: string, label?: string, fidgets?: boolean, hold?: string[] }} [opts]
   */
  function mount(host, opts = {}) {
    const X = engine();
    if (!X || !host) return null;
    const known = players.get(host);
    if (known) return known.player;
    host.replaceChildren();
    const player = X.bitPlayer.mount(host, { mood: opts.mood, label: opts.label, fidgets: opts.fidgets, context: () => context() });
    const hold = Array.isArray(opts.hold) ? opts.hold : TILE_HOLD;
    players.set(host, { player, hold });
    player.hold(held(hold));
    watchBody();
    syncHolds();
    return player;
  }

  function playerFor(host) {
    const entry = host && players.get(host);
    return entry ? entry.player : null;
  }

  // A still Bit as markup, for places that are copied as HTML (chat lines and
  // their mirrors). Only the engine's own palette and numbers go in it.
  function still(clipId, size, tint) {
    const X = engine();
    const c = X && X.bit.clip(clipId);
    if (!c) return '';
    return X.bit.frameSvg(c, X.bitPlayer.stillIndex(c), { size, tint, clipId: 'bitfloor-still' });
  }

  /**
   * Bit as an icon: the still pose cropped to a square around what it draws
   * (the stage keeps room for props a pose may not use), sized by its CSS.
   * @returns {string} SVG markup, or '' without the engine
   */
  function icon(clipId, tint) {
    const pose = iconPose(clipId, tint);
    if (!pose) return '';
    return pose.X.bit.frameSvg(pose.clip, pose.index, { size: 24, tint, clipId: 'bitfloor-still' })
      .replace(/ viewBox="[^"]*" width="[^"]*" height="[^"]*"/, ` viewBox="${pose.box}"`);
  }

  /**
   * Bit as a one-colour glyph (currentColor) with its face cut out, for a
   * button that carries its own fill: it reads on any accent the way the
   * other topbar icons do, where Bit's own colours would clash with it.
   * No mask or id, so a cloned copy (the phone dock) draws the same.
   * @returns {string} SVG markup, or '' without the engine
   */
  function glyph(clipId) {
    const pose = iconPose(clipId);
    if (!pose) return '';
    const ink = pose.X.bitClips && pose.X.bitClips.INK;
    const paths = pose.layers.map((layer) => {
      const d = cutOut(layer.rects, ink);
      const tr = pose.X.bit.transformAttr(layer.transform);
      return d ? `<path${tr ? ` transform="${tr}"` : ''} d="${d}"/>` : '';
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pose.box}" fill="currentColor" shape-rendering="crispEdges">${paths}</svg>`;
  }

  // The still pose without its floor shadow (it would pull the crop below
  // Bit's body), and the square around what it draws.
  function iconPose(clipId, tint) {
    const X = engine();
    const base = X && X.bit.clip(clipId);
    if (!base) return null;
    const index = X.bitPlayer.stillIndex(base);
    const clip = { ...base, frames: base.frames.map((f) => ({ ...f, noShadow: true })) };
    const { layers } = X.bit.renderFrame(clip, index, { tint });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const layer of layers) {
      for (const r of layer.rects) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
      }
    }
    const side = Math.max(x1 - x0, y1 - y0) + ICON_PAD * 2;
    const box = [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side, side].map((n) => Math.round(n * 100) / 100).join(' ');
    return { X, clip, index, layers, box };
  }

  // A layer's solid cells minus its ink (eyes, mouth, brows) as one path, on
  // a half-cell grid (poses move by halves) so overlapping rects never cancel.
  function cutOut(rects, ink) {
    const on = new Set();
    const cells = (r, fn) => {
      for (let y = Math.round(r.y * 2); y < Math.round((r.y + r.h) * 2); y++) {
        for (let x = Math.round(r.x * 2); x < Math.round((r.x + r.w) * 2); x++) fn(x + ',' + y);
      }
    };
    for (const r of rects) if (r.o >= 1 && r.fill !== ink) cells(r, (k) => on.add(k));
    for (const r of rects) if (r.fill === ink) cells(r, (k) => on.delete(k));
    const rows = new Map();
    for (const k of on) {
      const [x, y] = k.split(',').map(Number);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(x);
    }
    let d = '';
    for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i < xs.length;) {
        let j = i;
        while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
        d += `M${xs[i] / 2} ${y / 2}h${(j - i + 1) / 2}v0.5h${-(j - i + 1) / 2}z`;
        i = j + 1;
      }
    }
    return d;
  }

  // One of Bit's lines for a moment, in the dashboard language, never one of
  // the last few said.
  function say(moment, vars) {
    const P = window.Xenon && window.Xenon.bitPhrases;
    if (!P) return '';
    const code = typeof lang === 'string' && P.LANGS.includes(lang) ? lang : 'en';
    const line = P.say(code, moment, vars, recentLines);
    if (!line) return '';
    recentLines.push(line.raw);
    if (recentLines.length > RECENT_LINES) recentLines.shift();
    return line.text;
  }

  function greeting(now = new Date()) {
    const P = window.Xenon && window.Xenon.bitPhrases;
    return P ? say(P.greetingFor(now.getHours())) : '';
  }

  window.BitApp = { TILE_HOLD, mount, playerFor, still, icon, glyph, say, greeting, context, sweep: syncHolds };
})();
