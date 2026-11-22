// "When music plays I don't see the album, only a grey circle": the server sends a song's cover
// once and leaves it out of the updates that follow for the same song (media/cover-memory.js,
// mediaForBroadcast). The pump page keeps it between them (pump-face.js withCover), as the
// dashboard does (js/media/now-playing.js _lastThumb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mediaForBroadcast } = require('../media/cover-memory.js');
const { thumbMemory } = require('../media/thumb-memory.js');

// withCover lifted from the page with the one variable it keeps.
function pageCover() {
  const src = readFileSync(new URL('../js/pump/pump-face.js', import.meta.url), 'utf8');
  const at = src.indexOf('  function withCover(d) {');
  const end = src.indexOf('\n  }\n', at) + 4;
  assert.ok(at > 0 && end > at, 'withCover is in the page');
  assert.match(src, /on\(es, 'media', \(d\) => \{ data\.media = withCover\(d\); feed\(\); \}\);/, 'every media event goes through it');
  return new Function(`let cover = { key: '', url: '' };\n${src.slice(at, end)}\nreturn withCover;`)();
}

const COVER = 'data:image/png;base64,iVBORw0KGgo=';
const song = (title, extra = {}) => ({ active: true, title, artist: 'An Artist', playbackStatus: 'Playing', ...extra });

test('the cover stays on the pump while the server leaves it out for the same song', (t) => {
  thumbMemory.lastSentKey = null;
  t.after(() => { thumbMemory.lastSentKey = null; });
  const withCover = pageCover();
  const wire = (info) => JSON.parse(JSON.stringify(mediaForBroadcast(info)));

  const first = wire(song('One', { thumbnail: COVER }));
  assert.equal(withCover(first).thumbnail, COVER);
  const next = wire(song('One', { thumbnail: COVER, playbackStatus: 'Paused' }));
  assert.equal(next.thumbnail, undefined, 'the server leaves it out the second time');
  assert.equal(withCover(next).thumbnail, COVER, 'the page keeps it');

  assert.equal(withCover(wire(song('Two'))).thumbnail, undefined, 'another song never wears the last cover');
  assert.equal(withCover(wire(song('One'))).thumbnail, undefined, 'nor does the first one come back from memory once it changed');
  withCover(wire(song('Three', { thumbnail: COVER })));
  assert.equal(withCover({ ...song('Three'), active: false }).thumbnail, undefined, 'nothing playing: no cover kept');
});
