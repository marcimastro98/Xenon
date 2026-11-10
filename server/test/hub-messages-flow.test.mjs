// Announcement channel, end to end (js/hub-messages.js) against DOM stubs, through
// the real client (js/bit-messages.js) and the real inbox (bit-messages.js).
//
// hub-match.js covers WHO matches; this covers what happens next. Every message
// that matches is filed once, nothing opens on screen when it is, and what the
// feed no longer carries is taken back if nobody has read it yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBitMessages } = require('../bit-messages.js');

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const inboxFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-messages-')), 'bit-messages.json');

/** A dashboard just real enough to run the channel. */
function dashboard({ messages, settings = {}, store = new Map(), file = inboxFile() } = {}) {
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const opened = [];
  const document = {
    body: { classList: { contains: () => false }, append(n) { opened.push(n); } },
    documentElement: { lang: 'it', hasAttribute: () => false },
    createElement: () => ({}), querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  const window = { addEventListener() {} };
  const inbox = createBitMessages({ file, log: { warn() {} } });
  const toasts = [];
  const feed = { messages };
  const g = {
    window, document, localStorage,
    hubSettings: settings,
    apiJson: async () => ({ ok: true, context: { version: '4.9.0', os: 'win32' }, messages: feed.messages }),
    ContentInstalls: { normalizeContentInstalls: (v) => (Array.isArray(v) ? v : []) },
    fetch: async (url, opts) => {
      assert.equal(url, '/bit/messages/file');
      await inbox.post(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
    // The 35s boot timer must not fire.
    setTimeout: () => 0,
    clearTimeout() {},
  };
  const load = (rel) => { const n = Object.keys(g); new Function(...n, read(rel))(...n.map((k) => g[k])); };

  load('js/bit-messages.js');
  load('js/hub-match.js'); g.HubMatch = window.HubMatch;
  window.XenonToast = { show: (o) => toasts.push(o) };
  load('js/hub-messages.js');

  const stored = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).messages; } catch { return []; }
  };
  return {
    window, opened, toasts, store, feed, file, inbox, stored,
    /** Run the check, past its 3h throttle, and return every id in the inbox. */
    async check() {
      store.delete('xeneonedge.hubMessageCheck');
      await window.HubMessages.checkDaily();
      return stored().map((m) => m.id);
    },
  };
}

const news = (over = {}) => ({ id: 'big-news', title: 'Importante', body: 'Novità', ...over });
const IMG = 'https://assets.xenon-app.com/community/messages/v490.webp';

test('each message that matches is filed, and filing opens nothing on screen', async () => {
  const d = dashboard({ messages: [news({ where: 'stage' }), news({ id: 'small-news', title: 'Nota' }), news({ id: 'other', match: { lang: ['ja'] } })] });
  assert.deepEqual(await d.check(), ['hub:big-news', 'hub:small-news']);
  assert.deepEqual(d.opened, [], 'nothing was added to the page');
  assert.deepEqual(d.toasts, []);
  const [big, small] = d.stored();
  assert.equal(big.kind, 'hub');
  assert.equal(big.title, 'Importante');
  assert.equal(big.where, 'stage');
  assert.equal(small.where, 'corner', 'the corner unless the hub says otherwise');
});

test('the card gets one line, the opened card the whole text', async () => {
  const body = 'Il primo pezzo sta qui. Poi viene tutto il resto che si legge solo aprendo la scheda.';
  const d = dashboard({ messages: [news({ body })] });
  await d.check();
  const [m] = d.stored();
  assert.equal(m.line, 'Il primo pezzo sta qui.');
  assert.equal(m.body, body);
});

test('a long text with no full stop is cut at a word', async () => {
  const d = dashboard({ messages: [news({ body: 'parola '.repeat(40).trim() })] });
  await d.check();
  const [m] = d.stored();
  assert.ok(m.line.length <= 101);
  assert.match(m.line, /parola…$/);
});

test('picture, button and poll travel with the message and are checked again by the inbox', async () => {
  const d = dashboard({ messages: [
    news({ media: { type: 'image', url: IMG, alt: 'Il widget Disco' }, action: { type: 'url', label: 'Leggi', url: 'https://xenon-app.com/news' } }),
    news({ id: 'evil', media: { type: 'image', url: 'https://evil.example/x.webp' }, action: { type: 'url', label: 'Vai', url: 'https://evil.example/' } }),
    news({ id: 'q', title: 'Cosa prima?', poll: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }),
  ] });
  await d.check();
  const [good, evil, poll] = d.stored();
  assert.equal(good.media.url, IMG);
  assert.equal(good.action.url, 'https://xenon-app.com/news');
  assert.equal(evil.media, undefined);
  assert.equal(evil.action, undefined);
  assert.deepEqual(poll.poll.options.map((o) => o.label), ['A', 'B']);
});

test('a message is filed once, ever, and read stays read', async () => {
  const file = inboxFile();
  let d = dashboard({ messages: [news()], file });
  assert.deepEqual(await d.check(), ['hub:big-news']);
  d = dashboard({ messages: [news()], file });
  assert.deepEqual(await d.check(), ['hub:big-news'], 'a new session does not repeat it');
  assert.equal(d.stored().length, 1);

  await d.inbox.shown('hub:big-news');
  await d.inbox.read('hub:big-news');
  assert.equal((await d.inbox.view('dashboard')).next, null);
  await d.check();
  assert.equal((await d.inbox.view('dashboard')).next, null, 'the feed still has it, nobody is told twice');
});

test('a message taken off the feed before its turn is withdrawn', async () => {
  const d = dashboard({ messages: [news()] });
  await d.check();
  d.feed.messages = [];
  assert.deepEqual(await d.check(), []);
});

test('a message taken off the feed after it was read stays for the chat', async () => {
  const d = dashboard({ messages: [news()] });
  await d.check();
  await d.inbox.shown('hub:big-news');
  await d.inbox.read('hub:big-news');
  d.feed.messages = [];
  assert.deepEqual(await d.check(), ['hub:big-news']);
});

test('with announcements off, nothing is filed', async () => {
  const d = dashboard({ messages: [news()], settings: { hubMessages: false } });
  assert.deepEqual(await d.check(), []);
});

test('the feed is asked at most every three hours', async () => {
  const d = dashboard({ messages: [news()] });
  await d.check();
  d.feed.messages = [news(), news({ id: 'later' })];
  await d.window.HubMessages.checkDaily();
  assert.equal(d.stored().length, 1, 'inside the window: not asked');
});

test('the opt-out holds on this device and says what it did', () => {
  const d = dashboard({ messages: [] });
  d.window.HubMessages.mute();
  assert.equal(d.store.get('xeneonedge.hubMessagesMuted'), '1');
  assert.equal(d.toasts.length, 1);
});

test('nothing about what this PC has leaves it', () => {
  const src = read('js/hub-messages.js');
  assert.doesNotMatch(src, /hubmsg-overlay|aria-modal|whenIdle|showModal|showToast/, 'the old pop-ups are gone');
  const check = src.slice(src.indexOf('async function checkDaily()'));
  assert.match(check.slice(0, check.indexOf('\n  }')), /api\('\/api\/community\/messages'\)/, 'a plain GET of the whole feed');
});

test('_simulate says what would match without filing anything', () => {
  const d = dashboard({ messages: [] });
  const out = d.window.HubMessages._simulate({ messages: [news(), news({ id: 'ja', match: { lang: ['ja'] } })], context: { version: '4.9.0', os: 'win32' } });
  assert.deepEqual(out.matched.map((m) => m.id), ['big-news']);
  assert.deepEqual(out.skipped.map((m) => m.id), ['ja']);
  assert.deepEqual(d.stored(), []);
});
