// Apple Music on Windows: a blank cover, and the album mashed onto the artist.
//
// Reported as issue #128 with the payload attached, which is what made it
// diagnosable. Both faults are in what Windows' media session reports rather
// than in anything Xenon decided, and both hosts (server/media.ps1 and
// helper/MediaHost.cs, a faithful port of it) carried them equally.
//
// The first one is a comma. Apple Music reports its thumbnail's content type as
// a LIST of equivalent types, `image/jpeg,image/jpe,image/jpg`, and that went
// whole into the data URI — where the first comma ends the media type. The
// browser read the type as `image/jpeg` and everything after it, base64 payload
// included, as ordinary text. It never decoded: a valid 146 KB JPEG lost to
// punctuation. And because a broken string is still a string, it also defeated
// the iTunes fallback (`hydrateArtwork` only looks when there is no thumbnail)
// and the album-art accent, which resolves null on a decode error. One comma,
// three things off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const PS1 = readFileSync(new URL('../media.ps1', import.meta.url), 'utf8');
const CS = readFileSync(new URL('../../helper/MediaHost.cs', import.meta.url), 'utf8');

// server.js cannot be required (it starts a server), so the normaliser is lifted
// out and RUN — the property that matters is what comes out the other side.
const normalizeMedia = (() => {
  const at = SERVER.indexOf('const DATA_URI_HEAD_RE =');
  const end = SERVER.indexOf('\n}', SERVER.indexOf('function normalizeMedia(data) {', at)) + 2;
  assert.ok(at > -1 && end > at, 'server.js must still define the media normaliser');
  // eslint-disable-next-line no-new-func
  return new Function(`${SERVER.slice(at, end)}; return normalizeMedia;`)();
})();

const JPEG = '/9j/4AAQSkZJRgABAQAASABIAAD';
const APPLE = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
const media = (over) => Object.assign({ active: true, source: APPLE, title: 'T', artist: 'A', album: '', thumbnail: '' }, over);

// ── The comma ────────────────────────────────────────────────────────────────

test('a list of equivalent content types keeps the cover, it does not lose it', () => {
  // Repaired rather than dropped: the real cover has already been read off the
  // session, and falling back to iTunes would replace it with a lookup that can
  // miss or return the wrong release.
  const r = normalizeMedia(media({ thumbnail: 'data:image/jpeg,image/jpe,image/jpg;base64,' + JPEG }));
  assert.equal(r.thumbnail, 'data:image/jpeg;base64,' + JPEG);
});

test('the bytes are never touched — only the media type in front of them', () => {
  const body = JPEG + 'AAAA+/==';
  const r = normalizeMedia(media({ thumbnail: 'data:image/png,image/x-png;base64,' + body }));
  assert.equal(r.thumbnail.slice(r.thumbnail.indexOf(',') + 1), body);
  assert.equal(r.thumbnail, 'data:image/png;base64,' + body);
});

test('an ordinary single type is left exactly as it was', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']) {
    const uri = `data:${type};base64,${JPEG}`;
    assert.equal(normalizeMedia(media({ thumbnail: uri })).thumbnail, uri);
  }
});

test('a type that is not an image falls back rather than being trusted', () => {
  // The bytes came from a media session's thumbnail stream, so the payload is a
  // picture whatever the header claims; `text/html` in a data URI is not.
  const r = normalizeMedia(media({ thumbnail: 'data:text/html;base64,' + JPEG }));
  assert.equal(r.thumbnail, 'data:image/jpeg;base64,' + JPEG);
});

test('a remote cover URL passes through untouched', () => {
  const url = 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg';
  assert.equal(normalizeMedia(media({ thumbnail: url })).thumbnail, url);
});

test('a thumbnail no browser could decode becomes none, so the fallback runs', () => {
  // This is the knock-on that made one comma cost the cover twice: hydrateArtwork
  // returns early when `data.thumbnail` is truthy, so a broken string suppressed
  // the iTunes lookup as well.
  for (const bad of ['data:image/jpeg,' + JPEG, 'not a uri', 'data:image/jpeg;base64,', 'javascript:alert(1)', 'http://x/y.jpg']) {
    assert.equal(normalizeMedia(media({ thumbnail: bad })).thumbnail, null, bad);
  }
  assert.match(SERVER, /if \(!data \|\| !data\.active \|\| data\.thumbnail\) return data;/,
    'hydrateArtwork still only looks when there is nothing — which is why null matters');
});

// ── The em dash ──────────────────────────────────────────────────────────────

test('Apple Music\'s "Artist — Album" is split back into two fields', () => {
  const r = normalizeMedia(media({ artist: 'Wilmette — Hyperfocused' }));
  assert.equal(r.artist, 'Wilmette');
  assert.equal(r.album, 'Hyperfocused');
});

test('an album the app actually sent is never second-guessed', () => {
  const r = normalizeMedia(media({ artist: 'Wilmette — Hyperfocused', album: 'Real Album' }));
  assert.equal(r.artist, 'Wilmette — Hyperfocused');
  assert.equal(r.album, 'Real Album');
});

test('a dashed album title splits at the join, not at nothing', () => {
  // This shipped as "only when there is exactly one dash", which declined here.
  // The reporter came back with a real album and a count: across ~22,000 Apple
  // catalogue rows, artist names containing an em dash appeared 0 times and
  // album titles containing one appeared twice — both of which the first-dash
  // rule gets right, because Apple puts the artist first.
  const r = normalizeMedia(media({
    artist: 'Tom Holkenborg — Rebel Moon — Part One: A Child of Fire (Soundtrack from the Netflix Film)',
  }));
  assert.equal(r.artist, 'Tom Holkenborg');
  assert.equal(r.album, 'Rebel Moon — Part One: A Child of Fire (Soundtrack from the Netflix Film)');
});

test('an artist whose own name held the dash is what this trades away', () => {
  // Stated rather than hidden: nobody could find one in the catalogue, but if it
  // exists the artist line loses the tail. That is the accepted cost of not
  // leaving every dashed soundtrack mashed onto one line.
  const r = normalizeMedia(media({ artist: 'A — B — Album' }));
  assert.equal(r.artist, 'A');
  assert.equal(r.album, 'B — Album');
});

test('only Apple Music, because the em dash is their convention and not a rule', () => {
  const r = normalizeMedia(media({ source: 'Spotify.exe', artist: 'Godspeed You! — Black Emperor' }));
  assert.equal(r.artist, 'Godspeed You! — Black Emperor');
  assert.equal(r.album, '');
});

test('a dash with nothing on one side of it is not a split', () => {
  for (const artist of ['— Album', 'Artist — ', '—']) {
    const r = normalizeMedia(media({ artist }));
    assert.equal(r.artist, artist, artist);
    assert.equal(r.album, '', artist);
  }
});

test('a hyphen is not an em dash', () => {
  const r = normalizeMedia(media({ artist: 'Jay-Z - The Blueprint' }));
  assert.equal(r.artist, 'Jay-Z - The Blueprint');
  assert.equal(r.album, '');
});

// ── Both hosts, and the way in ───────────────────────────────────────────────

test('every media answer goes through the normaliser', () => {
  // Including the fallback path: a payload that skipped it would carry the bug
  // back in through the door the primary path just closed.
  assert.match(SERVER, /normalizeMedia\(await runMediaRequest\('info', 12000\)\)/);
  assert.match(SERVER, /hydrateArtwork\(normalizeMedia\(await getMediaFallback\(e\.message\)\)\)/);
});

test('both hosts build a correct data URI in the first place', () => {
  // The server repairs what arrives — which is what fixes the cover for people
  // whose xenon-helper.exe has not been rebuilt yet — but the hosts must stop
  // producing it, or the repair is load-bearing forever.
  assert.match(PS1, /Split\(','\)\[0\]\.Trim\(\)/, 'media.ps1 must take the first content type');
  assert.match(PS1, /\^image\/\[A-Za-z0-9\]\[A-Za-z0-9\.\+-\]\*\$/, 'and only use it when it is an image MIME');
  assert.ok(!/\$contentType = if \(\$stream\.ContentType\) \{ \[string\]\$stream\.ContentType \}/.test(PS1),
    'the whole ContentType must not reach the data URI any more');
  assert.match(CS, /private static string ImageContentType\(string\? raw\)/);
  assert.match(CS, /raw\.Split\(','\)\[0\]\.Trim\(\)/);
  assert.match(CS, /thumbnail = "data:" \+ ImageContentType\(stream\.ContentType\) \+ ";base64,"/);
  assert.ok(!/string\.IsNullOrEmpty\(stream\.ContentType\) \? "image\/jpeg" : stream\.ContentType/.test(CS),
    'the C# host must not pass the raw ContentType through either');
});
