// The music tile with nothing playing shows only the picture and the keys: no
// "Music" source label, no "Nothing playing" title and no "Spotify, YouTube and
// other players will show up here" hint on screen. The title stays in the page
// for screen readers, clipped out of sight, and the keys sit level with the
// picture's centre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const media = read('../js/media.js');
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

test('the title leaves the screen but stays readable to screen readers', () => {
  const rule = css.match(/\.media-panel\.is-empty \.media-textblock \{([^}]*)\}/);
  assert.ok(rule, 'the empty textblock rule exists');
  assert.match(rule[1], /position: absolute/);
  assert.match(rule[1], /clip-path: inset\(50%\)/);
  assert.doesNotMatch(rule[1], /display: none/, 'display:none would hide it from screen readers too');
  assert.match(css, /\.media-panel\.is-empty \.ph-label \{ display: none; \}/);
  assert.match(css, /\.media-panel\.is-empty \.app-pill \{ display: none; \}/);
});

test('the keys centre on the picture in every layout', () => {
  assert.match(css, /\.media-panel\.is-empty \.media-content \{[^}]*align-content: center[^}]*grid-template-rows: auto/);
  assert.match(css, /\.media-panel\.is-empty \.media-actions \{[^}]*grid-area: auto \/ 1 \/ auto \/ -1[^}]*margin-top: 0/);
  // Liquid Glass's wide grid keeps a row for the words; with none, it must not.
  assert.match(liquid, /\.media-panel\.is-empty:not\(\.lyrics-open\) \.media-content \{ grid-template-rows: auto; \}/);
  assert.match(liquid, /\.media-panel\.is-empty:not\(\.lyrics-open\) \.media-textblock \{ grid-row: auto; \}/);
});

test('the keys keep their sideways place when a track starts or stops (#154)', () => {
  // The short wide tile puts the keys at the start or the end of the row while
  // music plays; the empty tile must not centre them, or they jump.
  const rule = css.match(/\.media-panel\.is-empty \.media-actions \{([^}]*)\}/);
  assert.ok(rule, 'the empty keys rule exists');
  assert.doesNotMatch(rule[1], /justify-self/);
  assert.match(css, /\.media-panel \.media-actions\s+\{ grid-column: 2; grid-row: 1 \/ -1; justify-self: end; \}/);
  assert.match(css, /\.media-panel \.media-actions \{ grid-column: 1; grid-row: 4; justify-self: start;/);
});

test('a source picker, when there is one, stays visible', () => {
  assert.match(css, /\.media-panel\.is-empty \.media-app-row:not\(:has\(\.media-source-picker:not\(\[hidden\]\)\)\) \{ display: none; \}/);
});
