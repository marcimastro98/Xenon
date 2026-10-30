// Performance Mode with no dashboard ("widgets only"): the hidden driver page
// runs js/performance.js (js/driver-perf.js), the on-screen alerts window shows
// the suggestion and the result (js/screen-alerts.js, js/alert-toasts.js), and
// the two talk through the server (perf-screen.js, SSE perf_screen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PerfSettings = require('../js/perf-settings.js');
const perfScreen = require('../perf-screen.js');
const DriverPerf = require('../js/driver-perf.js');
const AlertToasts = require('../js/alert-toasts.js');
const aiSurface = require('../ai-surface.js');
const { remotePathAllowed } = require('../remote-access.js');

// ── one copy of the settings rules ───────────────────────────────────────────

test('the Performance Mode rules live in perf-settings.js, loaded before settings.js', () => {
  const p = PerfSettings.normalizePerformance({});
  assert.equal(p.enabled, false);
  assert.equal(p.autoMode, 'suggest');
  assert.deepEqual(Object.keys(p.autoActivities), PerfSettings.PERF_ACTIVITIES);
  assert.equal(p.autoActivities.gaming, true);
  assert.equal(p.opts.powerPlan, 'high');
  const s = read('../js/settings.js');
  assert.match(s, /\n {2}performance: PERF_DEFAULTS,\n/);
  for (const name of ['function normalizePerformance', 'function normalizeActivityApps', 'function normalizePerfAppChoices', 'const PERF_ACTIVITIES']) {
    assert.ok(!s.includes(name), name + ' has one home');
  }
  const html = read('../index.html');
  assert.ok(html.indexOf('src="js/perf-settings.js"') > 0 && html.indexOf('src="js/perf-settings.js"') < html.indexOf('src="js/settings.js"'));
});

// ── the server boundary ──────────────────────────────────────────────────────

test('only known perf_screen events go out, rebuilt from their fields', () => {
  const ev = perfScreen.screenEvent;
  assert.deepEqual(ev({ kind: 'prompt', activity: 'gaming', extra: 1 }), { kind: 'prompt', activity: 'gaming' });
  assert.deepEqual(ev({ kind: 'prompt', activity: '' }), { kind: 'prompt', activity: '' });
  assert.equal(ev({ kind: 'prompt', activity: 'hacking' }), null);
  assert.equal(ev({ kind: 'prompt' }), null);
  assert.deepEqual(ev({ kind: 'toast', tone: 'weird', note: { key: 'perf_auto_on', activity: 'coding', freed: '1.5 GB', x: 2 } }),
    { kind: 'toast', tone: 'ok', note: { key: 'perf_auto_on', activity: 'coding', freed: '1.5 GB' } });
  assert.deepEqual(ev({ kind: 'toast', tone: 'error', note: { key: 'perf_status_failed', freed: '<img>' } }),
    { kind: 'toast', tone: 'error', note: { key: 'perf_status_failed', activity: '', freed: '' } });
  assert.equal(ev({ kind: 'toast', note: { key: 'settings_title' } }), null, 'any other string key is refused');
  for (const choice of perfScreen.CHOICES) assert.deepEqual(ev({ kind: 'answer', choice }), { kind: 'answer', choice });
  for (const junk of [null, 'x', [], {}, { kind: 'answer', choice: 'reboot' }, { kind: 'eval' }]) {
    assert.equal(ev(junk), null, JSON.stringify(junk));
  }
});

test('the driver saves the performance block only, normalized', () => {
  const p = perfScreen.stateFrom({ performance: { active: true, savedPowerPlan: 'not-a-guid', closedApps: [{ name: 'x', path: 'C:\\x.bat' }] }, language: 'it' });
  assert.equal(p.active, true);
  assert.equal(p.savedPowerPlan, '', 'a GUID or nothing');
  assert.deepEqual(p.closedApps, [], 'only .exe/.lnk come back');
  assert.ok(!('language' in p));
  for (const junk of [null, {}, { performance: 'x' }, { performance: [] }]) assert.equal(perfScreen.stateFrom(junk), null);
});

test('both routes: this PC only, CSRF-guarded, one narrow locked writer', () => {
  for (const path of ['/api/performance/screen', '/api/performance/state']) {
    assert.equal(remotePathAllowed(path, 'POST'), false, path + ' never from a phone');
  }
  const server = read('../server.js');
  const csrf = server.slice(server.indexOf('const CSRF_MUTATION_PATHS = new Set(['), server.indexOf(']);', server.indexOf('const CSRF_MUTATION_PATHS = new Set([')));
  assert.match(csrf, /'\/api\/performance\/screen',\n {2}'\/api\/performance\/state',/);
  assert.match(server, /reqPath === '\/api\/performance\/screen' && req\.method === 'POST'[\s\S]{0,500}perfScreen\.screenEvent\([\s\S]{0,200}broadcastSSE\('perf_screen', ev\)/);
  assert.match(server, /reqPath === '\/api\/performance\/state' && req\.method === 'POST'[\s\S]{0,400}perfScreen\.stateFrom\([\s\S]{0,300}updatePerformanceSetting\(perf\)/);
  assert.match(server, /async function updatePerformanceSetting\(performance\) \{\n {2}return withHubSettingsLock\(async \(\) => \{[\s\S]{0,200}writeHubSettings\(\{ \.\.\.cur, performance, rev: nextSettingsRev\(cur\.rev\) \}\)[\s\S]{0,120}broadcastSSE\('settings'/);
});

test('Bit on the screen optimizes through the driver instead of saying it needs the dashboard', () => {
  assert.equal(aiSurface.screenPerfChoice('optimize_performance', 'screen'), 'optimize');
  assert.equal(aiSurface.screenPerfChoice('restore_performance', 'screen'), 'restore');
  assert.equal(aiSurface.screenPerfChoice('optimize_performance', ''), '', 'the dashboard runs it itself');
  assert.equal(aiSurface.clientActionRefusal('optimize_performance', 'screen'), null);
  assert.equal(aiSurface.clientActionRefusal('change_theme', 'screen').error, 'needs_dashboard');
  const server = read('../server.js');
  assert.match(server, /const perfChoice = aiSurface\.screenPerfChoice\(fnName, surface\);\n {4}if \(perfChoice\) \{\n {6}broadcastSSE\('perf_screen', perfScreen\.screenEvent\(\{ kind: 'answer', choice: perfChoice \}\)\);/);
});

// ── the cards ────────────────────────────────────────────────────────────────

const en = (() => {
  const ctx = {};
  vm.createContext(ctx);
  const src = read('../js/i18n.js');
  return vm.runInContext(src.slice(0, src.indexOf('\nfunction t(key) {')) + '\ni18n.en;', ctx);
})();
const ctxEn = { t: (k) => en[k] || k };

test('the suggestion card says what the banner says, and its buttons answer it', () => {
  const answers = [];
  const card = AlertToasts.perfPrompt('coding', ctxEn, (c) => answers.push(c));
  assert.equal(card.title, en.perf_banner_msg_coding);
  assert.equal(card.important, true, 'it is asked as a game starts, when routine cards are held');
  assert.ok(card.duration > 0, 'it goes away by itself');
  assert.deepEqual(card.actions.map((a) => a.label), [en.perf_banner_optimize, en.perf_banner_never]);
  assert.equal(card.actions[0].primary, true);
  card.actions.forEach((a) => a.onClick());
  assert.deepEqual(answers, ['optimize', 'never']);
  assert.equal(AlertToasts.perfPrompt('other', ctxEn, () => {}), null);
  // The same per-activity keys as the dashboard's banner.
  const perf = read('../js/performance.js');
  for (const [act, key] of Object.entries(AlertToasts.PERF_PROMPT_KEYS)) {
    assert.ok(perf.includes(`${act}: '${key}'`), act);
    assert.ok(en[key], key);
  }
});

test('the result card words a note like the dashboard toast', () => {
  const text = AlertToasts.perfNoteText({ key: 'perf_auto_on', activity: 'gaming', freed: '1.2 GB' }, ctxEn);
  assert.equal(text, en.perf_auto_on.replace('{a}', en.settings_perf_act_gaming) + ' · ' + en.perf_freed_ram.replace('{x}', '1.2 GB'));
  assert.equal(AlertToasts.perfNoteText({ key: 'perf_auto_off' }, ctxEn), en.perf_auto_off);
  assert.equal(AlertToasts.perfNoteText({ key: 'nope' }, ctxEn), en.perf_status_optimized);
  assert.equal(AlertToasts.perfNote({ key: 'perf_status_failed' }, 'error', ctxEn).type, 'error');
  assert.equal(AlertToasts.perfNote({ key: 'perf_status_restored' }, 'ok', ctxEn).type, 'success');
  // English fallbacks match the table, so a missing language reads the same.
  assert.equal(AlertToasts.perfNoteText({ key: 'perf_status_restored' }, { t: (k) => k }), en.perf_status_restored);
  assert.equal(AlertToasts.perfNoteText({ key: 'perf_auto_off' }, { t: (k) => k }), en.perf_auto_off);
});

test('the alerts window shows perf_screen events and posts the answers', () => {
  const src = read('../js/screen-alerts.js');
  assert.match(src, /perf_screen: perfScreen,/);
  assert.match(src, /if \(d\.activity\) perfPromptId = show\(AlertToasts\.perfPrompt\(d\.activity, ctx\(\), answerPerf\)\);/);
  assert.match(src, /show\(AlertToasts\.perfNote\(d\.note, d\.tone, ctx\(\)\)\);/);
  assert.match(src, /fetch\(SERVER \+ '\/api\/performance\/screen', \{[\s\S]{0,140}JSON\.stringify\(\{ kind: 'answer', choice \}\)/);
});

// ── the driver page ──────────────────────────────────────────────────────────

test('the driver loads Performance Mode only when it is on or a session runs', () => {
  assert.equal(DriverPerf.wanted({ performance: { enabled: true } }), true);
  assert.equal(DriverPerf.wanted({ performance: { enabled: false, active: true } }), true, 'a session started on the dashboard still has to end');
  for (const junk of [null, {}, { performance: null }, { performance: { enabled: 'yes' } }]) assert.equal(DriverPerf.wanted(junk), false);
  assert.notEqual(DriverPerf.configKey({ performance: { enabled: true } }), DriverPerf.configKey({ performance: { enabled: true, autoMode: 'auto' } }));
  assert.equal(DriverPerf.configKey({ performance: { enabled: true, active: true } }), DriverPerf.configKey({ performance: { enabled: true, active: false } }),
    'a running session is not a change of mind');
  const html = read('../shell-driver.html');
  assert.ok(html.indexOf('src="js/driver-perf.js"') > 0 && html.indexOf('src="js/driver-perf.js"') < html.indexOf('src="js/shell-driver.js"'));
  assert.doesNotMatch(html, /performance\.js|perf-settings\.js/, 'not loaded up front: off by default');
  const driver = read('../js/shell-driver.js');
  assert.match(driver, /hubSettings = perf \? perf\.merge\(next\) : next;/);
  assert.match(driver, /if \(perf\) perf\.sync\(hubSettings\);/);
  assert.match(driver, /if \(perf\) perf\.listen\(es\);/);
});

// A fake page: the scripts the driver injects run for real in a vm.
function page(settings) {
  const posts = [];
  const fetches = [];
  const timers = [];
  const ctx = {
    console, JSON, Promise, Set, Map, Date, Math,
    SERVER: '',
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; }, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame() {},
    fetch: (url, opts) => {
      fetches.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      const reply = /powerplan/.test(url) ? (opts && opts.method === 'POST' ? { ok: true } : { ok: true, guid: '11111111-2222-3333-4444-555555555555' }) : { ok: true };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) });
    },
  };
  const classes = new Set();
  const scripts = [];
  ctx.document = {
    hidden: true,
    readyState: 'complete',
    body: {
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      appendChild: (s) => {
        scripts.push(s.src);
        vm.runInContext(read('../' + s.src), ctx);
        Promise.resolve().then(() => s.onload());
      },
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    createElement: () => ({}),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('let hubSettings = ' + JSON.stringify(settings) + ';', ctx);
  const perf = DriverPerf.create({
    win: ctx,
    doc: ctx.document,
    read: () => vm.runInContext('hubSettings', ctx),
    post: (path, body) => { posts.push({ path, body }); return Promise.resolve(); },
  });
  const listeners = {};
  perf.listen({ addEventListener: (name, fn) => { listeners[name] = fn; } });
  const emit = (name, data) => listeners[name]({ data: JSON.stringify(data) });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { ctx, perf, posts, fetches, timers, scripts, classes, emit, settle, hub: () => vm.runInContext('hubSettings', ctx) };
}

const ON = { performance: { enabled: true, autoSuggest: true, autoMode: 'suggest', opts: { pauseAnimations: true, powerPlan: 'high', priorityBoost: true } } };

test('off by default: nothing is loaded, no event does anything', async () => {
  const p = page({ performance: { enabled: false } });
  p.perf.sync(p.hub());
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  assert.deepEqual(p.scripts, []);
  assert.deepEqual(p.posts, []);
});

test('a game starts: the suggestion goes to the screen, Optimize applies the safe tweaks', async () => {
  const p = page(ON);
  p.perf.sync(p.hub());
  await p.settle();
  assert.deepEqual(p.scripts, ['js/perf-settings.js', 'js/performance.js'], 'in order, once');
  p.perf.sync(p.hub());
  await p.settle();
  assert.equal(p.scripts.length, 2);

  p.emit('status', { muted: false });   // a partial payload is not "the game ended"
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  assert.deepEqual(p.posts, [{ path: '/api/performance/screen', body: { kind: 'prompt', activity: 'gaming' } }]);

  p.posts.length = 0;
  p.emit('perf_screen', { kind: 'answer', choice: 'optimize' });
  await p.settle();
  assert.ok(p.fetches.some((f) => f.url === '/api/performance/powerplan' && f.body && f.body.value === 'high'), 'power plan to High');
  assert.ok(p.fetches.some((f) => f.url === '/actions/perf' && f.body.type === 'setPriority' && f.body.name === 'game' && f.body.level === 'high'), 'the game gets the CPU first');
  const saves = p.posts.filter((x) => x.path === '/api/performance/state');
  assert.ok(saves.length >= 1);
  const last = saves[saves.length - 1].body.performance;
  assert.equal(last.active, true);
  assert.equal(last.activatedBy, 'manual');
  assert.equal(last.savedPowerPlan, '11111111-2222-3333-4444-555555555555', 'the plan to go back to');
  assert.ok(p.posts.some((x) => x.path === '/api/performance/screen' && x.body.kind === 'prompt' && x.body.activity === ''), 'the card closes');
  assert.deepEqual(p.posts.filter((x) => x.body.kind === 'toast').map((x) => [x.body.note.key, x.body.tone]), [['perf_status_optimized', 'ok']]);
  assert.ok(!p.fetches.some((f) => f.url === '/windows'), 'never the app list: closing apps is the sheet\'s choice');

  // Restore puts the plan back and says so.
  p.posts.length = 0;
  p.emit('perf_screen', { kind: 'answer', choice: 'restore' });
  await p.settle();
  assert.ok(p.fetches.some((f) => f.url === '/api/performance/powerplan' && f.body && f.body.value === '11111111-2222-3333-4444-555555555555'));
  assert.equal(p.hub().performance.active, false);
  assert.deepEqual(p.posts.filter((x) => x.body.kind === 'toast').map((x) => x.body.note.key), ['perf_status_restored']);
});

test('"Don\'t ask again" is saved, and the card goes when the game loses the focus', async () => {
  const p = page(ON);
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  p.emit('status', { gaming: false, gameRunning: true, activity: 'other', process: 'explorer.exe' });
  await p.settle();
  assert.deepEqual(p.posts.map((x) => x.body), [{ kind: 'prompt', activity: 'gaming' }, { kind: 'prompt', activity: '' }]);
  p.posts.length = 0;
  p.emit('perf_screen', { kind: 'answer', choice: 'never' });
  await p.settle();
  assert.equal(p.posts.at(-1).path, '/api/performance/state');
  assert.equal(p.posts.at(-1).body.performance.autoSuggest, false);
  p.posts.length = 0;
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game2.exe' });
  await p.settle();
  assert.deepEqual(p.posts, [], 'not asked again');
});

test('a settings change starts the suggestion over, and the card on screen goes with it', async () => {
  const p = page(ON);
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  p.posts.length = 0;
  // Found on the real app: the game list changed while the card was up, the
  // game then ended, and the card stayed until it timed out.
  vm.runInContext("hubSettings = { ...hubSettings, performance: { ...hubSettings.performance, autoActivities: { gaming: true, coding: true } } };", p.ctx);
  p.perf.sync(p.hub());
  await p.settle();
  assert.deepEqual(p.posts.map((x) => x.body), [{ kind: 'prompt', activity: '' }]);
  p.posts.length = 0;
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  assert.deepEqual(p.posts.map((x) => x.body), [{ kind: 'prompt', activity: 'gaming' }], 'asked again for the game still running');
});

test('automatic mode applies by itself with no sheet, even with app closing on', async () => {
  const p = page({ performance: { ...ON.performance, autoMode: 'auto', opts: { pauseAnimations: true, powerPlan: 'high', manageApps: true } } });
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  assert.ok(!p.posts.some((x) => x.body.kind === 'prompt'), 'no question in automatic mode');
  assert.equal(p.hub().performance.active, true);
  assert.equal(p.hub().performance.activatedBy, 'auto');
  assert.deepEqual(JSON.parse(JSON.stringify(p.posts.filter((x) => x.body.kind === 'toast').map((x) => x.body.note))), [{ key: 'perf_auto_on', activity: 'gaming', freed: '' }]);
});

test('an automatic session still ends after a settings change', async () => {
  const p = page({ performance: { ...ON.performance, autoMode: 'auto' } });
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: true, gameRunning: true, activity: 'gaming', process: 'game.exe' });
  await p.settle();
  assert.equal(p.hub().performance.activatedBy, 'auto');
  // Found on the real app: a settings change during the session, then the game
  // ended, and the restore was never scheduled (the session stayed on for good).
  vm.runInContext("hubSettings = { ...hubSettings, performance: { ...hubSettings.performance, autoActivities: { gaming: true, coding: true } } };", p.ctx);
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: false, gameRunning: false, activity: 'other', process: 'explorer.exe' });
  await p.settle();
  const grace = p.timers.filter((x) => x.fn && x.ms >= 4000);
  assert.ok(grace.length >= 1, 'a restore is on its way');
  p.posts.length = 0;
  for (const x of grace) await x.fn();
  await p.settle();
  assert.equal(p.hub().performance.active, false);
  assert.deepEqual(p.posts.filter((x) => x.body.kind === 'toast').map((x) => x.body.note.key), ['perf_auto_off']);
});
test('an automatic session left on when the page loads still ends', async () => {
  const p = page({ performance: { ...ON.performance, autoMode: 'auto', active: true, activatedBy: 'auto', autoActivity: 'gaming',
    applied: { pauseAnimations: true, powerPlan: 'none', boostedProc: '' } } });
  p.perf.sync(p.hub());
  await p.settle();
  p.emit('status', { gaming: false, gameRunning: false, activity: 'other', process: 'explorer.exe' });
  await p.settle();
  for (const x of p.timers.filter((t) => t.fn && t.ms >= 4000)) await x.fn();
  await p.settle();
  assert.equal(p.hub().performance.active, false, 'the driver reloaded mid-session (a new version, a crash)');
});
test('Bit can optimize with the suggestion off: loaded on demand', async () => {
  const p = page({ performance: { enabled: false } });
  p.emit('perf_screen', { kind: 'answer', choice: 'optimize' });
  await p.settle();
  assert.equal(p.scripts.length, 2);
  assert.equal(p.hub().performance.active, true);
  p.emit('perf_screen', { kind: 'prompt', activity: 'gaming' });   // not an answer: ignored
  p.emit('perf_screen', { kind: 'answer', choice: 'optimize' });   // already on: nothing twice
  await p.settle();
  assert.equal(p.fetches.filter((f) => f.url === '/api/performance/powerplan' && f.body).length, 1);
});

test('saves go one at a time with the latest block, and a stale read never overwrites it', async () => {
  const sent = [];
  let release;
  const win = {};
  let hub = { performance: { enabled: true, active: false }, rev: 1 };
  const perf = DriverPerf.create({
    win, doc: {}, read: () => hub,
    post: (_path, body) => { sent.push(body.performance.active); return new Promise((r) => { release = r; }); },
  });
  win.saveHubSettings = null;
  // the shims are installed on load; reach save through them
  perf.load().catch(() => {});
  hub = { ...hub, performance: { ...hub.performance, active: true } };
  win.saveHubSettings();
  win.saveHubSettings();
  win.saveHubSettings();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [true], 'one save in flight');
  const stale = { performance: { enabled: true, active: false }, rev: 2, language: 'it' };
  const merged = perf.merge(stale);
  assert.equal(merged.performance.active, true, 'ours, still on its way');
  assert.equal(merged.language, 'it', 'everything else is the fresh copy');
  release();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(perf.merge(stale), stale, 'once saved, the server copy wins');
});
