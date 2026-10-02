// "Install Xenon Helper", under the Media tile wave switch in Settings.
//
// Asked on Discord: the wave never appeared, the status line said to run
// INSTALL.bat again, and on the setup .exe that file sits in a folder nobody is
// shown. The boot heal only ever replaces a helper that is already there, so a
// helper that never arrived stayed missing. Settings now installs it, through
// the same signed, fail-closed download (helper-update.test.mjs covers that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);

function cut(src, start, endMarker) {
  const at = src.indexOf(start);
  assert.ok(at >= 0, start);
  return src.slice(at, src.indexOf(endMarker, at) + endMarker.length);
}

test('the route installs through helper-update, POST only, and restarts the wave', () => {
  const S = read('../server.js');
  const route = cut(S, "reqPath === '/audio/levels/install-helper' && req.method === 'POST'", '\n  } else if (');
  assert.match(route, /createHelperUpdate\(\{ helperExe: HELPER_EXE, appVersion: APP_VERSION \}\)\.install\(\)/);
  assert.match(route, /process\.platform !== 'win32'/);
  assert.match(route, /audioLevels\.reset\(\);\n\s+refreshAudioLevelsWatch\(\);/);
  assert.match(route, /if \(!_helperInstall\)/, 'a second tap waits on the first download');
  assert.doesNotMatch(S, /reqPath === '\/audio\/levels\/install-helper' && req\.method === 'GET'/);
});

test('a paired device cannot install it', () => {
  const RA = read('../remote-access.js');
  const deny = cut(RA, 'const REMOTE_DENY = new Set([', ']);');
  assert.match(deny, /'\/audio\/levels\/install-helper',/);
});

test('audio-levels forgets a helper that gave up', () => {
  const al = require('../audio-levels.js');
  assert.equal(typeof al.reset, 'function');
  const src = read('../audio-levels.js');
  const fn = cut(src, 'function reset() {', '\n}\n');
  assert.match(fn, /_disabled = false;/);
  assert.match(fn, /_lastFailure = '';/);
});

async function runInstall(answer) {
  const src = read('../js/settings.js');
  const code = cut(src, 'async function installXenonHelper() {', '\n}\n');
  const el = { textContent: '', dataset: {}, hidden: true };
  const btn = { hidden: false, disabled: false, textContent: '' };
  let refreshed = 0;
  const fn = new Function('fetch', 't', '$', 'refreshMediaVizStatus', code + '\nreturn installXenonHelper;')(
    async (url, opts) => {
      assert.equal(url, '/audio/levels/install-helper');
      assert.equal(opts.method, 'POST');
      if (answer === 'throw') throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => answer };
    },
    (k) => k,
    (id) => (id === 'settings-media-viz-install' ? btn : el),
    async () => { refreshed++; },
  );
  await fn();
  return { el, btn, refreshed };
}

test('after an install the status is read again, and a wave that is off still hears it worked', async () => {
  const r = await runInstall({ ok: true, status: 'installed' });
  assert.equal(r.refreshed, 1);
  assert.equal(r.el.textContent, 'settings_media_viz_st_installed');
  assert.equal(r.el.dataset.state, 'ok');
  assert.equal(r.btn.disabled, false);
});

test('a failed install says which kind of failure, with its code', async () => {
  let r = await runInstall({ ok: false, status: 'not-ready' });
  assert.equal(r.el.textContent, 'settings_media_viz_install_offline (not-ready)');
  r = await runInstall({ ok: false, status: 'mismatch' });
  assert.equal(r.el.textContent, 'settings_media_viz_install_unverified (mismatch)');
  r = await runInstall({ ok: false, status: 'signature-invalid' });
  assert.equal(r.el.textContent, 'settings_media_viz_install_unverified (signature-invalid)');
  r = await runInstall({ ok: false, status: 'error' });
  assert.equal(r.el.textContent, 'settings_media_viz_install_failed (error)');
  r = await runInstall('throw');
  assert.equal(r.el.textContent, 'settings_media_viz_install_failed (no_server)');
  assert.equal(r.el.dataset.state, 'bad');
  assert.equal(r.btn.hidden, false, 'the button stays, to try again');
  assert.equal(r.btn.disabled, false);
});

test('the button is in Settings, under the status line', () => {
  const H = read('../index.html');
  assert.match(H, /id="settings-media-viz-status"[^\n]*\n\s*<button class="settings-btn settings-media-viz-install" id="settings-media-viz-install" type="button" onclick="installXenonHelper\(\)" data-i18n="settings_media_viz_install" hidden>/);
});

test('no helper message sends anyone to INSTALL.bat, and each names the button as it is labelled', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const keys = ['settings_media_viz_install', 'settings_media_viz_installing', 'settings_media_viz_st_installed',
    'settings_media_viz_install_offline', 'settings_media_viz_install_unverified', 'settings_media_viz_install_failed'];
  for (const [l, d] of Object.entries(ctx.__i18n)) {
    for (const k of keys) {
      assert.ok(d[k], `${l}.${k}`);
      if (l !== 'en') assert.notEqual(d[k], ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
    for (const k of ['settings_media_viz_st_missing', 'settings_media_viz_st_old', 'settings_media_viz_st_failed']) {
      assert.doesNotMatch(d[k], /INSTALL\.bat/, `${l}.${k}`);
      assert.ok(d[k].includes(d.settings_media_viz_install), `${l}.${k} names "${d.settings_media_viz_install}"`);
    }
    // The mode names in the sentence are the buttons on screen.
    assert.ok(d.settings_media_viz_st_installed.includes(d.settings_media_viz_minimal), `${l}: Minimal`);
    assert.ok(d.settings_media_viz_st_installed.includes(d.settings_media_viz_wave), `${l}: Wave`);
    assert.match(d.settings_media_viz_st_old, /\{version\}/, l);
  }
});
