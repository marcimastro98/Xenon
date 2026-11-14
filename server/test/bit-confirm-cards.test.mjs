// The two cards where Bit asks before doing something: a Deck action (js/ai-deck-confirm.js) and
// a command on the PC (_aiShowPcConfirm in js/ai.js). They can come up while the next message is
// being typed, so a stray key must never say yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom, settle, windowKeys } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const FOCUS = read('../js/dialog-focus.js');
const DECK = read('../js/ai-deck-confirm.js');
const AI = read('../js/ai.js');
const PC = AI.slice(AI.indexOf('// The card on screen: a newer one'), AI.indexOf('function _aiRenderPcResult'));

function rig(extraWindow = {}) {
  const { document, descendants } = makeDom();
  const posts = [];
  const frozen = new Set();
  const window = {
    ambientFreeze: (token, on) => { if (on) frozen.add(token); else frozen.delete(token); },
    ...extraWindow,
  };
  const keys = windowKeys(window);
  const fetch = async (path, init) => {
    posts.push([path, JSON.parse(init.body).nonce]);
    return { json: async () => ({ ok: true }) };
  };
  const ctx = {
    window, document, fetch, clearTimeout, console, t: () => '',
    aiListening: false, _aiFollowupTimer: null, _aiPcConfirmOpen: false, _aiVoiceSessionActive: false,
    _aiStartFollowupListen() {}, _aiStopServerRecorder() {},
    _aiRenderPcResult(_card, row, _data, close) { row.remove(); ctx.closeResult = close; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${FOCUS}\n${DECK}\n${PC}\n;globalThis.showPc = _aiShowPcConfirm;`, ctx);
  const trigger = document.createElement('input');
  document.body.append(trigger);
  trigger.focus();
  const press = (key) => keys.slice().forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} }));
  const find = (cls) => descendants(document.body).find((n) => String(n.className).split(' ').includes(cls)) || null;
  return { window, ctx, document, descendants, keys, posts, frozen, trigger, press, find };
}

const deck = (r, hooks = {}, extra = {}) => r.window.AiDeckConfirm.open({
  nonce: 'n1', type: 'openApp', params: [{ name: 'path', value: 'C:\\Apps\\music.exe' }], description: 'Open the music.', ...extra,
}, hooks);
const pc = (r, nonce = 'p1') => r.ctx.showPc({ nonce, command: 'Get-Process | Select-Object -First 5', description: 'List five programs.' });

test('the keyboard lands on the card, not on the key that says yes', () => {
  for (const open of [deck, pc]) {
    const r = rig();
    open(r);
    const card = r.find('ai-pc-card');
    assert.equal(r.document.activeElement, card);
    assert.notEqual(r.document.activeElement, r.find('ai-pc-run'));
    assert.equal(card.tabIndex, -1);
    assert.equal(card.getAttribute('role'), 'dialog');
  }
});

test('Esc is Cancel: the server hears it, the focus comes back, the background thaws', () => {
  const r = rig();
  let closed = 0;
  deck(r, { onClose() { closed += 1; } });
  assert.ok(r.frozen.has('deck-confirm'));
  r.press('Escape');
  assert.deepEqual(r.posts, [['/ai/deck-cancel', 'n1']]);
  assert.equal(closed, 1);
  assert.equal(r.find('ai-pc-card'), null);
  assert.equal(r.document.activeElement, r.trigger);
  assert.equal(r.frozen.size, 0);
  assert.equal(r.keys.length, 0, 'nothing keeps listening');
});

test('with the answer on screen Esc only closes: there is nothing left to cancel', async () => {
  const r = rig();
  deck(r);
  r.find('ai-pc-run').click();
  await settle();
  assert.deepEqual(r.posts, [['/ai/deck-run', 'n1']]);
  r.press('Escape');
  assert.deepEqual(r.posts, [['/ai/deck-run', 'n1']]);
  assert.equal(r.find('ai-pc-card'), null);
});

test('a newer card takes the old one\'s place and does not leave the keyboard shut', () => {
  for (const open of [(r) => deck(r, {}, { nonce: 'n2' }), (r) => pc(r, 'p2')]) {
    const r = rig();
    open(r);
    open(r);
    assert.equal(r.descendants(r.document.body).filter((n) => String(n.className).split(' ').includes('ai-pc-card')).length, 1);
    r.press('Escape');
    assert.equal(r.find('ai-pc-card'), null);
    assert.equal(r.keys.length, 0, 'a card replaced without letting go would hold Tab and Esc for good');
  }
});

test('a Deck card names things the way the editor does, and shows the values as they are', () => {
  const words = { deck_act_openApp: 'Open app', deck_param_path: 'Path' };
  const r = rig({ t: (k) => words[k] || k });
  deck(r, {}, { params: [{ name: 'path', value: 'C:\\Apps\\music.exe' }, { name: 'odd', value: '<b>raw</b>' }] });
  assert.equal(r.find('ai-pc-detail-name').textContent, 'Open app');
  const rows = r.descendants(r.document.body).filter((n) => n.className === 'ai-pc-detail')
    .map((row) => row.children.map((part) => part.textContent));
  assert.deepEqual(rows, [['Path', 'C:\\Apps\\music.exe'], ['odd', '<b>raw</b>']]);
  assert.equal(r.find('ai-pc-cmd'), null, 'code is for the command on the PC, which must be read word for word');
});

test('the command on the PC stays word for word', () => {
  const r = rig();
  pc(r);
  assert.equal(r.find('ai-pc-cmd').textContent, 'Get-Process | Select-Object -First 5');
  r.press('Escape');
  assert.deepEqual(r.posts, [['/ai/pc-cancel', 'p1']]);
  assert.equal(r.ctx._aiPcConfirmOpen, false, 'the mic may listen again');
});

test('Bit opens the card when it can, and the card still works when it cannot', () => {
  const placed = [];
  const r = rig({ BitApp: { showIcon: (_host, clip) => placed.push(clip) } });
  deck(r);
  assert.deepEqual(placed, ['idle']);
  assert.ok(rig().window.AiDeckConfirm.head);
});
