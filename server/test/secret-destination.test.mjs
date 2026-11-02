// A saved credential belongs to the address it was typed for.
//
// The settings model never sends the Home Assistant token or the UniFi / OBS /
// Streamer.bot passwords to the browser, so every save arrives with them blank
// and the server fills the stored one back in. That fill used to ignore the
// address: a save (or an imported backup, which is outside data) that changed
// only `homeAssistant.url` to https://evil made Xenon send the long-lived token
// to evil on its next connection. The /test routes did the same with a URL taken
// straight from the request body. These tests pin "same destination or nothing",
// and the parts that must keep working: Connect with a just-typed URL + token,
// routine saves that do not carry the secret, and restores on a PC with no
// secrets at all.
//
// Also here: private calendar links treated as secrets (redacted on the wire,
// kept on save), and the shared list the dashboard uses to keep every secret out
// of its localStorage mirror.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import { createRequire } from 'node:module';

const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };
const require = createRequire(import.meta.url);
const ha = require('../actions/home-assistant.js');
const unifi = require('../actions/unifi.js');
const stream = require('../stream-creds.js');
const ics = require('../ics-feeds.js');
const secrets = require('../js/settings-secrets.js');
const { redactStockCreds } = require('../stocks-creds.js');
const { redactFootballCreds } = require('../football-creds.js');
const { redactNewsCreds } = require('../news-creds.js');
const { redactAiProviderCreds } = require('../ai-provider-creds.js');
const { redactRemoteCreds } = require('../remote-control/settings.js');

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const SETTINGS_JS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

function routeBody(path) {
  const start = SERVER.indexOf(`reqPath === '${path}'`);
  assert.ok(start >= 0, path + ' route not found');
  return SERVER.slice(start, SERVER.indexOf('} else if (', start + 10));
}

// ── Home Assistant ───────────────────────────────────────────────────────────
test('HA: the stored token follows a save only while the server is the same', () => {
  const prev = { homeAssistant: { url: 'http://ha.local:8123', token: 'LONG_LIVED' } };
  const same = ha.preserveHaToken({ homeAssistant: { url: 'http://HA.local:8123/', token: '' } }, prev);
  assert.equal(same.homeAssistant.token, 'LONG_LIVED', 'case and trailing slash are not a new server');

  const moved = ha.preserveHaToken({ homeAssistant: { url: 'https://evil.example', token: '' } }, prev);
  assert.equal(moved.homeAssistant.token, '', 'a new host must not inherit the token');

  const port = ha.preserveHaToken({ homeAssistant: { url: 'http://ha.local:9999', token: '' } }, prev);
  assert.equal(port.homeAssistant.token, '', 'a new port is a new destination');

  const downgrade = ha.preserveHaToken(
    { homeAssistant: { url: 'http://ha.me', token: '' } },
    { homeAssistant: { url: 'https://ha.me', token: 'T' } });
  assert.equal(downgrade.homeAssistant.token, '', 'https → http would send the token in clear text');

  const typed = ha.preserveHaToken({ homeAssistant: { url: 'https://new.example', token: 'NEW' } }, prev);
  assert.equal(typed.homeAssistant.token, 'NEW', 'a just-typed token always wins');
});

test('HA: a payload without the block still keeps everything (routine save)', () => {
  const prev = { homeAssistant: { url: 'http://ha:8123', token: 'SECRET', entities: ['light.a'] } };
  const out = ha.preserveHaToken({ appearance: 'dark' }, prev);
  assert.equal(out.homeAssistant.token, 'SECRET');
  assert.equal(out.homeAssistant.url, 'http://ha:8123');
});

test('HA: haSameDestination compares normalised origins', () => {
  assert.equal(ha.haSameDestination('https://ha.me', 'https://ha.me:443/lovelace'), true);
  assert.equal(ha.haSameDestination('https://ha.me', 'https://ha.me.evil.example'), false);
  assert.equal(ha.haSameDestination('https://ha.me', 'javascript:alert(1)'), false);
});

test('HA /test route: the stored token is used only for the stored URL', () => {
  const body = routeBody('/api/homeassistant/test');
  assert.match(body, /haSameDestination\(url, prevHa\.url\) \? prevHa\.token : ''/);
  assert.doesNotMatch(body, /body\.token : prevHa\.token/, 'the old unconditional fallback is gone');
});

// ── UniFi ────────────────────────────────────────────────────────────────────
test('UniFi: the stored password needs the same console AND the same username', () => {
  const prev = { unifi: { host: '10.0.0.2', username: 'viewer', password: 'saved', cameras: [] } };
  const keep = { unifi: { host: 'https://10.0.0.2', username: 'viewer', password: '', cameras: [] } };
  unifi.preserveUnifiCreds(keep, prev);
  assert.equal(keep.unifi.password, 'saved', 'a bare host and its https:// form are the same console');

  const host = { unifi: { host: 'evil.example', username: 'viewer', password: '' } };
  unifi.preserveUnifiCreds(host, prev);
  assert.equal(host.unifi.password, '');

  const user = { unifi: { host: '10.0.0.2', username: 'admin', password: '' } };
  unifi.preserveUnifiCreds(user, prev);
  assert.equal(user.unifi.password, '', 'a different login does not get this one\'s password');
});

test('UniFi /test route: the stored password is used only for the stored host + user', () => {
  const body = routeBody('/api/unifiprotect/test');
  assert.match(body, /unifiSameDestination\(\{ host, username \}, prevU\) \? prevU\.password : ''/);
  assert.doesNotMatch(body, /body\.password : prevU\.password/);
});

// ── OBS / Streamer.bot ───────────────────────────────────────────────────────
test('OBS / Streamer.bot: a password stays only while host and port are unchanged', () => {
  const prev = { obsHost: '192.168.1.5', obsPort: 4455, obsPassword: 'OBS', streamerbotHost: '', streamerbotPort: 8080, streamerbotPassword: 'SB' };

  const routine = { obsHost: '192.168.1.5', obsPort: 4455, obsPassword: '', streamerbotHost: 'localhost', streamerbotPort: 8080, streamerbotPassword: '' };
  stream.preserveStreamCreds(routine, prev);
  assert.equal(routine.obsPassword, 'OBS');
  assert.equal(routine.streamerbotPassword, 'SB', 'blank and localhost are both this PC');

  const moved = { obsHost: 'evil.example', obsPort: 4455, obsPassword: '', streamerbotHost: '', streamerbotPort: 9000, streamerbotPassword: '' };
  stream.preserveStreamCreds(moved, prev);
  assert.equal(moved.obsPassword, '', 'new host');
  assert.equal(moved.streamerbotPassword, '', 'new port');
});

// ── Backup import goes through the same rule ─────────────────────────────────
test('backup import: a bundle cannot move a stored secret to its own address', () => {
  // applyBackup runs the composed preserve helper; these are the parts of it
  // that are destination-bound. Simulate a tampered bundle against this PC.
  const prev = {
    homeAssistant: { url: 'http://ha.local:8123', token: 'HA' },
    unifi: { host: '10.0.0.2', username: 'v', password: 'U' },
    obsHost: '', obsPort: 4455, obsPassword: 'O',
  };
  const bundle = {
    homeAssistant: { url: 'https://evil.example', token: '', tokenSet: true },
    unifi: { host: 'evil.example', username: 'v', password: '', passwordSet: true },
    obsHost: 'evil.example', obsPort: 4455, obsPassword: '',
  };
  stream.preserveStreamCreds(unifi.preserveUnifiCreds(ha.preserveHaToken(bundle, prev), prev), prev);
  assert.equal(bundle.homeAssistant.token, '');
  assert.equal(bundle.unifi.password, '');
  assert.equal(bundle.obsPassword, '');

  // The applyBackup path really uses that composed helper.
  const apply = SERVER.slice(SERVER.indexOf('async function applyBackup('));
  assert.match(apply.slice(0, apply.indexOf('\n}\n')), /preserveSettingsSecrets\(\{ \.\.\.d\.settings \}, prev\)/);
});

test('backup import: the same address restores, and a PC with no secrets stays empty', () => {
  const prev = { homeAssistant: { url: 'http://ha.local:8123', token: 'HA' } };
  const sameAddr = { homeAssistant: { url: 'http://ha.local:8123', token: '' } };
  assert.equal(ha.preserveHaToken(sameAddr, prev).homeAssistant.token, 'HA');
  const fresh = { homeAssistant: { url: 'http://ha.local:8123', token: '' } };
  assert.equal(ha.preserveHaToken(fresh, null).homeAssistant.token, '');
});

// ── Calendar feed links ──────────────────────────────────────────────────────
test('calendar feeds: the private link never reaches the browser, host + urlSet do', () => {
  const s = { calendarFeeds: [{ id: 'f1', name: 'Work', url: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', color: '#1ed760' }] };
  const out = ics.redactCalendarFeedUrls(s);
  assert.equal(out.calendarFeeds[0].url, '');
  assert.equal(out.calendarFeeds[0].urlSet, true);
  assert.equal(out.calendarFeeds[0].host, 'calendar.google.com');
  assert.equal(out.calendarFeeds[0].name, 'Work');
  assert.match(s.calendarFeeds[0].url, /private-abc/, 'the stored copy is untouched');
});

test('calendar feeds: a blank link on save is refilled by id, a typed one wins', () => {
  const prev = { calendarFeeds: [{ id: 'f1', url: 'https://a.example/secret.ics' }, { id: 'f2', url: 'https://b.example/x.ics' }] };
  const incoming = { calendarFeeds: [
    { id: 'f1', name: 'Renamed', url: '', urlSet: true },
    { id: 'f2', url: 'https://b.example/new.ics' },
    { id: 'f3', url: '' },
  ] };
  ics.preserveCalendarFeedUrls(incoming, prev);
  assert.equal(incoming.calendarFeeds[0].url, 'https://a.example/secret.ics');
  assert.equal(incoming.calendarFeeds[0].name, 'Renamed');
  assert.equal(incoming.calendarFeeds[1].url, 'https://b.example/new.ics');
  assert.equal(incoming.calendarFeeds[2].url, '', 'an unknown id has nothing to inherit');
  // And the normaliser still accepts the refilled feed.
  assert.equal(ics.normalizeCalendarFeeds(incoming.calendarFeeds).length, 2);
});

test('calendar feeds: wired into the composed redact/preserve helpers', () => {
  const redact = SERVER.slice(SERVER.indexOf('function redactSettingsSecrets('));
  assert.match(redact.slice(0, redact.indexOf('\n}\n')), /icsFeeds\.redactCalendarFeedUrls\(/);
  const preserve = SERVER.slice(SERVER.indexOf('function preserveSettingsSecrets('));
  assert.match(preserve.slice(0, preserve.indexOf('\n}\n')), /icsFeeds\.preserveCalendarFeedUrls\(/);
});

test('backup: keeps the calendar links for the restore, and says the file is private', () => {
  const build = SERVER.slice(SERVER.indexOf('async function buildBackup('));
  assert.match(build.slice(0, build.indexOf('\n}\n')), /safeSettings\.calendarFeeds = settings\.calendarFeeds/);
  // The section comment no longer promises the file is safe to hand to someone.
  assert.doesNotMatch(SERVER, /safe to\s*\n?\/\/\s*keep on a cloud drive or hand to someone/);
  assert.match(SERVER, /A backup is NOT safe to hand to someone/);
  // Every language's export note is overridden with the corrected text.
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    const re = new RegExp(`Object\\.assign\\(i18n\\.${lang}, \\{\\n  settings_backup_note: "[^"]+",\\n\\}\\);`);
    assert.match(I18N, re, lang + ' is missing the corrected backup note');
  }
});

// ── One secret list for the server redaction and the localStorage mirror ─────
test('settings-secrets: every key the server redacts is in the shared list', () => {
  const full = {};
  for (const k of secrets.TOP_LEVEL_SECRET_KEYS) full[k] = 'S_' + k;
  // Probe each server redactor with every key it could know about plus decoys;
  // any key it blanks must be one the browser blanks too.
  const probe = { ...full, someOtherKey: 'x', obsPassword: 'p', streamerbotPassword: 'p' };
  for (const redact of [stream.redactStreamCreds, redactStockCreds, redactFootballCreds, redactNewsCreds, redactAiProviderCreds]) {
    const out = redact(probe);
    for (const [k, v] of Object.entries(out)) {
      if (v === '' && probe[k]) assert.ok(secrets.TOP_LEVEL_SECRET_KEYS.includes(k), k + ' is redacted by the server but not in the shared list');
    }
  }
  const nested = {
    homeAssistant: { url: 'http://h', token: 'T' },
    unifi: { host: 'h', username: 'u', password: 'P' },
    remoteControl: { sunshineUser: 'U', sunshinePass: 'P' },
  };
  const redacted = redactRemoteCreds(unifi.redactUnifiCreds(ha.redactHaToken(nested)));
  for (const block of Object.keys(nested)) {
    for (const [f, v] of Object.entries(nested[block])) {
      if (redacted[block][f] === '' && v) assert.ok(secrets.NESTED_SECRET_KEYS[block].includes(f), `${block}.${f} missing from the shared list`);
    }
  }
});

test('settings-secrets: stripSettingsSecrets blanks every secret the issue named', () => {
  const s = {
    sportsDbKey: 'a', newsDataKey: 'b', twelveDataKey: 'c', finnhubKey: 'd',
    obsPassword: 'e', streamerbotPassword: 'f', geminiApiKey: 'g', openaiApiKey: 'h', anthropicApiKey: 'i',
    obsPasswordSet: true,
    homeAssistant: { url: 'http://ha.local', token: 'T', tokenSet: true },
    unifi: { host: 'udm.local', password: 'P' },
    remoteControl: { sunshineUser: 'U', sunshinePass: 'P', enabled: true },
    calendarFeeds: [{ id: 'feed1', url: 'https://cal.example/private.ics' }],
    accent: '#fff',
  };
  const out = secrets.stripSettingsSecrets(s);
  const dump = JSON.stringify(out);
  for (const v of ['"a"', '"b"', '"c"', '"d"', '"e"', '"f"', '"g"', '"h"', '"i"', '"T"', '"P"', '"U"', 'private.ics']) {
    assert.ok(!dump.includes(v), v + ' leaked into the local mirror');
  }
  assert.equal(out.obsPasswordSet, true, 'the *Set flags stay for the "saved" placeholders');
  assert.equal(out.homeAssistant.tokenSet, true);
  assert.equal(out.calendarFeeds[0].urlSet, true);
  assert.equal(out.calendarFeeds[0].host, 'cal.example');
  assert.equal(out.accent, '#fff');
  assert.equal(out.remoteControl.enabled, true);
  assert.equal(s.obsPassword, 'e', 'the in-memory settings are not mutated');
  const clean = { accent: '#000' };
  assert.equal(secrets.stripSettingsSecrets(clean), clean, 'nothing to blank → same object');
});

test('settings-secrets: the server modules and the dashboard read the same list', () => {
  for (const f of ['stream-creds.js', 'stocks-creds.js', 'football-creds.js', 'news-creds.js', 'ai-provider-creds.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/js\/settings-secrets\.js'\)/, f + ' keeps its own copy of the list');
  }
  const save = SETTINGS_JS.slice(SETTINGS_JS.indexOf('function saveLocalHubSettings('));
  const body = save.slice(0, save.indexOf('\n}\n'));
  assert.match(body, /SettingsSecrets\.stripSettingsSecrets\(hubSettings\)/);
  assert.ok(INDEX.indexOf('<script src="js/settings-secrets.js">') >= 0
    && INDEX.indexOf('<script src="js/settings-secrets.js">') < INDEX.indexOf('<script src="js/settings.js">'),
    'settings-secrets.js must load before settings.js');
});
