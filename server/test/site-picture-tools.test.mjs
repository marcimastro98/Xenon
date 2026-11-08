// The tools that rebuild the site's pictures: which picture each shot writes, and that
// the data they run on is invented, so a re-shoot can never publish something real.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const { SCENE_PICTURES, TILE_PICTURES, pickSteps } = await import('../../tools/site-shots/publish.mjs');
const { SCENES } = await import('../../tools/site-shots/scenes.mjs');
const { WIDGET_CELLS } = await import('../../tools/site-shots/widgets.mjs');
const { HERO_THEMES } = await import('../../tools/site-shots/themes.mjs');
const { steamWidget } = await import('../../tools/site-shots/steam-widget.mjs');
const { bitChat } = await import('../../tools/site-shots/bit-chat.mjs');
const { CLIP, lyricsFixture } = await import('../../tools/site-shots/lyrics-clip.mjs');
const { CARD, CARDS, PICTURE, pickCards } = await import('../../tools/site-shots/og-card.mjs');

const docs = (file) => new URL(`../../docs/${file}`, import.meta.url);
const INVENTED_GAMES = ['Cyberfall', 'Skyharbor', 'Tidewarden', 'Emberline'];

test('the publish steps come from the command line, and an unknown one stops it', () => {
  assert.deepEqual(pickSteps([]), ['scenes', 'themes', 'ambient', 'tiles', 'desktop']);
  assert.deepEqual(pickSteps(['tiles', '--out', 'desktop']), ['tiles']);
  assert.throws(() => pickSteps(['tile']), /unknown step: tile/);
});

test('every picture has a scene or a tile behind it, and no two share a file', () => {
  for (const scene of Object.keys(SCENE_PICTURES)) assert.ok(SCENES[scene], `no scene ${scene}`);
  for (const tile of Object.keys(TILE_PICTURES)) assert.ok(WIDGET_CELLS[tile], `no cells for ${tile}`);
  const files = [...Object.values(SCENE_PICTURES).flat().map(([file]) => file), ...Object.values(TILE_PICTURES)];
  assert.equal(new Set(files).size, files.length);
});

test('the words of the home find their pictures', () => {
  const page = readFileSync(docs('index.html'), 'utf8');
  const words = [...page.matchAll(/data-w="([a-z]+)"/g)].map((m) => m[1]);
  for (const word of words) assert.ok(existsSync(docs(`images/home/w-${word}.webp`)), `no picture for ${word}`);
});

test('every theme of the home seeds the look it names', () => {
  for (const [id, make] of Object.entries(HERO_THEMES)) {
    const { settings, open } = make();
    assert.ok(settings || open, `${id} sets nothing`);
    if (settings) assert.equal(settings.dynamicAlbumTheme, false, `${id} follows the album cover`);
  }
});

test('the Steam picture runs on invented games, each with its own drawn cover', () => {
  const { answers, files, settings } = steamWidget();
  const { response } = JSON.parse(answers['/sdk/fetch'].body);
  assert.deepEqual(response.games.map((game) => game.name), INVENTED_GAMES);
  assert.equal(response.players[0].gameextrainfo, INVENTED_GAMES[0]);
  for (const { appid } of response.games) {
    const cover = Object.entries(files).find(([path]) => path.includes(`%2F${appid}%2F`));
    assert.ok(cover && String(cover[1].body).startsWith('<svg'), `no drawn cover for ${appid}`);
  }
  assert.ok(Object.keys(files).every((path) => path.startsWith('/sdk/')), 'a file answers off the local copy');
  assert.ok(Object.values(settings.sdkWidgets.assign).length === 1);
});

test('Bit\'s chat picture names an invented game, and says what the page says it says', () => {
  const { stage } = bitChat();
  assert.match(stage, /Cyberfall/);
  assert.doesNotMatch(stage, /tabletop/i);
  for (const fact of ['42 seconds', 'Desktop', 'FPS on average', '1% low', '0.1% low', 'worst frame']) assert.ok(stage.includes(fact), fact);
});

test('the Lyrics clip has a translation for each line, in time, on the page\'s size', () => {
  const { answers, settings } = lyricsFixture();
  const { lines } = answers['/api/lyrics'];
  assert.equal(answers['/api/lyrics/translate'].tr.length, lines.length);
  assert.ok(lines.every((line, i) => i === 0 || line.t > lines[i - 1].t));
  assert.equal(settings.lyricsTranslate, true);
  const video = /<video src="\/images\/home\/lyrics-widget\.mp4"[^>]*>/.exec(readFileSync(docs('widgets.html'), 'utf8'))[0];
  assert.ok(video.includes(`width="${CLIP.width}"`) && video.includes(`height="${CLIP.height}"`));
});

test('the link card keeps the shape every network crops to, on a picture that exists', () => {
  assert.deepEqual(CARD, { width: 1200, height: 630 });
  assert.ok(existsSync(docs(PICTURE.slice(1))));
  assert.ok(existsSync(docs('images/home/og-card.png')));
});

test('every page with a card of its own points at it, drawn from the page it names', () => {
  for (const [name, card] of Object.entries(CARDS)) {
    assert.ok(existsSync(docs(card.picture.slice(1))), `${name}: no ${card.picture}`);
    assert.ok(existsSync(docs(card.file)), `${name}: no ${card.file}`);
    const page = readFileSync(docs(card.page === '/' ? 'index.html' : card.page.slice(1)), 'utf8');
    assert.ok(page.includes(`<meta property="og:image" content="https://xenon-app.com/${card.file}">`), `${name}: the page points at another card`);
    assert.ok(page.includes(`id="${card.title.slice(1)}"`), `${name}: the page has no ${card.title}`);
  }
});

test('the cards come from the command line, and --out writes one only', () => {
  assert.deepEqual(pickCards([]), Object.keys(CARDS));
  assert.deepEqual(pickCards(['v5', '--out', 'card.png']), ['v5']);
  assert.throws(() => pickCards(['--out', 'card.png']), /--out takes one card/);
  assert.throws(() => pickCards(['v6']), /unknown card: v6/);
});
