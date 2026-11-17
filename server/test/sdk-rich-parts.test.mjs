// Badges and mini slots as rich as Vitals (Nov 2026, asked by a widget creator):
// icons by name or path, per-part colours and sizes, Vitals-like meters with
// their own tap and detail card, and badges made of several parts. Everything is
// drawn by the host from schema-validated values; these tests run the real
// browser scripts on the small DOM in mini-dom.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = join(HERE, '..', 'js');
const SCRIPTS = [
  'sdk-island-schema.js', 'deck-icons.js', 'sdk-block-render.js', 'sdk-badges.js',
].map((rel) => readFileSync(join(JS, rel), 'utf8'));

function rig() {
  const { document, descendants } = makeDom();
  const host = document.createElement('span');
  host.id = 'clock-sdkbadges';
  document.body.append(host);
  const window = { t: (k) => (k === 'close' ? 'Close' : k) };
  const ctx = { window, document, setInterval: () => 1, clearInterval: () => {} };
  ctx.globalThis = window;
  for (const src of SCRIPTS) vm.runInNewContext(src, ctx);
  return { window, document, host, all: () => descendants(document.body) };
}

const byClass = (nodes, cls) => nodes.filter((n) => n.classList && n.classList.contains(cls));

test('badge: normalize keeps 32 characters, a named or drawn icon, a size and its parts', () => {
  const { window } = rig();
  const view = window.SdkBadges.normalize({
    op: 'set', text: 'x'.repeat(50), icon: '🔋', iconName: 'battery', iconPath: 'M2 2h20v20H2z',
    color: '#22c55e', size: 'large', tooltip: 'Batteries',
    blocks: [{ type: 'meter', name: 'mouse', value: 0.35, label: '35%', id: 'mouse' }, { type: 'button', id: 'b', label: 'No' }],
  });
  assert.equal(view.text.length, 32);
  assert.deepEqual({ ...view.icon }, { text: '🔋', name: 'battery', path: 'M2 2h20v20H2z' });
  assert.equal(view.size, 'large');
  assert.deepEqual(JSON.parse(JSON.stringify(view.blocks.map((b) => b.type))), ['meter']);
  assert.equal(window.SdkBadges.normalize({ op: 'set', text: '  ' }), null, 'an empty chip is a clear');
  assert.equal(window.SdkBadges.normalize({ op: 'set', blocks: [{ type: 'meter', icon: '🎧', value: 1 }] }).text, '');
});

test('icons: a library name draws the app icon, a path draws the widget shape, else the glyph', () => {
  const { window, all } = rig();
  window.SdkBadges.set('pkg.a', window.SdkBadges.normalize({ text: 'a', iconName: 'mouse', icon: '🖱' }), null);
  window.SdkBadges.set('pkg.b', window.SdkBadges.normalize({ text: 'b', iconPath: 'M1 1h22v22H1z' }), null);
  window.SdkBadges.set('pkg.c', window.SdkBadges.normalize({ text: 'c', iconName: 'noSuchIcon', icon: '★' }), null);
  const icons = byClass(all(), 'sdk-badge-ico');
  assert.equal(icons.length, 3);
  const pathOf = (node) => node.children[0] && node.children[0].children[0] && node.children[0].children[0].getAttribute('d');
  assert.equal(pathOf(icons[0]), window.DeckIcons.el('mouse').children[0].getAttribute('d'));
  assert.equal(pathOf(icons[1]), 'M1 1h22v22H1z');
  assert.equal(icons[2].textContent, '★');
});

test('badge meters: a tap posts its id only with the tap grant; the chip is then not a button', () => {
  const { window, all } = rig();
  const sent = [];
  const view = window.SdkBadges.normalize({
    blocks: [
      { type: 'meter', name: 'mouse', value: 0.35, label: '35%', id: 'mouse' },
      { type: 'meter', name: 'keyboard', value: 0.5, label: '50%', id: 'kb' },
    ],
  });
  window.SdkBadges.set('pkg.tgk', view, (id) => sent.push(id || '(chip)'));
  const chip = byClass(all(), 'sdk-badge')[0];
  assert.equal(chip.tag, 'span', 'pressable meters inside: the chip itself is no button');
  const meters = byClass(all(), 'sdk-meter');
  assert.deepEqual(meters.map((m) => m.tag), ['button', 'button']);
  meters[1].click();
  assert.deepEqual(sent, ['kb']);

  window.SdkBadges.set('pkg.tgk', view, null);
  const plain = byClass(all(), 'sdk-meter');
  assert.deepEqual(plain.map((m) => m.tag), ['span', 'span'], 'no grant: the meters are read-only');
});

test('badge without pressable parts keeps the whole-chip tap', () => {
  const { window, all } = rig();
  const sent = [];
  window.SdkBadges.set('pkg.x', window.SdkBadges.normalize({ text: '12', blocks: [{ type: 'meter', icon: '⚡', value: 1 }] }), (id) => sent.push(id === undefined ? 'chip' : id));
  const chip = byClass(all(), 'sdk-badge')[0];
  assert.equal(chip.tag, 'button');
  chip.click();
  assert.deepEqual(sent, ['chip']);
});

test('detail card: a meter opens a host-drawn card, text only, and Escape closes it', () => {
  const { window, document, all } = rig();
  const view = window.SdkBadges.normalize({
    blocks: [{
      type: 'meter', name: 'headset', value: 0.9, color: '#38bdf8',
      detail: { title: 'Headset', note: '<b>not markup</b>', rows: [{ label: 'Battery', value: '90%', progress: 0.9, name: 'battery' }] },
    }],
  });
  window.SdkBadges.set('pkg.hs', view, null);
  const meter = byClass(all(), 'sdk-meter')[0];
  assert.equal(meter.tag, 'button', 'a detail makes the meter pressable even without the tap grant');
  meter.click();
  const card = byClass(all(), 'sdk-detail-card')[0];
  assert.ok(card, 'the card opened');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(byClass(all(), 'sdk-detail-title')[0].textContent, 'Headset');
  assert.equal(byClass(all(), 'sdk-detail-note')[0].textContent, '<b>not markup</b>');
  assert.equal(byClass(all(), 'sdk-detail-value')[0].textContent, '90%');
  assert.equal(byClass(all(), 'sdk-detail-close')[0].getAttribute('aria-label'), 'Close');
  (document._handlers.keydown || []).slice().forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(byClass(all(), 'sdk-detail-card').length, 0, 'Escape closed it');
  assert.equal((document._handlers.keydown || []).length, 0, 'and took its key listener with it');
});

test('bars: the widget shape and colour travel as custom properties, never a style string', () => {
  const { window } = rig();
  const node = window.SdkBlockRender.render({ type: 'progress', value: 0.4, width: 30, height: 4, color: '#ff8800', orientation: 'vertical' });
  assert.ok(node.classList.contains('is-vertical'));
  assert.equal(node.style.getPropertyValue('--sdk-bar-w'), '30px');
  assert.equal(node.style.getPropertyValue('--sdk-bar-h'), '4px');
  assert.equal(node.style.getPropertyValue('--sdk-part-color'), '#ff8800');
  assert.equal(node.children[0].style.getPropertyValue('--sdk-bar-level'), '0.4');
});

test('text: colour and size classes only when the widget asked', () => {
  const { window } = rig();
  const plain = window.SdkBlockRender.render({ type: 'text', text: 'a', tone: 'primary', weight: 'normal', maxLines: 1 });
  assert.equal(plain.className, 'sdk-island-text');
  const styled = window.SdkBlockRender.render({ type: 'text', text: 'b', tone: 'primary', weight: 'strong', maxLines: 1, size: 'small', color: '#123456' });
  assert.equal(styled.className, 'sdk-island-text is-strong is-small has-color');
  assert.equal(styled.style.getPropertyValue('--sdk-part-color'), '#123456');
});
