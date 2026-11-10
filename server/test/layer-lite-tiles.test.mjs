// js/layer-lite-tiles.js: the built-in tiles the light layer page carries keep
// the user's card choices, the language and the live data, the way the
// dashboard keeps them, and do nothing when their code was not served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeDom } from './mini-dom.mjs';

const LayerTiles = createRequire(import.meta.url)('../js/layer-tiles.js');

const SRC = readFileSync(new URL('../js/layer-lite-tiles.js', import.meta.url), 'utf8');

function systemTile(document) {
  const tile = document.createElement('aside');
  tile.setAttribute('data-dashboard-widget', 'system');
  for (const name of ['main', 'volume', 'mic', 'history']) {
    const tab = document.createElement('button');
    tab.className = 'sys-tab';
    tab.setAttribute('data-systab', name);
    tile.appendChild(tab);
  }
  const pane = document.createElement('div');
  pane.id = 'sys-grid-mic';
  tile.appendChild(pane);
  for (const [group, ids] of [['main', ['cpu', 'gpu', 'ram', 'disk']], ['net', ['ping', 'fps', 'latency', 'bandwidth']]]) {
    for (const id of ids) {
      const card = document.createElement('div');
      card.setAttribute('data-system-card', id);
      card.setAttribute('data-system-card-group', group);
      tile.appendChild(card);
    }
  }
  document.body.appendChild(tile);
  return tile;
}

// `system`: whether system.js and network.js were served with the page.
function boot({ system = true, media = false, lastData = null } = {}) {
  const { document } = makeDom();
  const calls = { applied: [], tabs: [], translated: 0, weather: 0, mic: [], audio: [] };
  const ctx = { document, JSON, Object, LayerTiles, window: {} };
  if (system) {
    Object.assign(ctx, {
      lastSystemData: lastData,
      applySystem: (d) => calls.applied.push(d),
      setSystemTab: (tab, opts) => calls.tabs.push([tab, opts]),
      translateStatic: () => { calls.translated++; },
      renderWeatherTile: () => { calls.weather++; },
      applyUI: (m) => calls.mic.push(m),
      applyAudio: (d) => calls.audio.push(d),
      syncSystemTabBar() {},
    });
  }
  // `media`: whether media.js was served too (it reads the track and draws it).
  if (media) {
    Object.assign(calls, { media: [], fetched: 0, sources: 0, viz: [] });
    Object.assign(ctx, {
      audioData: null,
      mediaData: null,
      translateStatic: ctx.translateStatic || (() => { calls.translated++; }),
      applyMedia: (d) => calls.media.push(d),
      fetchMedia: () => { calls.fetched++; },
      updateMediaSource: () => { calls.sources++; },
    });
    ctx.window.MediaViz = { setPlaying: (p) => calls.viz.push(['playing', p]), onLevels: (d) => calls.viz.push(['levels', d]) };
  }
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;globalThis.__tiles = LayerLiteTiles;', ctx);
  return { ctx, document, calls, tiles: ctx.__tiles };
}

const tab = (tile, name) => tile.children.find((c) => c.getAttribute('data-systab') === name);
const card = (tile, id, group = 'main') => tile.children.find((c) => c.getAttribute('data-system-card') === id && c.getAttribute('data-system-card-group') === group);

test("the System tile wears the user's card order, size and visibility; bad values fall back", () => {
  const b = boot();
  const tile = systemTile(b.document);
  b.tiles.refresh({ dashboardLayout: { cards: { main: {
    cpu: { order: 3, size: 'wide' },
    gpu: { visible: false },
    ram: { order: 99, size: 'huge' },
    disk: 'nonsense',
  } } } }, false);
  assert.equal(card(tile, 'cpu').dataset.systemCardOrder, '3');
  assert.equal(card(tile, 'cpu').dataset.systemCardSize, 'wide');
  assert.equal(card(tile, 'gpu').dataset.systemCardHidden, 'true');
  assert.equal(card(tile, 'ram').dataset.systemCardOrder, '2', 'out of range: its place in the list');
  assert.equal(card(tile, 'ram').dataset.systemCardSize, 'normal');
  assert.equal(card(tile, 'disk').dataset.systemCardHidden, 'false');
  assert.equal(card(tile, 'ping', 'net').dataset.systemCardOrder, '0', 'no settings: the defaults');
});

test('it opens the tab last chosen on the dashboard, translates on a language change, and redraws the last data', () => {
  const b = boot({ lastData: { cpu: 7 } });
  systemTile(b.document);
  b.tiles.refresh({}, false);
  b.tiles.refresh({}, false);
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.tabs)), [['main', { silent: true }]], 'the tab (and its poll) starts once');
  assert.equal(b.calls.translated, 1);
  b.tiles.refresh({}, true);
  assert.equal(b.calls.translated, 2, 'a new language is applied to the static labels');
  assert.equal(b.calls.applied.length, 3, 'units and language reach the numbers');
  assert.equal(b.calls.weather, 3);
});

test('Volume and Microphone are tabs unless their own tiles are on this page', () => {
  const b = boot();
  const tile = systemTile(b.document);
  const audioPane = b.document.createElement('div');
  audioPane.id = 'sys-grid-audio';
  const slider = b.document.createElement('input');
  audioPane.appendChild(slider);
  tile.appendChild(audioPane);
  const own = (id) => {
    const el = b.document.createElement('section');
    el.setAttribute('data-dashboard-widget', id);
    b.document.body.appendChild(el);
    return el;
  };
  const mic = own('mic');
  const btn = b.document.createElement('button');
  btn.className = 'mic-btn';
  mic.appendChild(btn);
  const audio = own('audio');
  const layout = (active) => ({ dashboardLayout: { tabs: { active } } });
  b.tiles.refresh(layout('volume'), false);
  assert.equal(btn.parentNode.id, 'sys-grid-mic', "the Microphone tile's content moves into its tab");
  assert.equal(slider.parentNode, audioPane);
  assert.equal(tab(tile, 'volume').hidden, false);
  assert.equal(tab(tile, 'mic').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.tabs)), [['volume', { silent: true }]]);
  // Placed on this page (LayerHost put them in slots): each takes its tab's content.
  for (const el of [mic, audio]) {
    const slot = b.document.createElement('div');
    slot.className = 'layer-slot';
    b.document.body.appendChild(slot);
    slot.appendChild(el);
  }
  b.tiles.refresh(layout('volume'), false);
  assert.equal(btn.parentNode, mic);
  assert.equal(slider.parentNode, audio);
  assert.equal(tab(tile, 'volume').hidden, true);
  assert.equal(tab(tile, 'mic').hidden, true);
  assert.deepEqual(b.calls.tabs.at(-1)[0], 'main', 'a tab that left the tile falls back to Sistema');
  // Taken off the page: the content goes back into the tabs.
  b.document.body.appendChild(mic);
  b.document.body.appendChild(audio);
  b.tiles.refresh(layout('main'), false);
  assert.equal(btn.parentNode.id, 'sys-grid-mic');
  assert.equal(slider.parentNode, audioPane);
  assert.equal(tab(tile, 'mic').hidden, false);
  assert.equal(b.calls.tabs.length, 2, 'the same choice again does not move a tab picked here');
  b.tiles.refresh(layout('bogus'), false);
  assert.equal(b.calls.tabs.length, 2, 'an unknown tab reads as Sistema');
});

test('the History tab follows the AI Guardian switch the way the dashboard reads it', () => {
  const b = boot();
  systemTile(b.document);
  b.tiles.refresh({ aiFeatures: { enabled: true, guardian: true } }, false);
  assert.equal(b.ctx.window.aiFeatureEnabled('guardian'), true);
  b.tiles.refresh({ aiFeatures: { enabled: false, guardian: true } }, false);
  assert.equal(b.ctx.window.aiFeatureEnabled('guardian'), false);
});

test('the live system, mute and audio streams reach the tile; a bad event never stops it', () => {
  const b = boot();
  const on = {};
  b.tiles.listen({ addEventListener: (name, fn) => { on[name] = fn; } });
  on.system({ data: '{"cpu":12}' });
  on.system({ data: '{broken' });
  on.system({ data: '{"cpu":13}' });
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.applied)), [{ cpu: 12 }, { cpu: 13 }]);
  on.status({ data: '{"muted":true}' });
  on.status({ data: '{"gaming":true}' });
  assert.deepEqual(b.calls.mic, [true], 'a payload without the mute state leaves the button alone');
  on.audio({ data: '{"speaker":{"volume":40}}' });
  assert.equal(b.calls.audio[0].speaker.volume, 40);
});

test("a page served without the tiles' code does nothing", () => {
  const b = boot({ system: false });
  systemTile(b.document);
  b.tiles.refresh({}, true);
  let listened = false;
  b.tiles.listen({ addEventListener: () => { listened = true; } });
  assert.equal(listened, false);
  assert.equal(typeof b.ctx.window.DashboardGrid.forEachInstance, 'function', 'system.js finds its tiles through the shim');
  const seen = [];
  b.ctx.window.DashboardGrid.forEachInstance('system', (el) => seen.push(el));
  assert.equal(seen.length, 1);
});

test('the shim never replaces the real dashboard grid', () => {
  const { document } = makeDom();
  const real = { forEachInstance() {} };
  const ctx = { document, JSON, Object, window: { DashboardGrid: real } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  assert.equal(ctx.window.DashboardGrid, real);
});

function mediaTile(document) {
  const tile = document.createElement('section');
  tile.setAttribute('data-dashboard-widget', 'media');
  document.body.appendChild(tile);
  return tile;
}

test('the Media tile asks for the track once and redraws it in a new language', () => {
  const b = boot({ system: false, media: true });
  mediaTile(b.document);
  b.tiles.refresh({}, false);
  b.tiles.refresh({}, false);
  assert.equal(b.calls.fetched, 1, 'one first read; the stream does the rest');
  assert.equal(b.calls.translated, 1);
  b.ctx.mediaData = { title: 'x' };
  b.tiles.refresh({}, true);
  assert.equal(b.calls.translated, 2);
  assert.deepEqual(b.calls.media.at(-1), { title: 'x' }, 'the labels of the playing track follow the language');
  assert.equal(b.calls.fetched, 1);
});

test('the Media tile takes the track, the waveform and the app volume from the stream', () => {
  const b = boot({ system: false, media: true });
  const on = {};
  b.tiles.listen({ addEventListener: (name, fn) => { on[name] = fn; } });
  assert.equal(on.system, undefined, 'no System tile: no system stream');
  on.media({ data: '{"active":true,"playbackStatus":"Playing"}' });
  assert.equal(b.calls.media.length, 1);
  assert.deepEqual(b.calls.viz.at(-1), ['playing', true]);
  on.audiolevels({ data: '{"peaks":{"spotify.exe":0.4}}' });
  assert.equal(b.calls.viz.at(-1)[0], 'levels');
  // Without the System tile volume.js is not here: the sessions are kept for the volume.
  on.audio({ data: '{"speakerApps":[{"proc":"Spotify.exe"}]}' });
  assert.equal(b.ctx.audioData.speakerApps[0].proc, 'Spotify.exe');
  assert.equal(b.calls.sources, 1);
});

test('with the System tile too, volume.js keeps the audio sessions', () => {
  const b = boot({ system: true, media: true });
  const on = {};
  b.tiles.listen({ addEventListener: (name, fn) => { on[name] = fn; } });
  on.audio({ data: '{"speakerApps":[]}' });
  assert.equal(b.calls.audio.length, 1);
  assert.equal(b.calls.sources, 0, 'applyAudio updates the Media tile itself');
  assert.equal(typeof on.system, 'function');
  assert.equal(typeof on.media, 'function');
});

test('the Game performance tile is drawn on refresh and takes perf and system from the stream', () => {
  const b = boot({ system: false });
  const got = { render: 0, perf: [], system: [] };
  b.ctx.window.PerfWidget = {
    renderWidgets: () => { got.render++; },
    onPerf: (d) => got.perf.push(d),
    onSystem: (d) => got.system.push(d),
  };
  b.tiles.refresh({}, false);
  assert.equal(got.render, 1);
  const on = {};
  b.tiles.listen({ addEventListener: (name, fn) => { (on[name] ||= []).push(fn); } });
  on.perf.forEach((fn) => fn({ data: '{"active":true,"fps":90}' }));
  on.perf.forEach((fn) => fn({ data: '{nope' }));
  on.system.forEach((fn) => fn({ data: '{"gpu":50}' }));
  assert.deepEqual(JSON.parse(JSON.stringify(got.perf)), [{ active: true, fps: 90 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(got.system)), [{ gpu: 50 }]);
  assert.equal(on.system.length, 1, 'no System tile: system.js is not driven');
});

test('perf beside the System tile: both get every system tick', () => {
  const b = boot({ system: true });
  const seen = [];
  b.ctx.window.PerfWidget = { renderWidgets() {}, onPerf() {}, onSystem: (d) => seen.push(d) };
  const on = {};
  b.tiles.listen({ addEventListener: (name, fn) => { (on[name] ||= []).push(fn); } });
  on.system.forEach((fn) => fn({ data: '{"cpu":5}' }));
  assert.equal(seen.length, 1);
  assert.equal(b.calls.applied.length, 1);
});

// The Agenda's tabs as the light page drives them (js/layer-lite-tiles.js
// refreshAgenda): a tab whose own tile is on this page leaves the Agenda.
function bootAgenda() {
  const { document } = makeDom();
  const calls = { switched: [], loads: [], notes: 0, translated: 0, intervals: 0 };
  const agenda = document.createElement('section');
  agenda.setAttribute('data-dashboard-widget', 'agenda');
  const bar = document.createElement('div');
  bar.className = 'cal-task-toggle';
  agenda.appendChild(bar);
  const content = {};
  for (const id of ['calendar', 'tasks', 'timer', 'notes']) {
    const btn = document.createElement('button');
    btn.setAttribute('data-caltab', id);
    bar.appendChild(btn);
    const pane = document.createElement('div');
    pane.setAttribute('data-calpane', id);
    content[id] = document.createElement('div');
    pane.appendChild(content[id]);
    agenda.appendChild(pane);
    const own = document.createElement('section');
    own.setAttribute('data-dashboard-widget', id);
    document.body.appendChild(own);
  }
  document.body.appendChild(agenda);
  const load = (name) => () => calls.loads.push(name);
  const ctx = {
    document, JSON, Object, LayerTiles, window: {}, calendarMode: false,
    translateStatic: () => { calls.translated++; },
    renderCalendar: load('calendar'), loadCalendarEvents: load('events'), loadExternalEvents: load('feeds'),
    loadTasks: load('tasks'), loadNotes: load('notes'), loadTimers: load('timers'),
    renderNotes: () => { calls.notes++; },
    switchCalendarTaskView: (tab, opts) => calls.switched.push([tab, opts]),
    setInterval: () => { calls.intervals++; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;globalThis.__tiles = LayerLiteTiles;', ctx);
  const own = (id) => document.querySelectorAll('[data-dashboard-widget="' + id + '"]')[0];
  const place = (id) => {
    const slot = document.createElement('div');
    slot.className = 'layer-slot';
    document.body.appendChild(slot);
    slot.appendChild(own(id));
  };
  return { ctx, calls, agenda, bar, content, own, place, tiles: ctx.__tiles };
}

const calTab = (bar, id) => bar.children.find((c) => c.getAttribute('data-caltab') === id);
const layoutTab = (active) => ({ dashboardLayout: { calendarTabs: { active } } });

test('the Agenda loads its data once and opens on the tab chosen on the dashboard', () => {
  const b = bootAgenda();
  b.tiles.refresh(layoutTab('tasks'), false);
  b.tiles.refresh(layoutTab('tasks'), false);
  assert.deepEqual(b.calls.loads, ['calendar', 'events', 'feeds', 'tasks', 'notes', 'timers']);
  assert.equal(b.calls.intervals, 1, 'one feed refresh for the life of the page');
  assert.equal(b.ctx.calendarMode, true);
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.switched)), [['tasks', { persist: false }]], 'the tab moves only when it changes');
  assert.equal(b.calls.notes, 2, 'an empty notes list is drawn on every pass');
  assert.equal(b.calls.translated, 5, 'the Agenda and its four tiles, in the user language once');
  b.tiles.refresh(layoutTab('tasks'), true);
  assert.equal(b.calls.translated, 10, 'again on a new language');
});

// The day sheet is sliced by id onto the body (layer-tiles.js '#day-modal'):
// the Agenda's own pass misses it, so it stayed in index.html's Italian.
test('the day sheet the Agenda opens is translated with it', () => {
  const b = bootAgenda();
  const sheet = b.ctx.document.createElement('div');
  sheet.id = 'day-modal';
  b.ctx.document.body.appendChild(sheet);
  const seen = [];
  b.ctx.translateStatic = (node) => seen.push(node);
  b.tiles.refresh(layoutTab('calendar'), false);
  assert.ok(seen.includes(sheet), 'translated on the first pass');
  seen.length = 0;
  b.tiles.refresh(layoutTab('calendar'), true);
  assert.ok(seen.includes(sheet), 'and again on a new language');
});

test("an Agenda tab whose tile is on this page leaves the Agenda, and comes back when it goes", () => {
  const b = bootAgenda();
  b.place('calendar');
  b.place('timer');
  b.tiles.refresh(layoutTab('calendar'), false);
  assert.equal(b.content.calendar.parentNode, b.own('calendar'));
  assert.equal(b.content.timer.parentNode, b.own('timer'));
  assert.equal(calTab(b.bar, 'calendar').hidden, true);
  assert.equal(calTab(b.bar, 'tasks').hidden, false);
  assert.equal(b.calls.switched.at(-1)[0], 'tasks', 'a tab that left falls back to the first one still here');
  b.place('tasks');
  b.tiles.refresh(layoutTab('calendar'), false);
  assert.equal(b.bar.style.display, 'none', 'one tab left: no tab bar');
  assert.equal(b.calls.switched.at(-1)[0], 'notes');
  b.ctx.document.body.appendChild(b.own('calendar'));
  b.tiles.refresh(layoutTab('calendar'), false);
  assert.equal(b.content.calendar.parentNode.getAttribute('data-calpane'), 'calendar');
  assert.equal(calTab(b.bar, 'calendar').hidden, false);
  assert.equal(b.bar.style.display, '');
  assert.equal(b.calls.switched.at(-1)[0], 'calendar');
});

test('without the Agenda code nothing of it runs', () => {
  const b = boot({ system: false });
  b.tiles.refresh(layoutTab('tasks'), false);
  const added = [];
  b.tiles.listen({ addEventListener: (name) => added.push(name) });
  assert.equal(added.includes('timer_update'), false);
  assert.equal(added.includes('notes'), false);
});

test('the Agenda and the Deck take their events from the stream', () => {
  const b = bootAgenda();
  const got = [];
  Object.assign(b.ctx, {
    onTimerUpdate: (t) => got.push(['timers', t]),
    onTimerDone: (id, label) => got.push(['done', id, label]),
    onNotesServerPush: (d) => got.push(['notes', d.v]),
  });
  let deckEs = null;
  b.ctx.window.DeckFeed = { attach: (es) => { deckEs = es; } };
  const on = {};
  const es = { addEventListener: (name, fn) => { on[name] = fn; } };
  b.tiles.listen(es);
  assert.equal(deckEs, es, 'the Deck feed gets the same stream');
  on.timer_update({ data: '{"timers":[1]}' });
  on.timer_done({ data: '{"id":"a","label":"Tea"}' });
  on.notes({ data: '{"v":3}' });
  on.notes({ data: 'not json' });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [['timers', [1]], ['done', 'a', 'Tea'], ['notes', 3]]);
});
