// The trial sheet (js/store-supporters/trial-sheet.js): the free week asked from the app.
//
// The rules these tests hold:
//  - the asking waits 5 s, then 1.5 times longer each time, never past 30 s;
//  - it stops by itself on an answer that ends the wait, at the 30 minute limit,
//    on stop(), and a stop in the middle of a look drops that look's answer;
//  - it never runs when nothing is waiting: at start it asks once whether a
//    request waits and starts only on a yes; the end of the page stops it;
//  - the code goes where a pasted code goes (the Lyrics tile's unlock route), no
//    other redeem route; a paired phone opens the hub's page instead;
//  - every refusal has words, and the strings exist in all 11 languages, no dash.
// The sheet on a real page (390px, desktop, languages, light) is checked by tools/trial-link-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { textsOf } from './i18n-source.mjs';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'js', 'store-supporters', 'trial-sheet.js');
const Sheet = require(FILE);
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

// Timers the test moves by hand.
function fakeTimers() {
  const live = new Map();
  let id = 0;
  return {
    live,
    set: (fn, ms) => { id += 1; live.set(id, { fn, ms }); return id; },
    clear: (h) => { live.delete(h); },
    async fire() {
      const [h, t] = [...live.entries()][0];
      live.delete(h);
      await t.fn();
    },
  };
}

test('the wait grows from 5 s by half each time and stops at 30 s', () => {
  const seen = [];
  let d = 0;
  for (let i = 0; i < 9; i++) { d = Sheet.nextDelay(d); seen.push(d); }
  assert.deepEqual(seen, [5000, 7500, 11250, 16875, 25313, 30000, 30000, 30000, 30000]);
  assert.equal(Sheet.LIMIT_MS, 30 * 60 * 1000);
});

test('the poller looks until an answer ends the wait, then stops by itself', async () => {
  for (const end of ['ready', 'started', 'none']) {
    const timers = fakeTimers();
    const answers = [];
    let looks = 0;
    const p = Sheet.createPoller({
      poll: async () => { looks += 1; return looks < 3 ? { state: 'pending' } : { state: end, code: 'XT-AAAA-BBBB-CCCC' }; },
      onAnswer: (out) => answers.push(out.state), setTimer: timers.set, clearTimer: timers.clear, now: () => 0,
    });
    p.start();
    assert.equal([...timers.live.values()][0].ms, 5000);
    await timers.fire();
    assert.equal([...timers.live.values()][0].ms, 7500, 'the wait grows');
    await timers.fire();
    await timers.fire();
    assert.deepEqual(answers, [end]);
    assert.equal(p.isRunning(), false);
    assert.equal(timers.live.size, 0, 'no timer left behind');
  }
});

test('the poller gives up at the limit and says so, and a failed look is just a wait', async () => {
  const timers = fakeTimers();
  const clock = { at: 0 };
  const answers = [];
  const p = Sheet.createPoller({
    poll: async () => { throw new Error('offline'); },
    onAnswer: (out) => answers.push(out.state), setTimer: timers.set, clearTimer: timers.clear, now: () => clock.at, limitMs: 60000,
  });
  p.start();
  await timers.fire();
  assert.equal(p.isRunning(), true);
  clock.at = 60000;
  await timers.fire();
  assert.deepEqual(answers, ['limit']);
  assert.equal(timers.live.size, 0);
  // Check again: a fresh start, from 5 s.
  p.start();
  assert.equal([...timers.live.values()][0].ms, 5000);
  p.stop();
  assert.equal(timers.live.size, 0);
});

test('a stop during a look drops its answer and leaves no timer', async () => {
  const timers = fakeTimers();
  const answers = [];
  let release;
  const p = Sheet.createPoller({
    poll: () => new Promise((r) => { release = r; }),
    onAnswer: (out) => answers.push(out.state), setTimer: timers.set, clearTimer: timers.clear, now: () => 0,
  });
  p.start();
  const look = timers.fire();
  p.stop();
  release({ state: 'ready', code: 'XT-AAAA-BBBB-CCCC' });
  await look;
  assert.deepEqual(answers, []);
  assert.equal(timers.live.size, 0);
});

// The page half, run in a bare context: only the calls it makes are watched.
function page({ pending, remote = false }) {
  const timers = fakeTimers();
  const calls = [];
  const handlers = {};
  const opened = [];
  const window = {
    __xenonRemote: remote,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    open: (url) => { opened.push(url); },
    Xenon: { constants: { trialUrl: (l) => 'https://hub.example/trial?lang=' + l } },
    t: (k) => k,
  };
  const context = {
    window, document: {}, SERVER: 'http://127.0.0.1:3030', lang: 'de', console,
    setTimeout: timers.set, clearTimeout: timers.clear,
    fetch: async (url, init) => {
      calls.push({ url, body: init && init.body ? JSON.parse(init.body) : undefined });
      const route = url.replace('http://127.0.0.1:3030', '');
      const out = route === '/api/community/trial/pending' ? { ok: true, pending, match: 'NXNX' } : { ok: true, state: 'pending' };
      return { json: async () => out };
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(FILE, 'utf8'), context, { filename: FILE });
  return { window, timers, calls, handlers, opened };
}

test('at start a waiting request resumes the quiet asking, and the end of the page stops it', async () => {
  const p = page({ pending: true });
  assert.equal(p.timers.live.size, 1, 'one boot look, nothing else');
  await p.timers.fire();
  assert.deepEqual(p.calls.map((c) => c.url), ['http://127.0.0.1:3030/api/community/trial/pending'], 'calls go to SERVER');
  assert.equal(p.timers.live.size, 1, 'the poller is armed');
  assert.equal([...p.timers.live.values()][0].ms, 5000);
  await p.timers.fire();
  assert.equal(p.calls[1].url, 'http://127.0.0.1:3030/api/community/trial/poll');
  assert.equal(p.timers.live.size, 1);
  p.handlers.pagehide();
  assert.equal(p.timers.live.size, 0, 'pagehide stops it');
});

test('with nothing waiting the sheet never asks the hub', async () => {
  const p = page({ pending: false });
  await p.timers.fire();
  assert.equal(p.calls.length, 1);
  assert.equal(p.timers.live.size, 0, 'no poll armed');
});

test('a paired phone opens the hub page instead of the sheet, and never looks at start', async () => {
  const p = page({ pending: true, remote: true });
  assert.equal(await p.window.TrialSheet.open('store'), false);
  assert.deepEqual(p.opened, ['https://hub.example/trial?lang=de']);
  await p.timers.fire();
  assert.equal(p.calls.length, 0);
});

test('the code goes where a pasted code goes, and the trial button opens the sheet', () => {
  const src = readFileSync(FILE, 'utf8');
  assert.match(src, /call\('\/api\/features\/lyrics\/unlock', \{ code: text \}\)/);
  const redeems = src.match(/\/api\/[\w/-]*(unlock|redeem)/g) || [];
  assert.deepEqual([...new Set(redeems)], ['/api/features/lyrics/unlock'], 'one way in');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, 'text goes in as text');
  const ui = readFileSync(path.join(here, '..', 'js', 'store-supporters', 'trial-pass-ui.js'), 'utf8');
  assert.match(ui, /window\.TrialSheet \? window\.TrialSheet\.open\(source, opts\)/);
  const share = readFileSync(path.join(here, '..', 'js', 'presets', 'preset-share.js'), 'utf8');
  assert.match(share, /openTry\('import', \{ onCode: \(code\) => \{ unlockField\.value = code; importBtn\.click\(\); \} \}\)/,
    'the unlock dialog gets the code in its own field');
  const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/store-supporters/trial-sheet.js') > html.indexOf('js/store-supporters/support-sheet.js'));
});

test('every refusal has its words', () => {
  assert.equal(Sheet.requestErrorKey('app_cap'), 'trial_sheet_err_busy');
  assert.equal(Sheet.requestErrorKey('bad_email'), 'trial_sheet_err_email');
  assert.equal(Sheet.requestErrorKey('closed'), 'trial_sheet_err_closed');
  assert.equal(Sheet.requestErrorKey('trial_used'), 'trial_err_used');
  assert.equal(Sheet.requestErrorKey('network'), 'preset_redeem_offline');
  assert.equal(Sheet.requestErrorKey(undefined), 'preset_redeem_offline');
  assert.equal(Sheet.redeemErrorKey('limit'), 'trial_err_other_pc');
  assert.equal(Sheet.redeemErrorKey('bad_code'), 'preset_redeem_bad');
  assert.equal(Sheet.redeemErrorKey('weird'), 'preset_redeem_offline');
  const used = [...new Set(['app_cap', 'bad_email', 'closed', 'trial_used', 'rate_limited', 'x'].map(Sheet.requestErrorKey)
    .concat(['trial_used', 'limit', 'expired', 'rate_limited', 'bad_code', 'x'].map(Sheet.redeemErrorKey)))];
  for (const key of used) assert.deepEqual(textsOf(key).map(([c]) => c).sort(), [...LANGS].sort(), key);
});

test('the sheet\'s strings exist in all 11 languages, placeholders kept, no dash', () => {
  const src = readFileSync(FILE, 'utf8');
  const keys = [...new Set(src.match(/trial_sheet_\w+/g))];
  assert.ok(keys.length >= 20, 'keys found: ' + keys.length);
  for (const k of Sheet.WAIT_LINES) assert.ok(keys.includes(k), k);
  for (const key of keys) {
    const texts = textsOf(key);
    assert.deepEqual(texts.map(([code]) => code).sort(), [...LANGS].sort(), key);
    const want = (texts.find(([code]) => code === 'en')[1].match(/\{\w+\}/g) || []).sort();
    for (const [code, text] of texts) {
      assert.deepEqual((text.match(/\{\w+\}/g) || []).sort(), want, `${key} ${code}`);
      assert.doesNotMatch(text, /[—–]/, `${key} ${code}`);
    }
  }
  const on = textsOf('trial_sheet_on');
  for (const [code, text] of on) assert.match(text, /\{date\}/, code);
});
