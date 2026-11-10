// The window that chooses the speaker or the mic (js/picker.js): real keys, the one in use
// marked, an empty list that says so, Esc, and nothing left behind when it closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/picker.js');

const SPEAKERS = [
  { id: 'a', name: 'Speakers', label: 'Realtek Audio' },
  { id: 'b', name: 'Headset', label: 'Headset' },
];

function rig(audioData = { speakers: SPEAKERS, mics: [], speaker: { id: 'b' }, mic: null }, withFocus = true) {
  const { document, descendants } = makeDom();
  const pickerOverlay = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  const pickerTitle = document.createElement('div');
  const pickerList = document.createElement('div');
  panel.append(pickerTitle, pickerList);
  pickerOverlay.append(panel);
  document.body.append(pickerOverlay);

  const frozen = new Set();
  const held = [];
  const posts = [];
  const window = { ambientFreeze: (token, on) => { if (on) frozen.add(token); else frozen.delete(token); } };
  if (withFocus) {
    window.DialogFocus = {
      hold(root, { onEsc }) {
        const entry = { root, onEsc };
        held.push(entry);
        return () => held.splice(held.indexOf(entry), 1);
      },
    };
  }
  const ctx = {
    window, document, audioData, pickerOverlay, pickerTitle, pickerList, SERVER: '', t: (k) => k,
    fetch: async (path, init) => { posts.push([path, JSON.parse(init.body).id]); return { ok: true }; },
    setOnline() {}, setOffline() {}, fetchAudio() {}, setTimeout: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const rows = () => pickerList.children;
  const has = (node, cls) => descendants(node).find((n) => String(n.className).split(' ').includes(cls)) || null;
  return { ctx, panel, pickerOverlay, pickerList, frozen, held, posts, rows, has };
}

test('every device is a real key, so the keyboard can reach it', () => {
  const r = rig();
  r.ctx.openPicker('speaker');
  assert.deepEqual(r.rows().map((row) => [row.tag, row.type]), [['button', 'button'], ['button', 'button']]);
});

test('the one in use carries the check, the others nothing', () => {
  const r = rig();
  r.ctx.openPicker('speaker');
  const [other, inUse] = r.rows();
  assert.equal(inUse.getAttribute('aria-current'), 'true');
  assert.ok(r.has(inUse, 'picker-check').classList.contains('checked'));
  assert.ok(!other.getAttribute('aria-current'));
  assert.ok(!r.has(other, 'picker-check').classList.contains('checked'));
});

test('a second line only when it says something the name does not', () => {
  const r = rig();
  r.ctx.openPicker('speaker');
  const [named, same] = r.rows();
  assert.equal(r.has(named, 'picker-item-label').textContent, 'Realtek Audio');
  assert.equal(r.has(same, 'picker-item-label'), null);
});

test('no devices says so, and a list the server never sent is not a crash', () => {
  for (const audio of [{ speakers: [], mics: [] }, {}]) {
    const r = rig(audio);
    r.ctx.openPicker('speaker');
    assert.equal(r.rows().length, 1);
    assert.equal(r.rows()[0].className, 'picker-empty');
    assert.equal(r.rows()[0].textContent, 'picker_none');
  }
});

test('Esc closes it, and closing leaves nothing held or frozen', () => {
  const r = rig();
  r.ctx.openPicker('speaker');
  assert.equal(r.held[0].root, r.panel);
  assert.ok(r.frozen.has('device-picker'));
  r.held[0].onEsc();
  assert.equal(r.pickerOverlay.classList.contains('open'), false);
  assert.equal(r.held.length, 0);
  assert.equal(r.frozen.size, 0);
  r.ctx.closePicker();
  r.ctx.openPicker('mic');
  assert.equal(r.held.length, 1, 'and it opens again');
});

test('choosing a device closes the window and asks for that device', async () => {
  const r = rig();
  r.ctx.openPicker('speaker');
  r.rows()[0].click();
  await settle();
  assert.deepEqual(r.posts, [['/speaker/set', 'a']]);
  assert.equal(r.held.length, 0);
});

test('it still opens on a page without the keyboard helper', () => {
  const r = rig(undefined, false);
  r.ctx.openPicker('speaker');
  assert.ok(r.pickerOverlay.classList.contains('open'));
  r.ctx.closePicker();
  assert.equal(r.pickerOverlay.classList.contains('open'), false);
});

test('closed it stays in the page, so Tab must not walk into its rows', () => {
  const css = read('../components/DevicePicker/DevicePicker.css');
  const closed = css.slice(css.indexOf('.picker-overlay {'), css.indexOf('.picker-overlay.open'));
  assert.match(closed, /visibility: hidden/);
  assert.match(css, /\.picker-overlay\.open \{[^}]*visibility: visible/);
});

test('the widget window carries what the picker needs, in order', () => {
  const layer = read('../js/layer-tiles.js');
  const system = layer.slice(layer.indexOf('const SYSTEM'), layer.indexOf('};', layer.indexOf('const SYSTEM')));
  assert.ok(system.includes("'styles/liquid-sheets.css'"));
  assert.ok(system.indexOf("'js/dialog-focus.js'") > 0 && system.indexOf("'js/dialog-focus.js'") < system.indexOf("'js/picker.js'"));
});
