// The steps that keep the iCUE session up ask for a repaint through lights/paint-hook.js, so they
// can live in a module the painting code requires. Before lighting.js is loaded the hook throws
// (a wiring fault must be loud); loaded, it is lighting's own apply(). What a repaint then does is
// in lighting-cycle.test.mjs. The call after a motherboard was woken cannot be run here (waking
// one talks to a USB controller of the PC the test runs on), so its line is read instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { paint } = require('../lights/paint-hook.js');

test('asked before lighting.js is loaded, the hook says so', () => {
  assert.throws(() => paint.apply(), /a repaint was asked before lighting\.js said how to paint/);
});

test('loading lighting.js puts its apply() in the hook, once, for every module that holds it', () => {
  require('../lights/lighting.js');
  assert.equal(typeof paint.apply, 'function');
  assert.equal(paint.apply.name, 'apply');
  assert.equal(require('../lights/paint-hook.js').paint, paint, 'one object, shared by require');
});

test('the four steps of the session repaint through the hook, and none calls apply() by name', () => {
  const src = engineSource('server/lights/lighting.js');
  const body = (name) => {
    const at = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(at >= 0, `${name} is there`);
    return src.slice(at, src.indexOf('\n}', at));
  };
  for (const name of ['wakeVendorBoard', 'tickAnimation', 'maybeReenumerate']) {
    assert.match(body(name), /paint\.apply\(\)/, name);
    assert.doesNotMatch(body(name), /(?<![.\w])apply\(\)/, name);
  }
  assert.match(src, /^function onConnected\(\) \{ paint\.apply\(\); \}$/m);
  assert.match(src, /^paint\.apply = apply;/m);
});
