// The settings save check (tools/ci/settings-save-check.mjs): its rules are worth what
// they catch. Each rule is asked here of an engine that breaks it, a stand-in a few lines
// long, and has to say so: one that stores whatever it is sent and lets everyone in, one
// that stores nothing, one that keeps every secret wherever it now goes, one that sends
// the secrets to the page, one that tells no dashboard. The real engine is asked by the
// check itself, in the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { endWithProcess, rigEnvironment, rigPort, stopChild, streamEvents } from '../../tools/ci/engine-rig.mjs';
import { cookiePair, deviceHeaders } from '../../tools/ci/paired-device.mjs';
import { LAST_RULES, READ_RULES, askRule, checkReport, crashLines } from '../../tools/ci/settings-save-check.mjs';
import { DEVICE_RULES } from '../../tools/ci/settings-save-rules-device.mjs';
import { PC_RULES, same, secretsOf, took, unchanged, without } from '../../tools/ci/settings-save-rules.mjs';
import { NESTED_SECRETS, SECRET_KEYS, SECRET_MARK, seedSettings } from '../../tools/ci/settings-save-seed.mjs';

const GUARD = fileURLToPath(new URL('../../tools/ci/no-network.cjs', import.meta.url));
const { staysHere, targetOf } = createRequire(import.meta.url)(GUARD);

const RULES = [...READ_RULES, ...PC_RULES, ...DEVICE_RULES, ...LAST_RULES];
// What a real engine has made of the seed by the time the rules are asked.
const STORED = {
  ...seedSettings('rig'), rev: 1, storeId: 'a'.repeat(32), dashboardLayoutVersion: 6,
  dashboardLayout: { gridCols: 24, topbarHidden: false, pages: [] }, remoteAccess: { enabled: true, https: false },
};

// The settings as a page is sent them: every secret taken out.
function wire(stored) {
  const sent = structuredClone(stored);
  for (const key of SECRET_KEYS) sent[key] = '';
  for (const [block, field] of NESTED_SECRETS) sent[block][field] = '';
  for (const feed of sent.calendarFeeds) feed.url = '';
  sent.fileTransfer.inboxDir = '';
  sent.capture.folder = '';
  return sent;
}

// The secrets a save left empty, put back from the store whatever address they now go to.
function withStoredSecrets(sent, stored) {
  const next = structuredClone(sent);
  for (const key of SECRET_KEYS) next[key] = next[key] || stored[key];
  for (const [block, field] of NESTED_SECRETS) if (next[block]) next[block][field] = next[block][field] || stored[block]?.[field];
  return next;
}

const answer = (status, json) => ({ status, headers: {}, text: JSON.stringify(json), json });

/** A stand-in engine and the three doors to it. It lets everyone in; the options say what else it gets wrong. */
function standIn(start, { stores = true, keepsSecrets = false, redacts = true, tells = true } = {}) {
  let text = JSON.stringify(start);
  const read = () => { try { return JSON.parse(text); } catch { return {}; } };
  const ask = async (method, pathname, body) => {
    if (method === 'GET') return answer(200, { settings: redacts ? wire(read()) : read() });
    if (!stores) return answer(200, { ok: true, rev: read().rev, savedAt: 1, lightingApplied: true });
    const next = keepsSecrets ? withStoredSecrets(body.settings, read()) : body.settings;
    text = JSON.stringify(next);
    return answer(200, { ok: true, rev: next.rev, savedAt: 1, lightingApplied: true, settings: next });
  };
  const door = { ask };
  return {
    rig: { storedText: () => text, stored: read, writeStore: (written) => { text = written; } },
    doors: { pc: door, device: door, stranger: door },
    stream: { waitFor: async () => tells },
  };
}

const ENGINES = { careless: {}, deaf: { stores: false }, keeper: { keepsSecrets: true }, leaky: { redacts: false }, mute: { tells: false } };
const alone = (rule, engine) => askRule(rule, standIn(rule.given ? rule.given(STORED) : STORED, ENGINES[engine]));

// The broken engine a guard is there for: the careless one, but for three that it does not break.
function breakerOf(rule) {
  if (/hold no secret/.test(rule.rule)) return 'leaky';
  if (/is told a save/.test(rule.rule)) return 'mute';
  if (/new destination/.test(rule.rule)) return 'keeper';
  return 'careless';
}

test('every rule has a name of its own and says which kind it is', () => {
  assert.equal(new Set(RULES.map((rule) => rule.rule)).size, RULES.length);
  assert.deepEqual(RULES.filter((rule) => !['guard', 'saved'].includes(rule.kind)).map((rule) => rule.rule), []);
  assert.ok(RULES.length >= 60, String(RULES.length));
});

test('every rule about what a save must not do is broken by the engine it is there for, and says how', async () => {
  const silent = [];
  for (const rule of RULES.filter((entry) => entry.kind === 'guard')) {
    const problem = await alone(rule, breakerOf(rule));
    if (!problem || /nothing was proven/.test(problem)) silent.push(`${rule.rule} [${breakerOf(rule)}]: ${problem || 'no problem seen'}`);
  }
  assert.deepEqual(silent, []);
});

test('every rule about what a save must do passes on an engine that stores what it is sent, and fails on one that stores nothing', async () => {
  const wrong = [];
  for (const rule of RULES.filter((entry) => entry.kind === 'saved')) {
    const stored = await alone(rule, 'careless');
    const lost = await alone(rule, 'deaf');
    if (stored) wrong.push(`${rule.rule}: on an engine that stores it, ${stored}`);
    if (!lost) wrong.push(`${rule.rule}: an engine that stores nothing passed`);
  }
  assert.deepEqual(wrong, []);
});

test('a rule that relies on an earlier one is not judged when the store is not as that one leaves it', async () => {
  const relying = RULES.filter((rule) => rule.given);
  assert.ok(relying.length >= 5, String(relying.length));
  for (const rule of relying) assert.match(await askRule(rule, standIn(STORED)), /nothing was proven/, rule.rule);
});

test('a rule that throws is a problem of that rule', async () => {
  const { askRules } = await import('../../tools/ci/settings-save-check.mjs');
  const results = await askRules([{ rule: 'breaks', kind: 'guard', send: () => { throw new Error('boom'); }, verdict: () => '' }], standIn(STORED));
  assert.deepEqual(results, [{ rule: 'breaks', kind: 'guard', problem: 'the check itself failed: boom' }]);
});

test('a refused save passes only when it is refused with that status and nothing was stored', async () => {
  const rule = { rule: 'refused', kind: 'guard', refused: 403, send: (mirror) => ({ ...mirror, language: 'en' }) };
  const refusing = standIn(STORED);
  refusing.doors.pc = { ask: async (method, ...rest) => (method === 'POST' ? answer(403, { ok: false }) : refusing.doors.device.ask(method, ...rest)) };
  assert.equal(await askRule(rule, refusing), '');
  assert.match(await askRule(rule, standIn(STORED)), /answered 200 and the stored settings changed/);
  assert.match(await askRule(rule, standIn(STORED, ENGINES.deaf)), /answered 200$/);
});

test('the verdicts say nothing was proven when the page sent what was stored', () => {
  const stored = { language: 'it', stocks: { alertPercent: 3 } };
  assert.match(unchanged('language')({ before: stored, after: stored, sent: stored }), /nothing was proven/);
  assert.equal(unchanged('language')({ before: stored, after: stored, sent: { language: 'en' } }), '');
  assert.match(unchanged('language')({ before: stored, after: { language: 'en' }, sent: { language: 'en' } }), /language was "it", the save made it "en"/);
  assert.match(took('stocks', 'alertPercent')({ before: stored, after: stored, sent: stored }), /nothing was proven/);
  assert.equal(took('language')({ before: stored, after: { language: 'en' }, sent: { language: 'en' } }), '');
  assert.match(took('language')({ before: stored, after: stored, sent: { language: 'en' } }), /language reads "it", "en" was saved/);
});

test('the seed marks every secret, and the helpers find each of them', () => {
  const found = secretsOf(STORED);
  assert.equal(Object.keys(found).length, SECRET_KEYS.length + NESTED_SECRETS.length + 3);
  assert.deepEqual(Object.entries(found).filter(([, value]) => !String(value).includes(SECRET_MARK)).map(([name]) => name), []);
  assert.equal(JSON.stringify(wire(STORED)).includes(SECRET_MARK), false);
  assert.equal(same({ a: 1, b: { c: [1, 2], d: 2 } }, { b: { d: 2, c: [1, 2] }, a: 1 }), true);
  assert.equal(same({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.deepEqual(without({ a: 1, b: 2, c: 3 }, 'a', 'c'), { b: 2 });
});

test('the seed names no real service: every address is of the documentation range or an example domain', () => {
  const text = JSON.stringify(seedSettings('rig'));
  const hosts = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((match) => match[0]);
  assert.ok(hosts.length >= 4);
  assert.deepEqual(hosts.filter((host) => !host.startsWith('192.0.2.')), []);
  assert.deepEqual([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((match) => match[1]).filter((host) => !/^192\.0\.2\.\d+$|\.example$/.test(host)), []);
});

test('the events of a live stream are read in order, a comment and a half-sent event aside', () => {
  const text = 'event: settings\ndata: {"rev":4}\n\n: ping\n\nevent: media\ndata: plain\n\nevent: late\ndata: {"re';
  assert.deepEqual(streamEvents(text.slice(0, text.lastIndexOf('\n\n') + 2)), [{ name: 'settings', data: { rev: 4 } }, { name: 'media', data: 'plain' }]);
  assert.deepEqual(streamEvents(''), []);
});

test('a rig engine listens on this computer only, in folders of its own, with the network held', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-rig-test-'));
  const env = rigEnvironment({ NODE_OPTIONS: '--no-warnings', PATH: 'kept' }, folder, 3041);
  assert.equal(env.XENON_PORT, '3041');
  assert.equal(env.XENON_BIND_HOST, '127.0.0.1');
  assert.equal(env.XENON_RIG_NO_NETWORK, '1');
  assert.equal(env.PATH, 'kept');
  assert.match(env.NODE_OPTIONS, /^--no-warnings --require "[^"\\]*\/tools\/ci\/no-network\.cjs"$/);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(String(env[key]).startsWith(folder + path.sep), key);
  assert.equal(rigEnvironment({}, folder, 3041).NODE_OPTIONS.startsWith('--require'), true);
  rmSync(folder, { recursive: true, force: true });
});

test('a rig takes a side port and never the one of the installed app', () => {
  // Not 3039 either: the gate's other throwaway engines start there when nobody names a port.
  assert.equal(rigPort(undefined), 3046);
  assert.equal(rigPort(''), 3046);
  assert.equal(rigPort('3041'), 3041);
  for (const refused of ['3030', 3030, 'http', '80', '70000']) assert.throws(() => rigPort(refused), /installed app/, String(refused));
});

// A stand-in for a started process: `leaves` says which way of ending it it obeys.
function standInChild(leaves) {
  const sent = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, sent,
    kill(signal) {
      sent.push(signal ?? 'asked');
      if (!leaves.includes(signal ?? 'asked')) return true;
      child.signalCode = signal ?? 'SIGTERM';
      child.emit('exit', null, child.signalCode);
      return true;
    },
  });
  return child;
}

test('an engine that does not leave when asked is ended without asking once the limit has passed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stubborn = standInChild(['SIGKILL']);
  let gone = false;
  const wait = stopChild(stubborn, 10_000).then(() => { gone = true; });
  await Promise.resolve();
  assert.deepEqual(stubborn.sent, ['asked']);
  assert.equal(gone, false);
  t.mock.timers.tick(9_999);
  assert.deepEqual(stubborn.sent, ['asked']);
  t.mock.timers.tick(1);
  await wait;
  assert.deepEqual(stubborn.sent, ['asked', 'SIGKILL']);
});

test('an engine that leaves when asked is not ended a second time, and one already gone is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const polite = standInChild(['asked']);
  await stopChild(polite, 10_000);
  t.mock.timers.tick(60_000);
  assert.deepEqual(polite.sent, ['asked']);
  // Ended by a signal it has no exit code: asking again must not wait for an exit that already happened.
  await stopChild(polite, 10_000);
  assert.deepEqual(polite.sent, ['asked']);
  await stopChild(null);
});

test('a real process is stopped and waited for, twice over without hanging', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await stopChild(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await stopChild(child);
});

test('the engine ends with the check that started it, until the check has stopped it itself', () => {
  const sent = [];
  const child = { kill: (signal) => { sent.push(signal); } };
  const owner = new EventEmitter();
  endWithProcess(() => child, owner);
  owner.emit('exit');
  assert.deepEqual(sent, ['SIGKILL']);

  const stopped = new EventEmitter();
  const unwatch = endWithProcess(() => child, stopped);
  unwatch();
  assert.equal(stopped.listenerCount('exit'), 0);
  stopped.emit('exit');
  assert.deepEqual(sent, ['SIGKILL']);

  // Nothing started yet, or a process that is gone and throws: the end of the check is not disturbed.
  for (const current of [() => null, () => ({ kill() { throw new Error('gone'); } })]) {
    const other = new EventEmitter();
    endWithProcess(current, other);
    assert.doesNotThrow(() => other.emit('exit'));
  }
});

test('the log of a check says where it ran, what the engine printed, every rule and what went wrong', () => {
  const results = [{ rule: 'first rule', kind: 'guard', problem: '' }, { rule: 'second rule', kind: 'saved', problem: 'the save answered 500' }];
  const bad = checkReport('listening\nsaved', results, ['second rule: the save answered 500']);
  assert.ok(bad.startsWith(`Node ${process.version} on ${process.platform}\nlistening\nsaved\n--- 2 rules asked\n`));
  assert.ok(bad.includes('kept      first rule\nNOT KEPT  second rule\n---\nsecond rule: the save answered 500\n'));
  assert.ok(checkReport('', results.slice(0, 1), []).endsWith('--- 1 rules asked\nkept      first rule\n---\nevery rule kept\n'));
});

test('a paired device is told apart by the address it opened and its cookie', () => {
  assert.deepEqual(deviceHeaders('192.0.2.7:3041'), { Host: '192.0.2.7:3041', Origin: 'http://192.0.2.7:3041' });
  assert.deepEqual(deviceHeaders('192.0.2.7:3041', 'pair=abc'), { Host: '192.0.2.7:3041', Origin: 'http://192.0.2.7:3041', Cookie: 'pair=abc' });
  assert.equal(cookiePair(['pair=abc; HttpOnly; SameSite=Strict; Path=/', 'other=1']), 'pair=abc');
  assert.equal(cookiePair('pair=abc; HttpOnly'), 'pair=abc');
  assert.equal(cookiePair(undefined), '');
});

test('the lines that mean an engine broke are picked out of its output', () => {
  assert.deepEqual(crashLines('listening\n  TypeError: x is not a function\nsaved\nUnhandled rejection\n'), ['TypeError: x is not a function', 'Unhandled rejection']);
  assert.deepEqual(crashLines(''), []);
});

test('the network guard tells where a connection goes, in every form Node gives it', () => {
  assert.equal(targetOf([{ host: '192.0.2.1', port: 80 }]), '192.0.2.1');
  assert.equal(targetOf([[{ host: 'service.example', port: 443 }, null]]), 'service.example');
  assert.equal(targetOf([{ port: 3041 }]), '');
  assert.equal(targetOf([3041, '192.0.2.1']), '192.0.2.1');
  assert.equal(targetOf([3041]), '');
  assert.equal(targetOf(['3041', 'service.example']), 'service.example');
  assert.equal(targetOf([{ path: 'a-pipe' }]), null);
  assert.equal(targetOf(['a-pipe']), null);
  for (const here of [null, '', 'localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) assert.equal(staysHere(here), true, String(here));
  for (const away of ['192.0.2.1', 'service.example', '0.0.0.0', '127.0.0.1.example']) assert.equal(staysHere(away), false, away);
});

test('with the guard loaded, a connection that leaves this computer is refused at once and one that stays goes through', () => {
  const script = [
    "const net = require('node:net'); const http = require('node:http'); const seen = {};",
    "const refusal = (start) => new Promise((resolve) => start().on('error', (error) => resolve(error.message)));",
    "const server = net.createServer((socket) => socket.end('hello')).listen(0, '127.0.0.1', async () => {",
    "  seen.address = await refusal(() => net.connect(9, '192.0.2.1'));",
    "  seen.name = await refusal(() => http.get({ host: 'service.example', port: 80, path: '/' }));",
    "  seen.fetch = await fetch('https://service.example/').then(() => 'answered', (error) => String(error.cause?.message || error.cause?.errors?.[0]?.message || error.message));",
    "  net.connect(server.address().port, '127.0.0.1').on('data', (chunk) => { seen.near = String(chunk); console.log(JSON.stringify(seen)); server.close(); });",
    '});',
  ].join('\n');
  const run = (on) => spawnSync(process.execPath, ['--require', GUARD, '-e', on ? script : "console.log(require('node:net').Socket.prototype.connect.name)"],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, XENON_RIG_NO_NETWORK: on ? '1' : '' } });
  const held = run(true);
  assert.equal(held.status, 0, held.stderr);
  const seen = JSON.parse(held.stdout);
  for (const kind of ['address', 'name', 'fetch']) assert.match(seen[kind], /kept off the network/, kind);
  assert.equal(seen.near, 'hello');
  assert.notEqual(run(false).stdout.trim(), 'connectHere');
});
