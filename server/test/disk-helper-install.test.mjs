// "How can I view the disk space?" The Disk tile said Xenon Helper was not on this PC
// and to run the installer again, which the setup .exe never shows anyone. On Windows
// the tile now downloads the helper itself, the same verified download Settings does.
// Game mode, asked in the same message, says what it does to the background and the
// Settings search finds it by the words people use for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const WIDGET = read('../js/disk-widget.js');
const SERVER = read('../server.js');
const I18N = read('../js/i18n.js');
const HTML = read('../index.html');

function cut(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `cannot cut ${start}`);
  return src.slice(a, b);
}

function node(tag, cls, text) {
  return {
    tag, className: cls || '', textContent: text == null ? '' : text, hidden: false, disabled: false, type: '',
    children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { this.listeners[t] = f; },
  };
}

// renderHelperHint with the widget's own dependencies faked.
function card({ status, remote = false, api = async () => ({ ok: true }), refresh = async () => {} }) {
  const body = cut(WIDGET, '  function renderHelperHint() {', '  function render(mount) {');
  const calls = { api: [], refresh: 0 };
  const el = (tag, cls, text) => node(tag, cls, text);
  const tr = (key) => `<${key}>`;
  const fn = new Function('el', 'tr', 'status', 'window', 'api', 'refresh',
    body + '\nreturn renderHelperHint;')(
    el, tr, status, { __xenonRemote: remote ? {} : undefined },
    async (...a) => { calls.api.push(a); return api(...a); },
    async () => { calls.refresh++; await refresh(); });
  const hint = fn();
  const find = (cls) => hint.children.find((c) => c.className.split(' ').includes(cls));
  return { hint, calls, button: hint.children.find((c) => c.tag === 'button'), result: find('diskw-hint-result'), text: find('diskw-hint-text') };
}

test('on Windows, at the PC, the card offers the download and says so', () => {
  const c = card({ status: { helper: false, canInstallHelper: true } });
  assert.ok(c.button, 'no button');
  assert.equal(c.button.textContent, '<settings_media_viz_install>');
  assert.equal(c.text.textContent, '<disk_helper_text_win>');
  assert.equal(c.result.hidden, true);
});

test('where the helper cannot be fetched, or on a paired phone, it only says what is missing', () => {
  for (const [status, remote] of [[{ helper: false, canInstallHelper: false }, false], [{ helper: false }, false], [{ helper: false, canInstallHelper: true }, true]]) {
    const c = card({ status, remote });
    assert.equal(c.button, undefined);
    assert.equal(c.text.textContent, '<disk_helper_text>');
  }
});

test('pressing it posts to the install route, shows progress, then reloads the tile', async () => {
  let seenWhileInstalling;
  const c = card({ status: { helper: false, canInstallHelper: true } });
  const done = c.button.listeners.click();
  seenWhileInstalling = { disabled: c.button.disabled, label: c.button.textContent };
  await done;
  assert.deepEqual(c.calls.api, [['/audio/levels/install-helper', {}]], 'a body is what makes api() a POST');
  assert.deepEqual(seenWhileInstalling, { disabled: true, label: '<settings_media_viz_installing>' });
  assert.equal(c.calls.refresh, 1, 'the real tile replaces the card');
});

test('a failure is named under the button and the button comes back', async () => {
  const cases = [
    [{ ok: false, status: 'not-ready' }, 'settings_media_viz_install_offline', 'not-ready'],
    [{ ok: false, error: 'offline' }, 'settings_media_viz_install_offline', 'offline'],
    [{ ok: false, status: 'signature-invalid' }, 'settings_media_viz_install_unverified', 'signature-invalid'],
    [{ ok: false, status: 'mismatch' }, 'settings_media_viz_install_unverified', 'mismatch'],
    [{ ok: false, status: 'error' }, 'settings_media_viz_install_failed', 'error'],
    [{ ok: false, error: 'http_403' }, 'settings_media_viz_install_failed', 'http_403'],
  ];
  for (const [reply, key, code] of cases) {
    const c = card({ status: { helper: false, canInstallHelper: true }, api: async () => reply });
    await c.button.listeners.click();
    assert.equal(c.result.textContent, `<${key}> (${code})`);
    assert.equal(c.result.hidden, false);
    assert.equal(c.button.disabled, false);
    assert.equal(c.button.textContent, '<settings_media_viz_install>');
    assert.equal(c.calls.refresh, 0, 'nothing to reload when nothing was installed');
  }
});

test('the tile renders that card, and the server says when it can be used', () => {
  assert.match(WIDGET, /if \(!status\.helper\) \{\n\s+mount\.appendChild\(renderHelperHint\(\)\);/);
  const route = cut(SERVER, "reqPath === '/disk/status' && req.method === 'GET'", '\n  } else if (');
  assert.match(route, /canInstallHelper: process\.platform === 'win32'/);
  // The route the button uses stays closed to paired devices.
  assert.match(read('../remote-access.js'), /'\/audio\/levels\/install-helper',/);
});

test('every language has the Windows sentence, and none still sends people to an installer', () => {
  const langs = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
  for (const lang of langs) {
    const re = new RegExp('Object\\.assign\\(i18n\\.' + lang + ', \\{\\n  disk_helper_text_win: "([^"]+)"');
    const m = re.exec(I18N);
    assert.ok(m, `${lang} has no disk_helper_text_win`);
    assert.ok(m[1].length > 40);
  }
});

test('Game mode names the background, and the search knows the words for it', () => {
  const hint = /settings_gamemode: 'Game mode', settings_gamemode_hint: '([^']+)'/.exec(I18N)[1];
  assert.match(hint, /animated background/);
  assert.match(hint, /aurora and neon grid/);
  assert.match(HTML, /<label class="settings-toggle-row full" data-search-kw="settings_gamemode_kw">\n\s+<input class="settings-check" id="settings-gamemode-enabled"/);
  const en = /Object\.assign\(i18n\.en, \{\n  disk_helper_text_win: "[^"]+",\n  settings_gamemode_kw: "([^"]+)"/.exec(I18N)[1];
  for (const word of ['black background', 'background goes black', 'in game', 'aurora', 'neon grid']) {
    assert.ok(en.includes(word), `the English keywords lack "${word}"`);
  }
});
