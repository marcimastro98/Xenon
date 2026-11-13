// Notifications open at the top centre of the screen, Dynamic Island style.
// Asked 5 Nov 2026: in "widgets only" the cards opened in a corner of the main
// screen. The alerts window now runs the dashboard's island, and the cards that
// are not notifications (What's New, Bit's messages) sit at the top centre too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('screen-alerts.html');
const SCRIPT = read('js/screen-alerts.js');
const TOAST = read('js/toast.js');
const ALERTS_CSS = read('components/ScreenAlerts/ScreenAlerts.css');
const TOAST_CSS = read('components/Toast/Toast.css');
const BIT_CSS = read('components/BitMessage/BitMessage.css');
const NEWS_CSS = read('components/WhatsNew/WhatsNew.css');
const ISLAND = read('js/toast-island.js');

// The window is cut 10 px around a card, so an outer shadow ends in a straight
// edge: on the screen it reads as a dark box behind the card. Asked 5 Nov 2026.
test('a card in the alerts window keeps no shadow outside itself', () => {
  const at = ALERTS_CSS.indexOf('html[data-screen-alerts] .xisland-skin--pill');
  assert.ok(at >= 0);
  const body = ALERTS_CSS.slice(ALERTS_CSS.indexOf('{', at), ALERTS_CSS.indexOf('}', at));
  const shadow = body.match(/box-shadow: *([^;]+);/);
  assert.ok(shadow, 'the rule sets its own shadow');
  assert.match(shadow[1], /^inset /);
  assert.doesNotMatch(shadow[1], /--shadow-lg/);
});

function rule(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, selector + ' not found');
  return css.slice(at, css.indexOf('}', at));
}

// isMinimalChrome() on its own, with the page around it described by the options.
function minimalChrome({ classes = [], alertsWindow = false, panel = '', place = false, taken = false }) {
  const start = TOAST.indexOf('function isMinimalChrome()');
  const taker = TOAST.match(/const CENTRE_TAKEN = [^;]+;/);
  assert.ok(start >= 0 && taker, 'isMinimalChrome and CENTRE_TAKEN');
  const body = TOAST.slice(start, TOAST.indexOf('\n  }\n', start) + 4);
  return vm.runInNewContext(`${taker[0]} ${body}; isMinimalChrome();`, {
    document: {
      body: { classList: { contains: (c) => classes.includes(c) }, dataset: { panel } },
      documentElement: { hasAttribute: (a) => (a === 'data-screen-alerts' ? alertsWindow : a === 'data-tb-toast-place' && place) },
      querySelector: () => (taken ? {} : null),
    },
  });
}

test('the alerts window loads the island before the toasts that use it', () => {
  const island = PAGE.indexOf('js/toast-island.js');
  assert.ok(island > 0 && island < PAGE.indexOf('js/toast.js'));
});

test('the alerts window uses the island without a top bar, the dashboard still needs one', () => {
  assert.equal(minimalChrome({ alertsWindow: true }), true);
  assert.equal(minimalChrome({ classes: ['topbar-minimal'] }), true);
  assert.equal(minimalChrome({}), false);
  assert.equal(minimalChrome({ classes: ['topbar-minimal', 'topbar-noisland'] }), false);
  assert.equal(minimalChrome({ classes: ['topbar-minimal'], panel: 'settings' }), false);
  assert.equal(minimalChrome({ classes: ['topbar-minimal'], place: true }), false);
});

test('with a card holding the top centre, a notification goes beside it, never under it', () => {
  assert.equal(minimalChrome({ alertsWindow: true, taken: true }), false);
  assert.equal(minimalChrome({ classes: ['topbar-minimal'], taken: true }), false);
  const taken = TOAST.match(/const CENTRE_TAKEN = '([^']+)'/)[1];
  for (const card of ['.call-overlay', '.rn-corner', '.wn-look']) assert.ok(taken.includes(card), card);
  // Bit's folded face is small and stays in the corner: it holds no place.
  assert.ok(taken.includes('.bm-card:not(.is-face)'));
  // A card arriving moves the ones on the island out of its way.
  assert.match(TOAST, /new MutationObserver\(.*\)\.observe\(document\.body, \{ childList: true \}\)/);
  assert.match(rule(ALERTS_CSS, 'html[data-screen-alerts] .xtoast-stack'), /right: 16px/);
  assert.match(TOAST_CSS, /body:has\(> \.rn-corner, > \.bm-card:not\(\.is-face\), > \.wn-look\) \.xtoast-stack \{[^}]*right: 16px/);
});

// With no clock pill to open from, the glass starts as a capsule over the card. Seen
// frame by frame on 5 Nov 2026: measured on the hidden island the slot reads 0, so the
// glass flew in from the top left corner of the screen.
test('with no pill the glass opens from the centre, not from the corner', () => {
  const start = ISLAND.indexOf('function homeBox()');
  const body = ISLAND.slice(start, ISLAND.indexOf('\n    }\n', start) + 6);
  const root = { hidden: true };
  const laidOut = (value) => (root.hidden ? 0 : value);
  const slot = { get offsetLeft() { return laidOut(520); }, get offsetWidth() { return laidOut(400); }, get offsetTop() { return laidOut(12); } };
  const home = vm.runInNewContext(`${body}; homeBox();`, { window: {}, root, slot });
  assert.equal(home.left + home.width / 2, 720);
  assert.equal(home.top, 12);
  assert.equal(home.none, true);
  assert.equal(root.hidden, true, 'the island stays hidden until it opens');
});

test('beside a card at the top centre the notifications keep their corner, or go to the bottom', () => {
  // The old place, under a card in the top right corner.
  assert.ok(!NEWS_CSS.includes('.xtoast-stack'));
  const narrow = TOAST_CSS.indexOf('@media (min-width: 561px) and (max-width: 1260px)');
  assert.ok(narrow >= 0, 'a window too narrow for both');
  assert.ok(TOAST_CSS.slice(narrow, TOAST_CSS.indexOf('}', narrow)).includes('top: auto; bottom: 16px;'));
  // A wide card leaves less room: the notifications narrow instead of going under it.
  assert.ok(TOAST_CSS.includes('body:has(> .bm-card.is-open, > .bm-card.is-poll, > .wn-look) .xtoast-stack { width: min(400px, calc(50vw - 276px)); }'));
});

test('the window is cut to the glass and to the card it grows into', () => {
  const cards = SCRIPT.match(/const CARDS = '([^']+)'/)[1];
  assert.ok(cards.includes('.xisland-slot > *'), 'the final size, from the first frame');
  assert.ok(cards.includes('.xisland-bg'), 'the glass, while it closes with the card gone');
  // screen-bit.js never reloads the page under a card someone is reading.
  assert.ok(SCRIPT.match(/const ALERT_CARDS = '([^']+)'/)[1].includes('.xisland-slot > *'));
  // The island ends by hiding itself, with no class or child changing.
  assert.match(SCRIPT, /attributeFilter: \['class', 'hidden'\]/);
});

test('the island on a see-through window has no blur and a denser fill', () => {
  const at = ALERTS_CSS.indexOf('html[data-screen-alerts] .xtoast-stack > .xtoast,');
  assert.ok(at >= 0);
  const block = ALERTS_CSS.slice(at, ALERTS_CSS.indexOf('}', at));
  for (const skin of ['card', 'pill']) assert.ok(block.includes('.xisland-skin--' + skin), skin);
  assert.match(block, /backdrop-filter: none/);
  // The card on the island is content only: the stack's fill stays off it.
  assert.doesNotMatch(ALERTS_CSS, /html\[data-screen-alerts\] \.xtoast \{/);
});

test('What\'s New and Bit\'s messages open at the top centre, Bit\'s face keeps the corner', () => {
  for (const [css, selector] of [[NEWS_CSS, '.rn-corner'], [BIT_CSS, '.bm-card']]) {
    const box = rule(css, selector);
    assert.match(box, /left: 0;/, selector);
    assert.match(box, /right: 0;/, selector);
    assert.match(box, /margin-inline: auto;/, selector);
  }
  const face = rule(BIT_CSS, '.bm-card.is-face');
  assert.match(face, /left: auto;/);
  assert.match(face, /right: 16px;/);
  assert.match(face, /margin-inline: 0;/);
  // A phone keeps the card at the bottom, where the thumb is.
  assert.match(BIT_CSS, /@media \(max-width: 560px\) \{\n {2}\.bm-card \{ top: auto; bottom: 16px; left: 16px; right: 16px; width: auto; margin-inline: 0; \}/);
});

// He saw something white behind a card as it closed, and no film could catch it:
// this window stays out of captures. So on Windows nothing fades there: the card
// stays and the shell closes over it (alert-roll.test.mjs). Mac and Linux have
// real alpha and keep the fade.
test('a card closing on the Windows alerts window never fades', () => {
  assert.match(TOAST, /leavesAtOnce: \(\) => !!window\.XenonAlertRoll/);
  const close = ISLAND.slice(ISLAND.indexOf('async function close(g)'));
  assert.ok(close.indexOf('atOnce()') >= 0 && close.indexOf('atOnce()') < close.indexOf('fade(cur, 0'), 'before any fade');
  assert.match(ISLAND, /if \(dir && wasShown && !reduced\(\) && !atOnce\(\) && root\) \{ fling\(dir\); return; \}/);
  const cards = SCRIPT.match(/const CARDS = '([^']+)'/)[1];
  assert.ok(cards.includes('.xtoast-stack > .xtoast:not(.xtoast-out, .xtoast-leaving)'), 'a leaving card is no longer cut in');
});
