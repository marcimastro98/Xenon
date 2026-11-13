// The Playback widget's progress line (js/media-progress.js) and its Liquid look
// (components/MediaPanel/LiquidPlayer.css): how far into the track, a tap or a drag
// to jump, one ticker that runs only while it is worth it, and a look that leaves
// every other style as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/media-progress.js');
const CSS = read('../components/MediaPanel/LiquidPlayer.css');
const INDEX = read('../index.html');

const TRACK = { active: true, title: 'Long Way Home', artist: 'The Quiet Hours', app: 'Spotify', playbackStatus: 'Playing', duration: 254 };

function rig({ media = TRACK, posMs = 64000, reply = { ok: true }, visiblePage = true } = {}) {
  const { document, mkEl } = makeDom();
  const root = mkEl('section');
  root.id = 'media-panel';
  const box = mkEl('div');
  box.dataset.mf = 'media-progress';
  box.hidden = true;
  const range = mkEl('input');
  range.dataset.mf = 'media-progress-range';
  const pos = mkEl('span');
  pos.dataset.mf = 'media-pos';
  const dur = mkEl('span');
  dur.dataset.mf = 'media-dur';
  const times = mkEl('div');
  times.append(pos, dur);
  box.append(range, times);
  root.appendChild(box);
  document.body.appendChild(root);

  const timers = new Map();
  let nextTimer = 1;
  const calls = { posts: [], noted: [], toasts: [] };
  const ctx = {
    console, document,
    mediaData: { ...media },
    posMs,
    reply,
    visiblePage,
    hasActiveMedia: () => !!(ctx.mediaData && ctx.mediaData.active && (ctx.mediaData.title || ctx.mediaData.artist || ctx.mediaData.app)),
    currentMediaPositionMs: () => ctx.posMs,
    eachMedia: (fn) => fn(root),
    noteMediaSeek: (ms) => calls.noted.push(ms),
    onVisiblePage: () => ctx.visiblePage,
    SERVER: 'http://127.0.0.1:3030',
    fetchWithDeadline: async (url, ms, opts) => {
      calls.posts.push({ url, ms, body: JSON.parse(opts.body) });
      if (ctx.reply instanceof Error) throw ctx.reply;
      return { json: async () => ctx.reply };
    },
    showHubToast: (title, message) => calls.toasts.push([title, message]),
    t: (key) => key,
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (type) => (range._handlers[type] || []).forEach((fn) => fn({ target: range }));
  const tick = () => [...timers.values()].forEach((tm) => tm.fn());
  return { ctx, root, box, range, pos, dur, timers, calls, fire, tick, api: ctx.MediaProgress };
}

test('times read as a player shows them, hours only when there are some', () => {
  const { api } = rig();
  assert.equal(api.fmt(0), '0:00');
  assert.equal(api.fmt(65000), '1:05');
  assert.equal(api.fmt(254999), '4:14');
  assert.equal(api.fmt(3729000), '1:02:09');
  assert.equal(api.fmt(-5000), '0:00');
});

test('a playing track shows where it is: the line, the fill and both times', () => {
  const r = rig();
  r.api.sync();
  assert.equal(r.box.hidden, false);
  assert.equal(r.range.max, '254');
  assert.equal(r.range.value, '64');
  assert.equal(r.range.disabled, false);
  assert.equal(r.range.style.getPropertyValue('--mp-fill'), '25.20%');
  assert.equal(r.pos.textContent, '1:04');
  assert.equal(r.dur.textContent, '4:14');
});

test('a stream with no length and an idle player show no line and run no ticker', () => {
  const live = rig({ media: { ...TRACK, duration: 0 } });
  live.api.sync();
  assert.equal(live.box.hidden, true, 'a radio or a live stream has no timeline');
  assert.equal(live.timers.size, 0);

  const idle = rig({ media: { active: false } });
  idle.api.sync();
  assert.equal(idle.box.hidden, true);
  assert.equal(idle.timers.size, 0);
});

test('one ticker, once a second, only while the track plays and the line is on screen', () => {
  const r = rig();
  r.api.sync();
  r.api.sync();
  assert.equal(r.timers.size, 1, 'a second sync does not start a second ticker');
  assert.equal([...r.timers.values()][0].ms, 1000);

  r.ctx.posMs = 65000;
  r.tick();
  assert.equal(r.pos.textContent, '1:05', 'the tick repaints from the shared clock');

  r.ctx.mediaData = { ...TRACK, playbackStatus: 'Paused' };
  r.tick();
  assert.equal(r.timers.size, 0, 'paused: the ticker stops itself');

  r.ctx.mediaData = { ...TRACK };
  r.api.sync();
  assert.equal(r.timers.size, 1, 'playing again: it starts again');
  r.root.hidden = true;
  r.api.sync();
  assert.equal(r.timers.size, 0, 'a tile hidden by its tab or page does not tick');

  const parked = rig({ visiblePage: false });
  parked.api.sync();
  assert.equal(parked.timers.size, 0, 'a tile on a page that is not shown does not tick');
});

test('a drag shows the time under the finger and jumps on release', async () => {
  const r = rig();
  r.api.sync();
  r.range.value = '120';
  r.fire('input');
  assert.equal(r.pos.textContent, '2:00');
  r.ctx.posMs = 66000;
  r.api.sync();
  assert.equal(r.range.value, '120', 'the clock leaves the line alone while it is held');

  r.fire('change');
  await settle();
  assert.equal(r.calls.posts.length, 1);
  assert.equal(r.calls.posts[0].url, 'http://127.0.0.1:3030/actions/run');
  assert.deepEqual(r.calls.posts[0].body, { type: 'mediaSeek', position: 120 });
  assert.deepEqual(r.calls.noted, [120000], 'the shared clock moves to the new place');
  assert.equal(r.calls.toasts.length, 0);
});

test('a drag the browser turns into a scroll lets the clock paint the line again', () => {
  for (const end of ['pointercancel', 'blur']) {
    const r = rig();
    r.api.sync();
    r.range.value = '200';
    r.fire('input');
    r.fire(end);
    r.ctx.posMs = 70000;
    r.api.sync();
    assert.equal(r.range.value, '70', end);
    assert.equal(r.calls.posts.length, 0, `${end}: no jump`);
  }
});

test('a player that refuses to jump says so once and the line stops offering until the next track', async () => {
  const r = rig({ reply: { ok: false, error: 'not_seekable' } });
  r.api.sync();
  r.range.value = '30';
  r.fire('change');
  await settle();
  assert.deepEqual(r.calls.toasts, [['Spotify', 'lyrics_seek_failed']]);
  assert.equal(r.calls.noted.length, 0);
  assert.equal(r.range.disabled, true);
  assert.equal(r.box.hidden, false, 'it still shows where the track is');

  r.ctx.mediaData = { ...TRACK, title: 'Next Song' };
  r.api.sync();
  assert.equal(r.range.disabled, false, 'a new track may allow it');
});

test('any other failure is told and the line stays usable', async () => {
  for (const reply of [{ ok: false, error: 'unavailable' }, new Error('offline')]) {
    const r = rig({ reply });
    r.api.sync();
    r.range.value = '30';
    r.fire('change');
    await settle();
    assert.equal(r.calls.toasts.length, 1, String(reply.error || reply.message));
    assert.equal(r.range.disabled, false);
  }
});

test('the dashboard and the layer windows load the look after the mixer and the line after the clock', () => {
  const mixer = INDEX.indexOf('<link rel="stylesheet" href="components/AudioSection/LiquidMixer.css">');
  const player = INDEX.indexOf('<link rel="stylesheet" href="components/MediaPanel/LiquidPlayer.css">');
  assert.ok(mixer > 0 && player > mixer, 'linked once, after LiquidMixer.css');
  assert.ok(INDEX.indexOf('src="js/media.js"') < INDEX.indexOf('<script src="js/media-progress.js"></script>'));
  assert.match(INDEX, /<div class="media-progress" data-mf="media-progress" hidden>\n\s*<input class="media-progress-range" data-mf="media-progress-range" type="range" [^>]*data-i18n-aria-label="spotify_w_seek"/);
  const layers = read('../js/layer-tiles.js');
  assert.match(layers, /'components\/MediaPanel\/LiquidPlayer\.css'/);
  assert.match(layers, /'js\/media\.js', 'js\/media-spotify\.js', 'js\/media-progress\.js'/);
  const media = read('../js/media.js');
  assert.equal(media.split('if (window.MediaProgress) window.MediaProgress.sync();').length - 1, 3, 'a track, no track, and a play/pause tap');
});

test('every rule is for the Liquid look, and elsewhere the line is not drawn', () => {
  const selectors = CSS.split('\n').filter((l) => /^\s*[.:[]/.test(l) && /\{|,$/.test(l));
  assert.ok(selectors.length > 60);
  for (const line of selectors) {
    if (line === '.media-progress { display: none; }' || line === '.ph-note { display: none; }') continue;
    assert.match(line, /^\s*:root\[data-style="liquid"\]/, line);
  }
  assert.match(CSS, /^\.media-progress \{ display: none; \}$/m);
  const shown = CSS.indexOf('.media-progress:not([hidden]) { display: flex; }');
  const big = CSS.indexOf('@container mediatile (min-height: 400px) and (min-width: 300px) {');
  assert.ok(big > 0 && shown > big, 'drawn only on a tile with room for it');
});

test('no white handle on any bar of the widget: the fill alone shows the level', () => {
  for (const bar of [':is(.media-progress-range, .msp-range)', '.media-vol-slider']) {
    for (const thumb of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
      const at = CSS.indexOf(`${bar}${thumb} {`);
      assert.ok(at > 0, bar + thumb);
      const rule = CSS.slice(at, CSS.indexOf('}', at));
      assert.match(rule, /background: transparent;/, bar + thumb);
      assert.match(rule, /box-shadow: none;/, bar + thumb);
    }
  }
});

test('no cover is a plain well with a note, not the green equaliser of the other looks', () => {
  assert.match(INDEX, /<div class="ph-eq">[^\n]*\n\s*<svg class="ph-note" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">/);
  assert.match(CSS, /^\.ph-note \{ display: none; \}$/m, 'the other looks keep their placeholder');
  assert.match(CSS, /\.media-art:not\(\.has-image\) \{\n  background: var\(--lg-key\);\n  box-shadow: none;\n\}/);
  assert.match(CSS, /\.media-placeholder::before \{ content: none; \}/, 'no glow');
  assert.match(CSS, /:is\(\.ph-eq, \.ph-label\) \{ display: none; \}/, 'no bars, no capitals under the note');
  assert.match(CSS, /\.ph-note \{\n  display: block;[^}]*color: var\(--muted-text\);/);
});

test('the volume is drawn as the mixer\'s fader, from tokens both stylesheets read', () => {
  const tiles = read('../styles/liquid-tiles.css');
  for (const token of ['--mix-track', '--mix-fill', '--mix-edge']) {
    assert.equal(tiles.split(`${token}:`).length - 1, 2, `${token} in the dark and light Liquid blocks`);
  }
  assert.doesNotMatch(read('../components/AudioSection/LiquidMixer.css'), /--mix-track:/, 'defined once');
  assert.match(CSS, /--slider-track: var\(--mix-track\);/);
  assert.match(CSS, /--slider-fill: var\(--mix-fill\);/);
});

test('Spotify\'s lists open on the sheet look, so light Liquid reads dark text on a light sheet', () => {
  assert.match(CSS, /\.msp-sheet \{[^}]*background: var\(--sheet-fill\);/);
  assert.match(CSS, /\.msp-item \{[^}]*background: var\(--sheet-well\);/);
  assert.match(CSS, /\.msp-item-dot \{ display: none; \}/);
});

// The wide tile (tools/island-tabs-check measures it on the demo): the cover starts
// right under the tabs instead of being centred in what the tile has left over.
test('a wide tile starts the cover under the tabs and leaves the waveform its strip', () => {
  const wide = CSS.slice(CSS.indexOf('@container mediatile (orientation: landscape) and (min-width: 560px)'));
  assert.match(wide, /\.media-pane-play:not\(\[hidden\]\) \{[^}]*align-content: start;/);
  assert.match(wide, /\.media-panel:not\(\.lyrics-open\) \.media-art \{ width: min\(100cqh, 100cqw - 300px, 560px\); max-width: none; \}/);
  assert.match(wide, /\.media-panel:not\(\.lyrics-open\):has\(> \.media-viz\) \.media-art \{ width: min\(100cqh - 60px, 100cqw - 300px, 560px\); \}/);
});
