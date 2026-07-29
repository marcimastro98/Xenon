import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ra = require('../remote-access.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The allowlist ────────────────────────────────────────────────────────────

// A paired device IS the dashboard. The first version of this door was far
// narrower — read-only plus media/audio/mic — and it produced a tablet that drew
// the whole dashboard and then refused almost every control on it. These are the
// controls that make it a second screen rather than a photograph of one.
test('a paired device gets the dashboard, not a view of it', () => {
  const allowed = [
    ['/', 'GET'], ['/sse', 'GET'], ['/status', 'GET'], ['/system', 'GET'],
    ['/js/main.js', 'GET'], ['/styles/global.css', 'GET'],
    ['/vendor/gridstack.js', 'GET'], ['/shared/src/constants.js', 'GET'],
    ['/public/images/logo/logo-mark.png', 'GET'], ['/uploads/background-1.png', 'GET'],
    ['/sdk/widget/pkg/index.html', 'GET'], ['/icon-pack/set/a.png', 'GET'],
    // The controls
    ['/toggle', 'POST'], ['/volume/set', 'POST'], ['/speaker/mute', 'POST'],
    ['/media/playpause', 'POST'], ['/media/next', 'POST'],
    ['/notes/list', 'POST'], ['/tasks', 'POST'], ['/api/timers', 'POST'],
    ['/api/timers/abc', 'DELETE'], ['/api/timers/abc', 'PATCH'],
    // The things the narrow version refused, which are the whole point
    ['/actions/run', 'POST'],            // a Deck key really fires on the PC
    ['/deck-config', 'POST'],            // the Deck can be edited from here
    ['/settings', 'POST'],               // and so can the settings
    ['/windows', 'GET'], ['/windows/focus', 'POST'], ['/windows/launch', 'POST'],
    ['/search', 'GET'], ['/search/open', 'POST'],
    ['/api/ai', 'POST'], ['/api/tts', 'POST'], ['/api/transcribe', 'POST'],
    ['/api/screenshot', 'POST'],
    ['/sdk/install', 'POST'], ['/sdk/fetch', 'POST'],
    ['/disk/overview', 'GET'], ['/disk/scan', 'POST'],
    ['/backup/export', 'GET'], ['/background', 'POST'], ['/font', 'POST'],
    ['/api/community/catalog', 'POST'], ['/icon-pack', 'POST'],
    ['/deck/app-icon', 'GET'], ['/deck/popup/open', 'POST'],
  ];
  for (const [p, m] of allowed) {
    assert.equal(ra.remotePathAllowed(p, m), true, m + ' ' + p + ' must be allowed');
  }
});

// The deny list is short and every entry has the same reason: it needs a person
// standing at the PC. Anything that grows this list should be able to say that
// sentence about itself.
test('only what needs a person at the PC is refused', () => {
  const denied = [
    ['/system/enable-sensors', 'POST'],  // raises a UAC prompt nobody is at
    ['/update/prepare', 'POST'],         // swaps files and restarts the server
    ['/update/apply', 'POST'],
    ['/api/native/install', 'POST'],     // installers: download, then place an exe
    ['/api/gamemode/install-presentmon', 'POST'],
    ['/api/lighting/sdk-install', 'POST'],
    ['/api/ai-local/whisper-install', 'POST'],
    ['/embedded-browser/adblock/install', 'POST'],
    ['/remote/install', 'POST'],
    ['/second-screen/install', 'POST'],
    ['/second-screen/create-display', 'POST'],
    ['/api/claude/event', 'POST'],       // Claude Code's own token-gated ingest
    ['/api/claude/permission', 'POST'],
    // …plus the pairing admin, which is loopback-only by being denied here: a
    // phone must not enrol another phone or revoke the device that kicks it off.
    ['/api/remote-access/status', 'GET'],
    ['/api/remote-access/enable', 'POST'],
    ['/api/remote-access/pair', 'POST'],
    ['/api/remote-access/revoke', 'POST'],
    ['/api/remote-access/revoke-all', 'POST'],
    // …and the transfer settings, which name a folder on the PC.
    ['/api/transfer/settings', 'POST'],
    ['/api/transfer/settings', 'GET'],
    // …and every GET that writes (see the dedicated test below).
    ['/toggle', 'GET'], ['/media/next', 'GET'], ['/notes', 'GET'],
  ];
  for (const [p, m] of denied) {
    assert.equal(ra.remotePathAllowed(p, m), false, m + ' ' + p + ' must be refused');
  }
  // Sending and receiving files IS the feature, so everything except the
  // folder-naming endpoint stays reachable from a paired device.
  for (const [p, m] of [['/api/transfer/upload', 'POST'], ['/api/transfer/open', 'POST'],
    ['/api/transfer/reveal', 'POST'], ['/api/transfer/delete', 'POST'],
    ['/api/transfer/list', 'GET'], ['/api/transfer/file', 'GET'],
    ['/api/transfer/file', 'HEAD'], ['/api/transfer/thumb', 'GET']]) {
    assert.equal(ra.remotePathAllowed(p, m), true,
      m + ' ' + p + ' must stay reachable — a phone that cannot send files has no feature');
  }
  // …and the download must NOT be a GET mutator, or tapping Download on the
  // phone refuses the very request it exists to serve.
  assert.equal(ra.remotePathAllowed('/api/transfer/upload', 'GET'), false,
    'the upload must be POST-only: a GET is what a top-level navigation looks like');

  // Redeem stays reachable — it is how a device becomes paired at all.
  assert.equal(ra.remotePathAllowed('/api/remote-access/redeem', 'POST'), true);
  assert.equal(ra.remotePathAllowed('/api/remote-access/whoami', 'GET'), true);
});

test('junk, traversal and exotic methods are refused', () => {
  for (const p of ['', 'js/main.js', null, undefined, 42, '/js/../server.js', '/../settings']) {
    assert.equal(ra.remotePathAllowed(p, 'GET'), false, String(p));
  }
  assert.equal(ra.remotePathAllowed('/status', 'PUT'), false);
  assert.equal(ra.remotePathAllowed('/status', 'TRACE'), false);
  assert.equal(ra.remotePathAllowed('/status', ''), false);
});

// THE contract test, inverted along with the model. Listing everything a paired
// device CAN reach is no longer meaningful — it is nearly the whole server, and
// that is the intent. What must stay reviewed is the other side: the exact set
// of real routes it cannot. A route that quietly joins this list (or drops off
// it) fails here instead of changing the product silently.
test('the refused surface matches an explicit, reviewed list', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  const routes = new Set();
  const re = /reqPath === '([^']+)' && req\.method === '([A-Z]+)'/g;
  let m;
  while ((m = re.exec(src))) routes.add(m[2] + ' ' + m[1]);
  assert.ok(routes.size > 200, 'route extraction broke: found only ' + routes.size);

  const refused = [...routes]
    .filter((r) => { const [meth, p] = r.split(' '); return !ra.remotePathAllowed(p, meth); })
    .sort();

  assert.deepEqual(refused, [
    // Pairing admin — loopback-only so a phone cannot enrol another phone or
    // revoke the device that would kick it off.
    'GET /api/remote-access/status',
    // File transfer settings, both methods. Everything ELSE about transfers is
    // open to a paired device on purpose — sending a photo from the phone in
    // your hand to the PC in the next room is the entire feature — but this
    // endpoint names the FOLDER on that PC where every future arrival lands,
    // and its GET answers with that path. A device that could set it could aim
    // arrivals at the app's own directory or at the user's Documents; a device
    // that could read it learns a path it has no use for. The folder is chosen
    // at the PC with the picker, the Slideshow folder-source shape. (The POST
    // is further down: this list is sorted.)
    'GET /api/transfer/settings',
    // The GET that SAVES the whole notes store (the iCUE ?save= shape). Reading
    // notes goes through /notes/list, which is allowed.
    'GET /notes',
    // The channel's RTMP stream key. It is the one credential the dashboard is
    // asked to put on screen, and whoever reads it can broadcast to the user's
    // channel — so it stays on the PC rather than crossing the LAN in the clear.
    'GET /stream/youtube/streamkey',
    // Installers: each downloads something and puts it where it will be run.
    'POST /api/ai-local/whisper-install',
    // Claude Code's own ingest, posted by the `claude` process against a token
    // minted on the PC. Nothing in the dashboard calls these.
    'POST /api/claude/event',
    'POST /api/claude/permission',
    'POST /api/gamemode/install-presentmon',
    'POST /api/lighting/sdk-install',
    'POST /api/native/install',
    // Dialling. The phonebook, the call log and the live call state stay open
    // to a paired device — that is the dashboard being the dashboard — but the
    // call itself is placed where its audio comes out, which is the PC. A dial
    // button on a tablet in another room would start a call the user can
    // neither hear nor hang up, and it is the one action here that costs money
    // per use.
    'POST /api/phone/dial',
    // Sending a message. Reading them stays open to a paired device; sending
    // one goes out under the user's number to somebody else and cannot be
    // recalled, which is the same class as dialling.
    'POST /api/phone/send',
    'POST /api/remote-access/enable',
    // The T2 opt-in belongs to the pairing admin for the same reason as the
    // rest of it: a paired device must not be able to change the doors. Turning
    // HTTPS off from a phone would be a device deciding how other devices reach
    // the PC, and turning it ON needs someone reading the reason it did not.
    'POST /api/remote-access/https',
    // The guided setup installs software with an elevation prompt and opens a
    // browser sign-in — both of which happen at the PC and need someone there.
    'POST /api/remote-access/https/setup',
    'POST /api/remote-access/pair',
    'POST /api/remote-access/pair/cancel',
    'POST /api/remote-access/rename',
    'POST /api/remote-access/revoke',
    'POST /api/remote-access/revoke-all',
    // The other half of the transfer settings pair above: the only writer of
    // the folder arrivals land in.
    'POST /api/transfer/settings',
    'POST /embedded-browser/adblock/install',
    'POST /remote/install',
    'POST /second-screen/create-display',
    'POST /second-screen/install',
    'POST /second-screen/remove-display',
    // Raises a UAC prompt on a PC nobody is standing at.
    'POST /system/enable-sensors',
    // The updater swaps files and restarts the server under the connection
    // making the request.
    'POST /update/apply',
    'POST /update/prepare',
  ]);
});

// ── The gate, end to end ─────────────────────────────────────────────────────

// A request from a paired phone loading the dashboard: everything correct.
const GOOD = {
  enabled: true,
  host: '192.168.1.42:3030',
  origin: 'http://192.168.1.42:3030',
  fetchSite: 'same-origin',
  fetchMode: 'cors',
  method: 'GET',
  pathname: '/status',
  hasDevice: true,
  addresses: ['192.168.1.42'],
  port: 3030,
};
const gate = (over) => ra.gateDecision(Object.assign({}, GOOD, over || {}));

test('a correct request from a paired device passes', () => {
  assert.equal(gate(), 'ok');
  assert.equal(gate({ pathname: '/', fetchSite: 'none', fetchMode: 'navigate' }), 'ok');
});

// The feature is off by default, and "off" must be indistinguishable from a
// build that never had it — otherwise the switch advertises itself.
test('while disabled every single request is the plain old 403', () => {
  for (const over of [{}, { pathname: '/pair', hasDevice: false }, { pathname: '/sse' },
    { pathname: '/api/remote-access/redeem', method: 'POST', hasDevice: false }]) {
    assert.equal(gate(Object.assign({ enabled: false }, over)), 'forbidden');
  }
});

// THE ordering test. Each check must lose to the one before it, or a later
// check's success could paper over an earlier failure — a valid token must not
// rescue a rebound Host, and being on the allowlist must not rescue a
// cross-site request.
test('an earlier layer always beats a later one', () => {
  // A perfect token cannot rescue a Host we do not own…
  assert.equal(gate({ host: 'evil.example:3030', origin: 'http://evil.example:3030' }), 'forbidden');
  // …nor can it rescue a foreign Origin…
  assert.equal(gate({ origin: 'http://evil.example' }), 'bad_origin');
  // …nor a cross-site request…
  assert.equal(gate({ fetchSite: 'cross-site' }), 'bad_fetch_site');
  // …nor a path that is not allowlisted.
  assert.equal(gate({ pathname: '/update/apply', method: 'POST' }), 'remote_denied');
  // And a bad Host beats a bad Origin, which beats a bad site, which beats the
  // allowlist: the FIRST failure is the one reported.
  assert.equal(gate({ host: 'evil:3030', origin: 'null', fetchSite: 'cross-site', pathname: '/update/apply' }), 'forbidden');
  assert.equal(gate({ origin: 'null', fetchSite: 'cross-site', pathname: '/update/apply' }), 'bad_origin');
  assert.equal(gate({ fetchSite: 'cross-site', pathname: '/update/apply' }), 'bad_fetch_site');
});

// An ABSENT Sec-Fetch-Site must pass. This is the header's whole story on this
// transport: browsers append Sec-Fetch-* only to potentially trustworthy URLs,
// so plain HTTP to a LAN address carries none of them — verified against a real
// echo server (a navigation, a same-origin fetch() and a favicon request to
// http://192.168.1.3:8321 arrived with no Sec-Fetch-Site, no Sec-Fetch-Mode and
// no Origin; the same page on http://127.0.0.1:8321 carried all of them).
// Requiring it, as the first version did, refused 100% of real traffic: a
// paired iPhone could not load the dashboard at all, only the refusal page.
test('an absent Sec-Fetch-Site passes — it never arrives on this transport', () => {
  assert.equal(gate({ fetchSite: '', fetchMode: '' }), 'ok');
  assert.equal(gate({ fetchSite: undefined, fetchMode: undefined }), 'ok');
  // …including the shape a QR scan produces: a top-level navigation with no
  // fetch-metadata at all.
  assert.equal(gate({ pathname: '/pair', hasDevice: false, fetchSite: undefined, fetchMode: undefined }), 'pre_auth');
  assert.equal(gate({ pathname: '/', fetchSite: undefined, fetchMode: undefined }), 'ok');
});

// Still enforced when it IS present — which is the T2 (HTTPS) case, where the
// header comes back. Absent means "this transport cannot say", not "trust me".
test('a Sec-Fetch-Site that IS present must still say same-origin', () => {
  assert.equal(gate({ fetchSite: 'cross-site' }), 'bad_fetch_site');
  assert.equal(gate({ fetchSite: 'same-site' }), 'bad_fetch_site');
  assert.equal(gate({ fetchSite: 'none', fetchMode: 'cors' }), 'bad_fetch_site', 'only navigations may be `none`');
  assert.equal(gate({ fetchSite: 'none', fetchMode: 'navigate' }), 'ok');
  assert.equal(gate({ fetchSite: 'same-origin' }), 'ok');
  assert.equal(gate({ fetchSite: 'SAME-ORIGIN' }), 'ok', 'header case is not significant');
});

// THE rule that replaces the layer Fetch Metadata cannot provide here. A
// top-level navigation is the one shape that carries neither an Origin nor a
// cross-site marker, and it is always a GET — so as long as no GET on this door
// mutates anything, a page on another port of the same LAN address cannot use a
// navigation to change state. server.js's own CSRF_MUTATION_PATHS is the
// authoritative list of "GET that mutates", so read it from the source.
test('no GET reachable from a paired device can mutate anything', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('const CSRF_MUTATION_PATHS = new Set(['));
  const list = block.slice(0, block.indexOf(']);'));
  const paths = [...list.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(paths.length > 30, 'CSRF_MUTATION_PATHS extraction broke: ' + paths.length);
  // CSRF_MUTATION_PATHS answers a slightly wider question than this door needs:
  // it also lists reads whose only side effect is OUTBOUND (a catalog cache miss
  // that fetches, a screenshot that photographs). Those change nothing on the PC
  // and the dashboard needs them, so they are named back in — see
  // GET_READ_EXCEPTIONS. Everything else in the list must be refused.
  let checked = 0;
  for (const p of paths) {
    if (ra.GET_READ_EXCEPTIONS.has(p)) continue;
    checked++;
    assert.equal(ra.remotePathAllowed(p, 'GET'), false,
      'GET ' + p + ' changes state and must not be reachable from a paired device');
    assert.equal(ra.remotePathAllowed(p, 'HEAD'), false, 'HEAD ' + p);
  }
  assert.ok(checked > 25, 'almost everything was excepted away: ' + checked);
  // Every exception must actually BE in the list it excepts from, or it is a
  // stale name quietly doing nothing.
  for (const p of ra.GET_READ_EXCEPTIONS) {
    assert.ok(paths.includes(p), p + ' is not in CSRF_MUTATION_PATHS — stale exception');
  }
  // The controls the phone DOES need still work — as POSTs, which a navigation
  // can never be. (The dashboard's own client already POSTs all of these.)
  for (const p of ['/toggle', '/volume/set', '/speaker/mute', '/media/playpause', '/mic/volume']) {
    assert.equal(ra.remotePathAllowed(p, 'POST'), true, 'POST ' + p + ' must still work');
  }
});

test('an unpaired device reaches exactly two paths, and is sent to pair from the root', () => {
  const un = { hasDevice: false, fetchSite: 'none', fetchMode: 'navigate' };
  assert.equal(gate(Object.assign({ pathname: '/pair' }, un)), 'pre_auth');
  assert.equal(gate(Object.assign({ pathname: '/api/remote-access/redeem', method: 'POST', fetchSite: 'same-origin', fetchMode: 'cors' }, { hasDevice: false })), 'pre_auth');
  assert.equal(gate(Object.assign({ pathname: '/' }, un)), 'redirect_pair');
  // Everything else it could name is refused, allowlisted or not.
  for (const p of ['/status', '/sse', '/settings', '/js/main.js', '/notes/list']) {
    assert.equal(gate(Object.assign({ pathname: p }, un, { fetchSite: 'same-origin', fetchMode: 'cors' })), 'unpaired', p);
  }
  // …and the pre-auth pair is exact in BOTH path and method: the same paths with
  // the other verb get no free pass, they fall through to the token check (or to
  // the GET-never-writes rule, which is why the redeem GET is refused outright).
  assert.equal(gate(Object.assign({ pathname: '/pair', method: 'POST' }, un)), 'unpaired');
  assert.equal(gate(Object.assign({ pathname: '/api/remote-access/redeem', method: 'GET' }, un)), 'remote_denied');
});

test('the gate never returns an unexpected verdict, whatever it is fed', () => {
  const OK = new Set(['forbidden', 'bad_origin', 'bad_fetch_site', 'remote_denied', 'redirect_pair', 'unpaired', 'pre_auth', 'ok']);
  const junk = [undefined, null, {}, { enabled: true }, { enabled: 'yes' },
    { enabled: true, host: 42, addresses: 'x', port: 'p', pathname: {}, method: [] }];
  for (const input of junk) assert.ok(OK.has(ra.gateDecision(input)), JSON.stringify(input));
  // …and nothing malformed is ever waved through.
  for (const input of junk) assert.notEqual(ra.gateDecision(input), 'ok');
});

// ── Host: the anti-rebinding layer ───────────────────────────────────────────

const ADDR = ['192.168.1.42', '100.101.102.103'];

test('a Host that is one of our own IP literals on our port is accepted', () => {
  assert.equal(ra.isOwnAddressHost('192.168.1.42:3030', ADDR, 3030), true);
  assert.equal(ra.isOwnAddressHost('100.101.102.103:3030', ADDR, 3030), true);
  assert.equal(ra.isOwnAddressHost('192.168.1.42:3030'.toUpperCase(), ADDR, 3030), true);
});

// A DNS-rebinding attack needs a NAME that later resolves to a private address.
// Refusing every name is the whole defence, so it gets its own test.
test('a Host that is a NAME is always refused, however plausible', () => {
  for (const h of ['xenon.local:3030', 'my-pc:3030', 'attacker.example:3030',
    'localhost:3030', 'XENON-PC.lan:3030', '192.168.1.42.nip.io:3030']) {
    assert.equal(ra.isOwnAddressHost(h, ADDR, 3030), false, h);
  }
});

test('a Host we do not own, or on another port, is refused', () => {
  assert.equal(ra.isOwnAddressHost('192.168.1.99:3030', ADDR, 3030), false);
  assert.equal(ra.isOwnAddressHost('192.168.1.42:8080', ADDR, 3030), false);
  assert.equal(ra.isOwnAddressHost('192.168.1.42', ADDR, 3030), false, 'a portless Host is not ours');
  assert.equal(ra.isOwnAddressHost('', ADDR, 3030), false);
  assert.equal(ra.isOwnAddressHost(null, ADDR, 3030), false);
  assert.equal(ra.isOwnAddressHost('192.168.1.42:3030', [], 3030), false);
  assert.equal(ra.isOwnAddressHost('192.168.1.42:3030', null, 3030), false);
});

test('IPv6 literals keep their brackets straight', () => {
  const v6 = ['fd00::1'];
  assert.equal(ra.isOwnAddressHost('[fd00::1]:3030', v6, 3030), true);
  assert.equal(ra.isOwnAddressHost('[fd00::1]:9999', v6, 3030), false);
  assert.equal(ra.isOwnAddressHost('[fd00::1]', v6, 3030), false, 'no port');
  assert.equal(ra.isOwnAddressHost('[fd00::2]:3030', v6, 3030), false);
  assert.equal(ra.isOwnAddressHost('[fd00::1:3030', v6, 3030), false, 'unclosed bracket');
});

// ── Origin ───────────────────────────────────────────────────────────────────

test('Origin must be our own origin, and `null` is refused', () => {
  assert.equal(ra.originAllowed('http://192.168.1.42:3030', '192.168.1.42:3030'), true);
  assert.equal(ra.originAllowed(undefined, '192.168.1.42:3030'), true, 'absent = not a browser fetch');
  assert.equal(ra.originAllowed('', '192.168.1.42:3030'), true);
  // The loopback path accepts Origin:null for the iCUE WebView. That acceptance
  // must NOT reach the LAN, where a sandboxed iframe on any page would inherit it.
  assert.equal(ra.originAllowed('null', '192.168.1.42:3030'), false);
  assert.equal(ra.originAllowed('http://evil.example', '192.168.1.42:3030'), false);
  assert.equal(ra.originAllowed('https://192.168.1.42:3030', '192.168.1.42:3030'), false);
  assert.equal(ra.originAllowed('http://192.168.1.43:3030', '192.168.1.42:3030'), false);
  assert.equal(ra.originAllowed('http://192.168.1.42:3030', ''), false);
});

// ── Codes and tokens ─────────────────────────────────────────────────────────

test('a pairing code avoids characters people confuse', () => {
  for (let i = 0; i < 200; i++) {
    const c = ra.newCode();
    assert.equal(c.length, ra.CODE_LENGTH);
    assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
    assert.equal(/[01OIL]/.test(c), false, 'ambiguous character in ' + c);
  }
});

test('codes are canonicalised so a typed one still works', () => {
  assert.equal(ra.canonicalCode('abcd-2345'), 'ABCD2345');
  assert.equal(ra.canonicalCode(' ab cd 23 45 '), 'ABCD2345');
  assert.equal(ra.canonicalCode('ABCD2345EXTRA'), 'ABCD2345');
  assert.equal(ra.canonicalCode(null), '');
  assert.equal(ra.formatCode('ABCD2345'), 'ABCD-2345');
  assert.equal(ra.formatCode('short'), 'SHORT');
});

test('tokens are long, url-safe and never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const t = ra.newToken();
    assert.match(t, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(seen.has(t), false);
    seen.add(t);
  }
});

test('safeEqual refuses mismatches without throwing on odd lengths', () => {
  assert.equal(ra.safeEqual('abc', 'abc'), true);
  assert.equal(ra.safeEqual('abc', 'abd'), false);
  assert.equal(ra.safeEqual('abc', 'abcd'), false);
  assert.equal(ra.safeEqual('', ''), true);
  assert.equal(ra.safeEqual(null, undefined), true, 'both coerce to the empty string');
  assert.equal(ra.safeEqual('abc', null), false);
});

// ── Cookie ───────────────────────────────────────────────────────────────────

test('the cookie is HttpOnly + SameSite=Strict and clears with Max-Age=0', () => {
  const set = ra.cookieHeader('tok123');
  assert.match(set, /^xenon_device=tok123;/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Path=\//);
  // Deliberately NOT Secure: T1 is plain HTTP, and a Secure cookie would never
  // be stored — pairing would silently do nothing.
  assert.equal(/Secure/.test(set), false);
  assert.match(ra.cookieHeader(''), /Max-Age=0/);
});

test('the cookie is read out of a crowded header', () => {
  assert.equal(ra.readCookie('a=1; xenon_device=tok; b=2', 'xenon_device'), 'tok');
  assert.equal(ra.readCookie('xenon_device=tok', 'xenon_device'), 'tok');
  assert.equal(ra.readCookie('xenon_device_other=nope', 'xenon_device'), '');
  assert.equal(ra.readCookie('', 'xenon_device'), '');
  assert.equal(ra.readCookie(null, 'xenon_device'), '');
  assert.equal(ra.readCookie('malformed', 'xenon_device'), '');
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('the limiter counts within a window and resets after it', () => {
  const lim = ra.createRateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(lim.take('a', 0), true);
  assert.equal(lim.take('a', 100), true);
  assert.equal(lim.take('a', 200), true);
  assert.equal(lim.take('a', 300), false);
  assert.equal(lim.take('b', 300), true, 'a different key has its own budget');
  assert.equal(lim.take('a', 1300), true, 'the window rolled over');
});

test('the limiter stays bounded under a flood of distinct keys', () => {
  const lim = ra.createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 32 });
  for (let i = 0; i < 5000; i++) lim.take('k' + i, i);
  assert.ok(lim.size() <= 33, 'unbounded map: ' + lim.size());
});

// ── The persisted store ──────────────────────────────────────────────────────

test('the store is rebuilt key-by-key, never spread from disk', () => {
  const out = ra.normalizeDeviceStore({
    version: 99,
    evil: 'passthrough',
    devices: [
      { id: 'a'.repeat(16), tokenHash: 'b'.repeat(64), name: 'Phone', createdAt: 5, lastSeenAt: 6, lastIp: '192.168.1.9', extra: 'x' },
      { id: 'bad', tokenHash: 'b'.repeat(64) },              // id shape
      { id: 'c'.repeat(16), tokenHash: 'short' },            // unusable hash
      { id: 'a'.repeat(16), tokenHash: 'd'.repeat(64) },     // duplicate id
      null, 'nope', 42,
    ],
  });
  assert.equal(out.version, ra.STORE_VERSION);
  assert.equal(out.evil, undefined);
  assert.equal(out.devices.length, 1);
  // The exact record, so a new field is a deliberate decision rather than
  // something that arrived with a spread. `assetKey` is the widget-asset
  // capability (see the section at the end of this file).
  assert.deepEqual(Object.keys(out.devices[0]).sort(),
    ['assetKey', 'createdAt', 'id', 'lastIp', 'lastSeenAt', 'name', 'tokenHash']);
  assert.equal(out.devices[0].extra, undefined);
  assert.deepEqual(ra.normalizeDeviceStore(null), { version: ra.STORE_VERSION, devices: [] });
  assert.deepEqual(ra.normalizeDeviceStore('junk'), { version: ra.STORE_VERSION, devices: [] });
});

test('device names are bounded and control characters cannot hide in them', () => {
  const out = ra.normalizeDeviceStore({
    devices: [{ id: 'a'.repeat(16), tokenHash: 'b'.repeat(64), name: 'Pixel' + String.fromCharCode(10) + '9  Pro' }],
  });
  assert.equal(out.devices[0].name, 'Pixel 9 Pro');
  const long = ra.normalizeDeviceStore({
    devices: [{ id: 'a'.repeat(16), tokenHash: 'b'.repeat(64), name: 'x'.repeat(500) }],
  });
  assert.equal(long.devices[0].name.length, ra.DEVICE_NAME_MAX);
  const empty = ra.normalizeDeviceStore({
    devices: [{ id: 'a'.repeat(16), tokenHash: 'b'.repeat(64), name: '   ' }],
  });
  assert.ok(empty.devices[0].name.length > 0, 'a nameless device still needs a label');
});

test('the device count is capped', () => {
  const devices = [];
  for (let i = 0; i < 100; i++) {
    devices.push({ id: String(i).padStart(16, '0').replace(/[^0-9a-f]/g, '0'), tokenHash: 'b'.repeat(64) });
  }
  assert.ok(ra.normalizeDeviceStore({ devices }).devices.length <= ra.MAX_DEVICES);
});

// ── The pairing lifecycle (against a real temp store) ────────────────────────

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ra-'));
  let clock = 1_000_000;
  const api = ra.createRemoteAccess({ dir, now: () => clock });
  return { dir, api, advance: (ms) => { clock += ms; }, at: () => clock };
}

test('a code redeems exactly once and yields a working token', async () => {
  const { api } = tmpStore();
  await api.load();
  assert.equal(api.authenticate('anything'), null);

  const { code } = api.startPairing();
  const first = await api.redeem(code, { name: 'Pixel', ip: '192.168.1.9' });
  assert.equal(first.ok, true);
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(first.device.name, 'Pixel');
  assert.equal(first.device.tokenHash, undefined, 'the hash must never leave the server');

  const dev = api.authenticate(first.token);
  assert.ok(dev, 'the token must authenticate');
  assert.equal(dev.id, first.device.id);
  assert.equal(api.authenticate(first.token + 'x'), null);
  assert.equal(api.authenticate(''), null);

  const second = await api.redeem(code, { name: 'Attacker' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'no_pairing');
  assert.equal(api.count(), 1);
});

test('the plaintext token is never written to disk', async () => {
  const { api, dir } = tmpStore();
  await api.load();
  const { code } = api.startPairing();
  const r = await api.redeem(code, { name: 'Pixel' });
  const raw = fs.readFileSync(path.join(dir, ra.STORE_FILENAME), 'utf8');
  assert.equal(raw.includes(r.token), false, 'the token itself is on disk');
  assert.equal(raw.includes(ra.hashToken(r.token)), true, 'the hash should be');
});

test('wrong codes burn the invitation instead of being ground down', async () => {
  const { api } = tmpStore();
  await api.load();
  api.startPairing();
  for (let i = 0; i < ra.CODE_MAX_ATTEMPTS - 1; i++) {
    assert.equal((await api.redeem('WRONGWRO', { ip: '1.2.3.' + i })).error, 'bad_code');
  }
  assert.equal((await api.redeem('WRONGWRO', { ip: '1.2.3.9' })).error, 'bad_code');
  // …and the invitation is gone, so even the RIGHT code no longer works.
  assert.equal((await api.redeem('WRONGWRO', { ip: '1.2.3.10' })).error, 'no_pairing');
  assert.equal(api.pairingState(), null);
});

test('a code expires on its own', async () => {
  const { api, advance } = tmpStore();
  await api.load();
  const { code } = api.startPairing();
  assert.ok(api.pairingState());
  advance(ra.CODE_TTL_MS + 1);
  assert.equal(api.pairingState(), null);
  assert.equal((await api.redeem(code, {})).error, 'no_pairing');
});

test('redeem attempts are rate-limited per source address', async () => {
  const { api } = tmpStore();
  await api.load();
  api.startPairing();
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await api.redeem('WRONGWRO', { ip: '10.0.0.5' });
    if (r.error === 'rate_limited') limited++;
  }
  assert.ok(limited > 0, 'a flood from one address must be throttled');
});

test('revoking a device kills its token immediately', async () => {
  const { api } = tmpStore();
  await api.load();
  const a = await api.redeem(api.startPairing().code, { name: 'A' });
  const b = await api.redeem(api.startPairing().code, { name: 'B' });
  assert.equal(api.count(), 2);

  assert.deepEqual(await api.revoke(a.device.id), { ok: true });
  assert.equal(api.authenticate(a.token), null, 'a revoked token must stop working');
  assert.ok(api.authenticate(b.token), 'the other device is untouched');
  assert.equal((await api.revoke(a.device.id)).error, 'not_found');

  const all = await api.revokeAll();
  assert.equal(all.revoked, 1);
  assert.equal(api.authenticate(b.token), null);
  assert.equal(api.count(), 0);
});

test('renaming is bounded and survives a reload from disk', async () => {
  const { api, dir } = tmpStore();
  await api.load();
  const r = await api.redeem(api.startPairing().code, { name: 'A' });
  await api.rename(r.device.id, 'x'.repeat(200));
  assert.equal(api.list()[0].name.length, ra.DEVICE_NAME_MAX);
  assert.equal((await api.rename('nope', 'x')).error, 'not_found');

  const reopened = ra.createRemoteAccess({ dir });
  await reopened.load();
  assert.equal(reopened.count(), 1);
  assert.ok(reopened.authenticate(r.token), 'the token must survive a restart');
  assert.equal(reopened.list()[0].tokenHash, undefined);
});

test('a damaged store starts empty rather than refusing to boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ra-'));
  fs.writeFileSync(path.join(dir, ra.STORE_FILENAME), '{ not json');
  const api = ra.createRemoteAccess({ dir });
  await api.load();
  assert.equal(api.count(), 0);
  const r = await api.redeem(api.startPairing().code, { name: 'A' });
  assert.equal(r.ok, true, 'pairing still works after the reset');
});

test('the device cap is enforced at redeem time, not only on load', async () => {
  const { api } = tmpStore();
  await api.load();
  // A distinct address each time: the per-IP redeem limiter is stricter than
  // the device cap, and this test is about the cap.
  for (let i = 0; i < ra.MAX_DEVICES; i++) {
    assert.equal((await api.redeem(api.startPairing().code, { name: 'd' + i, ip: '10.0.0.' + i })).ok, true);
  }
  const over = await api.redeem(api.startPairing().code, { name: 'one too many', ip: '10.0.1.1' });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'too_many_devices');
});

// ── Address discovery ────────────────────────────────────────────────────────

test('pairing addresses put the home LAN first and APIPA last', () => {
  const ifaces = {
    eth: [
      { address: '169.254.10.1', family: 'IPv4', internal: false },
      { address: '100.90.1.2', family: 'IPv4', internal: false },
      { address: '192.168.1.42', family: 'IPv4', internal: false },
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  };
  assert.deepEqual(ra.pairingAddresses(ifaces), ['192.168.1.42', '100.90.1.2', '169.254.10.1']);
});

test('address discovery drops loopback and link-local, and node 18+ numeric families', () => {
  const ifaces = {
    a: [{ address: '10.0.0.5', family: 4, internal: false },
      { address: 'fe80::abc%eth0', family: 6, internal: false },
      { address: '::1', family: 6, internal: true },
      { address: 'fd00::5', family: 6, internal: false }],
  };
  assert.deepEqual(ra.ownAddresses(ifaces), ['10.0.0.5', 'fd00::5']);
  assert.deepEqual(ra.ownAddresses({}), []);
});

// ── Widget assets: the capability that lives in the path ─────────────────────
//
// An SDK widget's iframe is `sandbox="allow-scripts"` with NO allow-same-origin,
// so its document has an opaque origin and the browser withholds the
// SameSite=Strict pairing cookie from every subresource it asks for — measured
// against an echo server: the iframe document carried the cookie, its
// widget.css and widget.js arrived with none, no Origin, no Referer and
// `Sec-Fetch-Site: cross-site`, while a non-sandboxed control carried all of
// them. Without a second credential the widget's HTML loads and its stylesheet
// and script are refused — a widget drawn as unstyled markup on a white canvas,
// which is what a real tablet showed. These tests pin the shape of the answer
// and, above all, its LIMITS.

const KEY32 = 'a'.repeat(32);
// Written this way so the character survives every tool between here and disk.
const BS = String.fromCharCode(92);

test('the asset path parses only a well-formed key plus a non-empty tail', () => {
  assert.deepEqual(
    ra.parseWidgetAssetPath('/sdk/wk/' + KEY32 + '/keyring/widget.css'),
    { key: KEY32, rest: 'keyring/widget.css' },
  );

  for (const bad of [
    '/sdk/wk/',                                  // nothing at all
    '/sdk/wk/' + KEY32,                          // key with no tail
    '/sdk/wk/' + KEY32 + '/',                    // empty tail
    '/sdk/wk//keyring/widget.css',               // empty key
    '/sdk/wk/' + 'a'.repeat(31) + '/x/y.css',    // key too short
    '/sdk/wk/' + 'a'.repeat(33) + '/x/y.css',    // key too long
    '/sdk/wk/' + 'A'.repeat(32) + '/x/y.css',    // not lowercase hex
    '/sdk/wk/' + 'z'.repeat(32) + '/x/y.css',    // not hex at all
    '/sdk/wk/' + KEY32 + '/../secrets.json',     // traversal
    '/sdk/wk/' + KEY32 + '/x' + BS + 'y.css',    // backslash
    '/sdk/widget/keyring/widget.css',            // the unkeyed spelling
    '/sdk/wkx/' + KEY32 + '/x/y.css',
    '', null, undefined, 42,
  ]) {
    assert.equal(ra.parseWidgetAssetPath(bad), null, JSON.stringify(bad));
  }
});

test('an asset key is minted per device, is not the token, and dies with it', async () => {
  const { api } = tmpStore();
  await api.load();
  const a = await api.redeem(api.startPairing().code, { name: 'tablet', ip: '10.0.0.9' });
  const b = await api.redeem(api.startPairing().code, { name: 'phone', ip: '10.0.0.10' });
  assert.ok(a.ok && b.ok);

  const devA = api.authenticate(a.token);
  const devB = api.authenticate(b.token);
  assert.match(devA.assetKey, /^[a-f0-9]{32}$/);
  assert.notEqual(devA.assetKey, devB.assetKey, 'two devices must not share a capability');

  // A DIFFERENT credential, not a second spelling of the token. Both directions,
  // because the whole safety argument is that this key buys only static files.
  assert.notEqual(devA.assetKey, a.token);
  assert.equal(api.authenticate(devA.assetKey), null, 'an asset key must never authenticate as a device');
  assert.equal(api.authenticateAssetKey(a.token), null, 'a device token is not an asset key');

  assert.equal(api.authenticateAssetKey(devA.assetKey).id, devA.id);
  assert.equal(api.authenticateAssetKey(devB.assetKey).id, devB.id);
  for (const junk of ['', 'x', 'a'.repeat(31), 'a'.repeat(33), 'Z'.repeat(32), null, undefined, 7]) {
    assert.equal(api.authenticateAssetKey(junk), null, JSON.stringify(junk));
  }

  await api.revoke(devA.id);
  assert.equal(api.authenticateAssetKey(devA.assetKey), null, 'revoking a device must revoke its assets');
  assert.equal(api.authenticateAssetKey(devB.assetKey).id, devB.id, 'and must not touch the others');
});

test('a device paired before the capability existed is given one on load', async () => {
  const { dir, api } = tmpStore();
  await api.load();
  const r = await api.redeem(api.startPairing().code, { name: 'old', ip: '10.0.0.1' });
  assert.ok(r.ok);

  // Rewrite the store the way a build without this feature left it.
  const file = path.join(dir, ra.STORE_FILENAME);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.devices[0].assetKey;
  fs.writeFileSync(file, JSON.stringify(raw));

  const reopened = ra.createRemoteAccess({ dir });
  await reopened.load();
  const dev = reopened.authenticate(r.token);
  assert.ok(dev, 'the token must still work');
  assert.match(dev.assetKey, /^[a-f0-9]{32}$/, 'a key is minted rather than left empty');
  assert.equal(reopened.authenticateAssetKey(dev.assetKey).id, dev.id);
});

test('normalizeDeviceStore keeps a valid key and drops a malformed one', () => {
  const base = { id: 'a'.repeat(16), tokenHash: 'b'.repeat(64) };
  const good = 'c'.repeat(32);
  const out = ra.normalizeDeviceStore({
    devices: [
      { ...base, assetKey: good },
      { ...base, id: 'd'.repeat(16), assetKey: 'nope' },
      { ...base, id: 'e'.repeat(16) },
    ],
  });
  assert.equal(out.devices[0].assetKey, good);
  assert.equal(out.devices[1].assetKey, '', 'a malformed key is dropped, never carried');
  assert.equal(out.devices[2].assetKey, '');
});

// The exemption exists because an opaque-origin subresource is stamped
// cross-site even when it is the same origin. It must be exactly that narrow.
test('the cross-site exemption covers the asset path and nothing else', () => {
  const base = {
    enabled: true, host: '192.168.1.5:3030', origin: undefined,
    fetchSite: 'cross-site', fetchMode: 'no-cors', method: 'GET',
    hasDevice: true, addresses: ['192.168.1.5'], port: 3030,
  };
  assert.equal(ra.gateDecision({ ...base, pathname: '/sdk/wk/' + KEY32 + '/keyring/widget.css' }), 'ok');
  // The same request in the unkeyed spelling → the ordinary rule applies again.
  assert.equal(ra.gateDecision({ ...base, pathname: '/sdk/widget/keyring/widget.css' }), 'bad_fetch_site');
  for (const p of ['/settings', '/deck-config', '/actions/run', '/', '/sdk/install', '/sdk/fetch']) {
    assert.equal(ra.gateDecision({ ...base, pathname: p }), 'bad_fetch_site', p);
  }
  // A malformed key gets no exemption — parse first, then decide.
  assert.equal(ra.gateDecision({ ...base, pathname: '/sdk/wk/short/keyring/widget.css' }), 'bad_fetch_site');
});

// A bearer credential in a URL: what it does NOT unlock is the safety argument.
test('the asset path is still subject to every other layer of the gate', () => {
  const p = '/sdk/wk/' + KEY32 + '/keyring/widget.css';
  const base = {
    enabled: true, host: '192.168.1.5:3030', method: 'GET', pathname: p,
    hasDevice: true, addresses: ['192.168.1.5'], port: 3030,
  };
  assert.equal(ra.gateDecision(base), 'ok');
  assert.equal(ra.gateDecision({ ...base, enabled: false }), 'forbidden');
  assert.equal(ra.gateDecision({ ...base, host: 'xenon.local:3030' }), 'forbidden');
  assert.equal(ra.gateDecision({ ...base, host: '10.9.9.9:3030' }), 'forbidden');
  assert.equal(ra.gateDecision({ ...base, origin: 'http://evil.example' }), 'bad_origin');
  // `null` is the ONE layer this path does not answer to, and this line used to
  // assert the opposite — which is how the bug shipped. A sandboxed document has
  // an opaque origin, so `Origin: null` is the only thing its subresources can
  // ever send; refusing it here refused every widget's own stylesheet. See the
  // dedicated test at the end of this file for the evidence.
  assert.equal(ra.gateDecision({ ...base, origin: 'null' }), 'ok');
  assert.equal(ra.gateDecision({ ...base, hasDevice: false }), 'unpaired');
});

test('the asset capability buys reads and nothing else', () => {
  const p = '/sdk/wk/' + KEY32 + '/keyring/widget.css';
  for (const m of ['GET', 'HEAD']) assert.equal(ra.remotePathAllowed(p, m), true, m);
  for (const m of ['POST', 'PATCH', 'DELETE']) assert.equal(ra.remotePathAllowed(p, m), false, m);
  // OPTIONS is the CORS preflight and answers before any path rule; assert the
  // decision that matters instead — a write never reaches the route.
  assert.equal(ra.gateDecision({
    enabled: true, host: '192.168.1.5:3030', method: 'DELETE', pathname: p,
    hasDevice: true, addresses: ['192.168.1.5'], port: 3030,
  }), 'remote_denied');
});

// The two spellings must resolve to the SAME asset, or a widget would behave
// differently depending on which screen it is on. The route regex below is
// asserted to be present VERBATIM in server.js and applied to `assetPath`, so
// this cannot pass while the route means something else. It is a contract test
// on the shapes: the running route is not exercised (server.js is not
// requireable, and a second live instance would share the user DATA_DIR).
test('the keyed and unkeyed asset paths resolve to the same package and file', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');

  assert.ok(src.includes("reqPath.startsWith('/sdk/widget/') || reqPath.startsWith(remoteAccessLib.WIDGET_ASSET_PREFIX)"),
    'the asset route must serve both spellings from one branch');
  assert.ok(src.includes("const assetPath = keyed ? '/sdk/widget/' + keyed.rest : reqPath;"),
    'the keyed path must be rewritten onto the unkeyed one before matching');
  assert.ok(src.includes("const m = /^\\/sdk\\/widget\\/([^/]+)\\/(.+)$/.exec(assetPath);"),
    'the route regex changed — update this test with it, deliberately');
  const routeRe = /^\/sdk\/widget\/([^/]+)\/(.+)$/;

  const key = 'b'.repeat(32);
  for (const [pkg, file] of [['keyring', 'widget.css'], ['codex-vivaio', 'assets/leaf.png'], ['x', '__xenon-perf.js']]) {
    const plain = '/sdk/widget/' + pkg + '/' + file;
    const keyed = '/sdk/wk/' + key + '/' + pkg + '/' + file;

    const parsed = ra.parseWidgetAssetPath(keyed);
    assert.ok(parsed, keyed);
    // The rewrite server.js performs before matching, asserted above.
    const rewritten = '/sdk/widget/' + parsed.rest;

    const a = routeRe.exec(plain);
    const b = routeRe.exec(rewritten);
    assert.ok(a && b, plain);
    assert.equal(b[1], a[1], 'same package id');
    assert.equal(b[2], a[2], 'same file');
    assert.equal(a[1], pkg);
    assert.equal(a[2], file);
  }

  // And the unkeyed path is left exactly alone.
  assert.equal(ra.parseWidgetAssetPath('/sdk/widget/keyring/widget.css'), null);
});

// The marker is how the client learns its capability, and it is read at mount
// time — nothing arriving later can substitute for it.
test('the served document carries the asset key, and one helper uses it', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('window.__xenonRemote = { device: '), 'the remote marker must still be injected');
  assert.ok(src.includes(", assetKey: '") || src.includes("+ ', assetKey: '"), 'and it must carry assetKey');

  const client = fs.readFileSync(path.join(HERE, '..', 'js', 'custom-widget.js'), 'utf8');
  assert.ok(client.includes('function sdkAssetBase('), 'one helper decides the asset base');
  // Every SDK frame must go through it. A second hand-built literal would be a
  // widget that loads unstyled on a phone and correctly everywhere else.
  for (const f of ['custom-widget.js', 'ambient-mode.js', 'ambient-canvas.js']) {
    const s = fs.readFileSync(path.join(HERE, '..', 'js', f), 'utf8');
    assert.ok(!s.includes("frame.src = '/sdk/widget/'"), f + ' must not build the asset base by hand');
  }
});

// The check that took four rounds to find, because it is invisible to every
// test that does not use a real browser. A sandboxed widget document has an
// OPAQUE origin, so its subresource requests carry `Origin: null` — the parent
// page fetching the identical URL sends no Origin at all and got 200, which is
// why hand-made probes all passed while the widget stayed unstyled. Chromium
// named it in the end: the stylesheet request came back as our JSON refusal and
// DevTools reported "Response was blocked by CORB (Cross-Origin Read Blocking)"
// next to "failed to load a stylesheet", with the network row showing 403 on a
// correctly keyed /sdk/wk/<key>/codex-vivaio/widget.css.
test('a sandboxed widget subresource may present Origin: null — and only there', () => {
  const asset = "/sdk/wk/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/codex-vivaio/widget.css";
  const base = {
    enabled: true, host: '192.168.1.5:3030', method: 'GET',
    hasDevice: true, addresses: ['192.168.1.5'], port: 3030,
  };

  // The real shape: opaque origin => Origin: null AND Sec-Fetch-Site: cross-site.
  assert.equal(ra.gateDecision({
    ...base, pathname: asset, origin: 'null', fetchSite: 'cross-site', fetchMode: 'no-cors',
  }), 'ok', 'a widget must be able to load its own stylesheet');

  // Whitespace and case are the browser’s, not ours.
  for (const spelling of ['null', 'NULL', ' null ']) {
    assert.equal(ra.gateDecision({ ...base, pathname: asset, origin: spelling }), 'ok', spelling);
  }

  // Everywhere else `null` stays refused. This is the rule the exemption must
  // not erode: a sandboxed iframe on ANY site inherits a null origin, and the
  // cookie-authenticated surface would hand it the dashboard.
  for (const p of ['/', '/settings', '/deck-config', '/actions/run', '/sdk/widget/codex-vivaio/widget.css', '/sdk/fetch']) {
    assert.equal(ra.gateDecision({ ...base, pathname: p, origin: 'null' }), 'bad_origin', p);
  }

  // And the exemption is for `null` only — a real foreign origin is still a
  // foreign origin, on the asset path like everywhere else.
  for (const bad of ['http://evil.example', 'http://192.168.1.9:3030', 'https://192.168.1.5:3030']) {
    assert.equal(ra.gateDecision({ ...base, pathname: asset, origin: bad }), 'bad_origin', bad);
  }

  // A malformed key gets no exemption at all: parse first, then decide.
  assert.equal(ra.gateDecision({
    ...base, pathname: '/sdk/wk/short/codex-vivaio/widget.css', origin: 'null',
  }), 'bad_origin');
});

// The refusal a widget receives is INVISIBLE to it: the browser blocks the body
// (CORB) and the widget renders unstyled with nothing in its own console. So the
// asset path must never be able to fail for a reason that is merely procedural.
test('nothing but a missing capability can refuse a widget asset', () => {
  const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const p = '/sdk/wk/' + key + '/codex-vivaio/widget.css';
  const real = {
    enabled: true, host: '192.168.1.5:3030', origin: 'null',
    fetchSite: 'cross-site', fetchMode: 'no-cors', method: 'GET',
    pathname: p, hasDevice: true, addresses: ['192.168.1.5'], port: 3030,
  };
  assert.equal(ra.gateDecision(real), 'ok');
  // Only the token/capability may turn it down; everything else about the
  // request is fixed by the sandbox and cannot be corrected by the widget.
  assert.equal(ra.gateDecision({ ...real, hasDevice: false }), 'unpaired');
});

// ── T2: the HTTPS door ───────────────────────────────────────────────────────
// The LAN door refuses every Host that is not an IP literal, because a NAME can
// be pointed at us by someone else's DNS while the browser keeps treating the
// page as theirs. On the TLS listener that attack cannot begin — the handshake
// only completes for the name on the certificate, and the only certificate we
// hold is the one tailscaled issues for THIS machine. So exactly one name is
// accepted, and only there.

const FQDN = 'mypc.tail1234.ts.net';

test('isTlsNameHost accepts one exact name and nothing that merely resembles it', () => {
  assert.equal(ra.isTlsNameHost(FQDN + ':3443', FQDN, 3443), true);
  assert.equal(ra.isTlsNameHost(FQDN.toUpperCase() + ':3443', FQDN, 3443), true, 'Host is case-insensitive');

  // The whole family a suffix/prefix match would let through.
  for (const bad of [
    'evil-mypc.tail1234.ts.net:3443',      // prefix
    'mypc.tail1234.ts.net.evil.com:3443',  // our name as a LABEL of theirs
    'sub.mypc.tail1234.ts.net:3443',       // subdomain
    'mypc.tail9999.ts.net:3443',           // another tailnet
    'other.tail1234.ts.net:3443',          // another machine in OUR tailnet
    'tail1234.ts.net:3443',                // the suffix alone
  ]) {
    assert.equal(ra.isTlsNameHost(bad, FQDN, 3443), false, bad);
  }

  // The port is part of the check, exactly as it is for an IP host.
  assert.equal(ra.isTlsNameHost(FQDN + ':3030', FQDN, 3443), false, 'wrong port');
  assert.equal(ra.isTlsNameHost(FQDN, FQDN, 3443), false, 'a non-default port must be present');
  assert.equal(ra.isTlsNameHost(FQDN, FQDN, 443), true, 'omitted only when it IS the default');

  // Nothing to compare against is not a pass.
  assert.equal(ra.isTlsNameHost(FQDN + ':3443', '', 3443), false);
  assert.equal(ra.isTlsNameHost('', FQDN, 3443), false);
  // An IP belongs to the other rule; this one must not answer for it.
  assert.equal(ra.isTlsNameHost('192.168.1.5:3443', '192.168.1.5', 3443), false);
  assert.equal(ra.isTlsNameHost('[fd7a::1]:3443', FQDN, 3443), false);
});

test('the certificate name opens the HTTPS door and ONLY the HTTPS door', () => {
  const base = {
    enabled: true, method: 'GET', pathname: '/', hasDevice: true,
    addresses: ['192.168.1.5'], tlsHost: FQDN,
  };
  // On the TLS listener: accepted.
  assert.equal(ra.gateDecision({ ...base, secure: true, port: 3443, host: FQDN + ':3443' }), 'ok');
  // On the cleartext listener the very same Host is a NAME again, and names are
  // refused there. This is the regression that would quietly undo T1's DNS
  // rebinding defence, so it is asserted rather than assumed.
  assert.equal(ra.gateDecision({ ...base, secure: false, port: 3030, host: FQDN + ':3030' }), 'forbidden');
  assert.equal(ra.gateDecision({ ...base, port: 3030, host: FQDN + ':3030' }), 'forbidden', 'absent secure = not secure');
  // And a machine that has no certificate name yet gets no name-based door.
  assert.equal(ra.gateDecision({ ...base, secure: true, port: 3443, host: FQDN + ':3443', tlsHost: '' }), 'forbidden');
  // The IP path is untouched by any of this, on either listener.
  assert.equal(ra.gateDecision({ ...base, secure: true, port: 3443, host: '192.168.1.5:3443' }), 'ok');
  assert.equal(ra.gateDecision({ ...base, secure: false, port: 3030, host: '192.168.1.5:3030' }), 'ok');
});

test('the Origin must carry the listener\'s own scheme, not the other one', () => {
  assert.equal(ra.originAllowed('https://' + FQDN + ':3443', FQDN + ':3443', true), true);
  assert.equal(ra.originAllowed('http://' + FQDN + ':3443', FQDN + ':3443', true), false, 'cleartext origin on the TLS door');
  assert.equal(ra.originAllowed('https://192.168.1.5:3030', '192.168.1.5:3030', false), false, 'https origin on the cleartext door');
  assert.equal(ra.originAllowed('http://192.168.1.5:3030', '192.168.1.5:3030', false), true);
  // Absent stays absent (not a browser fetch) and null stays refused, on both.
  for (const secure of [true, false]) {
    assert.equal(ra.originAllowed(undefined, FQDN + ':3443', secure), true);
    assert.equal(ra.originAllowed('null', FQDN + ':3443', secure), false);
  }
});

test('a whole cross-origin page cannot reach the HTTPS door either', () => {
  const base = {
    enabled: true, method: 'GET', pathname: '/settings', hasDevice: true,
    addresses: ['192.168.1.5'], tlsHost: FQDN, secure: true, port: 3443, host: FQDN + ':3443',
  };
  assert.equal(ra.gateDecision({ ...base, origin: 'https://' + FQDN + ':3443' }), 'ok');
  assert.equal(ra.gateDecision({ ...base, origin: 'https://evil.example' }), 'bad_origin');
  assert.equal(ra.gateDecision({ ...base, origin: 'null' }), 'bad_origin');
  // On HTTPS the fetch-metadata headers come back, and there they DO fire.
  assert.equal(ra.gateDecision({ ...base, fetchSite: 'cross-site' }), 'bad_fetch_site');
  assert.equal(ra.gateDecision({ ...base, fetchSite: 'same-origin' }), 'ok');
  assert.equal(ra.gateDecision({ ...base, fetchSite: 'none', fetchMode: 'navigate' }), 'ok');
});

test('the pairing cookie takes Secure from the door it was issued on', () => {
  const lan = ra.cookieHeader('t');
  assert.ok(!/;\s*Secure/i.test(lan), 'a Secure cookie on plain HTTP is never stored — pairing would silently do nothing');
  assert.ok(/HttpOnly/.test(lan) && /SameSite=Strict/.test(lan));
  const tls = ra.cookieHeader('t', { secure: true });
  assert.ok(/;\s*Secure/i.test(tls));
  assert.ok(/HttpOnly/.test(tls) && /SameSite=Strict/.test(tls));
  // Clearing must keep the same attributes or the browser keeps the old cookie.
  assert.ok(/Max-Age=0/.test(ra.cookieHeader('', { secure: true })));
  assert.ok(/;\s*Secure/i.test(ra.cookieHeader('', { secure: true })));
});

test('a paired device gets a budget several dashboard loads wide', async () => {
  // The regression this pins: the budget used to be 900/min against a shell
  // that costs 250 requests to load, so the fourth reload inside a minute got
  // 429s — and what a load asks for LAST is the SDK widget stylesheets, so the
  // dashboard came up looking fine with white, unstyled widgets in it. Anything
  // under ~10 loads is back in the range a person reaches by hand.
  assert.ok(ra.DEVICE_RATE_LIMIT >= ra.DASHBOARD_LOAD_REQUESTS * 10,
    'the per-device budget must be many dashboard loads wide, not three');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-rate-'));
  try {
    const store = ra.createRemoteAccess({ dir });
    store.startPairing();
    const code = store.pairingState().code;
    const r = await store.redeem(code, { name: 'phone', ip: '192.168.1.9' });
    assert.ok(r.ok);
    const id = r.device.id;
    const t = 1_700_000_000_000;
    // A burst the size of one load must not even approach the ceiling.
    for (let i = 0; i < ra.DASHBOARD_LOAD_REQUESTS; i++) {
      assert.ok(store.withinRate(id, t), 'a single load must never be throttled');
    }
    // The ceiling still exists: it is a runaway-client cap, not an absence.
    for (let i = ra.DASHBOARD_LOAD_REQUESTS; i < ra.DEVICE_RATE_LIMIT; i++) store.withinRate(id, t);
    assert.equal(store.withinRate(id, t), false, 'the budget must still end somewhere');
    // And it is a window, so the next minute starts clean.
    assert.equal(store.withinRate(id, t + 60_001), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a phone may subscribe to notifications, but only by POST', () => {
  // The phone IS the thing that subscribes, so these have to be reachable —
  // which makes them the first paths on this door that are both remote-allowed
  // and state-changing. The protection is the method: a top-level navigation is
  // always a GET, and it is the one request shape carrying neither an Origin
  // nor a cross-site marker.
  for (const p of ['/api/push/key', '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test']) {
    assert.equal(ra.remotePathAllowed(p, 'POST'), true, 'POST ' + p + ' must reach a paired device');
    assert.equal(ra.remotePathAllowed(p, 'GET'), false, 'GET ' + p + ' must not');
    assert.equal(ra.remotePathAllowed(p, 'HEAD'), false, 'HEAD ' + p + ' must not');
  }
  // The read is a read: it answers with counts and hosts, never an endpoint.
  assert.equal(ra.remotePathAllowed('/api/push/status', 'GET'), true);
});
