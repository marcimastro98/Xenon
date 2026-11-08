import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(HERE, '..', ...p), 'utf8');

// The Codex tile on the new look. What it has to keep true:
//  1. A state is a word in its colour, not a dot to decode.
//  2. Today is the one bar in colour; the other days stay neutral.
//  3. With no plan data the two tabs would say the same sentence, so they go.
//  4. The header speaks only when one step is left, and an empty list has no heading.
//  5. Decisions never leave the tile: a short one is the decision and nothing else,
//     and stacked cards become one card and a count.

const LABELS = {
  codex_state_running: 'Working',
  codex_state_waiting: 'Waiting for you',
  codex_connect: 'Connect',
  codex_sessions: 'Sessions',
  codex_link_ok: 'Connected.',
  codex_link_trust: 'One step left.',
  claude_more_waiting: '{n} more waiting',
};

const NOW = Date.now();
const days = (n) => Array.from({ length: n }, (_, i) => ({ date: `2026-11-0${i + 1}`, tokens: (i + 1) * 1000 }));
const thread = (id, status) => ({ id, title: `Thread ${id}`, project: 'harbor-shop', source: 'cli', status, updatedAt: NOW - 3600000 });
const approval = (id) => ({ id, sessionId: 's2', project: 'tide-tables', tool: 'Bash', risks: [], expiresInMs: 60000, detail: { kind: 'command', command: 'npm test' } });

function feed(over = {}) {
  return {
    app: { state: 'ok', account: { plan: 'plus' }, caps: {}, limits: { buckets: [] }, threads: [], usage: { today: 3000, last7: 9000, last30: 12000, days: days(5) } },
    live: {
      approvals: [],
      sessions: [
        { id: 's1', task: 'Move the importer', project: 'harbor-shop', model: 'gpt-5-codex', state: 'running', ageMs: 60000 },
        { id: 's2', task: 'Fix the upload test', project: 'tide-tables', model: 'gpt-5-codex', state: 'waiting', ageMs: 60000 },
      ],
    },
    link: { linked: true, complete: true, trust: { trusted: true } },
    ...over,
  };
}

function mount(payload, { face = 'live' } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;
  const page = mkEl('div');
  page.className = 'pager-page';
  document.body.appendChild(page);
  const tile = mkEl('section');
  tile.setAttribute('data-dashboard-widget', 'openaicodex');
  page.appendChild(tile);
  const host = mkEl('div');
  host.className = 'codex-widget-mount';
  tile.appendChild(host);

  const sandbox = {
    document,
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    apiJson: async () => null,
    hubSettings: {},
    localStorage: { getItem: () => face, setItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console: { warn() {}, error() {} },
  };
  sandbox.window = sandbox;
  sandbox.t = (k) => (k in LABELS ? LABELS[k] : k);
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(read('js', 'approval-keys.js'), sandbox, { filename: 'approval-keys.js' });
  vm.runInContext(read('js', 'codex-widget.js'), sandbox, { filename: 'codex-widget.js' });
  sandbox.CodexWidget.onSSE(payload);
  return host;
}

const texts = (host, sel) => host.querySelectorAll(sel).map((n) => n.textContent);

test('a session says its state in a word, and no dot is left', () => {
  const host = mount(feed());
  assert.deepEqual(texts(host, '.cx-row-state'), ['Working', 'Waiting for you']);
  assert.equal(host.querySelector('.cx-dot'), null);
  assert.ok(host.querySelector('.cx-row.is-running .cx-row-state'));
  assert.ok(host.querySelector('.cx-row.is-waiting .cx-row-state'));
});

test('a conversation names a state only while it is doing something', () => {
  const payload = feed();
  payload.live.sessions = [];
  payload.app.threads = [thread('a', 'idle'), thread('b', 'saved'), thread('c', 'active'), thread('d', 'waiting')];
  assert.deepEqual(texts(mount(payload), '.cx-row-state'), ['Working', 'Waiting for you']);
});

test('only today is the bar in colour', async () => {
  const host = mount(feed(), { face: 'usage' });
  await settle();
  const bars = host.querySelectorAll('.cx-day');
  assert.equal(bars.length, 5);
  assert.deepEqual(bars.map((b) => b.classList.contains('is-today')), [false, false, false, false, true]);
});

for (const state of ['missing', 'signedOut', 'error']) {
  test(`no tabs and no Connect word when Codex is ${state}`, () => {
    const payload = feed({ app: { state }, live: { approvals: [], sessions: [] }, link: { linked: true, trust: { trusted: false } } });
    const host = mount(payload);
    assert.equal(host.querySelector('.cx-faces'), null);
    assert.equal(host.querySelector('.cx-link-word'), null);
    assert.ok(host.querySelector('.cx-state'));
  });
}

test('the header says Connect only when one step is left', () => {
  const word = (link) => texts(mount(feed({ link })), '.cx-link-word');
  assert.deepEqual(word({ linked: true, trust: { trusted: true } }), []);
  assert.deepEqual(word({ linked: false }), []);
  assert.deepEqual(word({ linked: true, trust: { trusted: false } }), ['Connect']);
  assert.deepEqual(word({ linked: true, trust: {} }), ['Connect']);
});

test('connected with nothing running: no heading over an empty list, one true sentence', () => {
  const idle = (trusted) => {
    const payload = feed({ link: { linked: true, complete: true, trust: { trusted } } });
    payload.live.sessions = [];
    return mount(payload);
  };
  const on = idle(true);
  assert.ok(!texts(on, '.cx-sec-title').includes('Sessions'));
  assert.deepEqual(texts(on, '.cx-list .cx-muted'), ['Connected.']);
  assert.deepEqual(texts(idle(false), '.cx-list .cx-muted'), ['One step left.']);
});

test('decisions: the stacked count starts one earlier than the side-by-side one', () => {
  const asking = (n) => {
    const payload = feed();
    payload.live.approvals = Array.from({ length: n }, (_, i) => approval(`x${i}`));
    return mount(payload);
  };
  const one = asking(1);
  assert.equal(one.querySelectorAll('.cx-dec').length, 1);
  assert.equal(one.querySelector('.cx-decs-stacked'), null);

  const two = asking(2);
  assert.equal(two.querySelectorAll('.cx-dec').length, 2);
  assert.deepEqual(texts(two, '.cx-decs .cx-muted'), ['1 more waiting']);
  assert.ok(two.querySelector('.cx-decs-stacked'));

  assert.deepEqual(texts(asking(3), '.cx-decs .cx-muted'), ['1 more waiting', '2 more waiting']);
});

test('the CSS keeps a short tile on the decision, in both tiles', () => {
  const codex = read('components', 'CodexWidget', 'CodexWidget.css').replace(/\r\n/g, '\n');
  assert.match(codex, /@container cx \(max-height: 420px\) \{\n(?:  .*\n)*?  \.cx-decs ~ \* \{ display: none; \}/);
  assert.match(codex, /@container cx \(max-width: 859px\) \{\s*\.cx-decs\.is-pair > \.cx-dec ~ \.cx-dec/);

  const claude = read('components', 'ClaudeWidget', 'ClaudeWidget.css').replace(/\r\n/g, '\n');
  assert.match(claude, /@container cw \(max-width: 859px\) \{\s*\.cw-decs\.is-pair > \.cw-dec ~ \.cw-dec/);
  // `.is-stacked` is the page's stacked view, height 100dvh: on the count it left the card a sliver.
  assert.doesNotMatch(claude + read('js', 'claude-widget.js'), /cw-decs-more[ .]is-stacked/);
  // Weight ties with `.cw-cs-body.has-aside`, so the order is the rule: before it the thread stayed and the card got nothing.
  const hide = claude.indexOf('.cw-console > .cw-decs ~ * { display: none; }');
  assert.ok(hide > 0, 'a short tile hides what follows the decision');
  for (const layout of ['.cw-cs-body.has-aside {', '.cw-cs-body.has-strip { display: grid']) {
    assert.ok(hide > claude.lastIndexOf(layout), `the short rule comes after ${layout}`);
  }
});

test('a word in the accent stays readable on a light tile', () => {
  const light = read('styles', 'themes-light.css');
  const list = light.slice(light.indexOf('The accent as text'), light.indexOf('color: var(--accent-ink, var(--accent));', light.indexOf('The accent as text')));
  assert.match(list, /\.cx-row\.is-running, \.cx-row\.is-active\) \.cx-row-state/);
});

test('bold in a Codex or ChatGPT answer takes the bubble ink, never the chat pane white', () => {
  const contract = read('styles', 'theme-contract.css');
  assert.match(contract, /:is\(\.cx-bubble, \.cg-bubble\)\.ai-msg-markdown :is\(\.ai-h3, \.ai-h4, strong, em\) \{ color: inherit; \}/);
});
