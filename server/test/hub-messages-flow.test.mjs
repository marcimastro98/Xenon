// Announcement channel, end to end (js/hub-messages.js) against DOM stubs.
//
// hub-match.js covers WHO matches; this covers what happens next. Every message
// is filed as a letter in Bit's mail (js/bit-mail.js), once ever, and nothing
// opens on screen. Opening a letter reads the feed again, so what it draws
// (picture, button, poll) comes from the validated feed, never from
// localStorage, which anyone can edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/** A dashboard just real enough to run the channel. `busy` puts an overlay on screen. */
function dashboard({ messages, busy = false, settings = {}, seen = [], store = new Map() } = {}) {
  if (seen.length) store.set('xeneonedge.catalogSeen', JSON.stringify(seen));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const el = (tag) => ({
    tag, className: '', type: '', textContent: '', title: '', children: [], style: {}, dataset: {},
    isConnected: true, on: {},
    classList: { add() {}, remove() {}, contains: () => false },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; },
    addEventListener(type, fn) { this.on[type] = fn; }, setAttribute() {}, remove() { this.removed = true; }, closest: () => null,
    play() { return Promise.resolve(); },
  });
  const opened = [];
  const body = { classList: { contains: () => false }, appendChild(n) { opened.push(n); } };
  const document = {
    body, documentElement: { lang: 'it' }, createElement: el,
    querySelector: () => (busy ? {} : null),
    addEventListener() {}, removeEventListener() {},
  };
  const letters = [];
  const renderers = {};
  const window = {
    BitMail: {
      post(l) { if (!window.BitMailCore.post(l)) return false; letters.push(l); return true; },
      register(kind, fn) { renderers[kind] = fn; },
      open() {},
    },
  };
  const toasts = [];
  const posted = [];
  const feed = { messages };

  const g = {
    window, document, localStorage,
    hubSettings: settings,
    makeEl: (t, c, x) => { const n = el(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; },
    apiJson: async () => ({ ok: true, context: { version: '4.9.0', os: 'win32' }, messages: feed.messages }),
    ContentInstalls: { normalizeContentInstalls: (v) => (Array.isArray(v) ? v : []) },
    fetch: async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
    // The 35s boot timer must not fire; everything else runs immediately.
    setTimeout: (fn, ms) => (ms >= 30000 ? 0 : setTimeout(fn, 0)),
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const load = (rel) => { const n = Object.keys(g); new Function(...n, read(rel))(...n.map((k) => g[k])); };

  load('js/interrupt-queue.js'); g.XenonInterrupts = window.XenonInterrupts;
  load('js/bit-mail-core.js');
  load('js/hub-match.js'); g.HubMatch = window.HubMatch;
  window.XenonToast = { show: (o) => toasts.push(o) }; g.XenonToast = window.XenonToast;
  load('js/hub-messages.js');

  return {
    window, opened, toasts, posted, letters, store, feed,
    /** Run the check (past its 3h throttle) and return what it filed. */
    async check() {
      store.delete('xeneonedge.hubMessageCheck');
      const before = letters.length;
      await window.HubMessages.checkDaily();
      return {
        filed: letters.slice(before).map((l) => l.id),
        seen: window.XenonInterrupts.readSeen(),
      };
    },
    /** Open a letter the way Bit's mail does and return the drawn node. */
    async open(id) {
      const letter = window.BitMailCore.get(id);
      const node = el('div');
      const ctx = { closed: 0, close() { ctx.closed++; }, remove() {} };
      renderers[letter.kind](letter, node, ctx);
      await new Promise((r) => setTimeout(r, 5));
      return { node, ctx };
    },
  };
}

const news = (over = {}) => ({ id: 'big-news', level: 'modal', title: 'Importante', body: 'Novità', ...over });

/** Every node in a drawn tree, flattened. */
const nodes = (n) => (n ? [n, ...(n.children || []).flatMap(nodes)] : []);
const classes = (n) => nodes(n).map((x) => x.className).filter(Boolean);

test('each message becomes one letter, nothing opens on screen, and it is marked seen', async () => {
  const d = dashboard({ messages: [news(), news({ id: 'small-news', level: 'toast', title: 'Nota' })] });
  const out = await d.check();
  assert.deepEqual(out.filed, ['hub:big-news', 'hub:small-news'], 'a modal and a toast are both letters now');
  assert.deepEqual(d.opened, [], 'nothing was added to the page');
  assert.deepEqual(d.toasts, [], 'and no toast: Bit says it arrived, on its own schedule');
  assert.deepEqual(out.seen, ['big-news', 'small-news']);
  const l = d.letters[0];
  assert.equal(l.kind, 'hub');
  assert.equal(l.title, 'Importante');
  assert.equal(l.line, 'Novità');
  assert.deepEqual(l.data, { msgId: 'big-news' }, 'only the id is stored, never the button or the picture');
});

test('filed even while something is on screen, because filing interrupts nothing', async () => {
  const d = dashboard({ messages: [news()], busy: true });
  assert.deepEqual((await d.check()).filed, ['hub:big-news']);
  assert.deepEqual(d.opened, []);
});

test('a message is filed once, ever, and an already-seen one never', async () => {
  const store = new Map();
  let d = dashboard({ messages: [news()], store });
  assert.deepEqual((await d.check()).filed, ['hub:big-news']);
  d = dashboard({ messages: [news()], store });
  assert.deepEqual((await d.check()).filed, [], 'a new session does not repeat it');

  d = dashboard({ messages: [news({ id: 'old' })], seen: ['old'] });
  assert.deepEqual((await d.check()).filed, [], 'announced before by any channel');
  d = dashboard({ messages: [news({ id: 'about-a', entryId: 'a' })], seen: ['a'] });
  assert.deepEqual((await d.check()).filed, [], 'its drop already had its own letter');
});

test('banners are not letters, and a long body is cut for the list', async () => {
  const d = dashboard({ messages: [news({ id: 'b', level: 'banner' }), news({ id: 'long', body: 'x'.repeat(500) })] });
  assert.deepEqual((await d.check()).filed, ['hub:long']);
  assert.equal(d.letters[0].line.length, 240);
});

test('with announcements off, nothing is filed', async () => {
  const d = dashboard({ messages: [news()], settings: { hubMessages: false } });
  assert.deepEqual((await d.check()).filed, []);
});

// ── Opening a letter ───────────────────────────────────────────────────────
const IMG = 'https://assets.xenon-app.com/community/messages/v490.webp';
const CLIP = 'https://assets.xenon-app.com/community/messages/v490.mp4';

test('an opened letter draws the picture or clip from the feed, and no frame without one', async () => {
  const d = dashboard({ messages: [news({ media: { type: 'image', url: IMG, alt: 'Il widget Disco' } }), news({ id: 'clip', media: { type: 'video', url: CLIP } }), news({ id: 'plain' })] });
  await d.check();
  const pic = (await d.open('hub:big-news')).node;
  assert.equal(pic.children[0].className, 'bitmail-media', 'the picture sits above the text');
  assert.equal(pic.children[0].children[0].src, IMG);
  assert.ok(classes((await d.open('hub:clip')).node).includes('bitmail-media'));
  assert.ok(!classes((await d.open('hub:plain')).node).includes('bitmail-media'));
});

test('a letter edited in localStorage cannot bring its own picture or link', async () => {
  const d = dashboard({ messages: [news()] });
  await d.check();
  // Tamper with the stored box: the data the renderer gets is only an id.
  const box = JSON.parse(d.store.get('xeneonedge.bitMail'));
  box.letters[0].data = { msgId: 'big-news', media: { type: 'image', url: 'https://evil.example/x.png' }, action: { type: 'url', url: 'https://evil.example' } };
  d.store.set('xeneonedge.bitMail', JSON.stringify(box));
  const fresh = dashboard({ messages: [news()], store: d.store });
  const { node } = await fresh.open('hub:big-news');
  assert.ok(!nodes(node).some((n) => String(n.src || '').includes('evil')), 'no src from storage');
});

test('a message withdrawn from the feed opens as its summary alone', async () => {
  const d = dashboard({ messages: [news({ media: { type: 'image', url: IMG } })] });
  await d.check();
  d.feed.messages = [];
  const { node } = await d.open('hub:big-news');
  assert.deepEqual(classes(node), ['bitmail-letter-line'], 'the stored summary, nothing more');
  assert.equal(node.children[0].textContent, 'Novità');
});

test('a poll is answered inside the letter, once', async () => {
  const poll = news({ id: 'q', title: 'Cosa prima?', poll: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } });
  const d = dashboard({ messages: [poll] });
  await d.check();
  const { node, ctx } = await d.open('hub:q');
  const buttons = nodes(node).filter((n) => n.className === 'bitmail-btn');
  assert.deepEqual(buttons.map((b) => b.textContent), ['A', 'B'], 'the options are the buttons');
  buttons[1].on.click();
  assert.deepEqual(d.posted, [{ url: '/api/community/poll', body: { messageId: 'q', optionId: 'b' } }]);
  assert.equal(ctx.closed, 1);
  assert.equal(d.toasts.length, 1, 'the thank-you');
  const again = (await d.open('hub:q')).node;
  assert.equal(nodes(again).filter((n) => n.className === 'bitmail-btn').length, 0, 'asked once');
});

test('every letter carries the opt-out, and the old pop-ups are gone', async () => {
  const d = dashboard({ messages: [news()] });
  await d.check();
  const { node } = await d.open('hub:big-news');
  const off = nodes(node).find((n) => n.className === 'bitmail-link');
  off.on.click();
  assert.equal(d.store.get('xeneonedge.hubMessagesMuted'), '1');
  assert.doesNotMatch(read('js/hub-messages.js'), /hubmsg-overlay|aria-modal|whenIdle|showModal|showToast/);
});
