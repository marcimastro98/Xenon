// When the engine opens the dashboard in the browser by itself.
//
// Up to 5.1.0 a scheduled task ran a script at sign-in and the script opened the tab. The
// script is gone (antivirus software deleted it), and the engine does it now: it starts at
// sign-in anyway. But the engine also starts after an update, after a crash, when somebody
// restarts it by hand, in a test and as a copy on another port, and none of those may open a
// tab. This is the rule that tells them apart, as one function of facts handed in, so every
// case is checked here without a system, a browser or a clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signInOpenDecision, SIGN_IN_WINDOW_MS, INSTALLED_PORT } = require('../install/browser-auto-open.js');

const MINUTE = 60 * 1000;
/** A start one minute after a sign-in nobody met yet, by someone who asked for the tab in a browser. */
const signInStart = (changed = {}) => ({
  sideCopy: false,
  signIn: { id: 'sign-in-1', ageMs: MINUTE },
  seenId: '',
  armed: true,
  wanted: true,
  appAtSignIn: false,
  canOpen: true,
  ...changed,
});

test('the start of a sign-in opens the tab for someone who asked for it', () => {
  assert.deepEqual(signInOpenDecision(signInStart()), { open: true, why: 'sign_in', remember: true });
});

test('a copy beside the installed engine never opens anything and uses no sign-in up', () => {
  assert.deepEqual(signInOpenDecision(signInStart({ sideCopy: true })), { open: false, why: 'side_copy', remember: false });
  assert.equal(INSTALLED_PORT, 3030, 'the installed engine is the one on 3030');
});

test('a start the system cannot place in a sign-in opens nothing', () => {
  for (const signIn of [null, undefined, {}, { id: '', ageMs: 0 }, { id: 7, ageMs: 0 }]) {
    assert.deepEqual(signInOpenDecision(signInStart({ signIn })), { open: false, why: 'start_unknown', remember: false });
  }
});

test('a restart in the same session opens nothing: an update, a crash, a restart by hand', () => {
  const again = signInStart({ seenId: 'sign-in-1' });
  assert.deepEqual(signInOpenDecision(again), { open: false, why: 'sign_in_seen', remember: false });
  // Even seconds after the sign-in: what counts is that a start already met it.
  assert.equal(signInOpenDecision({ ...again, signIn: { id: 'sign-in-1', ageMs: 5000 } }).open, false);
});

test('a first start long after the sign-in is not the sign-in, and still uses it up', () => {
  const late = signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs: SIGN_IN_WINDOW_MS + 1 } }));
  assert.deepEqual(late, { open: false, why: 'not_a_sign_in', remember: true });
  assert.equal(signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs: SIGN_IN_WINDOW_MS } })).open, true, 'the limit itself is inside');
  assert.equal(signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs: 0 } })).open, true);
});

test('a start the clock puts before the sign-in, or nowhere, opens nothing', () => {
  for (const ageMs of [-1, -MINUTE, Number.NaN, undefined, null, '60000', Number.POSITIVE_INFINITY]) {
    const verdict = signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs } }));
    assert.equal(verdict.open, false, String(ageMs));
  }
  assert.equal(signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs: -1 } })).why, 'not_a_sign_in');
});

test('nobody asked in a real browser: no tab, whatever the switch says by default', () => {
  // The switch is on for everyone by default. Someone who only ever used the app, or a
  // screen that embeds the dashboard, never asked, and never gets a browser tab.
  for (const armed of [false, undefined, null, 'true', 1]) {
    assert.deepEqual(signInOpenDecision(signInStart({ armed })), { open: false, why: 'never_asked', remember: true });
  }
});

test('the switch turned off: no tab', () => {
  assert.deepEqual(signInOpenDecision(signInStart({ wanted: false })), { open: false, why: 'switched_off', remember: true });
});

test('the Xenon app opens at sign-in and shows the dashboard: no browser tab beside it', () => {
  assert.deepEqual(signInOpenDecision(signInStart({ appAtSignIn: true })), { open: false, why: 'app_shows_it', remember: true });
});

test('a system with no way to open a browser from the engine: no tab', () => {
  assert.deepEqual(signInOpenDecision(signInStart({ canOpen: false })), { open: false, why: 'cannot_open', remember: true });
});

test('one tab per sign-in, however many times the engine starts in it', () => {
  // The caller writes the sign-in down whenever `remember` says so; played here as it does.
  let seenId = '';
  const start = (changed) => {
    const verdict = signInOpenDecision(signInStart({ seenId, ...changed }));
    if (verdict.remember) seenId = changed.signIn.id;
    return verdict.open;
  };
  const monday = (ageMs) => ({ signIn: { id: 'monday', ageMs } });
  assert.equal(start(monday(MINUTE)), true, 'the sign-in');
  assert.equal(start(monday(2 * MINUTE)), false, 'an update a minute later');
  assert.equal(start(monday(3 * MINUTE)), false, 'a crash and restart');
  assert.equal(start(monday(8 * 60 * MINUTE)), false, 'a restart in the evening');
  assert.equal(start({ signIn: { id: 'tuesday', ageMs: MINUTE } }), true, 'the next sign-in');
});

test('a sign-in that got no tab does not get one from a later start either', () => {
  let seenId = '';
  const start = (changed) => {
    const verdict = signInOpenDecision(signInStart({ seenId, ...changed }));
    if (verdict.remember) seenId = 'sign-in-1';
    return verdict;
  };
  assert.equal(start({ wanted: false }).why, 'switched_off');
  // The switch is turned on, then the engine restarts within the same minutes.
  assert.deepEqual(start({ wanted: true }), { open: false, why: 'sign_in_seen', remember: false });
});

test('the refusals keep their order: where the engine runs, then the sign-in, then the person', () => {
  const nothingRight = { sideCopy: true, signIn: null, seenId: '', armed: false, wanted: false, appAtSignIn: true, canOpen: false };
  assert.equal(signInOpenDecision(nothingRight).why, 'side_copy');
  assert.equal(signInOpenDecision({ ...nothingRight, sideCopy: false }).why, 'start_unknown');
  const placed = { ...nothingRight, sideCopy: false, signIn: { id: 'a', ageMs: 0 } };
  assert.equal(signInOpenDecision({ ...placed, seenId: 'a' }).why, 'sign_in_seen');
  assert.equal(signInOpenDecision(placed).why, 'never_asked');
  assert.equal(signInOpenDecision({ ...placed, armed: true }).why, 'switched_off');
  assert.equal(signInOpenDecision({ ...placed, armed: true, wanted: true }).why, 'app_shows_it');
  assert.equal(signInOpenDecision({ ...placed, armed: true, wanted: true, appAtSignIn: false }).why, 'cannot_open');
});

test('facts that are missing or not facts never open a tab', () => {
  for (const facts of [undefined, null, {}, [], 'yes', 7]) {
    assert.equal(signInOpenDecision(facts).open, false);
  }
});

test('the limit can be handed in, and the default is ten minutes', () => {
  assert.equal(SIGN_IN_WINDOW_MS, 10 * MINUTE);
  assert.equal(signInOpenDecision(signInStart(), 30 * 1000).why, 'not_a_sign_in');
  assert.equal(signInOpenDecision(signInStart({ signIn: { id: 'sign-in-1', ageMs: 20 * MINUTE } }), 30 * MINUTE).open, true);
});
