// The person talking with Bit in the chat or by voice (js/ai/ai-bit-chat.js, POST /api/bit/talk): every other
// Bit listens, thinks and talks with it, on the dashboard (moments.js rest()), the pump's screen
// (elsewhere.js) and a widget's Bit (the SDK `bit` stream's `doing`), then goes back to what it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const sse = require('../http/sse-clients.js');
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('POST /api/bit/talk tells every surface one of the talk states, and refuses anything else', async () => {
  const { routes, stop } = require('../bit/routes.js');
  const sent = [];
  const client = { writableLength: 0, write: (p) => sent.push(p) };
  sse.sseClients.add(client);
  const ask = async (body) => {
    let said = null;
    await routes['POST /api/bit/talk']({}, {}, { json: (o) => { said = o; }, readBody: async () => body }, {});
    return said;
  };
  try {
    for (const state of ['listen', 'think', 'talk', '']) assert.deepEqual(await ask(JSON.stringify({ state })), { ok: true }, state);
    assert.deepEqual(sent, ['listen', 'think', 'talk', ''].map((state) => `event: bit_talk\ndata: ${JSON.stringify({ state })}\n\n`));
    for (const bad of [JSON.stringify({ state: 'dance' }), JSON.stringify({ state: 7 }), JSON.stringify({}), 'not json']) {
      assert.deepEqual(await ask(bad), { ok: false, error: 'bad_request' }, bad);
    }
    assert.equal(sent.length, 4, 'nothing told for a refused one');
  } finally {
    sse.sseClients.delete(client);
    stop();
  }
  assert.ok(engineSource().includes("'/api/bit/seen', '/api/bit/talk',"), 'in CSRF_MUTATION_PATHS');
});

test('the chat tells it once per change, and only the states other Bits can do', () => {
  const chat = src('../js/ai/ai-bit-chat.js');
  assert.match(chat, /const TALK_OF = \{ think: 'think', work: 'think', listen: 'listen', talk: 'talk' \};/);
  assert.match(chat, /if \(state === told \|\| typeof SERVER !== 'string'\) return;/);
  for (const fn of ['function setStatus', 'function typing', 'function voiceState']) {
    const body = chat.slice(chat.indexOf(fn), chat.indexOf('\n  }\n', chat.indexOf(fn)));
    assert.ok(body.includes('tellOthers(mood)'), fn);
  }
});

function pumpPage() {
  const clock = { now: 1e12 };
  const window = { Date: { now: () => clock.now }, Xenon: { bitSigns: require('../../packages/core/src/bit-signs.js') }, localStorage: { getItem: () => null, setItem() {} } };
  Object.assign(window, { window, dispatchEvent() {}, addEventListener() {}, CustomEvent: class {}, setTimeout: () => 0, clearTimeout() {} });
  vm.createContext(window);
  for (const f of ['../js/bit-companion/signals.js', '../js/bit-companion/elsewhere.js']) vm.runInContext(src(f), window);
  const fns = new Map();
  window.BitElsewhere.listen({ addEventListener: (name, fn) => fns.set(name, fn) });
  return { clock, B: window.BitElsewhere, send: (name, d) => fns.get(name)?.({ data: JSON.stringify(d) }) };
}

test('on the pump it talks first of all, then goes back to what it did; a talk never ended lets go', () => {
  const { clock, B, send } = pumpPage();
  send('status', { gaming: true });
  assert.equal(B.rest(), 'gamer');
  for (const state of ['listen', 'think', 'talk']) {
    send('bit_talk', { state });
    assert.equal(B.rest(), state);
  }
  send('bit_talk', { state: '<b>' });
  assert.equal(B.rest(), 'gamer', 'an unknown state is the end of the talk');
  send('bit_talk', { state: 'think' });
  clock.now += 119000;
  assert.equal(B.rest(), 'think');
  clock.now += 2000;
  assert.equal(B.rest(), 'gamer', 'after two minutes without news');
});

test('every rest a widget can be told is a clip of the kit, and the dashboard rests on the same list', () => {
  const X = require('../../packages/core/src/bit.js');
  const kit = src('../js/bit-companion/kit-api.js');
  const moments = src('../js/bit-companion/moments.js');
  const readers = src('../js/custom-widget/stream-readers.js');
  const list = "['idle', 'code', 'gamer', 'tell', 'listen', 'think', 'talk']";
  assert.ok(kit.includes(`const RESTS = ${list};`));
  assert.ok(moments.includes(`const RESTS = ${list};`));
  assert.ok(readers.includes(`const BIT_DOING = ${list};`));
  for (const id of ['listen', 'think', 'talk', 'code', 'gamer', 'tell']) assert.ok(X.clip(id), id);
});
