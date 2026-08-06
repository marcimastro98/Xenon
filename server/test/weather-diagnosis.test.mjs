import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// ── Why the weather can fail, said out loud ─────────────────────────────────
// Reported three times from the same install ("Weather not working and still
// wrong next hours", v4.11.3): the tile said only "unavailable", which is the
// same sentence whether the PC never got its coordinates, the typed city does
// not exist, or the free weather services were down — and the fix for each of
// those is different. It took a code read to work out that the machine had been
// running on the wttr fallback for weeks (that IS the "wrong next hours"), which
// only happens when IP geolocation fails, because open-meteo and met.no both
// return null on their first line without lat/lon.
//
// Two guarantees are pinned here. The lookup no longer hangs off ONE hostname,
// and the failure carries a reason the tile can translate. Neither is checkable
// by running the server — both depend on services being reachable — so the pure
// halves are extracted from the real sources and exercised against payloads
// captured from the live services.
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const SERVER = readFileSync(join(root, 'server.js'), 'utf8');
const SYSTEM = readFileSync(join(root, 'js', 'system.js'), 'utf8');
const I18N = readFileSync(join(root, 'js', 'i18n.js'), 'utf8');

// The real GEO_IP_SOURCES table and its value guard, lifted out of server.js and
// evaluated — a paraphrase here would test the paraphrase.
function geoModule() {
  const table = SERVER.match(/const GEO_IP_SOURCES = Object\.freeze\(\[[\s\S]*?\n\]\);/);
  assert.ok(table, 'GEO_IP_SOURCES not found in server.js');
  const guard = SERVER.match(/function normalizeGeoIpValue\(parsed\) \{[\s\S]*?\n\}/);
  assert.ok(guard, 'normalizeGeoIpValue not found in server.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `${table[0]}\n${guard[0]}\nglobalThis.__geo = { GEO_IP_SOURCES, normalizeGeoIpValue };`,
    ctx, { filename: 'server.js (geo)' },
  );
  return ctx.__geo;
}

// Real answers, trimmed to the fields the parsers read. Note the shapes differ:
// ipwho.is has a `success` flag and numeric coordinates, geojs sends them as
// STRINGS, ipapi.co reports failure with an `error` field and names the country
// in a different key.
const FIXTURES = {
  'ipwho.is': { success: true, latitude: 45.4643, longitude: 9.1895, city: 'Milan', region: 'Lombardy', country: 'Italy' },
  'geojs': { latitude: '45.4722', longitude: '9.1922', city: 'Milan', region: 'Lombardy', country: 'Italy' },
  'ipapi': { latitude: 45.4643, longitude: 9.1895, city: 'Milan', region: 'Lombardy', country_name: 'Italy' },
};

test('every geolocation source parses its own real payload into the same shape', () => {
  const { GEO_IP_SOURCES, normalizeGeoIpValue } = geoModule();
  assert.ok(GEO_IP_SOURCES.length >= 2, 'one hostname is one point of failure — that is the bug this fixes');
  for (const source of GEO_IP_SOURCES) {
    const fixture = FIXTURES[source.name];
    assert.ok(fixture, `no captured payload for ${source.name} — add one before adding the source`);
    const value = normalizeGeoIpValue(source.parse(fixture));
    assert.ok(value, `${source.name} produced no coordinates from its own answer`);
    assert.ok(Math.abs(value.lat - 45.47) < 0.1 && Math.abs(value.lon - 9.19) < 0.1, `${source.name} coordinates`);
    assert.equal(value.location, 'Milan', `${source.name} city`);
    assert.equal(value.country, 'Italy', `${source.name} country`);
  }
});

test("a source's own failure answer is refused rather than parsed", () => {
  const { GEO_IP_SOURCES, normalizeGeoIpValue } = geoModule();
  const byName = Object.fromEntries(GEO_IP_SOURCES.map(s => [s.name, s]));
  // ipwho.is answers 200 with success:false; ipapi.co answers 200 with error:true.
  // Both would otherwise yield NaN coordinates and look like a lookup that "worked".
  assert.equal(byName['ipwho.is'].parse({ success: false, message: 'Reserved range' }), null);
  assert.equal(byName['ipapi'].parse({ error: true, reason: 'RateLimited' }), null);
  for (const source of GEO_IP_SOURCES) {
    assert.equal(normalizeGeoIpValue(source.parse({})), null, `${source.name} accepted an empty body`);
  }
});

test('0/0 and out-of-range coordinates are refused', () => {
  const { normalizeGeoIpValue } = geoModule();
  // Null island is in the Atlantic: a forecast for it is a plausible-looking
  // answer, which is worse than no answer at all.
  assert.equal(normalizeGeoIpValue({ lat: 0, lon: 0 }), null);
  assert.equal(normalizeGeoIpValue({ lat: 91, lon: 9 }), null);
  assert.equal(normalizeGeoIpValue({ lat: 45, lon: -181 }), null);
  assert.equal(normalizeGeoIpValue({ lat: 'x', lon: 9 }), null);
  assert.ok(normalizeGeoIpValue({ lat: '0', lon: '9.19' }), 'a real coordinate on the equator is valid');
});

test('a total weather failure is answered with a reason, not thrown', () => {
  // A 500 gives the tile nothing to show, and the tile is where the user is.
  assert.doesNotMatch(SERVER, /throw new Error\('Weather unavailable from all providers'\)/);
  assert.match(SERVER, /error:\s*hasCoords \? 'providers_down' : \(location\.mode === 'manual' \? 'city_not_found' : 'no_location'\)/);
  // The failure must not be cached, or one bad minute freezes the tile for the
  // whole TTL: the return happens before weatherCache.set, never after.
  const fail = SERVER.indexOf("error: hasCoords ? 'providers_down'");
  const store = SERVER.indexOf('weatherCache.set(cacheKey');
  assert.ok(fail > 0 && store > fail, 'the failure payload must return before the cache write');
});

test('the reasons the server sends are exactly the ones the client can name', () => {
  const map = SYSTEM.match(/const WEATHER_ERROR_KEYS = \{[\s\S]*?\n\};/);
  assert.ok(map, 'WEATHER_ERROR_KEYS not found in js/system.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${map[0]}\nglobalThis.__m = WEATHER_ERROR_KEYS;`, ctx, { filename: 'system.js' });
  const client = Object.keys(ctx.__m).sort();
  // The literals the server can put in `error:`. A reason with no entry here
  // renders as the old generic "no data" — silently, which is how this whole
  // class of bug stays invisible.
  const server = ['city_not_found', 'no_location', 'providers_down'];
  assert.deepEqual(client, server);
  for (const reason of server) {
    assert.ok(SERVER.includes(`'${reason}'`), `server.js never sends ${reason}`);
  }
});

test('every reason is translated in all eleven languages', () => {
  const LANGS = 11;
  const keys = [
    'weather_err_no_location', 'weather_err_no_location_hint',
    'weather_err_city', 'weather_err_city_hint',
    'weather_err_providers', 'weather_err_providers_hint',
  ];
  for (const key of keys) {
    // Bare in ten blocks, quoted in the Dutch one — count both spellings. The
    // non-English blocks spread ...i18n.en, so a resolved lookup would pass on
    // English text; counting the literal is what proves it was translated.
    const bare = I18N.split(`${key}:`).length - 1;
    const quoted = I18N.split(`"${key}":`).length - 1;
    assert.equal(bare + quoted, LANGS, `${key} appears in ${bare + quoted} language blocks, expected ${LANGS}`);
  }
});
