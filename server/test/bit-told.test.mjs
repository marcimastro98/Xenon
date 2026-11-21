// What Bit said on its own, in the chat (js/ai/bit-told.js), against a small DOM, and
// the way Bit opens a creation it told someone about (open_store_entry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surface = require('../ai/ai-surface.js');

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ''; this.text = ''; }
  set textContent(v) { this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(' '); }
  get firstChild() { return this.children[0] || null; }
  append(...nodes) { this.children.push(...nodes); }
  insertBefore(node, before) {
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }
  insertAdjacentHTML() {}
  querySelector(selector) { return selector === '[data-bit-welcome]' ? this.children.find((c) => c.dataset.bitWelcome) || null : null; }
}

function page({ messages = [], summary = '', store = new Map(), sparks = '', packages = [] } = {}) {
  const chat = new Node('div');
  const listeners = {};
  const ran = [];
  const sent = [];
  const waits = new Map();
  const ctx = {
    aiConversationSummary: summary,
    aiSendMessage: (text) => sent.push(text),
    document: {
      getElementById: (id) => (id === 'ai-chat' ? chat : null),
      createElement: (tag) => new Node(tag),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0,
    Map, Number, String, Date,
  };
  ctx.window = {
    addEventListener() {},
    t: (key) => ({ bm_noted: 'Noted: {answer}', bm_fit_ask: 'Fix {name}' }[key] || key),
    XenonBitCard: { mediaFrame: (media, cls) => { if (!media) return null; const n = new Node('div'); n.className = cls; return n; } },
    BitMessages: { told: async () => messages, run: (m) => ran.push(m.id) },
    XenonCredits: { level: () => sparks },
    CustomWidget: { cachedPackages: () => packages, whenFit: (id, fn, ms) => waits.set(id, { fn, ms }) },
  };
  vm.runInNewContext(read('js/ai/bit-told.js'), ctx);
  return { chat, ctx, ran, sent, waits, store, told: ctx.window.BitTold, click: (target) => listeners.click({ target }) };
}

const said = (over = {}) => ({ id: 'hub:news', kind: 'hub', title: 'News', line: 'One line.', body: 'The whole text.', readAt: 1000, ...over });
const toldNodes = (chat) => chat.children.filter((c) => c.dataset.bitTold);
const find = (node, cls) => (node.className === cls ? node : node.children.map((c) => find(c, cls)).find(Boolean));

test('only what has been read reaches the chat, oldest first, once', async () => {
  const p = page({ messages: [said({ id: 'hub:b', readAt: 2000 }), said({ id: 'hub:a' }), said({ id: 'hub:new', readAt: undefined })] });
  await p.told.sync();
  assert.deepEqual(toldNodes(p.chat).map((n) => n.dataset.bitTold), ['hub:a', 'hub:b']);
  await p.told.sync();
  assert.equal(toldNodes(p.chat).length, 2);
});

test('a word on the Scintille stays only while the balance still says it', async () => {
  const low = said({ id: 'sparks:low:2026-11', kind: 'sparks', title: 'Running low' });
  const empty = said({ id: 'sparks:empty:2026-11', kind: 'sparks', title: 'Out', readAt: 1500 });
  const topped = page({ messages: [low, empty, said()], sparks: 'ok' });
  await topped.told.sync();
  assert.deepEqual(toldNodes(topped.chat).map((n) => n.dataset.bitTold), ['hub:news'], 'after a top-up: no "running low" over a full balance');
  assert.ok(!topped.ctx.aiConversationSummary.includes('Running low'), 'nor in what Bit remembers');
  const still = page({ messages: [low, empty], sparks: 'low' });
  await still.told.sync();
  assert.deepEqual(toldNodes(still.chat).map((n) => n.dataset.bitTold), ['sparks:low:2026-11']);
  const unknown = page({ messages: [low], sparks: '' });
  await unknown.told.sync();
  assert.equal(toldNodes(unknown.chat).length, 0, 'balance not read: no claim about it');
});

test('the chat keeps the last five', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => said({ id: `hub:${i}`, readAt: 1000 + i }));
  const p = page({ messages });
  await p.told.sync();
  assert.deepEqual(toldNodes(p.chat).map((n) => n.dataset.bitTold), ['hub:3', 'hub:4', 'hub:5', 'hub:6', 'hub:7']);
});

test('read before the page opened goes above the talk, read later above the welcome', async () => {
  const p = page({ messages: [said()] });
  const talk = new Node('div');
  p.chat.append(talk);
  await p.told.sync();
  assert.equal(p.chat.children[1], talk, 'above what the chat already had');

  const q = page({ messages: [] });
  await q.told.sync();
  const welcome = new Node('div');
  welcome.dataset.bitWelcome = '1';
  q.chat.append(welcome);
  q.ctx.window.BitMessages.told = async () => [said()];
  await q.told.sync();
  assert.equal(q.chat.children[1], welcome);
});

test('title, whole text, picture and answer are drawn as text', async () => {
  const p = page({ messages: [said({ media: { type: 'image', url: 'x' }, poll: { options: [{ id: 'a', label: '<b>More</b>' }] }, answer: 'a' })] });
  await p.told.sync();
  const [row] = toldNodes(p.chat);
  assert.ok(find(row, 'ai-told-media'));
  assert.equal(find(row, 'ai-told-title').text, 'News');
  assert.equal(find(row, 'ai-msg-text').text, 'The whole text.');
  assert.equal(find(row, 'ai-told-answer').text, 'Noted: <b>More</b>');
});

test("the ask gives its line: its text leads into a list only the card has", async () => {
  const p = page({ messages: [said({ kind: 'support', body: 'Here is what you get:' })] });
  await p.told.sync();
  assert.equal(find(toldNodes(p.chat)[0], 'ai-msg-text').text, 'One line.');
});

test('its button runs the message, also from a copy of the chat', async () => {
  const p = page({ messages: [said({ action: { type: 'store', label: 'Open' } })] });
  await p.told.sync();
  const go = find(toldNodes(p.chat)[0], 'ai-told-go');
  assert.equal(go.dataset.bitToldGo, 'hub:news');
  p.click({ closest: () => ({ dataset: { bitToldGo: 'hub:news' } }) });
  assert.deepEqual(p.ran, ['hub:news']);
  p.click({ closest: () => ({ dataset: { bitToldGo: 'hub:gone' } }) });
  assert.equal(p.ran.length, 1, 'an id it never drew runs nothing');
});

test('Bit knows through the memory, with the entry and the answer, without repeating it', async () => {
  const msg = said({ entryId: 'river', poll: { options: [{ id: 'a', label: 'Yes' }] }, answer: 'a' });
  const p = page({ messages: [msg], summary: 'Earlier talk.' });
  await p.told.sync();
  const memory = p.ctx.aiConversationSummary;
  assert.match(memory, /"News"/);
  assert.match(memory, /Store entry id: river\./);
  assert.match(memory, /The user answered: Yes\./);
  assert.match(memory, /Earlier talk\.$/);

  const again = page({ messages: [msg], summary: memory });
  await again.told.sync();
  assert.equal(again.ctx.aiConversationSummary, memory);
});

test('the memory stays inside what the server keeps', async () => {
  const p = page({ messages: [said({ body: 'x'.repeat(5000) })], summary: 'y'.repeat(5000) });
  await p.told.sync();
  assert.ok(p.ctx.aiConversationSummary.length <= 2000);
});

test('a new chat stays clean after a reload, and what comes later still arrives', async () => {
  const store = new Map();
  page({ store }).told.forget();
  const cleared = Number(store.get('xeneonedge.bitToldCleared'));
  assert.ok(cleared > 0);
  const p = page({ store, messages: [said({ id: 'hub:old', readAt: cleared - 1 }), said({ id: 'hub:new', readAt: cleared + 1 })] });
  await p.told.sync();
  assert.deepEqual(toldNodes(p.chat).map((n) => n.dataset.bitTold), ['hub:new']);
});

test('what Bit said does not make the chat a conversation', () => {
  const ai = read('js/ai/ai.js');
  assert.match(ai, /_aiTalkNodes = \(chat\) => chat\.querySelectorAll\(':scope > :not\(\[data-bit-told\]\)'\)/);
  assert.match(ai, /!chat \|\| _aiTalkNodes\(chat\)\.length > 0/, 'the welcome still shows under it');
  assert.match(ai, /function aiClearHistory\(\) \{\s*if \(window\.BitTold\) BitTold\.forget\(\);/);
});

test('Bit opens a creation and stops there: installing stays with the person', () => {
  const server = engineSource();
  assert.match(server, /\{ name: 'open_store_entry', description: "[^"]*only opens the page[^"]*"/);
  assert.match(server, /const CLIENT_ACTIONS = new Set\(\[[^\]]*'open_store_entry'/);
  assert.match(read('js/ai/ai.js'), /case 'open_store_entry':\s*if \(window\.CommunityGallery\) CommunityGallery\.openEntryById\(String\(args\.entryId \|\| ''\)\);/);
  assert.equal(surface.SHEET_OK.has('open_store_entry'), true);
  assert.equal(surface.SCREEN_OK.has('open_store_entry'), false, 'the alerts window has no Store');
});

test('a widget Bit just made that does not fit: Bit says so, remembers where, and asks for the fix once', () => {
  const p = page({ packages: [{ id: 'ruled-week', name: 'Ruled Week' }] });
  p.told.watchFit('ruled-week');
  assert.ok(p.waits.get('ruled-week').ms >= 60000, 'time for the person to approve its permissions');
  p.waits.get('ruled-week').fn({ w: 2193, h: 593, items: [{ kind: 'past', by: 'tile', side: 'right', px: 212, sel: 'div.day', nth: 7, of: 7, count: 2 }] });
  const [note] = toldNodes(p.chat);
  assert.match(note.textContent, /Ruled Week/);
  assert.match(note.textContent, /bm_fit_edge/);
  assert.equal(find(note, 'ai-told-go').textContent, 'bm_fit_fix');
  assert.match(p.ctx.aiConversationSummary, /2193x593 tile/);
  assert.match(p.ctx.aiConversationSummary, /div\.day 7\/7 \(2 alike\): 212px past the tile's right edge/);
  const go = { dataset: { bitToldGo: note.dataset.bitTold } };
  p.click({ closest: () => go });
  p.click({ closest: () => go });
  assert.deepEqual(p.sent, ['Fix Ruled Week'], 'one tap, one ask');
  assert.equal(go.disabled, true);
  assert.deepEqual(p.ran, [], 'not an inbox action');
});

test('a widget that fits says nothing; text a box cuts is told as text', () => {
  const p = page();
  p.told.watchFit('clock');
  p.waits.get('clock').fn({ w: 300, h: 300, items: [] });
  assert.equal(toldNodes(p.chat).length, 0);
  p.told.watchFit('clock');
  p.waits.get('clock').fn({ w: 300, h: 300, items: [{ kind: 'cut', by: 'box', side: 'right', px: 40, sel: 'p.title', in: 'li.row', nth: 2, of: 5, count: 1 }] });
  assert.match(toldNodes(p.chat)[0].textContent, /clock/, 'a widget not in the list goes by its id');
  assert.match(toldNodes(p.chat)[0].textContent, /bm_fit_text/);
  assert.match(p.ctx.aiConversationSummary, /p\.title in li\.row 2\/5: its own box cuts 40px of its text/);
});

test('Bit starts listening when it puts the widget on the page', () => {
  const actions = read('js/ai/client-actions.js');
  const place = actions.slice(actions.indexOf("case 'place_created_widget':"), actions.indexOf("case 'choose_pump_picture':"));
  assert.match(place, /window\.BitTold\.watchFit\(String\(args\.id\)\)/);
});
