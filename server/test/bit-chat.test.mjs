// Bit in the app chat: the shared player's hold (the dashboard freezes stop
// it), the app mount (context from the dashboard, the freeze classes, copies
// of the tile), the cost line under a reply on Scintille and the still Bit
// beside a reply. The page itself is checked in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Just enough DOM for the player: elements that keep children and attributes.
class FakeEl {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parent = null; this.textContent = ''; this.className = ''; this.isConnected = true; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.isConnected = false; }
}

function fakeClock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    pending,
    runNext() { const [id, t] = pending.entries().next().value; pending.delete(id); t.fn(); },
  };
}

function bootPlayer() {
  const clock = fakeClock();
  const docListeners = {};
  const document = {
    hidden: false,
    createElementNS: (_ns, tag) => new FakeEl(tag),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: () => {},
  };
  const ctx = { document, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Math, Promise, Object, Array, String, Number, Set, Map };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['bit-clips.js', 'bit.js', 'bit-player.js']) {
    vm.runInContext(read(`../../packages/core/src/${f}`), ctx, { filename: f });
  }
  return { ctx, clock, Xenon: ctx.Xenon };
}

test('a held Bit stops its clock and picks up again when let go', () => {
  const { clock, Xenon } = bootPlayer();
  const host = new FakeEl('span');
  const p = Xenon.bitPlayer.mount(host, { mood: 'think', reducedMotion: false, fidgets: false });
  assert.ok(clock.pending.size > 0, 'a mood animates');
  p.hold(true);
  assert.equal(clock.pending.size, 0, 'held: no timer left running');
  p.setMood('work');
  assert.equal(clock.pending.size, 0, 'a mood change while held draws, but does not animate');
  assert.equal(p.mood, 'work');
  p.hold(false);
  assert.ok(clock.pending.size > 0, 'let go: it animates again');
  p.destroy();
  assert.equal(clock.pending.size, 0);
});

function bootApp({ classes = [], weather = null, now } = {}) {
  const { ctx, Xenon } = bootPlayer();
  const bodyClasses = new Set(classes);
  const observers = [];
  ctx.window = ctx;
  ctx.document.body = { classList: { contains: (c) => bodyClasses.has(c) } };
  ctx.MutationObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} };
  ctx.weatherData = weather;
  ctx.classifyWeatherState = (wd) => (/rain/i.test(wd.condition) ? 'state-rain' : 'state-sun');
  ctx.weatherStateIcon = (st) => st.replace('state-', '');
  ctx.hasActiveMedia = () => true;
  ctx.lang = 'it';
  vm.runInContext(read('../../packages/core/src/bit-phrases.js'), ctx);
  vm.runInContext(read('../js/bit-app.js'), ctx, { filename: 'bit-app.js' });
  const flip = (name, on) => { if (on) bodyClasses.add(name); else bodyClasses.delete(name); observers.forEach((o) => o.fn()); };
  return { ctx, BitApp: ctx.BitApp, Xenon, flip, now };
}

test('the app reads the moment from the dashboard', () => {
  const { BitApp } = bootApp({ classes: ['game-mode'], weather: { ok: true, condition: 'Light rain', tempC: 31 } });
  const c = BitApp.context(new Date(2026, 9, 31, 22, 15));
  assert.equal(c.hour, 22);
  assert.equal(c.weather, 'rain');
  assert.equal(c.hot, true);
  assert.equal(c.cold, false);
  assert.equal(c.music, true);
  assert.equal(c.gaming, true);
  assert.equal(c.season, 'halloween');
  const none = bootApp().BitApp.context(new Date(2026, 3, 2, 9));
  assert.equal(none.weather, '');
  assert.equal(none.hot, false);
  assert.equal(none.gaming, false);
});

test('a tile Bit follows the dashboard freezes, an overlay Bit only its own list', () => {
  const { BitApp, flip } = bootApp();
  const tile = new FakeEl('span');
  const overlay = new FakeEl('span');
  const holds = new Map();
  const spy = (host, opts) => {
    const p = BitApp.mount(host, opts);
    const real = p.hold.bind(p);
    p.hold = (h) => { holds.set(host, h); real(h); };
    return p;
  };
  spy(tile, { mood: 'idle' });
  spy(overlay, { mood: 'listen', hold: ['game-mode'] });
  flip('overlay-frozen', true);
  assert.equal(holds.get(tile), true, 'the chat tile stands still under an overlay');
  assert.equal(holds.get(overlay), false, 'the Bit on the overlay keeps moving');
  flip('overlay-frozen', false);
  assert.equal(holds.get(tile), false);
  for (const cls of BitApp.TILE_HOLD) {
    flip(cls, true);
    assert.equal(holds.get(tile), true, `${cls} holds the tile Bit`);
    flip(cls, false);
  }
});

test('a copied tile gets a fresh Bit, and a Bit whose tile left is let go', () => {
  const { BitApp } = bootApp();
  const host = new FakeEl('span');
  host.appendChild(new FakeEl('svg')); // the stale copy a cloned tile carries
  const p = BitApp.mount(host, { mood: 'idle' });
  assert.equal(host.children.length, 1, 'only the live Bit is in the host');
  assert.equal(BitApp.mount(host), p, 'mounting again keeps the same Bit');
  host.isConnected = false;
  BitApp.sweep();
  assert.equal(BitApp.playerFor(host), null);
});

test('Bit says a greeting in the dashboard language, never the same twice running', () => {
  const { BitApp } = bootApp();
  const P = require('../../packages/core/src/bit-phrases.js');
  const evening = new Set(P.LINES.it.evening);
  const a = BitApp.greeting(new Date(2026, 9, 26, 20));
  const b = BitApp.greeting(new Date(2026, 9, 26, 20));
  assert.ok(evening.has(a) && evening.has(b));
  assert.notEqual(a, b);
});

test('the still Bit beside a reply is engine markup with its own clip id', () => {
  const { BitApp } = bootApp();
  const svg = BitApp.still('happy', 18, 'done');
  assert.match(svg, /^<svg [^>]*width="18"/);
  assert.match(svg, /clipPath id="bitfloor-still"/);
  assert.match(svg, /fill="rgb\(110,231,135\)"/, 'the done colour');
  assert.equal(BitApp.still('nope', 18), '');
});

function bootChat(credits) {
  const ctx = {
    window: {},
    document: {
      createElement: (tag) => new FakeEl(tag),
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    t: (k) => k,
    queueMicrotask,
  };
  ctx.window = ctx;
  ctx.XenonCredits = credits;
  vm.createContext(ctx);
  vm.runInContext(read('../js/ai-bit-chat.js'), ctx, { filename: 'ai-bit-chat.js' });
  return ctx.BitChat;
}

test('a reply shows no Scintille spent: next to Annulla a number read like a refund', () => {
  const chat = bootChat({ format: String, spark: () => new FakeEl('svg') });
  assert.equal(chat.costLine, undefined);
  const ai = read('../js/ai.js');
  assert.doesNotMatch(ai, /_aiAppendCostLine/);
  assert.doesNotMatch(read('../js/i18n.js'), /bit_cost_line/);
});

test('every reply mood beside a reply is a pose Bit has', () => {
  const { ctx } = bootApp();
  ctx.t = (k) => k;
  ctx.queueMicrotask = queueMicrotask;
  ctx.document.createElement = (tag) => new FakeEl(tag);
  ctx.document.querySelectorAll = () => [];
  ctx.document.querySelector = () => null;
  vm.runInContext(read('../js/ai-bit-chat.js'), ctx, { filename: 'ai-bit-chat.js' });
  for (const mood of ['idle', 'done', 'worry', undefined, 'unknown']) {
    assert.match(ctx.BitChat.avatarHtml(mood), /^<span class="ai-msg-bit" aria-hidden="true"><svg /, String(mood));
  }
  // every mood setAiStatus can name is a mood clip
  const src = read('../js/ai-bit-chat.js');
  const moods = [...src.match(/STATUS_MOOD = \{([^}]+)\}/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  for (const m of moods) assert.equal(ctx.Xenon.bit.clip(m)?.kind, 'mood', m);
});

test('in the light theme the chat follows the theme, and the tile never slides sideways', () => {
  // The old dark island forced a near-black base under text that is now dark
  // in the light theme, so the replies vanished.
  const light = read('../styles/themes-light.css');
  const chatRules = [...light.matchAll(/([^{}]*\.chat-panel[^{}]*)\{([^}]*)\}/g)];
  for (const [, sel, body] of chatRules) assert.doesNotMatch(body, /background\s*:/, `light theme paints the chat: ${sel.trim()}`);
  // The blurred cover over-fills the tile; with overflow:hidden alone the tile
  // is still a scroll container and focusing the input scrolled it.
  const media = read('../components/MediaPanel/MediaPanel.css');
  const rule = media.match(/\n\.chat-panel \{([^}]*)\}/)[1];
  assert.match(rule, /overflow:\s*clip/);
});

test('in voice mode Bit listens, thinks and talks, in the colour of the mood', () => {
  const { ctx, flip } = bootApp();
  const props = {};
  const view = { style: { setProperty: (k, v) => { props[k] = v; } } };
  const host = new FakeEl('div');
  host.closest = (sel) => (sel === '.ai-voice-view' ? view : null);
  Object.assign(ctx.document, {
    createElement: (tag) => new FakeEl(tag),
    querySelector: (sel) => (sel === '[data-voice-bit]' ? host : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  });
  ctx.queueMicrotask = queueMicrotask;
  vm.runInContext(read('../js/ai-bit-chat.js'), ctx, { filename: 'ai-bit-chat.js' });
  const holds = [];
  const player = () => ctx.BitApp.playerFor(host);
  const cases = [['connecting', 'think'], ['listening', 'listen'], ['thinking', 'think'], ['speaking', 'talk'], ['', 'idle']];
  for (const [state, mood] of cases) {
    ctx.BitChat.voiceState(state);
    assert.equal(player().mood, mood, `${state || 'no state'} -> ${mood}`);
    assert.equal(props['--bit-rgb'], ctx.Xenon.bit.rgb(mood));
    if (state === 'speaking') assert.equal(props['--bit-rgb'], ctx.Xenon.bit.MOOD_RGB.idle, 'talking is Bit yellow, not the thinking colour');
  }
  assert.equal(host.children.length, 1, 'one Bit, mounted once');
  const real = player().hold.bind(player());
  player().hold = (h) => { holds.push(h); real(h); };
  // The voice view is the overlay in front: the dashboard freezes leave it moving.
  for (const cls of ['overlay-frozen', 'ambient-idle', 'game-mode']) { flip(cls, true); assert.equal(holds.at(-1), false, cls); flip(cls, false); }
  for (const cls of ['low-power-gpu', 'perf-mode']) { flip(cls, true); assert.equal(holds.at(-1), true, cls); flip(cls, false); }
});

test('the voice view is Bit: no orb or ring left, and the words say Bit', () => {
  const html = read('../index.html');
  const view = html.slice(html.indexOf('id="ai-voice-view"'), html.indexOf('id="ai-status"'));
  assert.match(view, /data-voice-bit/);
  assert.match(view, /class="ai-voice-bars"/);
  assert.doesNotMatch(view, /ai-eq|ai-voice-core|ai-voice-ripple|style="/);
  assert.doesNotMatch(html, /id="ai-panel-title">Xenon AI</);
  const css = read('../components/AIPanel/AIPanel.css');
  assert.doesNotMatch(css, /\.ai-eq|\.ai-voice-core|\.ai-voice-ripple|\.ai-avatar/);
  // the bars and halo stop with the low-GPU choices, like Bit
  for (const cls of ['low-power-gpu', 'perf-mode']) assert.match(css, new RegExp(`body\.${cls} \.ai-voice-bars span`));
  const ai = read('../js/ai.js');
  const stateFn = ai.slice(ai.indexOf('function _aiVoiceState('), ai.indexOf('function _aiVoiceTapInterrupt('));
  assert.match(stateFn, /BitChat\.voiceState\(state\)/);
  const i18n = read('../js/i18n.js');
  const speaking = [...i18n.matchAll(/["']?ai_state_speaking["']?: ["']([^"']+)["']/g)].map((m) => m[1]);
  assert.equal(speaking.length, 11);
  for (const s of speaking) assert.match(s, /Bit/);
});

// Every string of a key, one per language block (single or double quotes).
const strings = (i18n, key) => [...i18n.matchAll(new RegExp(`["']?${key}["']?: (["'])((?:(?!\\1).)+)\\1`, 'g'))].map((m) => m[2]);

test('Bit as an icon is the still pose cropped to a square around it, sized by CSS', () => {
  const { ctx } = bootApp();
  for (const [clipId, tint] of [['idle'], ['think', 'think'], ['gaming']]) {
    const svg = ctx.BitApp.icon(clipId, tint);
    const [x, y, w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
    assert.equal(w, h, `${clipId}: square`);
    assert.doesNotMatch(svg.slice(0, svg.indexOf('>')), / width=| height=/, `${clipId}: no fixed size`);
    // every drawn rect of the pose is inside the box, and the box is no bigger than it needs
    const clip = ctx.Xenon.bit.clip(clipId);
    const c = { ...clip, frames: clip.frames.map((f) => ({ ...f, noShadow: true })) };
    const rects = ctx.Xenon.bit.renderFrame(c, ctx.Xenon.bitPlayer.stillIndex(clip), { tint }).layers.flatMap((l) => l.rects);
    for (const r of rects) assert.ok(r.x >= x && r.y >= y && r.x + r.w <= x + w + 1e-9 && r.y + r.h <= y + h + 1e-9, `${clipId}: rect inside`);
    assert.ok(w < ctx.Xenon.bit.STAGE.w, `${clipId}: tighter than the stage`);
    // the still pose, without the floor shadow that would pull the crop off Bit
    const drawn = (m) => (m.match(/<rect [^>]+>/g) || []).filter((r) => !/height="0.6"/.test(r));
    assert.deepEqual(drawn(svg), drawn(ctx.BitApp.still(clipId, 24, tint)), `${clipId}: same drawing as the still`);
    assert.doesNotMatch(svg, /height="0.6"/, `${clipId}: no floor shadow`);
  }
  assert.equal(ctx.BitApp.icon('no-such-pose'), '');
});

test('Bit as a glyph is one colour with its face cut out, in the icon box', () => {
  const { ctx } = bootApp();
  for (const clipId of ['idle', 'think', 'gaming']) {
    const svg = ctx.BitApp.glyph(clipId);
    const head = svg.slice(0, svg.indexOf('>'));
    assert.match(head, /fill="currentColor"/, `${clipId}: the button's ink`);
    assert.match(head, /shape-rendering="crispEdges"/);
    assert.equal(head.match(/viewBox="([^"]+)"/)[1], ctx.BitApp.icon(clipId).match(/viewBox="([^"]+)"/)[1], `${clipId}: same box as the icon`);
    // no colour of its own, no rect, mask or id a cloned copy would lose
    assert.doesNotMatch(svg, /<rect|rgb\(|#[0-9a-f]{3,6}|mask|clip-path| id=/i, `${clipId}: plain paths only`);
    assert.match(svg, /<path [^>]*d="M/, `${clipId}: drawn`);
  }
  // The eyes are holes: an ink cell of the face is not covered by any run.
  const clip = ctx.Xenon.bit.clip('idle');
  const c = { ...clip, frames: clip.frames.map((f) => ({ ...f, noShadow: true })) };
  const layer = ctx.Xenon.bit.renderFrame(c, ctx.Xenon.bitPlayer.stillIndex(clip), {}).layers.find((l) => l.rects.some((r) => r.fill === ctx.Xenon.bitClips.INK));
  const eye = layer.rects.find((r) => r.fill === ctx.Xenon.bitClips.INK);
  const runs = [...ctx.BitApp.glyph('idle').matchAll(/M([\d.-]+) ([\d.-]+)h([\d.-]+)/g)].map((m) => m.slice(1).map(Number));
  const covered = (px, py) => runs.some(([x, y, w]) => py >= y && py < y + 0.5 && px >= x && px < x + w);
  assert.equal(covered(eye.x + 0.25, eye.y + 0.25), false, 'an eye is cut out');
  const body = layer.rects.find((r) => r.fill !== ctx.Xenon.bitClips.INK);
  assert.equal(covered(body.x + 0.25, body.y + 0.25), true, 'the body is drawn');
  assert.equal(ctx.BitApp.glyph('no-such-pose'), '');
});

test('the top bar launcher is Bit, so the phone dock that copies it is Bit too', () => {
  const { ctx } = bootApp();
  let placed = null;
  const old = { replaceWith: (el) => { placed = el; } };
  const btn = { querySelector: (sel) => (sel === 'svg' ? old : null), prepend: (el) => { placed = el; } };
  const made = [];
  Object.assign(ctx.document, {
    createElement: (tag) => {
      if (tag !== 'template') return new FakeEl(tag);
      const first = new FakeEl('svg');
      first.classList = { list: [], add(c) { this.list.push(c); } };
      const tpl = { content: { firstElementChild: first }, set innerHTML(v) { first.markup = v; made.push(v); } };
      return tpl;
    },
    querySelector: (sel) => (sel === '.topbtn-xenon' ? btn : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  });
  ctx.queueMicrotask = queueMicrotask;
  vm.runInContext(read('../js/ai-bit-chat.js'), ctx, { filename: 'ai-bit-chat.js' });
  assert.ok(placed, 'the old icon is replaced');
  assert.match(placed.markup, /^<svg [^>]*shape-rendering="crispEdges"/, 'an engine-drawn Bit');
  assert.equal(placed.markup, ctx.BitApp.glyph('idle'), 'the one-colour glyph, not the coloured sprite');
  assert.equal(placed.attrs['aria-hidden'], 'true');
  assert.deepEqual(placed.classList.list, ['topbtn-bit']);
  // Painted at load, before js/phone-view.js builds the dock that clones it.
  const html = read('../index.html');
  assert.ok(html.indexOf('<script src="js/ai-bit-chat.js">') < html.indexOf('<script src="js/phone-view.js">'));
  const launcher = html.slice(html.indexOf('class="topbtn topbtn-xenon"'), html.indexOf('</button>', html.indexOf('class="topbtn topbtn-xenon"')));
  assert.match(launcher, /<span>Bit<\/span>/);
  const i18n = read('../js/i18n.js');
  for (const key of ['topbar_btn_xenon', 'ph_ai']) {
    const all = strings(i18n, key);
    assert.equal(all.length, 11, key);
    assert.ok(all.every((v) => v === 'Bit'), key);
  }
});

test('Game Companion, Spotlight and the Deck show Bit, and their words say Bit', () => {
  const html = read('../index.html');
  const pill = html.slice(html.indexOf('id="gc-pill"'), html.indexOf('</button>', html.indexOf('id="gc-pill"')));
  assert.doesNotMatch(pill, /🎮/);
  assert.match(pill, /id="gc-pill-icon"/);
  // a still Bit with the controller: game mode holds animation while the pill shows
  const gc = read('../js/game-companion.js');
  assert.match(gc, /BitApp\.icon\('gaming'\)/);
  const { Xenon } = bootPlayer();
  assert.ok(Xenon.bit.clip('gaming').frames.every((f) => f.ex.includes('controller')));
  // Spotlight: Bit thinks while the provider reads the phrase, then is back to idle
  const spot = read('../js/spotlight.js');
  const run = spot.slice(spot.indexOf('async function runAiSearch('), spot.indexOf('// ── search plumbing'));
  assert.match(run, /spot-ai-thinking'\);\s*paintAiBit\('think'\)/);
  assert.match(run, /finally \{[\s\S]*paintAiBit\('idle'\)/);
  // the native Spotlight window loads the engine before spotlight.js
  const page = read('../spotlight.html');
  const at = (f) => page.indexOf(f);
  for (const f of ['shared/src/bit-clips.js', 'shared/src/bit.js', 'shared/src/bit-player.js', 'js/bit-app.js']) {
    assert.ok(at(f) > 0 && at(f) < at('js/spotlight.js'), f);
  }
  // the Deck action picker shows Bit for the AI action
  assert.match(read('../js/deck-editor.js'), /ai: \(window\.BitApp && BitApp\.icon\('idle'\)\) \|\| _ai\(/);
  const i18n = read('../js/i18n.js');
  for (const key of ['spot_ai_toggle', 'spot_ai_hint', 'spot_ai_thinking', 'spot_ai_fallback', 'deck_act_aiEdgeGlow', 'settings_ai_edge_glow_hint']) {
    const all = strings(i18n, key);
    assert.equal(all.length, 11, key);
    for (const v of all) assert.match(v, /Bit/, `${key}: ${v}`);
  }
  for (const key of ['deck_cat_ai', 'deck_act_ai']) assert.ok(strings(i18n, key).every((v) => v === 'Bit'), key);
});

test('inside the Game Companion card Bit waits, looks at the screen, answers and worries', async () => {
  const { ctx, flip } = bootApp({ classes: ['game-mode'] });
  const els = {};
  const el = (id) => (els[id] ||= Object.assign(new FakeEl('div'), { id, dataset: {}, classList: { add() {}, remove() {} }, innerHTML: '' }));
  Object.assign(ctx.document, { getElementById: el, addEventListener: () => {} });
  ctx.requestAnimationFrame = () => {};
  ctx.setInterval = () => 1;
  ctx.clearInterval = () => {};
  ctx.t = (k) => k;
  ctx.aiFeatureEnabled = () => true;
  ctx.hubSettings = {};
  let keyReady = true;
  ctx._aiHasKey = () => keyReady;
  let reply = { ok: true, json: async () => ({ text: 'Prendi la torre a nord.' }) };
  ctx.fetch = async (url) => (url === '/network' ? { json: async () => ({}) } : reply);
  vm.runInContext(read('../js/game-companion.js'), ctx, { filename: 'game-companion.js' });
  const head = () => ctx.BitApp.playerFor(els['gc-bit']);
  const pose = (clipId, tint) => ctx.BitApp.still(clipId, 18, tint);

  ctx.GameCompanion.openOverlay();
  assert.equal(els['gc-insight'].textContent, 'gc_waiting');
  assert.equal(head().mood, 'idle');
  assert.equal(els['gc-reply-bit'].innerHTML, pose('idle'));
  // the card is in front while open: game mode does not stop this Bit, the low-GPU choices do
  const holds = [];
  const real = head().hold.bind(head());
  head().hold = (h) => { holds.push(h); real(h); };
  flip('game-mode', false); flip('game-mode', true);
  assert.equal(holds.at(-1), false, 'game-mode');
  flip('perf-mode', true); assert.equal(holds.at(-1), true, 'perf-mode'); flip('perf-mode', false);

  const played = [];
  const realPlay = head().play.bind(head());
  head().play = (id) => { played.push(id); return realPlay(id); };
  const looking = ctx.GameCompanion.analyze();
  assert.equal(head().mood, 'think');
  assert.equal(els['gc-reply-bit'].innerHTML, pose('think', 'think'));
  await looking;
  assert.equal(els['gc-insight'].textContent, 'Prendi la torre a nord.');
  assert.equal(head().mood, 'idle', 'a nod, then back to waiting');
  assert.deepEqual(played, ['nod']);
  assert.equal(els['gc-reply-bit'].innerHTML, pose('happy', 'done'));

  reply = { ok: false, json: async () => ({ error: 'x' }) };
  await ctx.GameCompanion.analyze();
  assert.equal(els['gc-insight'].textContent, 'gc_error');
  assert.equal(head().mood, 'worry');
  assert.equal(els['gc-reply-bit'].innerHTML, pose('worry'));

  // an AI that cannot see, or no Sparks left: said in words, Bit worried
  reply = { ok: false, json: async () => ({ error: 'no_vision' }) };
  await ctx.GameCompanion.analyze();
  assert.equal(els['gc-insight'].textContent, 'gc_no_vision');
  reply = { ok: false, json: async () => ({ error: 'no_credits' }) };
  await ctx.GameCompanion.analyze();
  assert.equal(els['gc-insight'].textContent, 'gc_no_sparks');
  assert.equal(head().mood, 'worry');

  // no AI ready after a good answer: from happy back to worried
  reply = { ok: true, json: async () => ({ text: 'ok' }) };
  await ctx.GameCompanion.analyze();
  assert.equal(head().mood, 'idle');
  keyReady = false;
  await ctx.GameCompanion.analyze();
  assert.equal(els['gc-insight'].textContent, 'gc_need_key');
  assert.equal(head().mood, 'worry');
  assert.equal(els['gc-reply-bit'].innerHTML, pose('worry'));
  // reopened, the card shows the Bit of the answer it still holds
  ctx.GameCompanion.closeOverlay();
  els['gc-reply-bit'].innerHTML = '';
  ctx.GameCompanion.openOverlay();
  assert.equal(els['gc-reply-bit'].innerHTML, pose('worry'));
  assert.equal(els['gc-bit'].children.length, 1, 'one Bit in the head, mounted once');
});

test('the Game Companion card is Bit: a name, the game, the answer beside Bit', () => {
  const html = read('../index.html');
  const card = html.slice(html.indexOf('id="gc-overlay"'), html.indexOf('id="gc-analyze"'));
  assert.match(card, /id="gc-bit"/);
  assert.match(card, /class="gc-name">Bit</);
  assert.match(card, /id="gc-reply-bit"/);
  assert.doesNotMatch(card, /🎮|style="/);
  // the card itself: theme colours, no glow or pulse (the pill keeps its own look)
  const css = read('../components/GameCompanion/GameCompanion.css');
  assert.doesNotMatch(css.slice(css.indexOf('.gc-card {')), /gradient|@keyframes|animation/);
  const i18n = read('../js/i18n.js');
  for (const key of ['gc_ask_placeholder']) {
    const all = strings(i18n, key);
    assert.equal(all.length, 11, key);
    for (const v of all) assert.match(v, /Bit/, `${key}: ${v}`);
  }
});

test('Annulla is underlined text that works from any chat copy and says when it fails', () => {
  const ai = read('../js/ai.js');
  const chip = ai.slice(ai.indexOf('function _aiAppendUndoChip'), ai.indexOf('async function _aiUndo'));
  assert.match(chip, /btn\.textContent = t\('ai_undo'\);/, 'just the word, no arrow and no Scintille');
  assert.match(chip, /ai-choices/, 'it sits above the follow-ups');
  const undo = ai.slice(ai.indexOf('async function _aiUndo'), ai.indexOf('function _aiRenderWelcomeIfEmpty'));
  assert.match(undo, /_aiNotice\(t\('ai_undo_failed'\)\)/, 'a failure is said, not swallowed');
  assert.match(undo, /document\.addEventListener\('click'/, 'delegated, so a mirrored copy works');
  const css = read('../components/AIPanel/AIPanel.css');
  assert.match(css, /\.ai-undo-btn[^{]*\{[^}]*text-decoration: underline/);
});

test('a failed reply keeps the question and offers to try again now', () => {
  const ai = read('../js/ai.js');
  assert.match(ai, /else if \(text && !hasAudio\) _aiAppendRetry\(text\);/);
  const retry = ai.slice(ai.indexOf('function _aiRetry('), ai.indexOf('function _aiClearChoices'));
  assert.match(retry, /aiConversationHistory\.pop\(\)/, 'the question is not sent twice');
  assert.match(retry, /!aiTurnRunning\(\)/, 'no second turn while one runs');
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const k of ['ai_undo', 'ai_undo_done', 'ai_undo_failed', 'ai_retry_now']) assert.equal(typeof i18n[l][k], 'string', `${l}.${k} is missing`);
  }
});

test('with nothing to answer, the log and the composer really hide behind the card', () => {
  const css = read('../components/AIPanel/AIPanel.css');
  assert.match(css, /\.ai-chat\[hidden\],\s*\.ai-input-row\[hidden\] \{ display: none; \}/);
});
