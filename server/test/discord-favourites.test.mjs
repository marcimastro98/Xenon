// Pinning voice channels to the top of the Discord widget.
//
// Asked for on Discord: "can I somehow favourite voice channels to the top?"
// The order was whatever Discord gave us, so the channel you always join sat
// wherever it happened to sit.
//
// Three decisions worth stating, because they are the design rather than the
// code. Per CHANNEL, since a Discord id is a snowflake and unique on its own.
// Stored SERVER-side, because which channels you care about is a fact about you
// and should follow you to the phone and the Edge — the opposite call from the
// tile layout, which is per-device precisely because the right answer differs
// from screen to screen. And shown as one group at the top rather than sorted
// within each server, because the point is to reach the channel fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/discord-widget.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DiscordWidget/DiscordWidget.css', import.meta.url), 'utf8');

// discord-widget.js cannot be required here — it reaches for browser globals at
// IIFE top level — so the one pure function is lifted out and run.
const splitFavourites = (() => {
  const at = WIDGET.indexOf('function splitFavourites(');
  assert.notEqual(at, -1, 'js/discord-widget.js must still define splitFavourites');
  const end = WIDGET.indexOf('\n  }', at) + 4;
  // eslint-disable-next-line no-new-func
  return new Function(`${WIDGET.slice(at, end)}; return splitFavourites;`)();
})();

const CHANNELS = [
  { id: '111', name: 'General', guild: 'Alpha' },
  { id: '222', name: 'Music', guild: 'Alpha' },
  { id: '333', name: 'Chat', guild: 'Beta' },
];
const names = (list) => list.map((c) => c.name);

// ── The ordering ─────────────────────────────────────────────────────────────

test('nothing pinned leaves the list exactly as Discord gave it', () => {
  const { pinned, rest } = splitFavourites(CHANNELS, []);
  assert.deepEqual(pinned, []);
  assert.deepEqual(names(rest), ['General', 'Music', 'Chat']);
});

test('a pinned channel moves to the top and leaves its server group', () => {
  const { pinned, rest } = splitFavourites(CHANNELS, ['333']);
  assert.deepEqual(names(pinned), ['Chat']);
  // Shown in ONE place: a row repeated under both headings would duplicate its
  // member strip too, and "why is this twice?" is worse than "where did it go?",
  // which the star on the row answers.
  assert.deepEqual(names(rest), ['General', 'Music']);
});

// The order you starred them in, not Discord's and not alphabetical: the point
// is to put the one you always join first, and re-sorting would take that back.
test('favourites keep the order they were starred in', () => {
  assert.deepEqual(names(splitFavourites(CHANNELS, ['333', '111']).pinned), ['Chat', 'General']);
  assert.deepEqual(names(splitFavourites(CHANNELS, ['111', '333']).pinned), ['General', 'Chat']);
});

// A channel can be deleted, or the user can lose access, while its id is still
// in the list. That must not leave a hole or a crash.
test('a favourite that no longer exists is simply not shown', () => {
  const { pinned, rest } = splitFavourites(CHANNELS, ['999', '222']);
  assert.deepEqual(names(pinned), ['Music']);
  assert.deepEqual(names(rest), ['General', 'Chat']);
});

test('every channel pinned leaves nothing behind, and that is fine', () => {
  const { pinned, rest } = splitFavourites(CHANNELS, ['111', '222', '333']);
  assert.equal(pinned.length, 3);
  assert.deepEqual(rest, []);
});

test('junk in either argument yields empty lists, never a throw', () => {
  for (const [list, fav] of [[null, ['1']], [undefined, null], [CHANNELS, null], [CHANNELS, 'nope'], [[], []]]) {
    const r = splitFavourites(list, fav);
    assert.ok(Array.isArray(r.pinned) && Array.isArray(r.rest), JSON.stringify([list, fav]));
  }
  assert.deepEqual(splitFavourites(CHANNELS, 'nope').rest.length, 3, 'a bad fav list hides nothing');
});

// Ids arrive from settings as strings but a hand-edited store could hold numbers.
test('an id compares the same whether it is a string or a number', () => {
  assert.deepEqual(names(splitFavourites([{ id: 111, name: 'General' }], ['111']).pinned), ['General']);
});

// ── Where it is stored ───────────────────────────────────────────────────────

test('both sides declare the setting and normalize it the same way', () => {
  for (const src of [SERVER, CLIENT]) {
    assert.match(src, /discordFavChannels: Object\.freeze\(\[\]\)/, 'default');
    assert.match(src, /discordFavChannels: normalizeSnowflakeList\(/, 'normalizer');
    assert.match(src, /function normalizeSnowflakeList\(value, max = 50\)/, 'the shared shape');
  }
});

// The list is echoed back to every surface and used as a DOM key, so anything
// that is not a Discord id has no business surviving a round trip.
test('the normalizer keeps snowflakes and nothing else', () => {
  const at = SERVER.indexOf('function normalizeSnowflakeList(');
  const src = SERVER.slice(at, SERVER.indexOf('\n}', at) + 2);
  // eslint-disable-next-line no-new-func
  const norm = new Function(`${src}; return normalizeSnowflakeList;`)();
  assert.deepEqual(norm(['12345', 'nope', '12345', '', null, undefined, '67890']), ['12345', '67890']);
  assert.deepEqual(norm('not a list'), []);
  assert.deepEqual(norm([{ id: 1 }, [], true]), []);
  assert.equal(norm(Array.from({ length: 200 }, (_, i) => String(100000 + i))).length, 50, 'bounded');
  assert.deepEqual(norm([' 12345 ']), ['12345'], 'trimmed');
});

// ── The row ──────────────────────────────────────────────────────────────────

// A button inside a button is invalid and only one of the two would be
// reachable — the same reason soundTile() is built as siblings.
test('the star and the join button are siblings, never nested', () => {
  const at = WIDGET.indexOf('const channelRow =');
  const fn = WIDGET.slice(at, WIDGET.indexOf('\n    };', at));
  assert.match(fn, /const row = el\('div', 'dc-chan-row'\)/);
  assert.match(fn, /row\.append\(b, star\)/, 'both are children of the wrapper');
  assert.ok(!/b\.appendChild\(star\)|b\.append\([^)]*star/.test(fn), 'the star must not go inside the join button');
});

// Clicking the star must not also join the channel.
test('the star does not fall through to the join', () => {
  assert.match(WIDGET, /star\.addEventListener\('click', \(ev\) => \{ ev\.stopPropagation\(\); toggleFav/);
});

// paintChannels skips the rebuild when its signature is unchanged, and it runs
// on a 6s roster tick. Without the favourites in that signature, starring a
// channel would change nothing until a member happened to move.
test('the pinned list is part of what decides a repaint', () => {
  const at = WIDGET.indexOf('const sig = !linked');
  assert.match(WIDGET.slice(at, WIDGET.indexOf(';', at) + 1), /favIds\(\)\.join/);
});

// Appending rather than prepending: starring a second channel must not shift the
// first one out from under the pointer that is about to click it.
test('a new favourite goes to the bottom of the pinned group', () => {
  const at = WIDGET.indexOf('function toggleFav(');
  const fn = WIDGET.slice(at, WIDGET.indexOf('\n  }', at));
  assert.match(fn, /cur\.concat\(\[key\]\)/);
  assert.match(fn, /saveHubSettings\(\{ server: true \}\)/, 'and it follows you to the other surfaces');
});

// ── Presentation ─────────────────────────────────────────────────────────────

test('the three labels are translated in every language the app ships', () => {
  const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
  for (const key of ['discord_w_favourites', 'discord_w_favourite', 'discord_w_unfavourite']) {
    const found = new Set();
    let cur = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) cur = ns[1];
      if (line.trimStart().startsWith(key + ':')) found.add(cur);
    }
    assert.deepEqual(LANGS.filter((l) => !found.has(l)), [], `${key} is missing translations`);
  }
});

test('the star reads as filled when pinned and quiet when not', () => {
  assert.match(CSS, /\.dc-chan-fav\.is-on svg \{ fill: currentColor/, 'filled when pinned');
  // The classic favourite gold, fixed rather than the theme accent: a star means
  // "favourite" partly BY being yellow, and on a theme whose accent is already
  // the colour of every lit control the pinned rows would stop standing out.
  assert.match(CSS, /\.dc-chan-fav\.is-on \{[^}]*color: #f5c518/, 'the star is gold on every theme');
  assert.ok(!/\.dc-chan-fav\.is-on \{[^}]*var\(--accent/.test(CSS), 'and does not follow the accent');
  const rule = CSS.slice(CSS.indexOf('.dc-chan-fav {'));
  assert.match(rule.slice(0, rule.indexOf('}')), /opacity: 0\.\d+/, 'dimmed until the row is touched');
  assert.match(CSS, /\.dc-chan-row:hover \.dc-chan-fav/, 'and lit on hover');
});
