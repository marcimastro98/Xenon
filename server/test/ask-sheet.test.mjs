import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, windowKeys } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The window Codex and Claude Code open over the whole screen when a request cannot
// wait. What it has to keep true:
//  1. It is one window for as long as there is something to answer: pushes repaint it,
//     they do not reopen it, so the keyboard and the freeze are taken once.
//  2. A push never takes the keyboard from a box being typed into.
//  3. The focus goes to the window, never to a key: a stray Enter allows nothing.
//  4. Esc gives the answer that starts nothing.
//  5. Nothing else may land over it: a screensaver or a promo would hide what an agent
//     is blocked on.
//  6. It says what happens if nobody answers, in words, not in a tooltip.

function sheetRig() {
  const { document } = makeDom();
  const window = {};
  const keys = windowKeys(window);
  const log = [];
  window.ambientFreeze = (token, on) => log.push(`freeze ${token} ${on}`);
  vm.runInNewContext(read('../js/dialog-focus.js'), { window, document });
  const realHold = window.DialogFocus.hold;
  window.DialogFocus = {
    hold(root, opts) {
      log.push('hold');
      const letGo = realHold(root, opts);
      return () => { log.push(`let go, in the page: ${root.isConnected}`); letGo(); };
    },
  };
  vm.runInNewContext(read('../js/approval-keys.js'), { window, document, setTimeout, clearTimeout });
  const press = (key) => keys.slice().forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} }));
  const sheet = window.ApprovalKeys.createSheet({ className: 'cw-overlay', freeze: 'claude-approval', scrollers: ['.cw-dec-body'] });
  const card = () => {
    const node = document.createElement('section');
    const box = document.createElement('input');
    box.dataset.keep = 'answer';
    node.appendChild(box);
    return node;
  };
  return { document, window, log, press, sheet, card };
}

test('pushes repaint the same window: the keyboard and the freeze are taken once', () => {
  const { document, log, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'First', esc() {} });
  const root = document.querySelector('.ask-overlay');
  sheet.paint(card(), { label: 'Second', esc() {} });
  assert.equal(document.querySelectorAll('.ask-overlay').length, 1);
  assert.equal(document.querySelector('.ask-overlay'), root);
  assert.ok(root.classList.contains('cw-overlay'));
  assert.equal(root.children.length, 1);
  assert.deepEqual(log, ['freeze claude-approval true', 'hold']);
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Second');
});

test('the focus sits on the window, never on a key', () => {
  const { document, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'x', esc() {} });
  assert.equal(document.activeElement, document.querySelector('.ask-overlay'));
});

test('a push leaves the box being typed into with the focus and the caret', () => {
  const { document, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'x', esc() {} });
  const typing = document.querySelector('.ask-overlay input');
  typing.focus();
  typing.selectionStart = 3;
  typing.selectionEnd = 3;
  const moved = [];
  const next = card();
  next.children[0].setSelectionRange = (s, e) => moved.push(s, e);
  sheet.paint(next, { label: 'x', esc() {} });
  assert.equal(document.activeElement, next.children[0]);
  assert.deepEqual(moved, [3, 3]);
});

test('a key lost to a push hands the focus back to the window, not to the page', () => {
  const { document, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'x', esc() {} });
  const root = document.querySelector('.ask-overlay');
  document.activeElement = document.body;   // what the browser does when the focused key goes
  sheet.paint(card(), { label: 'x', esc() {} });
  assert.equal(document.activeElement, root);
});

test('Esc gives the answer of the request on screen now', () => {
  const { press, sheet, card } = sheetRig();
  const said = [];
  sheet.paint(card(), { label: 'x', esc: () => said.push('first') });
  sheet.paint(card(), { label: 'x', esc: () => said.push('second') });
  press('Escape');
  assert.deepEqual(said, ['second']);
});

test('the window lets go of the keyboard before it leaves the page, once', () => {
  const { document, log, press, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'x', esc: () => assert.fail('nothing is on screen') });
  sheet.close();
  sheet.close();
  assert.deepEqual(log, ['freeze claude-approval true', 'hold', 'let go, in the page: true', 'freeze claude-approval false']);
  assert.equal(document.querySelector('.ask-overlay'), null);
  press('Escape');
});

test('it opens again after closing, as a new window', () => {
  const { document, log, sheet, card } = sheetRig();
  sheet.paint(card(), { label: 'x', esc() {} });
  sheet.close();
  sheet.paint(card(), { label: 'y', esc() {} });
  assert.equal(document.querySelectorAll('.ask-overlay').length, 1);
  assert.equal(log.filter((l) => l === 'hold').length, 2);
});

const NOW = Date.now();
const LABELS = {
  codex_asking_in: 'Codex is asking in {project}',
  codex_permission: 'Codex is asking',
  codex_dec_expires: 'After this Codex asks you itself',
  codex_handback: 'Answer in Codex',
  codex_intent_command: 'Run a command',
  claude_dec_left: '{t} left',
  claude_deny: 'Deny',
  claude_allow: 'Allow',
  claude_more_waiting: '{n} more waiting',
  claude_asking_in: 'Claude is asking in {project}',
  claude_asking: 'Claude is asking',
  claude_dec_expires: 'After this the terminal asks instead',
  claude_q_terminal: 'In the terminal',
  claude_q_send: 'Answer',
  claude_xp_what: 'Ready to code?',
  claude_xp_keep: 'No, keep planning',
  claude_question: 'Question',
  claude_risk_irreversible: 'Cannot be undone',
};

function widgetRig(scripts, tileClass, widget) {
  const { document } = makeDom();
  const tile = document.createElement('section');
  tile.dataset.dashboardWidget = widget;
  const page = document.createElement('div');
  page.className = 'pager-page';
  page.appendChild(tile);
  document.body.appendChild(page);
  const host = document.createElement('div');
  host.className = tileClass;
  tile.appendChild(host);
  const calls = [];
  const clock = { now: NOW };
  document.createTextNode = (text) => { const n = document.createElement('#text'); n.textContent = text; return n; };
  const sandbox = {
    document,
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    apiJson: async (url, opts) => { calls.push([url, opts && opts.body ? JSON.parse(opts.body) : null]); return { ok: true }; },
    hubSettings: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console: { warn() {}, error() {} },
    Date: class extends Date { static now() { return clock.now; } },
    Intl,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.t = (k) => (k in LABELS ? LABELS[k] : k);
  const keys = windowKeys(sandbox);
  vm.createContext(sandbox);
  for (const name of scripts) vm.runInContext(read(`../js/${name}`), sandbox, { filename: name });
  const press = (key) => keys.slice().forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} }));
  // Past the moments a new request ignores taps, and the repaint a real timer would bring.
  const armed = () => { clock.now += 1000; };
  return { document, sandbox, calls, press, armed };
}

const words = (root, sel) => root.querySelectorAll(sel).map((n) => n.textContent);

function codexSheet(approvals) {
  const rig = widgetRig(['dialog-focus.js', 'approval-keys.js', 'codex-widget.js'], 'codex-widget-mount', 'openaicodex');
  rig.sandbox.CodexWidget.onSSE({
    app: { state: 'ok', account: { plan: 'plus' }, caps: {}, limits: { buckets: [] }, threads: [], usage: {} },
    live: { approvals, sessions: [] },
    link: { linked: true, complete: true, trust: { trusted: true } },
  });
  return { ...rig, root: rig.document.querySelector('.ask-overlay') };
}
const codexAsk = (id, over = {}) => ({
  id, sessionId: 's1', project: 'tide-tables', model: 'gpt-5-codex', tool: 'shell', urgent: true, risks: [], expiresInMs: 72000,
  detail: { kind: 'command', text: 'npm publish' }, ...over,
});

test('Codex: who asks and what for in the head, what follows in the foot, words not a tooltip', () => {
  const { root } = codexSheet([codexAsk('a'), codexAsk('b'), codexAsk('c', { urgent: false })]);
  assert.ok(root.classList.contains('cx-overlay'));
  assert.deepEqual(words(root, '.ask-title'), ['Run a command']);
  assert.deepEqual(words(root, '.ask-line'), ['Codex is asking in tide-tables']);
  assert.equal(root.getAttribute('aria-label'), 'Codex is asking in tide-tables');
  assert.equal(root.querySelector('.cx-dec-head'), null);
  assert.equal(root.querySelector('.cx-dec-what'), null);
  const note = root.querySelector('.ask-note').textContent;
  assert.match(note, /1:12 left/);
  assert.match(note, /After this Codex asks you itself/);
  assert.match(note, /1 more waiting/);
  assert.equal(root.querySelector('[data-cx-expires-at]').dataset.tpl, '{t} left');
});

test('a push leaves a reader where they are, in the sheet and in its command', () => {
  const { root, sandbox } = codexSheet([codexAsk('a')]);
  root.querySelector('.ask-sheet').scrollTop = 40;
  root.querySelector('.cx-dec-body').scrollTop = 70;
  sandbox.CodexWidget.onSSE({
    app: { state: 'ok', account: { plan: 'plus' }, caps: {}, limits: { buckets: [] }, threads: [], usage: {} },
    live: { approvals: [codexAsk('a')], sessions: [] },
    link: { linked: true, complete: true, trust: { trusted: true } },
  });
  assert.equal(root.querySelector('.ask-sheet').scrollTop, 40);
  assert.equal(root.querySelector('.cx-dec-body').scrollTop, 70);
});

test('Codex: with no project it still says who asks, and alone it counts nobody', () => {
  const { root } = codexSheet([codexAsk('a', { project: '' })]);
  assert.deepEqual(words(root, '.ask-line'), ['Codex is asking']);
  assert.doesNotMatch(root.querySelector('.ask-note').textContent, /waiting/);
});

test('Codex: the keys follow the eye, the main one last, and Esc hands the request back', async () => {
  const { root, press, calls, armed } = codexSheet([codexAsk('a')]);
  assert.deepEqual(words(root, '.cx-key'), ['Answer in Codex', 'Deny', 'Allow']);
  assert.ok(root.querySelectorAll('.cx-key').every((k) => k.dataset.keep));
  press('Escape');
  assert.deepEqual(calls, []);   // still arming: a hand on its way lands on nothing
  armed();
  press('Escape');
  assert.equal(JSON.stringify(calls), JSON.stringify([['/api/codex/decide', { id: 'a', behavior: 'handback' }]]));
});

test('Codex: the tile keeps its own order of keys', () => {
  const { document } = codexSheet([codexAsk('a', { urgent: false })]);
  assert.equal(document.querySelector('.ask-overlay'), null);
  assert.deepEqual(words(document.querySelector('.codex-widget-mount'), '.cx-key'), ['Deny', 'Answer in Codex', 'Allow']);
});

function claudeSheet(approvals) {
  const rig = widgetRig(['dialog-focus.js', 'approval-keys.js', 'claude-history.js', 'claude-thread.js', 'claude-roadmap.js', 'claude-ident.js', 'claude-clawd.js', 'claude-rail.js', 'claude-console.js', 'claude-agents.js', 'claude-widget.js'], 'claude-widget-mount', 'claude');
  rig.sandbox.ClaudeWidget.onSSE({ live: { approvals, sessions: [] }, usage: {}, budget: {}, tile: {} });
  return { ...rig, root: rig.document.querySelector('.ask-overlay') };
}
const claudeAsk = (id, over = {}) => ({
  id, sessionId: 's1', project: 'harbor-shop', model: 'claude-opus-5-5', tool: 'Bash', kind: 'permission', urgent: true,
  risks: [], expiresInMs: 72000, detail: 'git push', ...over,
});

test('Claude: the mascot in the session\'s colour, the sentence, and no second kicker', () => {
  const { root } = claudeSheet([claudeAsk('a')]);
  assert.ok(root.classList.contains('cw-overlay'));
  assert.deepEqual(words(root, '.ask-line'), ['Claude is asking in harbor-shop']);
  const mark = root.querySelector('.ask-mark .cw-clawd');
  assert.match(mark.className, /is-s\d/);
  assert.doesNotMatch(mark.className, /is-needs/);   // it hops and goes amber: not for a window this size
  assert.equal(root.querySelector('.cw-dec-head'), null);
  assert.equal(root.querySelector('.cw-dec-what'), null);
  assert.deepEqual(words(root, '.cw-dec-cmd'), ['git push']);
  assert.deepEqual(words(root, '.cw-key'), ['Deny', 'Allow']);
  assert.match(root.querySelector('.ask-note').textContent, /After this the terminal asks instead/);
});

test('Claude: Esc refuses a request, as it does in the terminal', () => {
  const { press, calls, armed } = claudeSheet([claudeAsk('a')]);
  press('Escape');
  assert.deepEqual(calls, []);
  armed();
  press('Escape');
  assert.equal(JSON.stringify(calls), JSON.stringify([['/api/claude/decide', { id: 'a', behavior: 'deny' }]]));
  press('Escape');
  assert.equal(calls.length, 1, 'a second Esc while the answer travels sends nothing');
});

test('Claude: Esc on a question hands it back, on a plan keeps planning', () => {
  const question = claudeSheet([claudeAsk('q', {
    kind: 'question', tool: 'AskUserQuestion', detail: '', questions: [{ question: 'Which?', options: [{ label: 'One' }] }],
  })]);
  question.armed();
  question.press('Escape');
  assert.equal(JSON.stringify(question.calls), JSON.stringify([['/api/claude/answer', { id: 'q', skip: true }]]));

  const plan = claudeSheet([claudeAsk('p', { kind: 'plan', tool: 'ExitPlanMode', detail: '', plan: 'Do it', choices: ['default'] })]);
  plan.armed();
  plan.press('Escape');
  assert.equal(JSON.stringify(plan.calls), JSON.stringify([['/api/claude/decide', { id: 'p', behavior: 'deny', feedback: '' }]]));
});

test('two presses of the keyboard survive a push that rebuilds the key between them', () => {
  const { document } = makeDom();
  const window = {};
  vm.runInNewContext(read('../js/approval-keys.js'), { window, document, setTimeout, clearTimeout, Date });
  let allowed = 0;
  const hold = () => window.ApprovalKeys.holdButton({
    className: 'k', label: 'Hold to allow', pressAgain: 'Press again', holdMs: 900, keep: 'k-a-hold',
    isArmed: () => true, onConfirm: () => { allowed += 1; },
  });
  const enter = (b) => b._handlers.keydown.forEach((fn) => fn({ key: 'Enter', preventDefault() {} }));
  const first = hold();
  enter(first);
  assert.equal(allowed, 0);
  const rebuilt = hold();
  assert.equal(rebuilt.textContent, 'Press again');
  enter(rebuilt);
  assert.equal(allowed, 1);
  const after = hold();
  assert.equal(after.textContent, 'Hold to allow');
});

test('Claude: one question is the title of the window, and is not said twice', () => {
  const { root } = claudeSheet([claudeAsk('a', {
    kind: 'question', tool: 'AskUserQuestion', detail: '',
    questions: [{ header: 'Rounding', question: 'Where should the total be rounded?', options: [{ label: 'At the end' }, { label: 'On each line' }] }],
  })]);
  assert.deepEqual(words(root, '.ask-title'), ['Where should the total be rounded?']);
  assert.equal(root.querySelector('.cw-dec-qtext'), null);
  assert.equal(root.querySelector('.cw-dec-qhead'), null);
  assert.deepEqual(words(root, '.cw-key'), ['In the terminal', 'Answer']);
  assert.ok(root.querySelectorAll('.cw-opt').every((o) => o.dataset.keep));
});

test('Claude: several questions keep their own lines under a plain title', () => {
  const q = (question) => ({ question, options: [{ label: 'Yes' }] });
  const { root } = claudeSheet([claudeAsk('a', {
    kind: 'question', tool: 'AskUserQuestion', detail: '', questions: [q('One?'), q('Two?')],
  })]);
  assert.deepEqual(words(root, '.ask-title'), ['Question']);
  assert.deepEqual(words(root, '.cw-dec-qtext'), ['One?', 'Two?']);
});

test('Claude: a plan reads as a plan, not as markdown with its hashes', () => {
  const { root } = claudeSheet([claudeAsk('a', {
    kind: 'plan', tool: 'ExitPlanMode', detail: '', plan: '## Round once\n\n1. Move it', choices: ['default'],
  })]);
  assert.deepEqual(words(root, '.ask-title'), ['Ready to code?']);
  const plan = root.querySelector('.cw-dec-plan');
  assert.deepEqual(words(plan, '.cw-md-h'), ['Round once']);
  assert.doesNotMatch(plan.textContent, /##/);
});

test('the tile keeps its own card: the sheet\'s parts stay in the sheet', () => {
  const { document } = claudeSheet([claudeAsk('a', { urgent: false, sessionId: '' })]);
  assert.equal(document.querySelector('.ask-overlay'), null);
  const tile = document.querySelector('.claude-widget-mount');
  assert.ok(tile.querySelector('.cw-dec-head'));
  assert.ok(tile.querySelector('.cw-dec-what'));
  assert.equal(tile.querySelector('.ask-head'), null);
  assert.equal(tile.querySelector('.ask-foot'), null);
});

test('nothing lands over a request, for either agent', () => {
  const idle = /const OVERLAY_SELECTOR = '([^']+)'/.exec(read('../js/ambient-mode.js'))[1].split(/,\s*/);
  assert.ok(idle.includes('.ask-overlay'), 'a screensaver would start over the request');
  const queue = read('../js/interrupt-queue.js');
  assert.match(queue, /^\s*'\.ask-overlay',$/m, 'a promo card would draw itself over the request');
});

test('the window comes with the tile wherever the tile can stand alone', () => {
  const layer = read('../js/layer-tiles.js');
  const claude = /claude: tile\([\s\S]*?\n\s*chatgpt: tile/.exec(layer)[0];
  assert.equal((claude.match(/'js\/dialog-focus\.js'/g) || []).length, 2);
  assert.equal((claude.match(/'js\/approval-keys\.js'/g) || []).length, 2);
  assert.equal((claude.match(/components\/AskSheet\/AskSheet\.css/g) || []).length, 2);
  assert.equal((claude.match(/styles\/liquid-sheets\.css/g) || []).length, 2);
  const page = read('../index.html');
  const at = (name) => page.indexOf(`<script src="js/${name}"`);
  assert.ok(at('approval-keys.js') > 0 && at('approval-keys.js') < at('claude-widget.js'), 'Claude needs it on load');
  assert.ok(at('dialog-focus.js') > 0 && at('dialog-focus.js') < at('claude-widget.js'));
  assert.match(page, /components\/AskSheet\/AskSheet\.css/);
});

test('the sheet is the theme\'s own, with no dark box of its own', () => {
  const claude = read('../components/ClaudeWidget/ClaudeWidget.css');
  const codex = read('../components/CodexWidget/CodexWidget.css');
  for (const css of [claude, codex]) {
    assert.doesNotMatch(css, /rgba\(16, 18, 21/);
    assert.doesNotMatch(css, /\.c[wx]-overlay \{\s*position: fixed/);
  }
  const sheet = read('../components/AskSheet/AskSheet.css');
  assert.match(sheet, /var\(--surface/);
  assert.match(sheet, /var\(--radius-modal\)/);
  assert.match(sheet, /prefers-reduced-motion/);
  assert.doesNotMatch(sheet, /backdrop-filter/);   // the base stays cheap: the blur is Liquid's, and it has its slow paths
});
