// The music tile with nothing playing shows only the picture and the keys: no
// "Music" source label, no "Nothing playing" title and no hint on screen. The
// words keep their room, invisible, so the keys stay where a song puts them; the
// title stays readable to screen readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const media = read('../js/media/media.js');
const i18n = appStringsSource();
const html = read('../index.html');
const css = read('../components/MediaPanel/MediaPanel.css');
const liquid = read('../components/MediaPanel/LiquidPlayer.css');

test('the hint string is gone from every language and from the page', () => {
  assert.doesNotMatch(i18n, /media_empty_sub/);
  assert.doesNotMatch(html, /media_empty_sub/);
  assert.doesNotMatch(media, /media_empty_sub/);
});

test('the empty state clears the source name and the artist line', () => {
  const at = media.indexOf("t('media_empty_title')");
  assert.ok(at > 0, 'the empty branch still names the title');
  const branch = media.slice(Math.max(0, at - 400), at + 200);
  assert.match(branch, /app\.textContent = ''/);
  assert.match(branch, /artist\.textContent = ''/);
});


test('the words go invisible but keep their room, and stay readable to screen readers', () => {
  const rule = css.match(/\.media-panel\.is-empty :is\(\.media-textblock, \.app-pill\) \{([^}]*)\}/);
  assert.ok(rule, 'the empty words rule exists');
  assert.match(rule[1], /opacity: 0/);
  // display:none or visibility:hidden would hide the title from screen readers too,
  // and position:absolute would give its room back and move the keys.
  assert.doesNotMatch(css, /\.media-panel\.is-empty[^{]*\.media-textblock[^{]*\{[^}]*(display: none|visibility: hidden|position: absolute)/);
  assert.match(css, /\.media-panel\.is-empty \.ph-label \{ display: none; \}/);
  // An empty artist line would fold to nothing; one blank line keeps its height.
  assert.match(css, /\.media-panel\.is-empty \.media-artist:empty::before \{ content: '\\a0'; \}/);
});

test('the keys keep their place when a track starts or stops, in both directions (#154)', () => {
  // Nothing playing lays the tile out exactly as a song does: no empty-state rule
  // may move the keys or reshape the column, in any look.
  for (const sheet of [css, liquid]) {
    assert.doesNotMatch(sheet, /\.is-empty[^{]*\.media-(actions|content)\b[^{]*\{/);
  }
  assert.doesNotMatch(liquid, /\.is-empty/);
  assert.match(css, /\.media-panel \.media-actions\s+\{ grid-column: 2; grid-row: 1 \/ -1; justify-self: end; \}/);
  assert.match(css, /\.media-panel \.media-actions \{ grid-column: 1; grid-row: 4; justify-self: start;/);
});

test('a source picker, when there is one, stays visible', () => {
  assert.match(css, /\.media-panel\.is-empty \.media-app-row:not\(:has\(\.media-source-picker:not\(\[hidden\]\)\)\) \{ visibility: hidden; \}/);
});
