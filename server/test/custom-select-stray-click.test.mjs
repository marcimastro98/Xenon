// "+ Add Action list does not collapse after selecting an option"
//
// Reported on macOS, and reproduced in a real browser against the real dashboard
// — in Chromium as well as WebKit, so not an engine quirk. What was measured,
// driving the actual Deck key editor:
//
//   pointerdown -> button.deck-ed-addstep   trusted, detail 1
//   mouseup     -> button.deck-ed-addstep   trusted, detail 1
//   click       -> button.deck-ed-addstep   trusted, detail 1   <- rebuilds the list
//   click       -> button.cs-trigger        trusted, detail 0   <- nobody clicked this
//
// One press, two clicks. The editor rebuilds the whole action list inside the
// "+ Add action" click handler, and the browser then fires a SECOND trusted click
// — detail 0, so not a pointer gesture — at whatever now sits under the pointer.
// What sits there is the dropdown that rebuild just created, so it opened itself.
// Choosing an option rebuilds the list the same way, so it re-opened: from the
// outside, "the list stays expanded".
//
// The discriminator needs no threshold: the stray click carries the ORIGINAL
// gesture's timestamp, which is earlier than the moment the control was created.
// Measured at 3.5ms and 9.1ms before, but the sign is what matters, not the size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CS = readFileSync(new URL('../js/custom-select.js', import.meta.url), 'utf8');

const TRIGGER = (() => {
  const at = CS.indexOf("trigger.addEventListener('click'");
  assert.ok(at > 0, 'the trigger click handler is still where this test looks');
  return CS.slice(at, CS.indexOf('\n  });', at));
})();

test('a control ignores a click from a gesture that predates it', () => {
  assert.match(TRIGGER, /if \(e\.isTrusted && e\.timeStamp && e\.timeStamp < bornAt\) return;/,
    'the guard compares the event against when this control came into existence');
  assert.match(CS, /const bornAt = \(typeof performance !== 'undefined' && performance\.now\) \? performance\.now\\?\(\) : 0;/,
    'bornAt is stamped at init');
});

// Order matters: the guard has to run before the open/close decision, or the
// stray click still toggles the panel.
test('the guard runs before the panel is toggled', () => {
  const guardAt = TRIGGER.indexOf('e.timeStamp < bornAt');
  const toggleAt = TRIGGER.indexOf("classList.contains('cs-open')");
  assert.ok(guardAt > 0 && toggleAt > guardAt, 'the guard precedes the toggle');
});

// Three ways someone could "simplify" this into something that breaks again.
test('the guard stays narrow', () => {
  // 1. Refusing untrusted clicks would break every programmatic .click(), which
  //    is how other code and assistive tech drive this control.
  assert.match(TRIGGER, /e\.isTrusted &&/, 'only trusted events are ever refused');
  // 2. A time WINDOW would be a guess, and would refuse fast legitimate clicks.
  //    The comparison is against this control's own birth, and nothing else.
  assert.doesNotMatch(TRIGGER, /timeStamp\s*[-+]\s*\d/, 'no arbitrary threshold');
  assert.doesNotMatch(TRIGGER, /Date\.now\(\)/, 'not wall-clock time: event timestamps are not');
  // 3. `e.timeStamp &&` keeps a 0 timestamp (some environments) from refusing
  //    every click on a control created after page load.
  assert.match(TRIGGER, /e\.timeStamp &&/, 'a missing timestamp never refuses a click');
});

// The keyboard path is separate and must not be caught by any of this: Enter and
// Space are handled in keydown, which preventDefaults so no synthetic click
// follows — and a synthetic one would carry detail 0 too.
test('the keyboard path is untouched', () => {
  const at = CS.indexOf("trigger.addEventListener('keydown'");
  const kd = CS.slice(at, CS.indexOf('\n  });', at));
  assert.match(kd, /e\.key === 'Enter' \|\| e\.key === ' '/, 'Enter and Space still open and close');
  assert.doesNotMatch(kd, /bornAt/, 'the guard is not copied where it does not belong');
});
