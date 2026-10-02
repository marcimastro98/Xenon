// Switching a device without moving calls.
//
// Windows keeps a Default Device (Console + Multimedia) and a Default
// Communications Device per direction, and Xenon always set both ('all').
// Asked on Discord: "would only swap the default device (not the communication
// device)". A setting now decides, on by default so nothing changes for anyone
// who did not ask; every place that switches a device goes through one helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const S = read('../server.js');

function helper(platform, hubSettings) {
  const at = S.indexOf('async function setDefaultAudioDevice(');
  assert.ok(at >= 0, 'setDefaultAudioDevice not found');
  const code = S.slice(at, S.indexOf('\n}\n', at) + 3);
  const calls = [];
  const fn = new Function('process', 'svvExec', '_serverHubSettings', code + '\nreturn setDefaultAudioDevice;')(
    { platform },
    async (args) => { calls.push(args); },
    hubSettings,
  );
  return { fn, calls };
}

test('by default a switch moves every role, as it always did', async () => {
  const { fn, calls } = helper('win32', {});
  await fn('Speakers');
  assert.deepEqual(calls, [['/SetDefault', 'Speakers', 'all']]);
});

test('with the setting off, Windows moves Console and Multimedia and leaves Communications', async () => {
  const { fn, calls } = helper('win32', { audioSetCommunications: false });
  await fn('Headset');
  assert.deepEqual(calls, [['/SetDefault', 'Headset', '0'], ['/SetDefault', 'Headset', '1']]);
});

test('settings passed in win over the server copy', async () => {
  const { fn, calls } = helper('win32', { audioSetCommunications: true });
  await fn('Headset', { audioSetCommunications: false });
  assert.deepEqual(calls.map((c) => c[2]), ['0', '1']);
});

test('macOS and Linux have one default and keep the single call', async () => {
  for (const p of ['darwin', 'linux']) {
    const { fn, calls } = helper(p, { audioSetCommunications: false });
    await fn('x');
    assert.deepEqual(calls, [['/SetDefault', 'x', 'all']], p);
  }
});

test('no switch bypasses the helper', () => {
  const at = S.indexOf('async function setDefaultAudioDevice(');
  const rest = S.slice(0, at) + S.slice(S.indexOf('\n}\n', at));
  assert.doesNotMatch(rest, /svvExec\(\[\s*'\/SetDefault'/, 'a /SetDefault call outside setDefaultAudioDevice');
  assert.ok((S.match(/setDefaultAudioDevice\(/g) || []).length >= 6, 'deck, AI tool and both routes use it');
});

test('the setting defaults to on, on both sides, and survives a round trip', () => {
  assert.match(S, /audioSetCommunications: true,/);
  assert.match(S, /audioSetCommunications: source\.audioSetCommunications !== false,/);
  const C = read('../js/settings.js');
  assert.match(C, /audioSetCommunications: true,/);
  assert.match(C, /audioSetCommunications: value\.audioSetCommunications !== false,/);
  assert.match(C, /function updateAudioSetCommunications\(checked\)/);
});

test('Settings shows the switch, on Windows only', () => {
  const H = read('../index.html');
  assert.match(H, /id="settings-audio-comms-row"/);
  assert.match(H, /id="settings-audio-comms"[^>]*onchange="updateAudioSetCommunications\(this\.checked\)"/);
  const C = read('../js/settings.js');
  const fn = C.slice(C.indexOf('function syncAudioCommsControl()'));
  assert.match(fn.slice(0, 400), /platform !== 'win32'\) \? 'none' : ''/);
});

test('every language has the words, translated', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const keys = ['settings_audio_hint', 'settings_audio_comms', 'settings_audio_comms_desc'];
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  for (const l of langs) {
    const d = ctx.__i18n[l];
    assert.ok(d.settings_audio_head, `${l}.settings_audio_head`);
    for (const k of keys) {
      assert.ok(d[k], `${l}.${k}`);
      if (l !== 'en') assert.notEqual(d[k], ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
  }
});
