// Announcement channel, end to end (js/hub-messages.js) against DOM stubs.
//
// hub-match.js covers WHO matches; this covers what happens next, which is where
// the expensive mistakes live. An announcement is shown once and then remembered
// forever, so recording it at the wrong moment does not degrade the feature — it
// destroys that message for that machine, permanently and silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

/** A dashboard just real enough to run the channel. `busy` decides whether the
 *  interrupt queue ever finds a free moment. */
function dashboard({ messages, busy = false, settings = {}, seen = [] } = {}) {
  const store = new Map();
  if (seen.length) store.set('xeneonedge.catalogSeen', JSON.stringify(seen));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const el = (tag) => ({
    tag, className: '', type: '', textContent: '', title: '', children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, setAttribute() {}, remove() {}, closest: () => null,
  });
  const opened = [];
  const body = { classList: { contains: () => false }, appendChild(n) { opened.push(n); } };
  const document = {
    body, documentElement: { lang: 'it' }, createElement: el,
    querySelector: () => (busy ? {} : null),   // an overlay already on screen
    addEventListener() {}, removeEventListener() {},
  };
  const window = {};
  const toasts = [];
  const posted = [];
  let ticker = null;

  const g = {
    window, document, localStorage,
    hubSettings: settings,
    makeEl: (t, c, x) => { const n = el(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; },
    apiJson: async () => ({ ok: true, context: { version: '4.9.0', os: 'win32' }, messages }),
    ContentInstalls: { normalizeContentInstalls: (v) => (Array.isArray(v) ? v : []) },
    fetch: async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
    // The 35s boot timer must not fire; everything else runs immediately.
    setTimeout: (fn, ms) => (ms >= 30000 ? 0 : setTimeout(fn, 0)),
    setInterval: (fn) => { ticker = fn; return 1; },
    clearInterval: () => { ticker = null; },
  };
  const load = (rel) => { const n = Object.keys(g); new Function(...n, read(rel))(...n.map((k) => g[k])); };

  load('js/interrupt-queue.js'); g.XenonInterrupts = window.XenonInterrupts;
  load('js/hub-match.js'); g.HubMatch = window.HubMatch;
  window.XenonToast = { show: (o) => toasts.push(o) }; g.XenonToast = window.XenonToast;
  load('js/hub-messages.js');

  return {
    window, opened, toasts, posted,
    /** Run the daily check, then let the queue run past its give-up point. */
    async check({ expire = false } = {}) {
      await window.HubMessages.checkDaily();
      await new Promise((r) => setTimeout(r, 20));
      if (expire) for (let i = 0; i < 205 && ticker; i++) ticker();
      return {
        opened: opened.map((n) => n.className),
        toasts: toasts.map((t) => t.title),
        seen: window.XenonInterrupts.readSeen(),
        budgetSpent: window.XenonInterrupts.budgetSpent(),
      };
    },
  };
}

const modal = (over = {}) => ({ id: 'big-news', level: 'modal', title: 'Importante', ...over });
const toast = (over = {}) => ({ id: 'small-news', level: 'toast', title: 'Nota', ...over });

// ── The one that matters ───────────────────────────────────────────────────
// Recording it at queue time meant five minutes of game mode deleted the
// announcement for good. catalog-drop.js marks seen inside its own callback for
// exactly this reason.
test('a modal that never gets on screen is not remembered as shown', async () => {
  const d = dashboard({ messages: [modal()], busy: true });
  const out = await d.check({ expire: true });
  assert.deepEqual(out.opened, [], 'nothing rendered');
  assert.deepEqual(out.seen, [], 'and nothing may be marked seen');
  assert.equal(out.budgetSpent, false, 'a slot spent on nothing is a slot wasted');
});

test('a modal that does get on screen is remembered, once', async () => {
  const d = dashboard({ messages: [modal()] });
  const out = await d.check();
  assert.deepEqual(out.opened, ['hubmsg-overlay']);
  assert.deepEqual(out.seen, ['big-news']);
  assert.equal(out.budgetSpent, true);
});

test('an already-seen message is never re-shown', async () => {
  const d = dashboard({ messages: [modal()], seen: ['big-news'] });
  const out = await d.check();
  assert.deepEqual(out.opened, []);
  assert.equal(out.budgetSpent, false, 'and it does not consume the day');
});

// ── Toasts ─────────────────────────────────────────────────────────────────
test('a toast is on screen the moment it is presented, so it is marked at once', async () => {
  const d = dashboard({ messages: [toast()] });
  const out = await d.check();
  assert.deepEqual(out.toasts, ['Nota']);
  assert.deepEqual(out.seen, ['small-news']);
  assert.equal(out.budgetSpent, false, 'toasts do not interrupt, so they cost no slot');
});

// ── Which message gets the day ─────────────────────────────────────────────
// present() treats a poll as a modal, so the selection has to as well; picking
// with level alone made the winner depend on feed order.
test('a poll declared as a toast still takes the modal slot, not a toast', async () => {
  const poll = { id: 'q', level: 'toast', title: 'Cosa prima?', poll: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } };
  const d = dashboard({ messages: [poll] });
  const out = await d.check();
  assert.deepEqual(out.opened, ['hubmsg-overlay']);
  assert.deepEqual(out.toasts, [], 'a poll can never be a toast: its answers are buttons');
  assert.equal(out.budgetSpent, true);
});

test('only one modal-shaped message runs per day; the rest keep their turn', async () => {
  const d = dashboard({ messages: [modal({ id: 'first' }), modal({ id: 'second' }), toast()] });
  const out = await d.check();
  assert.equal(out.opened.length, 1, 'one interruption, not two');
  assert.deepEqual(out.toasts, ['Nota'], 'the toast still goes out alongside it');
  assert.ok(out.seen.includes('first') && out.seen.includes('small-news'));
  assert.equal(out.seen.includes('second'), false, 'the loser waits for another day');
});

// ── The switch ─────────────────────────────────────────────────────────────
test('with announcements off, nothing is fetched and nothing is shown', async () => {
  const d = dashboard({ messages: [modal()], settings: { hubMessages: false } });
  const out = await d.check();
  assert.deepEqual(out.opened, []);
  assert.deepEqual(out.toasts, []);
  assert.deepEqual(out.seen, []);
});
