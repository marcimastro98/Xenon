// What we ask LRCLIB for, from what each media host reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildQueries, trackKey } = require('../lyrics.js');

const q = (media) => buildQueries({ duration: 200, ...media });

test('app players: fields as given come first', () => {
  const out = q({ title: 'Paper Lanterns', artist: 'The Invented Band' });
  assert.deepEqual(out[0], { track: 'Paper Lanterns', artist: 'The Invented Band' });
});

test('YouTube video title is split and its tags removed', () => {
  const out = q({ title: 'Nova Reyes - Glass Harbor (Official Video)', artist: 'NovaReyesVEVO' });
  assert.deepEqual(out[0], { track: 'Glass Harbor', artist: 'Nova Reyes' });
});

test('"- Topic" channels are treated as the artist name', () => {
  const out = q({ title: 'Glass Harbor', artist: 'Nova Reyes - Topic' });
  assert.deepEqual(out[0], { track: 'Glass Harbor', artist: 'Nova Reyes' });
});

test('a dash inside an app title stays a fallback, not the first try', () => {
  const out = q({ title: 'Long Road - Acoustic', artist: 'Sam Field' });
  assert.deepEqual(out[0], { track: 'Long Road - Acoustic', artist: 'Sam Field' });
  assert.ok(out.some(x => x.artist === 'Long Road' && x.track === 'Acoustic'));
});

test('remaster suffix and host suffix are removed', () => {
  assert.equal(q({ title: 'Blue Hour - 2011 Remaster', artist: 'A' })[0].track, 'Blue Hour');
  assert.equal(q({ title: 'Blue Hour - YouTube', artist: 'A' })[0].track, 'Blue Hour');
});

test('a feat. variant is tried with the first artist only', () => {
  const out = q({ title: 'Night Bus (feat. Other Person)', artist: 'Lead Person, Other Person' });
  assert.ok(out.some(x => x.track === 'Night Bus' && x.artist === 'Lead Person'));
});

test('a real subtitle in brackets survives', () => {
  assert.equal(q({ title: 'Signals (Part II)', artist: 'A' })[0].track, 'Signals (Part II)');
});

test('no artist at all falls back to a free-text query', () => {
  const out = q({ title: 'Some Upload', artist: '' });
  assert.ok(out.some(x => x.artist === '' && x.track === 'Some Upload'));
});

test('no timeline or an hour-plus mix asks nothing', () => {
  assert.deepEqual(buildQueries({ title: 'Radio', artist: 'Station', duration: 0 }), []);
  assert.deepEqual(buildQueries({ title: 'Mix', artist: 'DJ', duration: 3601 }), []);
  assert.deepEqual(buildQueries({ title: '', artist: 'DJ', duration: 200 }), []);
});

test('at most three attempts', () => {
  assert.ok(q({ title: 'X - Y (feat. Z)', artist: '' }).length <= 3);
});

test('track key folds case, accents and noise, keeps the duration', () => {
  const a = trackKey({ title: 'Café (Official Video)', artist: 'Ana', duration: 200.4 });
  const b = trackKey({ title: 'cafe', artist: 'ANA', duration: 200 });
  assert.equal(a, b);
  assert.notEqual(a, trackKey({ title: 'cafe', artist: 'ana', duration: 215 }));
  assert.equal(trackKey({ title: '', artist: 'x', duration: 1 }), '');
});
