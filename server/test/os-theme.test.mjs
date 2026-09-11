// Why the dashboard woke up white.
//
// "Auto" follows the OS colour scheme, and the obvious way to read that — the
// WebView's own `prefers-color-scheme` — is wrong in exactly the moment that
// matters. On macOS it reports LIGHT for a moment after the display wakes. The
// media-query listener fired, the whole dashboard repainted white, and nothing
// afterwards disagreed: /system/theme only knew how to read the Windows
// registry, so on a Mac there was no second opinion to correct it with.
//
// Reported on Discord from a Mac mini (Sep 2026): dark before the screen slept,
// white after it woke, every single time.
//
// The reading is a TRI-STATE, and the third value is the whole fix: `null` means
// "this platform cannot say", and only then does the media query decide.
// Answering an unknown with `false` would be the same bug in a new place — a
// dashboard painted light because nobody could say otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const osTheme = require('../os-theme.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** execFile, replaced by what the platform's tool would have printed. */
const fake = (err, stdout) => (cmd, args, opts, cb) => cb(err, stdout, '');
const exits = (code) => Object.assign(new Error('exit'), { code });

test('macOS: "Dark" is dark, and a missing key is light, not unknown', async () => {
  // `defaults read -g AppleInterfaceStyle` prints Dark while dark; in light mode
  // the key does not exist, so it exits non-zero with nothing to say. That
  // silence is the answer, not a failure.
  assert.deepEqual(await osTheme.read('darwin', fake(null, 'Dark\n')), { osDark: true });
  assert.deepEqual(await osTheme.read('darwin', fake(exits(1), '')), { osDark: false });
});

test('macOS: a tool that could not be RUN is unknown, not light', async () => {
  // This is the distinction the whole fix rests on. Read it as light and the
  // dashboard goes white on any Mac where `defaults` is missing or wedged —
  // which is the bug, moved rather than fixed.
  assert.deepEqual(await osTheme.read('darwin', fake(exits('ENOENT'), '')), { osDark: null });
  assert.deepEqual(
    await osTheme.read('darwin', fake(Object.assign(new Error('t'), { killed: true }), '')),
    { osDark: null },
  );
});

test('Windows keeps reading the registry exactly as it did', async () => {
  const row = (hex) => `\r\nHKEY_CURRENT_USER\\...\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    ${hex}\r\n`;
  assert.deepEqual(await osTheme.read('win32', fake(null, row('0x0'))), { osDark: true });
  assert.deepEqual(await osTheme.read('win32', fake(null, row('0x1'))), { osDark: false });
  assert.deepEqual(await osTheme.read('win32', fake(exits(1), '')), { osDark: null });
  // A value that is there but unreadable is an unknown, never a colour.
  assert.deepEqual(await osTheme.read('win32', fake(null, 'ERROR: The system was unable to find')), { osDark: null });
});

test('GNOME: only an explicit preference counts', async () => {
  assert.deepEqual(await osTheme.read('linux', fake(null, "'prefer-dark'\n")), { osDark: true });
  assert.deepEqual(await osTheme.read('linux', fake(null, "'prefer-light'\n")), { osDark: false });
  // 'default' is the desktop stating no preference, which is not light.
  assert.deepEqual(await osTheme.read('linux', fake(null, "'default'\n")), { osDark: null });
  assert.deepEqual(await osTheme.read('linux', fake(exits(1), '')), { osDark: null });
});

test('a platform with no probe answers without spawning anything', async () => {
  let spawned = 0;
  const count = (...a) => { spawned++; a[3](null, ''); };
  assert.deepEqual(await osTheme.read('freebsd', count), { osDark: null });
  assert.equal(spawned, 0, 'a doomed process every 30 s is not a reading');
});

test('nothing the probe does can make the read hang or throw', async () => {
  const boom = () => { throw new Error('spawn exploded'); };
  assert.deepEqual(await osTheme.read('darwin', boom), { osDark: null });
  // A callback that fires twice must not settle twice.
  const twice = (cmd, args, opts, cb) => { cb(null, 'Dark'); cb(exits(1), ''); };
  assert.deepEqual(await osTheme.read('darwin', twice), { osDark: true });
});

test('every probe reads, and can only read, the colour scheme', () => {
  for (const [platform, probe] of Object.entries(osTheme.PROBES)) {
    assert.equal(typeof probe.cmd, 'string');
    assert.ok(Array.isArray(probe.args), `${platform} has no argument list`);
    assert.equal(typeof probe.decode, 'function');
    // No shell, and nothing interpolated: the args are a frozen literal list, so
    // this endpoint can never become a way to run something.
    assert.ok(probe.args.every((a) => typeof a === 'string'));
  }
  assert.deepEqual(Object.keys(osTheme.PROBES).sort(), ['darwin', 'linux', 'win32']);
});

test('the route hands the question to the module, on every platform', () => {
  const src = read('../server.js');
  assert.match(src, /const osTheme = require\('\.\/os-theme'\);/);
  assert.match(src, /reqPath === '\/system\/theme'[\s\S]{0,1400}?json\(await osTheme\.read\(\)\);/);
  // The old route was Windows-only and spawned reg.exe on every platform.
  assert.ok(!/execFile\('reg', \['query', 'HKCU/.test(src), 'the registry read is no longer inline');
});

test('the WebView only decides where nothing else can', () => {
  const src = read('../js/settings.js');
  // resolveAppearance prefers the server reading and falls back to the query.
  assert.match(src, /if \(typeof _osPrefersDark === 'boolean'\) return _osPrefersDark \? 'dark' : 'light';/);
  // A media-query flip asks the OS again instead of repainting on the WebView's
  // word — that repaint is what turned the dashboard white after a wake.
  const mq = src.slice(src.indexOf("matchMedia('(prefers-color-scheme: dark)').addEventListener"));
  const handler = mq.slice(0, mq.indexOf('\n  } catch {}'));
  assert.match(handler, /refreshOsTheme\(\);/);
  assert.match(handler, /if \(typeof _osPrefersDark !== 'boolean'\) applyHubSettings\(\);/);
  // And a wake re-reads at once rather than waiting out the 30 s poll.
  assert.match(src, /visibilitychange', \(\) => \{ if \(!document\.hidden\) refreshOsTheme\(\); \}\);/);
});
