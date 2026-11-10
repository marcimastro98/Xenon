// "If I click outside a dropdown to close it, it does not close" — every
// dropdown in the Deck key editor, and any other one sitting inside a <label>.
//
// A <label> makes the first labelable control inside it its target, and that is
// the dropdown's trigger button. The browser re-sends every click on the label's
// other content to that target as a new click: the caption, the padding of the
// field box, and the option rows of the panel (which is a child of the label).
// So the outside click closed the panel and the forwarded click opened it again,
// and picking an option did the same.
//
// Measured in Chromium against the real dashboard, Deck editor, Actions tab:
// before, a click on the field caption and an option pick both left the panel
// open; after, both close it, and a click on the modal header still does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CS = readFileSync(new URL('../js/custom-select.js', import.meta.url), 'utf8');

const GUARD = (() => {
  const at = CS.indexOf("const hostLabel = wrap.closest('label');");
  assert.ok(at > 0, 'the label guard is still where this test looks');
  return CS.slice(at, CS.indexOf('\n  }\n', at));
})();

test('a wrapping label no longer forwards clicks to the trigger', () => {
  assert.match(GUARD, /hostLabel\.control === trigger/,
    'only when the trigger really is the label\'s control');
  assert.match(GUARD, /e\.preventDefault\(\);/, 'the label activation is cancelled');
});

// Option rows stop propagation, so a bubble listener on the label would never
// see their clicks; the forward would still happen.
test('the guard listens in the capture phase', () => {
  assert.match(GUARD, /hostLabel\.addEventListener\('click', \(e\) => \{[\s\S]*?\}, true\);/);
});

// Other controls in the same label keep working: a checkbox or the in-panel
// search box must still get its own click.
test('interactive content inside the label is left alone', () => {
  assert.match(GUARD, /closest\('button, input, select, textarea, a\[href\]'\)\) return;/);
});

// The click itself must still reach the document listener that closes panels:
// the guard cancels the default action, never the propagation.
test('the guard does not stop the click from closing the panel', () => {
  assert.doesNotMatch(GUARD, /stopPropagation/);
});
