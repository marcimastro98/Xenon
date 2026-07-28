import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `SERVER` in server/js/state.js is the origin ~50 call sites across 15 modules
// aim at. It used to resolve to the loopback origin unless the page's HOSTNAME
// was 127.0.0.1/localhost/::1, which meant a paired phone (R1.1) fetched its OWN
// loopback: /deck-config, /network, /api/performance/stats, /windows, /media/*,
// /volume/*, /system, /events and the rest all reached nothing, while the shell,
// the SSE stream and every relative fetch worked — so the dashboard drew in full
// and then did nothing. That is the exact failure the paired-device door exists
// to avoid, and it is invisible from the machine running the server, which is
// why it is pinned here.
//
// state.js cannot be require()d: it is a classic script whose top level calls
// helpers from utils.js. So the declaration is extracted and evaluated on its
// own, which is also what keeps this test honest — it reads the shipped source.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'js', 'state.js'), 'utf8');

const FALLBACK = 'http://127.0.0.1:3030';

function extractServerExpr() {
  const at = SRC.indexOf('const SERVER = ');
  assert.notEqual(at, -1, 'state.js must still declare `const SERVER =`');
  const end = SRC.indexOf(';', at);
  assert.notEqual(end, -1, 'the SERVER declaration must terminate');
  return SRC.slice(at + 'const SERVER = '.length, end);
}

// Evaluate the real declaration against a stubbed window. `_xcConst` is the
// @xenon/core constants object state.js reads for the fallback.
// The `new Function` body is a slice of our OWN source file, read from disk in a
// test — the point is precisely that nothing here re-implements the expression,
// because a copy would keep passing after the shipped one regressed. Never let
// anything from the wire reach this.
function resolveServer(location) {
  const expr = extractServerExpr();
  const fn = new Function('window', '_xcConst', 'return (' + expr + ');');
  return fn(location ? { location } : undefined, { LOOPBACK_ORIGIN: FALLBACK });
}

const loc = (href) => {
  const u = new URL(href);
  return { protocol: u.protocol, hostname: u.hostname, origin: u.origin, href };
};

test('a page served over http/https talks to the origin that served it', () => {
  const CASES = [
    'http://127.0.0.1:3030/',              // the PC
    'http://localhost:3030/',
    'http://192.168.1.3:3030/',            // a paired phone on the LAN — the regression
    'http://10.0.0.42:3030/deck',
    'http://[fd00::1]:3030/',              // IPv6 literal
    'https://xenon-app.com/demo/',         // the static browser demo, unpatched
  ];
  for (const href of CASES) {
    assert.equal(resolveServer(loc(href)), new URL(href).origin, href);
  }
});

// The one thing SERVER must never be on a paired device: someone else's machine.
test('a LAN page never addresses the loopback of the device rendering it', () => {
  assert.notEqual(resolveServer(loc('http://192.168.1.3:3030/')), FALLBACK);
  assert.notEqual(resolveServer(loc('http://192.168.1.3:3030/')), 'http://localhost:3030');
});

// Surfaces that are NOT served over http have no usable origin to inherit, and
// there the local backend genuinely is the answer.
test('a non-http surface falls back to the local backend', () => {
  assert.equal(resolveServer(loc('file:///C:/x/index.html')), FALLBACK);
  assert.equal(resolveServer(loc('about:blank')), FALLBACK);
  assert.equal(resolveServer(undefined), FALLBACK);   // no window at all
});

// tools/build-demo.mjs prefix-inserts its own `SERVER = ''` above this exact
// line. If the declaration is ever reflowed, the demo build fails loudly there —
// but it fails at build time on a machine nobody is watching, so say it here too.
test('the declaration keeps the shape the demo build anchors on', () => {
  const anchor = "const SERVER = (typeof window !== 'undefined' && window.location &&";
  assert.equal(SRC.split(anchor).length - 1, 1,
    'exactly one occurrence of the build-demo anchor must remain');
});

// A second hardcoded loopback origin would reintroduce the same bug one module
// at a time — silently, and only for the users who are not at the PC.
//
// The exceptions are listed with the reason each one is NOT the dashboard
// addressing its own backend, because that is the whole distinction the rule
// draws. Widening this list is the review; anything else fails.
const LOOPBACK_EXEMPT = [
  // Everything in native-bridge.js runs inside the native shell, on the machine
  // hosting the backend, where the loopback origin IS the same origin. Its one
  // non-native path now refuses to run on a remote surface at all.
  { file: 'native-bridge.js' },
  // Prose.
  { file: 'ambient-idle.js' },
  // The address of the user's OLLAMA, not of Xenon: a default for a setting the
  // SERVER dials (server/ai-local.js). The browser never fetches it.
  { match: ':11434' },
  // An OAuth redirect URI registered with Spotify, which must match the string
  // on file byte for byte. Pointing it at the origin the page happens to be on
  // would make the callback fail the moment it is not the registered one.
  { match: '/stream/spotify/callback' },
];

test('no client module hardcodes the loopback origin as a fetch base', () => {
  const dir = path.join(HERE, '..', 'js');
  const exemptFiles = new Set(['state.js', ...LOOPBACK_EXEMPT.filter((e) => e.file).map((e) => e.file)]);
  const exemptMatches = LOOPBACK_EXEMPT.filter((e) => e.match).map((e) => e.match);
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    if (exemptFiles.has(name)) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of src.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;   // comments explain, they don't fetch
      if (!/['"`]https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/.test(line)) continue;
      if (exemptMatches.some((m) => line.includes(m))) continue;
      offenders.push(name + ': ' + trimmed);
    }
  }
  assert.deepEqual(offenders, [], 'use SERVER (or a relative path) instead');
});
