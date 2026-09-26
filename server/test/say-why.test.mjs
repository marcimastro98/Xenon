// Two places where Xenon knew the reason and did not say it.
//
// 1. The Media tile's wave needs Xenon Helper to measure the sound. Without it
//    the strip simply stayed empty. Asked on Discord: "how do I install xenon
//    helper for media visualization?" /audio/levels/status already knew why
//    and nothing on screen asked it; Settings now does, next to the switch.
//
// 2. A streaming login that failed without a reason of its own showed the bare
//    "Could not start login. Try again." Reported on Discord for Discord, with
//    nothing else to go on. A server error page, a dropped connection and an
//    unexpected exception all ended there; each now carries what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const T = (k, fb) => fb || k;

function cut(src, start, endMarker = '\n  }\n') {
  const at = src.indexOf(start);
  assert.ok(at >= 0, start);
  return src.slice(at, src.indexOf(endMarker, at) + endMarker.length);
}

// ── streaming logins ──────────────────────────────────────────────────────

function loginHelpers(fetchImpl) {
  const src = read('../js/streaming-page.js');
  const code = cut(src, '  async function postLogin(') + cut(src, '  function genericLoginError(') + cut(src, '  function rpcLoginError(');
  return new Function('fetch', 't', code + '\nreturn { postLogin, genericLoginError, rpcLoginError };')(fetchImpl, T);
}

test('a server error page arrives as its status and its words, not as nothing', async () => {
  const h = loginHelpers(async () => ({ status: 500, text: async () => 'Cannot read properties of undefined (reading "id")' }));
  const r = await h.postLogin('/stream/discord/login');
  assert.deepEqual(r, { ok: false, error: 'http_500', detail: 'Cannot read properties of undefined (reading "id")' });
  assert.match(h.rpcLoginError(r), /Could not start login\. Try again\. \(http_500\) — “Cannot read properties/);
});

test('a server that does not answer says so', async () => {
  const h = loginHelpers(async () => { throw new TypeError('Failed to fetch'); });
  const r = await h.postLogin('/stream/discord/login');
  assert.deepEqual(r, { ok: false, error: 'no_server' });
  assert.match(h.rpcLoginError(r), /Xenon did not answer/);
});

test('a JSON answer is read as it is, and every code has words', async () => {
  const h = loginHelpers(async () => ({ status: 200, text: async () => '{"ok":false,"error":"authorize_denied"}' }));
  const r = await h.postLogin('/stream/discord/login');
  assert.equal(r.error, 'authorize_denied');
  assert.match(h.rpcLoginError(r), /Authorization was denied/);
  assert.match(h.rpcLoginError({ ok: false, error: 'no_client' }), /no Discord Client ID and Client Secret yet/);
  assert.match(h.rpcLoginError({ ok: false, error: 'login_failed', detail: 'EPERM: rename' }), /failed inside Xenon.*— “EPERM: rename”/);
  // An unknown code is still shown rather than swallowed.
  assert.match(h.rpcLoginError({ ok: false, error: 'something_new' }), /\(something_new\)/);
});

test('Twitch and YouTube get the same reason, and so does Spotify', () => {
  const src = read('../js/streaming-page.js');
  assert.match(src, /const r = await postLogin\(cfg\.base \+ '\/login'\);\n    if \(!r \|\| !r\.ok\) \{ btn\.disabled = false; setNote\(card, genericLoginError\(r\)\); return; \}/);
  assert.doesNotMatch(src, /setNote\(card, t\('streaming_error', 'Could not start login\. Try again\.'\)\)/, 'no bare generic note left');
  const sp = read('../js/spotify-settings.js');
  assert.match(sp, /\(code \? ' \(' \+ code \+ '\)' : ''\)/);
});

test('the server answers a failed Discord login in JSON, with the reason', () => {
  const S = read('../server.js');
  const route = cut(S, "  } else if (reqPath === '/stream/discord/login' && req.method === 'POST') {", "\n  } else if (");
  assert.doesNotMatch(route, /err500/);
  assert.match(route, /json\(\{ ok: false, error: 'login_failed', detail: /);
  const rpc = read('../discord-rpc.js');
  const fn = cut(rpc, '  function loginFail(error, detail) {');
  assert.match(fn, /if \(!\/\^\[a-z\]\[a-z0-9_\]\{0,40\}\$\/\.test\(String\(error \|\| ''\)\)\) \{\n\s+detail = detail \|\| error;\n\s+error = 'login_failed';/);
  // The rule itself: codes pass, sentences do not.
  const isCode = (e) => /^[a-z][a-z0-9_]{0,40}$/.test(String(e || ''));
  assert.equal(isCode('authorize_timeout'), true);
  assert.equal(isCode("Cannot read properties of undefined (reading 'id')"), false);
  assert.equal(isCode('EPERM: operation not permitted'), false);
});

// ── the Media tile wave ───────────────────────────────────────────────────

async function vizStatus(status, mode = 'wave') {
  const src = read('../js/settings.js');
  const code = 'let _mediaVizStatusSeq = 0;\n' + cut(src, 'async function refreshMediaVizStatus(recheck) {', '\n}\n');
  const el = { textContent: '', dataset: {}, hidden: true };
  const fn = new Function('fetch', 't', '$', 'mediaVisualizerMode', 'setTimeout', code + '\nreturn refreshMediaVizStatus;')(
    async () => ({ ok: !!status, json: async () => status }),
    (k) => k + (k === 'settings_media_viz_st_old' ? ':{version}' : ''),
    () => el,
    () => mode,
    () => {},
  );
  await fn(true);
  return el;
}

test('Settings says whether the wave can be drawn, and what to do when it cannot', async () => {
  let el = await vizStatus({ ok: true, platform: 'win32', available: false, failure: 'no-helper' });
  assert.equal(el.textContent, 'settings_media_viz_st_missing');
  assert.equal(el.dataset.state, 'bad');
  assert.equal(el.hidden, false);
  el = await vizStatus({ ok: true, platform: 'win32', available: true, failure: 'helper-too-old', minVersion: '0.7.0' });
  assert.equal(el.textContent, 'settings_media_viz_st_old:0.7.0');
  el = await vizStatus({ ok: true, platform: 'win32', available: true, failure: 'helper-failed' });
  assert.equal(el.textContent, 'settings_media_viz_st_failed');
  el = await vizStatus({ ok: true, platform: 'darwin', available: false, failure: 'no-helper' });
  assert.equal(el.textContent, 'settings_media_viz_st_platform', 'a Mac is told it is Windows-only, not to install anything');
  el = await vizStatus({ ok: true, platform: 'win32', available: true, failure: '' });
  assert.equal(el.textContent, 'settings_media_viz_st_ok');
  assert.equal(el.dataset.state, 'ok');
  el = await vizStatus({ ok: true, platform: 'win32', available: true, failure: '' }, 'off');
  assert.equal(el.hidden, true, 'nothing to say while it is off and would work');
  el = await vizStatus({ ok: true, platform: 'win32', available: false, failure: 'no-helper' }, 'off');
  assert.equal(el.hidden, false, 'a missing helper is said before the wave is even switched on');
});

test('the status route says which platform it runs on', () => {
  const S = read('../server.js');
  assert.match(cut(S, "reqPath === '/audio/levels/status'", '\n  } else if ('), /platform: process\.platform,/);
  assert.match(read('../index.html'), /id="settings-media-viz-status" role="status"/);
});

test('every language has the new sentences, translated', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const keys = ['settings_media_viz_st_platform', 'settings_media_viz_st_missing', 'settings_media_viz_st_old', 'settings_media_viz_st_failed', 'settings_media_viz_st_ok', 'streaming_no_server', 'streaming_discord_noclient', 'streaming_login_failed'];
  for (const [l, d] of Object.entries(ctx.__i18n)) {
    for (const k of keys) {
      assert.ok(d[k], `${l}.${k}`);
      if (l !== 'en') assert.notEqual(d[k], ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
    assert.match(d.settings_media_viz_st_old, /\{version\}/, l);
    // The button names in the sentences are the buttons on screen.
    assert.ok(d.streaming_discord_noclient.includes(d.streaming_connect), `${l}: names the Connect button as it is labelled`);
    assert.ok(d.streaming_discord_noclient.includes(d.streaming_edit_creds), `${l}: names Edit credentials as it is labelled`);
  }
});
