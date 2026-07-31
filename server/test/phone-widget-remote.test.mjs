import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'phone-widget.js'), 'utf8');

// Calling and texting from a paired phone or tablet are refused by
// server/remote-access.js, deliberately: a call's audio comes out of the PC, so
// one placed from another room would be a call nobody could hear, and a message
// leaves under the user's own number from a device they might lose.
//
// The refusal was right and its TIMING was wrong. Reported from a real phone:
// every row in the call log invited a tap, the confirm sheet came up naming the
// contact and the number, the Call button was there — and it answered with a
// "this is done on the PC" toast. A control offered and then refused is the
// failure this codebase avoids everywhere else, and it is the one shape a
// server-side allowlist can never fix on its own.
//
// The other half of the same report was that the confirm sheet rendered
// see-through over the list behind it, so the decision could not be read even
// when it was legitimately being asked. That is CSS and is asserted at the end.

const LABELS = {
  phone_remote_note: 'Chiamate e messaggi partono dal PC.',
  phone_tab_recents: 'Recenti',
  phone_tab_contacts: 'Rubrica',
  phone_tab_messages: 'Messaggi',
  phone_tab_dial: 'Tastierino',
  phone_call: 'Chiama',
  phone_new_message: 'Nuovo messaggio',
  phone_unknown: 'Sconosciuto',
};

const STATUS = { ok: true, canDial: true, pbap: true, telephony: true, map: true, device: 'iPhone' };
const CALLS = [
  { name: 'Mamma Nadia', number: '+393478594466', direction: 'out', at: Date.now() - 6e5 },
  { name: '', number: '+390912570471', direction: 'out', at: Date.now() - 12e5 },
];

/**
 * Mount the widget with one tile, on the PC or on a paired device.
 * `api` is stubbed, so nothing here touches the network or a real phone.
 */
async function mount({ remote = false } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;

  const tile = mkEl('div');
  tile.setAttribute('data-dashboard-widget', 'phone');
  const page = mkEl('div');
  page.className = 'pager-page';
  page.appendChild(tile);
  document.body.appendChild(page);

  const calledPaths = [];
  const sandbox = {
    document,
    window: null,
    console: { warn: () => {}, error: () => {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date, Math, JSON, Array, String, Number, Object, Promise, RegExp, Intl,
    makeEl: (tag, cls, text) => {
      const n = mkEl(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    apiJson: async (path) => {
      calledPaths.push(path);
      if (path.startsWith('/api/phone/calls')) return { ok: true, list: CALLS };
      if (path.startsWith('/api/phone/contacts')) return { ok: true, list: [] };
      if (path.startsWith('/api/phone/messages')) return { ok: true, list: [] };
      if (path.startsWith('/api/phone')) return STATUS;
      return null;
    },
  };
  sandbox.window = sandbox;
  sandbox.window.t = (k) => LABELS[k] || '';
  if (remote) sandbox.window.__xenonRemote = { name: 'iPhone di Marcello' };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'phone-widget.js' });

  sandbox.PhoneWidget.renderWidgets();
  await settle();
  sandbox.PhoneWidget.renderWidgets();
  await settle();
  return { ...dom, tile, sandbox, calledPaths, PhoneWidget: sandbox.PhoneWidget };
}

const tabNames = (tile) => tile.querySelectorAll('.phw-tab').map((n) => n.textContent);

// ── On the PC, nothing changes ───────────────────────────────────────────────

test('on the PC the widget still dials, writes and offers the keypad', async () => {
  const { tile } = await mount();
  assert.ok(tabNames(tile).includes('Tastierino'), 'the keypad tab must still be there');
  assert.equal(tile.querySelector('.phw-remote-note'), null, 'no explanation is owed on the PC');

  const rows = tile.querySelectorAll('.phw-row');
  assert.ok(rows.length >= 2, 'the call log should have rendered');
  for (const r of rows) {
    assert.ok(r.classList.contains('is-callable'), 'every row with a number is callable on the PC');
    assert.equal(r.disabled, false);
  }
});

test('tapping a row on the PC opens the confirm sheet, naming the number in full', async () => {
  const { tile } = await mount();
  tile.querySelectorAll('.phw-row')[0].click();
  const sheet = tile.querySelector('.phw-confirm');
  assert.ok(sheet, 'a call must ask first — that has always been the rule here');
  assert.equal(sheet.querySelector('.phw-confirm-name').textContent, 'Mamma Nadia');
  assert.equal(sheet.querySelector('.phw-confirm-num').textContent, '+393478594466',
    'a name alone would hide what is about to be dialled');
});

// ── On a paired device, it says so instead of pretending ─────────────────────

test('a paired device is told where calls are placed, before it taps anything', async () => {
  const { tile } = await mount({ remote: true });
  const note = tile.querySelector('.phw-remote-note');
  assert.ok(note, 'the explanation must be on screen, not inside a refusal');
  assert.equal(note.textContent, LABELS.phone_remote_note);
});

test('a paired device is not offered the keypad, which can only dial', async () => {
  const { tile } = await mount({ remote: true });
  const tabs = tabNames(tile);
  assert.equal(tabs.includes('Tastierino'), false, 'the keypad has no read-only use');
  // Everything that READS is untouched: that is the whole point of the surface.
  assert.deepEqual(tabs, ['Recenti', 'Rubrica', 'Messaggi']);
});

test('a row on a paired device cannot open a call it would not be allowed to place', async () => {
  const { tile } = await mount({ remote: true });
  const rows = tile.querySelectorAll('.phw-row');
  assert.ok(rows.length >= 2, 'the call log must still be readable');
  for (const r of rows) {
    assert.equal(r.classList.contains('is-callable'), false);
    assert.equal(r.disabled, true, 'inert, and explained by the note above');
  }
  rows[0].click();
  assert.equal(tile.querySelector('.phw-confirm'), null,
    'the sheet must never appear on a surface whose Call button could only fail');
});

test('the call log itself is still read from the phone on a paired device', async () => {
  const { calledPaths, tile } = await mount({ remote: true });
  assert.ok(calledPaths.some((p) => p.startsWith('/api/phone/calls')), 'reading must not be gated');
  assert.equal(tile.querySelectorAll('.phw-row').length, CALLS.length);
  assert.ok(tile.querySelectorAll('.phw-name').map((n) => n.textContent).includes('Mamma Nadia'));
});

// ── The sheet, when it is legitimately shown, has to be readable ─────────────

test('the confirm sheet is painted opaque, not with the translucent tile token', () => {
  const css = readFileSync(join(HERE, '..', 'components', 'PhoneWidget', 'PhoneWidget.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf('.phw-confirm-card {');
  assert.notEqual(at, -1, 'the confirm card rule was not located');
  const block = bare.slice(at, bare.indexOf('}', at));

  // `var(--panel)` carries --panel-alpha, so a card painted with it is
  // translucent — which is right for a tile over the wallpaper and wrong for a
  // dialog over a LIST. Reported: the call log showed straight through it and
  // the whole decision was unreadable.
  assert.equal(/background:\s*var\(--panel[,)]/.test(block), false,
    'the confirm card must not be painted with the translucent tile token');
  assert.match(block, /background:\s*rgb\(var\(--panel-rgb/,
    'it must use the panel colour with the alpha dropped, like the other decision dialogs');
  // A dialog that themes only one way is unreadable on the other half.
  assert.match(bare, /\[data-appearance="light"\]\s*\.phw-confirm-card/,
    'the opaque card needs a light-palette answer too');
});
