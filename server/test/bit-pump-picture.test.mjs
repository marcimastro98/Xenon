// Bit cannot pick a file of the person's: choose_pump_picture puts a row in the chat that
// opens their file picker, and the file goes to the pump as the menu's own button sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const Pumps = require('../js/menu/xenon-menu-pumps.js');
const { SHEET_OK, SCREEN_OK, clientActionRefusal } = require('../ai/ai-surface.js');
const { GROUPS } = require('../ai/ai-tool-groups.js');
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SERVER = 'http://127.0.0.1:3030';
const flush = () => new Promise((done) => setTimeout(done, 10));

// The few DOM calls the card makes, nothing more.
function node(tag) {
  const n = {
    tag, className: '', dataset: {}, attrs: {}, children: [], parentElement: null, textContent: '', disabled: false, listeners: {}, clicked: 0,
    setAttribute(k, v) { n.attrs[k] = v; },
    append(...kids) { for (const k of kids) n.appendChild(k); },
    appendChild(k) { k.parentElement = n; n.children.push(k); return k; },
    addEventListener(type, fn) { n.listeners[type] = fn; },
    querySelector(sel) { return n.children.find((c) => c.className.split(' ').includes(sel.slice(1))) || null; },
    closest(sel) {
      for (let at = n; at; at = at.parentElement) if (at.className.split(' ').includes(sel.slice(1))) return at;
      return null;
    },
    click() { n.clicked += 1; },
  };
  return n;
}

function cardRig({ upload = { ok: true, url: '/uploads/pump-1-ab.gif' }, run = { ok: true }, pumps = true } = {}) {
  const chat = node('div');
  const made = [];
  const listeners = {};
  const calls = [];
  let mirrored = 0;
  const window = {};
  const doc = {
    activeElement: null,
    getElementById: (id) => (id === 'ai-chat' ? chat : null),
    createElement: (tag) => { const n = node(tag); made.push(n); return n; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  if (pumps) {
    window.XenonMenuPumps = {
      ...Pumps,
      upload: async (server, file) => { calls.push(['upload', server, file.name]); return upload; },
    };
  }
  const fetch = async (url, init) => { calls.push(['run', url, JSON.parse(init.body)]); return { json: async () => run }; };
  const ctx = vm.createContext({
    window, document: doc, t: (key) => `<${key}>`, SERVER, fetch, setTimeout, mirrorChatCopies: () => { mirrored += 1; },
  });
  vm.runInContext(read('../js/ai/ai-ask-card.js'), ctx);
  const tap = (target) => listeners.click({ target });
  return { api: window.AiAskCard, chat, made, calls, tap, mirrored: () => mirrored };
}

async function offered(rig, args) {
  rig.api.pumpPicture(args);
  await flush();
  const card = rig.chat.children.at(-1);
  return { card, btn: card.children[0], note: card.children[1] };
}

async function pickFile(rig, btn, file) {
  rig.tap(btn);
  const input = rig.made.filter((n) => n.tag === 'input').at(-1);
  input.files = [file];
  input.listeners.change();
  await flush();
  return input;
}

test('the upload the menu and Bit share: the url, a file the pump refuses, a PC that does not answer', async () => {
  const sent = [];
  const answer = (d) => async (url, init) => { sent.push([url, init.method, init.body.get('asset').name]); return { json: async () => d }; };
  const gif = new File(['GIF89a'], 'cat.gif', { type: 'image/gif' });
  assert.deepEqual(await Pumps.upload(SERVER, gif, answer({ ok: true, url: '/uploads/a.gif' })), { ok: true, url: '/uploads/a.gif' });
  assert.deepEqual(sent, [[`${SERVER}/pump/picture`, 'POST', 'cat.gif']]);
  assert.deepEqual(await Pumps.upload(SERVER, gif, answer({ ok: false, error: 'bad_type' })), { ok: false, bad: true });
  assert.deepEqual(await Pumps.upload(SERVER, gif, answer({ ok: false, error: 'too_big' })), { ok: false, bad: true });
  assert.deepEqual(await Pumps.upload(SERVER, gif, answer(null)), { ok: false, bad: false });
  sent.length = 0;
  assert.deepEqual(await Pumps.upload(SERVER, { name: 'huge.gif', size: 21 * 1024 * 1024 }, answer({ ok: true })), { ok: false, bad: true });
  assert.deepEqual(sent, [], 'too big for the PC to keep: not even sent');
  assert.equal(Pumps.PICTURE_TYPES, 'image/png,image/jpeg,image/webp,image/gif,video/webm');
});

test('Bit offers a row under its reply that opens the file picker, never one of the answers that send words', async () => {
  const rig = cardRig();
  rig.api.pumpPicture({ screen: 'desk' });
  assert.equal(rig.chat.children.length, 0, 'the reply is drawn first, the row goes under it');
  const { card, btn, note } = await offered(rig, { screen: 'desk' });
  assert.equal(card.className, 'ai-ask-file');
  assert.equal(card.attrs.role, 'group');
  assert.equal(btn.className.includes('ai-choice'), false, 'a tap on .ai-choice sends its words as a message');
  assert.equal(btn.textContent, '<xmenu_pump_own>');
  assert.equal(btn.dataset.pumpScreen, 'desk');
  assert.equal(note.attrs.role, 'status');
  assert.equal(rig.mirrored(), 2, 'the copies of the chat get the row too');
  const input = await pickFile(rig, btn, new File(['GIF89a'], 'cat.gif'));
  assert.equal(input.type, 'file');
  assert.equal(input.accept, Pumps.PICTURE_TYPES);
  assert.equal(input.clicked, 1, 'opened inside the tap itself');
  assert.deepEqual(rig.calls, [
    ['upload', SERVER, 'cat.gif'],
    ['run', `${SERVER}/actions/run`, { type: 'pumpSet', screen: 'desk', patch: JSON.stringify({ base: { face: 'picture', items: ['/uploads/pump-1-ab.gif'] } }) }],
  ]);
  assert.equal(note.textContent, '<ai_ask_file_done>');
  assert.equal(btn.disabled, false, 'it can pick another one');
});

test('no screen named: the first pump; a strange screen value is cut, never trusted', async () => {
  const rig = cardRig();
  const { btn } = await offered(rig, {});
  assert.equal(btn.dataset.pumpScreen, '');
  const odd = await offered(rig, { screen: { id: 'x' } });
  assert.equal(odd.btn.dataset.pumpScreen, '');
  const long = await offered(rig, { screen: 'p'.repeat(90) });
  assert.equal(long.btn.dataset.pumpScreen.length, 24, 'as long as pumpSet takes (catalog-pump.js SCREEN)');
});

test('a file the pump refuses, a failed upload, a failed change, a page without the upload: said under the row', async () => {
  const refused = cardRig({ upload: { ok: false, bad: true } });
  let r = await offered(refused, {});
  await pickFile(refused, r.btn, new File(['x'], 'tool.exe'));
  assert.equal(r.note.textContent, '<xmenu_pump_own_bad>');
  assert.equal(refused.calls.some((c) => c[0] === 'run'), false, 'nothing changes');
  const down = cardRig({ upload: { ok: false, bad: false } });
  r = await offered(down, {});
  await pickFile(down, r.btn, new File(['GIF89a'], 'cat.gif'));
  assert.equal(r.note.textContent, '<xmenu_pump_own_failed>');
  const noRun = cardRig({ run: { ok: false, error: 'bad_screen' } });
  r = await offered(noRun, {});
  await pickFile(noRun, r.btn, new File(['GIF89a'], 'cat.gif'));
  assert.equal(r.note.textContent, '<xmenu_pump_own_failed>');
  const bare = cardRig({ pumps: false });
  r = await offered(bare, {});
  await pickFile(bare, r.btn, new File(['GIF89a'], 'cat.gif'));
  assert.equal(r.note.textContent, '<xmenu_pump_own_failed>');
  assert.deepEqual(bare.calls, []);
});

test('a row busy sending opens no second picker', async () => {
  const rig = cardRig();
  const { btn } = await offered(rig, {});
  btn.disabled = true;
  rig.tap(btn);
  assert.equal(rig.made.some((n) => n.tag === 'input'), false);
});

test('Bit has the tool in the pump group, the server lets it reach the chat, and the menu window runs it too', () => {
  assert.ok(GROUPS.pump_screen.tools.includes('choose_pump_picture'));
  assert.match(engineSource(), /const CLIENT_ACTIONS = new Set\(\[[^\]]*'choose_pump_picture'/);
  assert.ok(SHEET_OK.has('choose_pump_picture'));
  assert.equal(clientActionRefusal('choose_pump_picture', 'sheet'), null);
  assert.equal(SCREEN_OK.has('choose_pump_picture'), false, 'the alerts window has no chat rows to pick from');
  assert.match(read('../ai/core-tools-dashboard.js'), /\{ name: 'choose_pump_picture', description: "[^"]*file picker[^"]*", parameters: \{ type: 'OBJECT', properties: \{ screen: \{ type: 'STRING'/);
  assert.match(read('../js/ai/client-actions.js'), /case 'choose_pump_picture':\s*if \(window\.AiAskCard && AiAskCard\.pumpPicture\) AiAskCard\.pumpPicture\(args \|\| \{\}\);/);
  assert.match(read('../js/capabilities/catalog-pump.js'), /not uploaded yet call choose_pump_picture/);
  assert.equal(appStringsSource().match(/\bai_ask_file_done:/g)?.length, 11);
});
