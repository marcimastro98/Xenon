'use strict';

// Bit in the dashboard: mounts the shared engine (shared/src/bit*.js) where the app shows Bit,
// feeds it the moment (hour, weather, music, a game running) and sets how much every live Bit
// moves. One body-class observer covers all of them; a Bit whose host left the page is let go
// on the next mount or sweep.
(() => {
  // A Bit stops under every dashboard freeze (invariants-rendering-gpu: overlay-frozen,
  // ambient-idle, game-mode, low-power-gpu, perf-mode); one that lives ON an overlay passes its
  // own list without overlay-frozen. The person's own Bit (a host marked data-own-bit) moves at
  // the pace moments.js reads instead: slower, never frozen, by those same states.
  const TILE_HOLD = ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu', 'perf-mode'];
  const HOT_C = 28, COLD_C = 3;
  const CHIP_HOT_C = 85; // a CPU or GPU this warm makes Bit fan itself
  const BORN = /^(\d{4})-(\d{2})-(\d{2})/;
  const RECENT_LINES = 6;
  // The person's own Bit, kept for the next page that opens (and the other windows).
  const OWN_KEY = 'xenon.bit.own';
  const SEED = /^[0-9a-f]{16}$/;
  const MAX_WORN = 8;
  const BACKGROUND = { light: '#f4f6f5', dark: '#0b0f14' };

  const players = new Map(); // host -> { player, hold }
  const recentLines = [];
  let observer = null;
  let own = null; // { seed, worn } of the person's own Bit, or null: the classic Bit
  let look = null;
  let directorSeed = '';
  let director = null; // the rhythm of the person's own Bit (bit-director.js), with or without the classic Bit chosen
  let state = null; // the last answer of /api/bit or the 'bit' event: egg, stage, prefs, wardrobe
  let personal = null; // the look of the person's own Bit, also where the app keeps the classic one (the companion)

  const engine = () => (window.Xenon?.bit && window.Xenon.bitPlayer ? window.Xenon : null);

  const held = (hold) => hold.some((name) => document.body.classList.contains(name));
  const paceOf = (entry) => (entry.own && window.BitMoments ? window.BitMoments.pace() : held(entry.hold) ? 'still' : 'live');

  function syncHolds() {
    for (const [host, entry] of players) {
      // A host still being built (the search bar joins the page after its button) is not gone.
      if (!host.isConnected) {
        if (entry.placed) { entry.player.destroy(); players.delete(host); }
        continue;
      }
      entry.placed = true;
      entry.player.setPace(paceOf(entry));
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

  // The last system reading the dashboard got (js/state.js), never a poll of its own.
  function chipsHot() {
    const sys = typeof lastSystemData !== 'undefined' && lastSystemData ? lastSystemData : null;
    return !!sys && [sys.cpuTemp, sys.gpuTemp].some((v) => Number(v) >= CHIP_HOT_C);
  }

  function birthday() {
    const m = own && BORN.exec(own.born || '');
    return m ? { month: Number(m[2]), day: Number(m[3]) } : null;
  }

  // The moment, in the shape bitDirector.fits() reads.
  function context(now = new Date()) {
    const w = weatherKind();
    const X = engine();
    return {
      hour: now.getHours(),
      weather: w.kind,
      season: X?.bitDirector ? X.bitDirector.seasonOf(now, birthday()) : '',
      cpuHot: chipsHot(),
      hot: w.tempC != null && w.tempC >= HOT_C,
      cold: w.tempC != null && w.tempC <= COLD_C,
      music: typeof hasActiveMedia === 'function' && !!hasActiveMedia(),
      gaming: document.body.classList.contains('game-mode'),
    };
  }

  /**
   * A live Bit in `host` (emptied first: a cloned tile carries a stale copy).
   * @param {Element} host
   * @param {{ mood?: string, label?: string, fidgets?: boolean|string[], calm?: boolean, hold?: string[], look?: () => object|null }} [opts]
   *   look: a look of its own instead of the page's (the companion keeps the person's Bit)
   */
  function mount(host, opts = {}) {
    const X = engine();
    if (!X || !host) return null;
    const known = players.get(host);
    if (known) return known.player;
    host.replaceChildren();
    const mine = typeof host.hasAttribute === 'function' && host.hasAttribute('data-own-bit');
    const player = X.bitPlayer.mount(host, {
      mood: opts.mood, label: opts.label, fidgets: opts.fidgets, calm: opts.calm, context: () => context(),
      director: () => (opts.look || own ? director : null), look: opts.look, home: opts.home, onWake: mine ? () => window.BitMoments?.woke() : undefined,
    });
    const entry = { player, hold: Array.isArray(opts.hold) ? opts.hold : TILE_HOLD, own: mine };
    players.set(host, entry);
    player.setPace(paceOf(entry));
    watchBody();
    syncHolds();
    return player;
  }

  const playerFor = (host) => (host && players.get(host)?.player) || null;

  // A still Bit as markup, for places that are copied as HTML (chat lines and
  // their mirrors). Only the engine's own palette and numbers go in it.
  function still(clipId, size, tint) {
    const X = engine();
    const c = X?.bit.clip(clipId);
    if (!c) return '';
    const svg = X.bit.frameSvg(c, X.bitPlayer.stillIndex(c), { size, tint, look, clipId: 'bitfloor-still' });
    return X.bitIcon ? X.bitIcon.mark(svg, { kind: 'still', clip: clipId, tint, size }) : svg;
  }

  // Markup made from the look of the moment carries how it was made
  // (bitIcon.mark), so a new look (a hatch, an outfit) draws it again in place.
  const MAKERS = {
    still: (el) => still(el.dataset.bitClip, Number(el.dataset.bitSize) || undefined, el.dataset.bitTint),
    icon: (el) => icon(el.dataset.bitClip, el.dataset.bitTint),
    glyph: (el) => glyph(el.dataset.bitClip),
  };

  function redrawMarks() {
    if (typeof document.querySelectorAll !== 'function') return;
    const tpl = document.createElement('template');
    for (const el of document.querySelectorAll('svg[data-bit-kind]')) {
      const make = MAKERS[el.dataset.bitKind];
      const markup = make?.(el);
      if (!markup) continue;
      tpl.innerHTML = markup; // the engine's own numbers and colours, never user text
      const next = tpl.content.firstElementChild;
      if (!next) continue;
      if (el.getAttribute('class')) next.setAttribute('class', el.getAttribute('class'));
      el.replaceWith(next);
    }
  }

  // Bit as an icon: the still pose cropped to a square around it, sized by CSS (bit-icon.js); '' without the engine.
  function icon(clipId, tint) {
    const I = window.Xenon?.bitIcon;
    const svg = I ? I.icon(clipId, { tint, look }) : '';
    return svg && I.mark(svg, { kind: 'icon', clip: clipId, tint });
  }

  /** Bit as an icon inside `host`: a card that shows other text can stay free of markup. */
  function showIcon(host, clipId, tint) {
    host.innerHTML = icon(clipId, tint);
  }

  // Bit as a one-colour glyph (currentColor) with its face cut out, for a button with its own fill:
  // it reads on any accent like the other topbar icons, where Bit's colours would clash. '' without the engine.
  function glyph(clipId) {
    const I = window.Xenon?.bitIcon;
    const svg = I ? I.glyph(clipId, { look }) : '';
    return svg && I.mark(svg, { kind: 'glyph', clip: clipId });
  }

  // ── The person's own Bit (server/bit/, GET /api/bit) ──
  // Every Bit this page draws wears it: the live players (bitPlayer.useLook),
  // the stills, icons and glyphs (redrawMarks), its bubbles in the chat and the game card (paintTint).
  // Until it hatches, or with the classic Bit chosen for the app, every place keeps the classic Bit.

  function ownOf(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.seed !== 'string' || !SEED.test(raw.seed)) return null;
    const worn = Array.isArray(raw.worn) ? raw.worn.filter((id) => typeof id === 'string' && id.length <= 40).slice(0, MAX_WORN) : [];
    const born = typeof raw.born === 'string' && BORN.test(raw.born) ? raw.born.slice(0, 10) : '';
    const items = Array.isArray(raw.items) ? raw.items.filter((it) => it && worn.includes(it.id)).slice(0, MAX_WORN) : []; // the hub's items it wears (server/bit/items.js): drawn offline too
    return { seed: raw.seed, worn, born, items };
  }

  function lookFor(o) {
    const X = window.Xenon;
    if (!o || !X?.bitGenome || !X.bitLook || !X.bitWardrobe) return null;
    X.bitWardrobe.addItems(o.items);
    const root = document.documentElement;
    const light = !!(root?.style && root.style.colorScheme === 'light');
    return X.bitLook.lookOf(X.bitGenome.decode(o.seed), { worn: X.bitWardrobe.outfit(o.worn), background: light ? BACKGROUND.light : BACKGROUND.dark });
  }

  function paintTint() {
    const root = document.documentElement?.style;
    if (typeof root?.setProperty !== 'function') return;
    const body = look?.body;
    if (typeof body === 'string' && /^#[0-9a-f]{6}$/i.test(body)) root.setProperty('--bit-body', body);
    else root.removeProperty('--bit-body');
  }

  function remember(o) {
    try {
      if (o) localStorage.setItem(OWN_KEY, JSON.stringify(o));
      else localStorage.removeItem(OWN_KEY);
    } catch { /* storage off: the next page asks the server */ }
  }

  function recalled() {
    try { return ownOf(JSON.parse(localStorage.getItem(OWN_KEY) || 'null')); } catch { return null; }
  }

  /**
   * The Bit every place in this page draws: { seed, worn } of the person's own
   * Bit, or null for the classic one. `keep: false` leaves the copy kept for the
   * other windows as it is (it came from there).
   */
  function setOwn(raw, { keep = true } = {}) {
    own = ownOf(raw);
    look = lookFor(own);
    const X = window.Xenon;
    if (own) rhythmOf(own.seed);
    if (keep) remember(own);
    if (X?.bitPlayer?.useLook) X.bitPlayer.useLook(look);
    redrawMarks();
    paintTint();
    return own;
  }

  // One director per seed: a new outfit or the classic choice keeps its hourly count.
  function rhythmOf(seed) {
    const X = window.Xenon;
    if (!X?.bitDirector || !X.bitGenome || (director && directorSeed === seed)) return;
    director = X.bitDirector.createDirector(X.bitGenome.decode(seed), { cap: state ? state.reactionsPerHour : undefined });
    directorSeed = seed;
  }

  // The server's word on the Bit: once per page (a hatch or an outfit while
  // this page was closed) and on every 'bit' event. The classic Bit chosen for
  // the app's places keeps every place classic.
  function heard(bit) {
    if (!bit || typeof bit !== 'object' || bit.ok !== true) return;
    state = bit;
    const hatched = bit.hatched ? ownOf(bit) : null;
    personal = lookFor(hatched);
    if (hatched) rhythmOf(hatched.seed);
    const mine = hatched && bit.everywhere !== false ? bit : null;
    if (JSON.stringify(ownOf(mine)) !== JSON.stringify(own)) setOwn(mine);
    if (director) director.setCap(bit.reactionsPerHour);
    if (typeof dispatchEvent === 'function' && typeof CustomEvent === 'function') dispatchEvent(new CustomEvent('xenon-bit', { detail: bit }));
  }

  async function askServer() {
    if (typeof fetch !== 'function') return;
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}/api/bit`, { cache: 'no-store' });
      if (res.ok) heard((await res.json()).bit);
    } catch { /* offline or an older engine: the copy kept here stays */ }
  }

  // The dashboard's live stream (grid/data-stream.js) hands its EventSource here.
  function listen(es) {
    es.addEventListener('bit', (e) => {
      try { heard(JSON.parse(e.data)); } catch { /* a broken event changes nothing */ }
    });
  }

  function startOwn() {
    setOwn(recalled(), { keep: false });
    if (typeof addEventListener === 'function') {
      addEventListener('storage', (e) => { if (e.key === OWN_KEY) setOwn(recalled(), { keep: false }); });
    }
    askServer();
  }

  // One of Bit's lines for a moment, in the dashboard language, never one of the last few said.
  function say(moment, vars) {
    const P = window.Xenon?.bitPhrases;
    if (!P) return '';
    const code = typeof lang === 'string' && P.LANGS.includes(lang) ? lang : 'en';
    const line = P.say(code, moment, vars, recentLines);
    if (!line) return '';
    recentLines.push(line.raw);
    if (recentLines.length > RECENT_LINES) recentLines.shift();
    return line.text;
  }

  function greeting(now = new Date()) {
    const P = window.Xenon?.bitPhrases;
    return P ? say(P.greetingFor(now.getHours())) : '';
  }

  // One anonymous count of what was seen of the Bit (server/bit/seen.js); a paired phone counts nothing.
  const seen = (what) => { if (!window.RemoteSurface?.isRemote?.()) fetch(SERVER + '/api/bit/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }) }).catch(() => {}); };
  window.BitApp = {
    TILE_HOLD, seen, mount, playerFor, still, icon, showIcon, glyph, say, greeting, context, sweep: syncHolds,
    setOwn, own: () => own, look: () => look, director: () => director, listen, state: () => state, heard, personal: () => personal,
    dressed: (worn) => (state?.hatched ? lookFor({ ...ownOf(state), worn }) : null),
  };
  startOwn();
})();
