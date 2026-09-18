import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// `hidden` not hiding anything in the Slideshow widget.
//
// The widget shows and hides seven things with `el.hidden = true`. Five of them
// carry a class that sets `display`, and an author rule of equal specificity beats
// the browser's own `[hidden] { display: none }` — so for those five the property
// set the attribute and changed nothing.
//
// Visible consequences, all of them shipped:
//   · a one-image slideshow kept its prev/next arrows and its dots;
//   · the pause pip sat on every tile, paused or not;
//   · freezeTile hides the <img> before stripping its src (that strip is what
//     stops a GIF decoding). With the hide ignored, a live source-less <img>
//     stayed on screen — broken-image icon and empty box around the still.
//
// The last is the one that got reported, and only under `contain`: with `cover`
// the still covers the tile and hides the wreckage underneath. "Works fine on
// desktop, but pauses with a white border and a little picture broken icon top
// left corner" while gaming — gaming being when a tile is frozen AND watched.

const CSS = readFileSync(new URL('../components/SlideshowWidget/SlideshowWidget.css', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../js/slideshow-widget.js', import.meta.url), 'utf8');

// Every class the widget toggles `hidden` on, with the display it sets (if any).
const TOGGLED = ['sl-img', 'sl-freeze', 'sl-nav', 'sl-dots', 'sl-pausepip', 'sl-empty-btn'];

function declaredDisplay(cls) {
  const re = new RegExp('(^|\\n)\\.' + cls + ' \\{([\\s\\S]*?)\\n\\}', 'm');
  const m = re.exec(CSS);
  if (!m) return null;
  const d = /display:\s*([a-z-]+)/.exec(m[2]);
  return d ? d[1] : null;
}

test('the stage hides anything marked hidden, whatever display it was given', () => {
  assert.match(CSS, /\.sl-stage \[hidden\] \{ display: none; \}/,
    'one rule for the whole widget — a per-class list lets the next element opt out by accident');
});

test('that rule outranks every display the widget sets on a hideable element', () => {
  // `.sl-stage [hidden]` is (0,1,1); a bare `.sl-foo` is (0,1,0). Anything that
  // sets display on one of these with TWO classes would win and must be caught.
  for (const cls of TOGGLED) {
    const d = declaredDisplay(cls);
    if (!d) continue;
    const stronger = new RegExp('\\.[a-z-]+[ .]\\.?' + cls + '[^{]*\\{[^}]*display:', 'g');
    const hits = (CSS.match(stronger) || []).filter(h => !/is-empty/.test(h));
    assert.equal(hits.length, 0, `.${cls} has a higher-specificity display rule that would survive [hidden]: ${hits}`);
  }
});

test('freezing still depends on the hide, so this is not cosmetic', () => {
  const at = JS.indexOf('function freezeTile(');
  const body = JS.slice(at, JS.indexOf('\n    }', at));
  assert.match(body, /img\.hidden = true;/);
  assert.match(body, /img\.removeAttribute\('src'\)/,
    'the src is stripped right after — if the hide is ignored, that is a broken image on screen');
  // Order matters: hide, then strip.
  assert.ok(body.indexOf('img.hidden = true') < body.indexOf("removeAttribute('src')"));
});

test('the one-image case really does ask for those controls to go', () => {
  const at = JS.indexOf('function paintTile(');
  const body = JS.slice(at, JS.indexOf('\n    function paintAll', at));
  assert.match(body, /ui\.prev\.hidden = !multi;/);
  assert.match(body, /ui\.next\.hidden = !multi;/);
  assert.match(body, /ui\.pausePip\.hidden = !s\.paused;/);
  assert.match(body, /ui\.dots\.hidden = true;/);
});

test('the empty state keeps its own rule — it never relied on the attribute', () => {
  // .sl-stage.is-empty swaps the <img> for the message with its own display
  // rules; those are deliberate and must not be mistaken for the bug above.
  assert.match(CSS, /\.sl-stage\.is-empty \.sl-img \{ display: none; \}/);
  assert.match(CSS, /\.sl-stage\.is-empty \.sl-empty \{ display: flex; \}/);
});
