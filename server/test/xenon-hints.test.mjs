// The few hints Xenon gives once each (js/xenon-hints.js) and the list of the ones a
// PC has shown (hints/routes.js): shown once across every surface, never on a paired
// phone, never over a game, brought back from Settings, About.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync as readRaw, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';
import { appStringsSource } from './i18n-source.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const hints = require('../hints/routes.js');
const { remotePathAllowed } = require('../paired/remote-access.js');
const featureRoutes = require('../feature-routes.js');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

// ── The server's list ─────────────────────────────────────────────────────
async function call(key, body, dataDir) {
  const out = [];
  const ctx = { json: (v) => out.push(v), readBody: async () => body, dataDir };
  await hints.routes[key]({}, {}, ctx);
  return out[0];
}

test('the server keeps the shown hints, each once, known ids only, and forgets them on reset', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-hints-'));
  try {
    hints.stop();
    assert.deepEqual(await call('GET /hints', '', dir), { ok: true, seen: [] });
    assert.deepEqual(await call('POST /hints/seen', '{"id":"phone"}', dir), { ok: true, seen: ['phone'] });
    assert.deepEqual(await call('POST /hints/seen', '{"id":"game"}', dir), { ok: true, seen: ['game', 'phone'] });
    assert.deepEqual(await call('POST /hints/seen', '{"id":"game"}', dir), { ok: true, seen: ['game', 'phone'] });
    for (const bad of ['{"id":"tour"}', '{}', 'not json', '{"id":["game"]}']) {
      assert.deepEqual(await call('POST /hints/seen', bad, dir), { ok: false, error: 'bad_request' }, bad);
    }
    assert.deepEqual(JSON.parse(readRaw(path.join(dir, 'hints-seen.json'), 'utf8')), { seen: ['game', 'phone'] });
    hints.stop();   // a restart reads the file again
    assert.deepEqual((await call('GET /hints', '', dir)).seen, ['game', 'phone']);
    assert.deepEqual(await call('POST /hints/reset', '', dir), { ok: true, seen: [] });
    hints.stop();
    assert.deepEqual((await call('GET /hints', '', dir)).seen, []);
    // A hand-edited or broken file: unknown ids dropped, unreadable means nothing shown yet.
    writeFileSync(path.join(dir, 'hints-seen.json'), '{"seen":["dashboard","x","dashboard"]}');
    hints.stop();
    assert.deepEqual((await call('GET /hints', '', dir)).seen, ['dashboard']);
    writeFileSync(path.join(dir, 'hints-seen.json'), '{');
    hints.stop();
    assert.deepEqual((await call('GET /hints', '', dir)).seen, []);
  } finally {
    hints.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hints are closed to paired devices, the POSTs are CSRF-guarded, the routes are listed', () => {
  const server = engineSource();
  const start = server.indexOf('const CSRF_MUTATION_PATHS');
  const csrf = server.slice(start, server.indexOf(']);', start));
  for (const [p, method] of [['/hints', 'GET'], ['/hints/seen', 'POST'], ['/hints/reset', 'POST']]) {
    assert.equal(remotePathAllowed(p, method), false, p);
  }
  for (const p of ['/hints/seen', '/hints/reset']) assert.ok(csrf.includes(`'${p}'`), p);
  for (const k of ['GET /hints', 'POST /hints/seen', 'POST /hints/reset']) assert.ok(featureRoutes.keys().includes(k), k);
  assert.match(server, /featureRoutes\.run\(req\.method, reqPath, req, res, \{ json, err500, dataDir: DATA_DIR,/);
});

// ── The page ──────────────────────────────────────────────────────────────
function page({ seen = [], menuKey = 'Alt+Shift+X', remote = false, native = true, about = false, hintsDown = false } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;
  if (about) {
    const row = mkEl('div');
    row.className = 'settings-row settings-hints-group';
    row.appendChild(mkEl('button'));
    document.body.appendChild(row);
  }
  const overlay = mkEl('div');
  overlay.id = 'settings-overlay';
  document.body.appendChild(overlay);
  const posts = [];
  const toasts = [];
  const opened = [];
  const timers = [];
  const answer = (v) => ({ ok: true, json: async () => v });
  const fetch = async (url, opts = {}) => {
    const p = url.replace('http://pc', '');
    if (opts.method === 'POST') { posts.push([p, JSON.parse(opts.body)]); return answer({ ok: true }); }
    if (p === '/hints') { if (hintsDown) throw new Error('down'); return answer({ ok: true, seen: [...seen] }); }
    if (p === '/xenon-menu') return answer({ menuKey });
    throw new Error('unexpected ' + p);
  };
  const window = {
    __xenonRemote: remote,
    __XENON_NATIVE__: native,
    XenonToast: { show: (o) => { toasts.push(o); return toasts.length; } },
    UsageMode: { widgetsOnly: (m) => m === 'widgets' },
  };
  const ctx = {
    window, document, fetch, console, MutationObserver: dom.MutationObserver,
    SERVER: 'http://pc', hubSettings: { usageMode: 'dashboard' },
    t: (k) => 'T:' + k, openSettings: (s) => opened.push(s),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  vm.runInNewContext(src('js/xenon-hints.js'), ctx);
  const notifyBody = () => (dom.observersFor.get(document.body) || []).forEach((cb) => cb());
  return { api: window.XenonHints, document, ctx, posts, toasts, opened, timers, notifyBody };
}

test('a hint shows once: the server marks it, a second call and a failed show do nothing', async () => {
  const p = page();
  let shows = 0;
  assert.equal(await p.api.once('phone', () => { shows++; }), true);
  assert.equal(await p.api.once('phone', () => { shows++; }), false);
  assert.equal(shows, 1);
  assert.deepEqual(p.posts, [['/hints/seen', { id: 'phone' }]]);
  // Do-not-disturb or no key: not marked, so it can come another time.
  assert.equal(await p.api.once('game', () => false), false);
  assert.equal(await p.api.once('game', () => { shows++; }), true);
  assert.equal(shows, 2);
});

test('nothing shows when the server cannot say what was shown, nor on a paired phone', async () => {
  for (const opts of [{ hintsDown: true }, { remote: true }, { seen: ['dashboard'] }]) {
    const p = page(opts);
    let shows = 0;
    assert.equal(await p.api.once('dashboard', () => { shows++; }), false, JSON.stringify(opts));
    assert.equal(shows, 0);
    assert.deepEqual(p.posts, []);
  }
});

test('the dashboard tells the key once the first game ends, never during it', async () => {
  const p = page();
  await settle();
  p.document.body.classList.add('game-running');
  p.notifyBody();
  await settle();
  assert.equal(p.toasts.length, 0, 'nothing over the game');
  p.document.body.classList.remove('game-running');
  p.notifyBody();
  await settle(16);
  assert.equal(p.toasts.length, 1);
  assert.equal(p.toasts[0].title, 'T:hint_game_title');
  assert.equal(p.toasts[0].message, 'T:hint_game_text'.replace('{key}', 'Alt+Shift+X'));
  assert.deepEqual(p.posts, [['/hints/seen', { id: 'game' }]]);
  p.toasts[0].actions[0].onClick();
  assert.deepEqual(p.opened, ['keys'], 'opens Xenon on its keys');
  p.document.body.classList.add('game-running');
  p.notifyBody();
  p.document.body.classList.remove('game-running');
  p.notifyBody();
  await settle(16);
  assert.equal(p.toasts.length, 1, 'once');
});

test('no game hint without the key, in a plain browser, or where the dashboard is not in use', async () => {
  const cases = [{ menuKey: '' }, { native: false }];
  for (const opts of cases) {
    const p = page(opts);
    await settle();
    p.document.body.classList.add('game-running');
    p.notifyBody();
    p.document.body.classList.remove('game-running');
    p.notifyBody();
    await settle(16);
    assert.equal(p.toasts.length, 0, JSON.stringify(opts));
  }
  const p = page();
  p.ctx.hubSettings.usageMode = 'widgets';
  await settle();
  p.document.body.classList.add('game-running');
  p.notifyBody();
  p.document.body.classList.remove('game-running');
  p.notifyBody();
  await settle(16);
  assert.equal(p.toasts.length, 0, 'widgets only: the alerts window tells it');
});

test('the first paired device adds that it is one of the screens, with a button to them', async () => {
  const p = page();
  await p.api.paired({ name: 'Pixel test' });
  await p.api.paired({ name: 'Tab test' });
  assert.equal(p.toasts.length, 2);
  assert.equal(p.toasts[0].message, 'Pixel test. T:hint_phone_line T:ra_paired_toast_hint');
  assert.equal(p.toasts[1].message, 'Tab test. T:ra_paired_toast_hint');
  assert.equal(p.toasts[1].actions.length, 0);
  p.toasts[0].actions[0].onClick();
  assert.deepEqual(p.opened, ['screens']);
  const phone = page({ remote: true });
  await phone.api.paired({ name: 'x' });
  assert.equal(phone.toasts.length, 0, 'a phone is not told about itself');
});

test('in "widgets only" the alerts window tells where the dashboard went, later, and the key after a game', async () => {
  const p = page();
  const state = { widgetsOnly: true, gaming: false };
  p.api.screen({ first: true, gameEnded: false, state: () => state });
  p.api.screen({ first: true, gameEnded: false, state: () => state });
  assert.equal(p.timers.length, 1, 'one wait per window');
  assert.equal(p.timers[0].ms, p.api.DASHBOARD_AFTER_MS);
  p.timers[0].fn();
  await settle(16);
  assert.equal(p.toasts[0].title, 'T:hint_dash_title');
  assert.equal(p.toasts[0].message, 'T:xmenu_sec_screens › T:xmenu_scr_shows › T:xmenu_scr_dashboard');
  p.toasts[0].actions[0].onClick();
  await settle();
  assert.deepEqual(p.posts.at(-1), ['/screen-menu', { open: true, section: 'screens' }]);
  p.api.screen({ first: false, gameEnded: true, state: () => state });
  await settle(16);
  assert.equal(p.toasts[1].title, 'T:hint_game_title');
  p.toasts[1].actions[0].onClick();
  await settle();
  assert.deepEqual(p.posts.at(-1), ['/screen-menu', { open: true, section: 'keys' }]);
  // A game running when the wait ends, or a dashboard after all: it waits for another start.
  const q = page();
  const later = { widgetsOnly: true, gaming: true };
  q.api.screen({ first: true, gameEnded: false, state: () => later });
  q.timers[0].fn();
  await settle(16);
  assert.equal(q.toasts.length, 0);
  q.api.screen({ first: true, gameEnded: true, state: () => ({ widgetsOnly: false, gaming: false }) });
  await settle(16);
  assert.equal(q.toasts.length, 0, 'with a dashboard the dashboard tells it');
});

test('Settings, About brings the hints back, and is hidden on a paired phone', async () => {
  const p = page({ about: true });
  p.document.querySelector('.settings-hints-group button').click();
  await settle();
  assert.deepEqual(p.posts, [['/hints/reset', {}]]);
  assert.equal(p.toasts[0].type, 'success');
  const phone = page({ about: true, remote: true });
  assert.equal(phone.document.querySelector('.settings-hints-group').hidden, true);
});

test('every surface is wired: dashboard, alerts window, the paired toast, About', () => {
  const index = src('index.html');
  assert.ok(index.indexOf('src="js/xenon-hints.js"') > index.indexOf('src="js/usage-ask/usage-ask.js"'));
  assert.match(index, /class="settings-row settings-hints-group"[\s\S]{0,200}data-i18n="hints_again_title"[\s\S]{0,200}data-i18n="hints_again_btn"/);
  const alerts = src('screen-alerts.html');
  assert.ok(alerts.indexOf('src="js/xenon-hints.js"') < alerts.indexOf('src="js/alerts/screen-alerts.js"'));
  assert.match(src('js/grid/data-stream.js'), /es\.addEventListener\('remote_paired', e => \{\n\s+try \{ window\.XenonHints\?\.paired\(JSON\.parse\(e\.data\) \|\| \{\}\); \} catch \{\}/);
  assert.match(src('js/alerts/screen-alerts.js'), /window\.XenonHints\?\.screen\(\{ first, gameEnded: wasGaming && !gaming, state: \(\) => \(\{ widgetsOnly: routine\(\), gaming \}\) \}\);/);
});

test('every hint in all 11 languages, with its place for the key', () => {
  const i18n = appStringsSource();
  const ctx = {};
  vm.runInNewContext(i18n.slice(0, i18n.search(/^function /m)) + '\nthis.i18n = i18n;', ctx);
  const keys = ['hint_game_title', 'hint_game_text', 'hint_phone_line', 'hint_dash_title',
    'hints_again_title', 'hints_again_btn', 'hints_again_done', 'hints_again_failed'];
  for (const lang of LANGS) {
    const words = ctx.i18n[lang];
    for (const k of keys) {
      assert.ok(words[k], lang + ' ' + k);
      if (lang !== 'en') assert.notEqual(words[k], ctx.i18n.en[k], lang + ' ' + k);
      assert.doesNotMatch(words[k], /—/, lang + ' ' + k);
    }
    assert.ok(words.hint_game_text.includes('{key}'), lang);
    assert.equal(words.hint_dash_text, undefined, lang);
    for (const k of ['xmenu_sec_screens', 'xmenu_scr_shows', 'xmenu_scr_dashboard', 'tip_settings']) assert.ok(words[k], lang + ' ' + k);
  }
});
