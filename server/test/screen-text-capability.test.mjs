// capabilities/screen-text.js: "Copy text from screen" for the Deck and Bit.
// Pinned here: the text never rides in the action's result (a phone can press
// the key), only the AI turn reads it, once and only while fresh; the toast
// gets a count, never the text; a picker already open answers "picking" for a
// screenshot too; the engine's errors the user can act on keep their code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const screenText = require('../capabilities/screen-text.js');
const shot = require('../capabilities/screenshot.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SECRET = 'Fattura 4821\ntotale 1.250,40 euro';

function deps({ reply = { ok: true, text: SECRET, copied: true, lang: 'it-IT' }, wait = null } = {}) {
  const log = { requests: [], opts: [], told: [] };
  const capture = {
    host: {
      available: () => true,
      request: async (cmd, body, opts) => {
        log.requests.push({ cmd, body });
        log.opts.push(opts);
        if (wait) await wait;
        return typeof reply === 'function' ? reply() : reply;
      },
    },
    textHint: async () => 'Drag over the text',
    onText: (r) => log.told.push(r),
  };
  return { d: { capture }, log };
}

test('an area by default: the hint goes with it, the long wait, a count back and no text', async () => {
  const { d, log } = deps();
  const r = await screenText.run(d, {});
  assert.deepEqual(log.requests, [{ cmd: 'ocr', body: { target: 'region', hint: 'Drag over the text' } }]);
  assert.equal(log.opts[0].timeoutMs, 150000);
  assert.deepEqual(r, { ok: true, lines: 2, chars: SECRET.length, copied: true });
  assert.ok(!JSON.stringify(r).includes('4821'), 'the text is not in the result');
  assert.deepEqual(log.told, [{ lines: 2, copied: true }], 'the toast hears a count');
  screenText.takeText();
});

test('the window and the screen are read without a picker or a hint', async () => {
  for (const target of ['window', 'screen']) {
    const { d, log } = deps();
    await screenText.run(d, { target });
    assert.deepEqual(log.requests, [{ cmd: 'ocr', body: { target } }]);
    assert.equal(log.opts[0], undefined, 'the normal timeout');
  }
  screenText.takeText();
});

test('the AI reads the text once, only while fresh, and long text is cut and says so', async () => {
  const { d } = deps();
  await screenText.run(d, { target: 'window' });
  assert.deepEqual(screenText.takeText(), { text: SECRET, cut: false });
  assert.equal(screenText.takeText(), null, 'a second read gets nothing');

  await screenText.run(d, { target: 'window' });
  assert.equal(screenText.takeText(Date.now() + screenText.KEEP_MS + 1), null, 'stale text is dropped');

  const long = 'x'.repeat(screenText.AI_TEXT_MAX + 50);
  await screenText.run(deps({ reply: { ok: true, text: long, copied: true } }).d, { target: 'window' });
  const read = screenText.takeText();
  assert.equal(read.text.length, screenText.AI_TEXT_MAX);
  assert.equal(read.cut, true);
});

test('no text: empty, nothing copied, the toast still hears it', async () => {
  const { d, log } = deps({ reply: { ok: true, text: '', copied: false } });
  const r = await screenText.run(d, { target: 'screen' });
  assert.deepEqual(r, { ok: true, lines: 0, chars: 0, copied: false, empty: true });
  assert.deepEqual(log.told, [{ lines: 0, copied: false }]);
  screenText.takeText();
});

test('Esc is not an error and tells nobody', async () => {
  const { d, log } = deps({ reply: { ok: true, cancelled: true } });
  assert.deepEqual(await screenText.run(d, {}), { ok: true, cancelled: true });
  assert.equal(log.told.length, 0);
  assert.equal(screenText.takeText(), null);
});

test('engine errors the user can act on keep their code, the rest are "failed"', async () => {
  for (const code of ['no_ocr_language', 'no_window', 'unsupported', 'too_large']) {
    const r = await screenText.run(deps({ reply: { ok: false, error: code } }).d, { target: 'window' });
    assert.deepEqual(r, { ok: false, error: code });
  }
  const r = await screenText.run(deps({ reply: { ok: false, error: 'ocr_failed' } }).d, { target: 'window' });
  assert.deepEqual(r, { ok: false, error: 'failed' });
  assert.deepEqual(await screenText.run({ capture: { host: { available: () => false } } }, {}), { ok: false, error: 'unavailable' });
});

test('one picker at a time across screenshots and text', async () => {
  let release;
  const wait = new Promise((r) => { release = r; });
  const text = deps({ wait });
  const first = screenText.run(text.d, { target: 'region' });
  assert.deepEqual(await screenText.run(deps().d, { target: 'region' }), { ok: true, picking: true });
  const shotDeps = { capture: { host: { available: () => true, request: async () => assert.fail('no capture behind the picker') }, store: () => ({}) } };
  assert.deepEqual(await shot.run(shotDeps, { target: 'screen' }), { ok: true, picking: true });
  release();
  assert.equal((await first).ok, true);
  screenText.takeText();
});

test('catalog: a sensitive capture key, the AI function, area first', () => {
  const cap = CAPABILITIES.find(c => c.type === 'screenText');
  assert.equal(cap.capability.risk, 'sensitive');
  assert.equal(cap.capability.requires, 'captureOcr');
  assert.equal(cap.params[0].options[0], 'region', 'an absent target is the area picker');
  const fns = aiFunctions({ capture: true });
  assert.ok(fns.some(f => f.name === 'read_screen_text'));
  assert.ok(!aiFunctions({ captureOcr: false }).some(f => f.name === 'read_screen_text'), 'hidden without the engine');
  assert.deepEqual(aiAction('read_screen_text', { target: 'window', extra: 1 }), { type: 'screenText', target: 'window' });
});

test('the registry routes the key to the capability', async () => {
  const { d, log } = deps();
  const caps = createCapabilities(d);
  const r = await caps.run({ type: 'screenText', target: 'window' });
  assert.equal(r.ok, true);
  assert.equal(log.requests[0].cmd, 'ocr');
  screenText.takeText();
});

test('server.js hands the text to the AI turn only, and the SSE carries a count', () => {
  const src = readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.match(src, /fnName === 'read_screen_text'[\s\S]{0,200}takeText\(\)/);
  // A picker already open answers "picking": the text kept then is an older read's.
  assert.match(src, /fnName === 'read_screen_text' && fnResult && fnResult\.ok === true && !fnResult\.cancelled && !fnResult\.picking\)/);
  assert.match(src, /onText: \(r\) => broadcastSSE\('capture', \{ kind: 'text', lines: r\.lines, copied: r\.copied === true \}\)/);
});
