// Welcome Sparks, the app's half (welcome-sparks.js, ai-xenon-credits.js).
//
// The rules these tests hold:
//  - only an empty data folder is a new install, never an update or a damaged one;
//  - the first message claims, once; nothing in the background ever does;
//  - the code stays in DATA_DIR and never reaches the balance the browser reads;
//  - when the hub says they ended, this PC is simply one with no code;
//  - the default layout and provider change for new installs only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
process.env.XENON_LOG_DIR = mkdtempSync(join(tmpdir(), 'xenon-log-'));
const redeem = require('../supporter-redeem.js');
const X = require('../ai-xenon-credits.js');
const W = require('../welcome-sparks.js');
const wallet = require('../sparks-wallet.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const CODE = 'XC-ABCD-EFGH-JKLM';
const CANON = 'XCABCDEFGHJKLM';
const dir = () => mkdtempSync(join(tmpdir(), 'xenon-welcome-'));
const stores = (d) => ['settings.json', 'notes.json', 'install-id.json'].map((f) => join(d, f));
const reply = () => ({
  id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 }, xenon: { credits: 0.1, balance: 29 },
});
const session = () => ({ ok: true, token: 'tok', exp: Math.floor(Date.now() / 1000) + 3600 });
const history = [{ role: 'user', parts: [{ text: 'hello' }] }];
const send = (dataDir) => X.chat({ dataDir, model: 'haiku', history, systemText: 's', geminiTools: [], executeTool: async () => ({}) });

function hub(routes) {
  const calls = [];
  redeem._setTransport(async (url, body) => {
    const path = new URL(url).pathname;
    calls.push({ path, body });
    const r = routes[path];
    return typeof r === 'function' ? r(body) : r;
  });
  return calls;
}
const claims = (calls) => calls.filter((c) => c.path === '/welcome/claim').length;

beforeEach(() => { X._reset(); W._setNowForTests(); });

test('an empty data folder is a new install', () => {
  const d = dir();
  assert.equal(W.isFreshDataDir(stores(d), join(d, 'snapshots')), true);
});

test('settings on disk, even unreadable ones, are not a new install', () => {
  const d = dir();
  writeFileSync(join(d, 'settings.json'), '{ not json');
  assert.equal(W.isFreshDataDir(stores(d), join(d, 'snapshots')), false);
});

test('settings gone from a folder with snapshots are not a new install', () => {
  const d = dir();
  mkdirSync(join(d, 'snapshots'));
  assert.equal(W.isFreshDataDir(stores(d), join(d, 'snapshots')), false);
});

test('a 4.x folder that lost its settings is not a new install: it has notes, or an install id', () => {
  for (const file of ['notes.json', 'install-id.json']) {
    const d = dir();
    writeFileSync(join(d, file), '{}');
    assert.equal(W.isFreshDataDir(stores(d), join(d, 'snapshots')), false, file);
  }
});

test('the claim sends its own hash of the install, not the one the activations use', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({ '/welcome/claim': { ok: true, code: CODE, until: 1, sparks: 30 }, '/ai/session': session(), '/ai/messages': reply() });
  await send(d);
  const claimed = calls.find((c) => c.path === '/welcome/claim').body.scopedId;
  assert.equal(claimed, await redeem.getScopedId(d, redeem.SCOPE_WELCOME));
  assert.notEqual(claimed, await redeem.getScopedId(d, redeem.SCOPE_DEVICES));
});

test('when the hub says no, the chat offers Sparks or a key instead of failing on every message', async () => {
  const d = dir();
  await W.markPending(d);
  let now = 1000;
  W._setNowForTests(() => now);
  const calls = hub({ '/welcome/claim': { ok: false, error: 'closed' } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.deepEqual(await X.balance(d), { ok: false, error: 'no_code' });
  assert.equal(await W.pending(d), true, 'the marker stays: it may open again');
  now += 11 * 60 * 1000;
  assert.deepEqual(await X.balance(d), { ok: false, error: 'no_code', welcome: true });
  assert.equal(claims(calls), 1);
});

test('a Sparks code typed in during the trial pays from the next round, with no restart', async () => {
  const d = dir();
  await W.markPending(d);
  const opened = [];
  hub({
    '/welcome/claim': { ok: true, code: CODE, until: 1, sparks: 30 },
    '/ai/session': (b) => { opened.push(b.code); return session(); },
    '/ai/messages': reply(),
  });
  await send(d);
  await wallet.saveTypedWalletCode(d, 'XC-MMMM-NNNN-PPPP');
  await send(d);
  assert.deepEqual(opened, [CANON, 'XCMMMMNNNNPPPP']);
});

test('the first message brings the code, and Bit answers it', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({
    '/welcome/claim': { ok: true, code: CODE, until: 1, sparks: 30 },
    '/ai/session': (b) => { assert.equal(b.code, CANON); return session(); },
    '/ai/messages': reply(),
  });
  const out = await send(d);
  assert.equal(out.text, 'hi');
  assert.equal(claims(calls), 1);
  assert.equal(await wallet.readWalletCode(d), CANON);
  assert.equal(await W.pending(d), false);
  assert.match(calls[0].body.scopedId, /^[0-9a-f]{16,}$/);
});

test('no marker, no claim: an update never asks', async () => {
  const d = dir();
  const calls = hub({ '/welcome/claim': { ok: true, code: CODE } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(claims(calls), 0);
});

test('a PC with a code never claims, even with the marker', async () => {
  const d = dir();
  await W.markPending(d);
  await wallet.saveTypedWalletCode(d, 'XC-MMMM-NNNN-PPPP');
  const calls = hub({ '/ai/session': session(), '/ai/messages': reply() });
  await send(d);
  assert.equal(claims(calls), 0);
});

test('reading the balance claims nothing: it only says the Sparks are on their way', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({ '/welcome/claim': { ok: true, code: CODE } });
  assert.deepEqual(await X.balance(d), { ok: false, error: 'no_code', welcome: true });
  assert.equal(claims(calls), 0);
  assert.equal(await X.hasCode(d), false);
});

test('the one-shot helpers never claim, so the days only start with a message to Bit', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({ '/welcome/claim': { ok: true, code: CODE } });
  await X.oneShot({ dataDir: d, systemText: 's', userText: 'u', maxTokens: 10 }).catch(() => {});
  assert.equal(claims(calls), 0);
  assert.equal(await W.pending(d), true);
});

test('used is final: the marker goes and the chat is one with no code', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({ '/welcome/claim': { ok: false, error: 'used' } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(await W.pending(d), false);
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(claims(calls), 1);
});

test('closed or offline keeps the marker and waits before asking again', async () => {
  const d = dir();
  await W.markPending(d);
  let now = 1000;
  W._setNowForTests(() => now);
  const calls = hub({ '/welcome/claim': { ok: false, error: 'closed' } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(claims(calls), 1);
  assert.equal(await W.pending(d), true);
  now += 11 * 60 * 1000;
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(claims(calls), 2);

  redeem._setTransport(async () => { throw new Error('offline'); });
  now += 11 * 60 * 1000;
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(await W.pending(d), true);
});

test('two messages at once make one claim', async () => {
  const d = dir();
  await W.markPending(d);
  const calls = hub({
    '/welcome/claim': { ok: true, code: CODE },
    '/ai/session': session(),
    '/ai/messages': reply(),
  });
  await Promise.all([send(d), send(d)]);
  assert.equal(claims(calls), 1);
});

test('a malformed answer saves nothing and keeps the marker', async () => {
  const d = dir();
  await W.markPending(d);
  hub({ '/welcome/claim': { ok: true, code: '../../evil' } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(await wallet.readWalletCode(d), '');
  assert.equal(await W.pending(d), true);
});

test('when the hub says they ended, the code is forgotten and this PC has none', async () => {
  const d = dir();
  await wallet.saveTypedWalletCode(d, CODE);
  hub({ '/ai/session': { ok: false, error: 'welcome_over' } });
  await assert.rejects(send(d), (e) => e.code === 'no_code');
  assert.equal(await wallet.readWalletCode(d), '');
  assert.deepEqual(await X.balance(d), { ok: false, error: 'no_code' });
});

test('the balance passes the end date on, and never the code', async () => {
  const d = dir();
  await wallet.saveTypedWalletCode(d, CODE);
  hub({
    '/ai/session': session(),
    '/ai/balance': { ok: true, balance: 30, included: 0, topup: 30, monthly: 0, wallet: true, welcomeUntil: 1700000000 },
  });
  const out = await X.balance(d);
  assert.equal(out.welcomeUntil, 1700000000);
  assert.ok(!JSON.stringify(out).includes(CANON));
});

test('a code that is not a number of seconds does not reach the screen', async () => {
  const d = dir();
  await wallet.saveTypedWalletCode(d, CODE);
  hub({ '/ai/session': session(), '/ai/balance': { ok: true, balance: 30, welcomeUntil: 'soon' } });
  assert.equal('welcomeUntil' in await X.balance(d), false);
});

test('the marker is a local file, not a setting that travels', async () => {
  const d = dir();
  await W.markPending(d);
  assert.ok(existsSync(join(d, 'welcome-sparks.json')));
  assert.ok(!engineSource().includes("welcomeSparks: "));
});

test('server and dashboard seed the same tabs: Playback with the Agenda', () => {
  const seeded = /'media-group': Object\.freeze\(\{ id: 'media-group', members: Object\.freeze\(\['media', 'agenda'\]\)/;
  assert.match(engineSource(), seeded);
  assert.match(read('../js/settings.js'), seeded);
});

test('a saved layout with no groups keeps the chat in its tab, on both sides', () => {
  for (const file of ['../server.js', '../js/settings.js']) {
    const src = file === '../server.js' ? engineSource() : read(file);
    assert.match(src, /LEGACY_SEEDED_GROUPS = Object\.freeze[\s\S]{0,160}members: Object\.freeze\(\['media', 'chat'\]\)/);
    assert.match(src, /source\.groups !== undefined \? source\.groups : \(source\.widgets \? LEGACY_SEEDED_GROUPS : DEFAULT_DASHBOARD_LAYOUT\.groups\)/);
  }
});

test('the layout version stays: a bump would replace every saved dashboard', () => {
  assert.match(read('../js/settings.js'), /const DASHBOARD_LAYOUT_VERSION = 6;/);
});

test('only the first start moves a PC to Bit: the plain default stays Gemini', () => {
  const src = engineSource();
  assert.match(src, /aiProvider: 'gemini', \/\/ 'gemini'/);
  assert.match(src, /if \(!FRESH_INSTALL\) return;/);
  assert.equal(src.split("aiProvider: 'xenon'").length - 1, 1);
});

test('every language has the strings, and no line mentions a Chat tab any more', () => {
  const src = appStringsSource();
  assert.equal(src.split(/\bbit_welcome_until"?:/).length - 1, 11);
  assert.equal(src.split('{date}').length - 1 >= 11, true);
  const bodies = src.split('\n').filter((l) => /onb_ai_body"?:/.test(l));
  assert.equal(bodies.length, 11);
  bodies.forEach((l) => assert.ok(!/Chat tab|scheda Chat|Chat-Tab|pestaña Chat|onglet Chat|separador Chat|tabblad Chat/.test(l), l));
});

test('a new install starts on the model the trial can pay for, and the plain default stays', () => {
  const src = engineSource();
  assert.match(src, /writeHubSettings\(\{ \.\.\.DEFAULT_HUB_SETTINGS, aiProvider: 'xenon', xenonModel: 'haiku' \}\)/);
  assert.match(src, /^ {2}xenonModel: 'sonnet',/m);
});

test('trial Sparks are never "running low", only out', () => {
  const body = read('../js/xenon-credits.js').match(/function level\(\) \{[\s\S]*?\n {2}\}/)[0];
  const level = (state) => vm.runInNewContext(`${body}\nlevel();`, { state, LOW_CREDITS: 80 });
  assert.equal(level({ status: 'ok', balance: 30, welcomeUntil: 1700000000 }), 'ok');
  assert.equal(level({ status: 'ok', balance: 1, welcomeUntil: 1700000000 }), 'ok');
  assert.equal(level({ status: 'ok', balance: 0, welcomeUntil: 1700000000 }), 'empty');
  assert.equal(level({ status: 'ok', balance: 30, welcomeUntil: 0 }), 'low');
});
