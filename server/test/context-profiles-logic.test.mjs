import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { profileIsActive, decideContextAction } = require('../js/context-profiles.js');

// Pure decision core of Smart context profiles (the DOM/timer controller is
// browser-only and skipped when window is undefined, as here under node).

test('profileIsActive is true only when a dimension is set', () => {
  assert.equal(profileIsActive(null), false);
  assert.equal(profileIsActive({ page: '', lighting: '', deck: '' }), false);
  assert.equal(profileIsActive({ page: 'games', lighting: '', deck: '' }), true);
  assert.equal(profileIsActive({ page: '', lighting: 'cycle', deck: '' }), true);
  assert.equal(profileIsActive({ page: '', lighting: '', deck: 'Stream' }), true);
});

const CONFIG = {
  enabled: true,
  revertOnExit: true,
  map: {
    gaming: { page: 'games', lighting: 'cycle', deck: '' },
    coding: { page: '', lighting: '', deck: '' }, // present but empty → no profile
  },
};

test('decideContextAction: apply when the activity has a profile', () => {
  assert.equal(decideContextAction(CONFIG, 'gaming', false), 'apply');
  assert.equal(decideContextAction(CONFIG, 'gaming', true), 'apply');
});

test('decideContextAction: revert only when a baseline is held and revert is on', () => {
  // coding has an empty profile → treated as "no profile"
  assert.equal(decideContextAction(CONFIG, 'coding', true), 'revert');
  assert.equal(decideContextAction(CONFIG, 'coding', false), 'noop'); // nothing to revert
  assert.equal(decideContextAction(CONFIG, 'other', true), 'revert');
  assert.equal(decideContextAction({ ...CONFIG, revertOnExit: false }, 'other', true), 'noop');
});

test('decideContextAction: disabled or missing config is always noop', () => {
  assert.equal(decideContextAction({ ...CONFIG, enabled: false }, 'gaming', true), 'noop');
  assert.equal(decideContextAction(null, 'gaming', true), 'noop');
  assert.equal(decideContextAction({ enabled: true }, 'gaming', false), 'noop'); // no map
});
