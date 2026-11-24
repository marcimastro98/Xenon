// Goccia, Xenon's own style of the pump screen (js/pump/face-drop.js): the drop takes the tone of
// the hottest reading on it, moves faster as the PC works harder without restarting its shape,
// and the Sensors face puts its first reading large on it with the others under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function kit() {
  const { document } = makeDom();
  const window = {};
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  vm.runInContext(read('../js/pump/face-kit.js'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  vm.runInContext(read('../js/pump/face-drop.js'), ctx);
  vm.runInContext(read('../js/pump/face-sensors.js'), ctx);
  return { Kit: window.PumpFaceKit, document };
}

function drop() {
  const { Kit, document } = kit();
  const root = document.createElement('div');
  const part = Kit.get('part', 'drop')(root);
  const rates = [];
  part.node.getAnimations = () => [{ updatePlaybackRate: (r) => rates.push(r) }];
  return { Kit, root, part, rates };
}

test('the drop takes the tone of the hottest reading it carries', () => {
  const { Kit, root, part } = drop();
  assert.equal(root.dataset.drop, 'ok');
  part.set([Kit.reading('cpuTemp', { cpuTemp: 50 }), Kit.reading('gpuTemp', { gpuTemp: 84 })]);
  assert.equal(root.dataset.drop, 'warm');
  part.set([Kit.reading('cpuTemp', { cpuTemp: 95 }), Kit.reading('gpuTemp', { gpuTemp: 84 })]);
  assert.equal(root.dataset.drop, 'hot', 'hot wins over warm whatever the order');
  part.set([Kit.reading('cpuTemp', {})]);
  assert.equal(root.dataset.drop, 'ok', 'a missing reading is not warm');
});

test('the drop moves faster as the PC works harder, in steps, and only when the step changes', () => {
  const { Kit, part, rates } = drop();
  part.set([Kit.reading('cpuTemp', { cpuTemp: 30 })]);
  assert.deepEqual(rates, [], 'at rest it keeps its own pace, nothing to change');
  part.set([Kit.reading('cpuTemp', { cpuTemp: 95 })]);
  assert.deepEqual(rates, [3], 'working its hardest: three times faster');
  part.set([Kit.reading('cpuTemp', { cpuTemp: 94 })]);
  assert.deepEqual(rates, [3], 'a small change inside the same step does not touch the animation');
  part.set([Kit.reading('cpuTemp', { cpuTemp: 62 }), Kit.reading('gpuTemp', { gpuTemp: 30 })]);
  assert.deepEqual(rates, [3, 2], 'the busiest reading sets the pace');
});

test('Sensors on the drop: the first reading large, the others one to a line under it', () => {
  const { Kit, document } = kit();
  const root = document.createElement('div');
  const face = Kit.get('face', 'sensors')(root, { style: 'rings', readings: ['cpuTemp', 'gpuTemp', 'cpu'] });
  face.update({ system: { cpuTemp: 61, gpuTemp: 92, cpu: 40 } });
  assert.equal(root.querySelectorAll('.pf-drop').length, 1);
  assert.equal(root.querySelector('.pf-drop-label').textContent, Kit.reading('cpuTemp', {}).label);
  assert.equal(root.querySelector('.pf-drop-value .pf-num').textContent, '61');
  const cells = root.querySelectorAll('.pf-drop-cell');
  assert.equal(cells.length, 2);
  assert.equal(cells[0].querySelector('.pf-rest-value').dataset.tone, 'hot');
  assert.equal(root.dataset.drop, 'hot', 'a hot reading under the large one still turns the drop');
});

test('Bars and Numbers draw no drop', () => {
  const { Kit, document } = kit();
  for (const style of ['bars', 'numbers']) {
    const root = document.createElement('div');
    Kit.get('face', 'sensors')(root, { style, readings: ['cpuTemp'] }).update({ system: { cpuTemp: 50 } });
    assert.equal(root.querySelectorAll('.pf-drop').length, 0, style);
  }
});

test('the page loads the drop before the faces that draw on it, and its stylesheet', () => {
  const page = read('../pump-face.html');
  assert.ok(page.indexOf('js/pump/face-drop.js') > page.indexOf('js/pump/face-kit.js'));
  assert.ok(page.indexOf('js/pump/face-drop.js') < page.indexOf('js/pump/face-sensors.js'));
  assert.ok(page.includes('components/PumpFace/PumpFaceDrop.css'));
  // No motion when the system asks for none: the animations live only under no-preference.
  const css = read('../components/PumpFace/PumpFaceDrop.css');
  const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outside, /animation:/);
});

// The body of the rule with exactly this selector, comments left out.
function ruleOf(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = clean.indexOf(`${selector} {`);
  return at < 0 ? '' : clean.slice(at, clean.indexOf('}', at));
}

test('what is behind the drop is seen: a glow around it, a picture through it', () => {
  const css = read('../components/PumpFace/PumpFaceDrop.css');
  // The layer's glow is a radial in the middle, all under the drop: on a drop it is the drop's own
  // colour spilling round it, warm and hot with it.
  assert.match(ruleOf(css, '.pf-bg-glow.pf-face[data-drop]'), /background-image:\s*none/);
  const halo = ruleOf(css, '.pf-bg-glow .pf-drop::before');
  assert.match(halo, /radial-gradient\([^;]*var\(--drop-c\)/);
  assert.match(halo, /inset:\s*-\d+%/, 'it reaches past the drop');
  // A picture: bright, the drop glass, the deeper drop out of the way.
  assert.match(ruleOf(css, '.pf-face[data-drop] > .pf-bg-pic'), /brightness\(0\.[89]\d*\)/);
  assert.match(ruleOf(css, '.pf-has-bg .pf-drop-front'), /color-mix\(in oklab, var\(--drop-c\) \d+%, transparent\)/);
  assert.match(ruleOf(css, '.pf-has-bg .pf-drop-back'), /display:\s*none/);
  // On the other faces the words sit on the picture: shaded in the middle only, not all over.
  assert.match(ruleOf(read('../components/PumpFace/PumpFace.css'), '.pf-has-bg:not([data-drop])::after'), /radial-gradient/);
});
