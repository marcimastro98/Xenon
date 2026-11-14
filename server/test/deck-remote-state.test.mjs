import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

// Keeping the remote state fresh starts programs on the PC, so main.js only asks for
// it while a Deck key shows it. These run that block of main.js as the page does,
// on a fake Deck, clock and server.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = read('../js/main.js');
const block = main.slice(main.indexOf('// ── Remote state for Deck live-state keys'), main.indexOf('// ── Init app favorites buttons'));
const settled = () => new Promise((resolve) => { setImmediate(resolve); });
const TOOLS = { installed: { sunshine: false, tailscale: true }, ready: true, blocked: false, connectedClients: ['phone'] };

async function page({ panel = 'full', shown = true, hidden = false, status = TOOLS } = {}) {
  const live = { shown, hidden, status, asked: 0, states: [], sources: [] };
  let tick = null;
  const window = {
    Deck: {
      usesState(sources) { live.sources = [...sources]; return live.shown; },
      refreshStates(states) { live.states.push({ ...states }); },
    },
  };
  const document = { get hidden() { return live.hidden; } };
  const fetch = async (url) => {
    assert.equal(url, '/remote/status');
    live.asked++;
    if (!live.status) throw new Error('offline');
    return { ok: true, json: async () => live.status };
  };
  const setInterval = (fn, ms) => { assert.equal(ms, 15000); tick = fn; };
  vm.runInNewContext(block, { activePanel: panel, window, document, fetch, setInterval });
  await settled();
  return { live, hasTick: () => !!tick, tick: async () => { tick(); await settled(); } };
}

test('no key shows the remote state: nothing is asked, at load or later', async () => {
  const p = await page({ shown: false });
  await p.tick();
  await p.tick();
  assert.equal(p.live.asked, 0);
  assert.deepEqual(p.live.sources, ['remoteConnected', 'remoteActive']);
});

test('a key that shows it gets the state at load and on every tick', async () => {
  const p = await page();
  assert.equal(p.live.asked, 1);
  assert.deepEqual(p.live.states, [{ remoteConnected: true, remoteActive: true }]);
  await p.tick();
  assert.equal(p.live.asked, 2);
});

test('a key added later starts it on the next tick', async () => {
  const p = await page({ shown: false });
  p.live.shown = true;
  await p.tick();
  assert.equal(p.live.asked, 1);
});

test('a hidden tab asks nothing until it shows again', async () => {
  const p = await page({ hidden: true });
  await p.tick();
  assert.equal(p.live.asked, 0);
  p.live.hidden = false;
  await p.tick();
  assert.equal(p.live.asked, 1);
});

test('a PC with neither tool is asked once, then left alone', async () => {
  const p = await page({ status: { installed: { sunshine: false, tailscale: false }, connectedClients: [] } });
  assert.equal(p.live.asked, 1);
  assert.deepEqual(p.live.states, [{ remoteConnected: false, remoteActive: false }]);
  await p.tick();
  assert.equal(p.live.asked, 1);
});

test('a failed answer says nothing about the tools, so the next tick asks again', async () => {
  const p = await page({ status: null });
  assert.equal(p.live.asked, 1);
  p.live.status = TOOLS;
  await p.tick();
  assert.equal(p.live.asked, 2);
  assert.equal(p.live.states.length, 1);
});

test('a single-panel embed never hosts a Deck, so it never polls', async () => {
  const p = await page({ panel: 'media' });
  assert.equal(p.hasTick(), false);
  assert.equal(p.live.asked, 0);
});

test('the Deck answers for every instance in the store, not only the one on screen', () => {
  assert.match(read('../js/deck.js'), /function usesState\(sources\) \{\n\s+const all = readStore\(\);\n\s+return Object\.keys\(all\)\.some\(\(id\) => window\.DeckStore\.isInstanceKey\(id\) && window\.DeckModel\.deckUsesState\(all\[id\], sources\)\);/);
  assert.match(read('../js/deck.js'), /window\.Deck = \{[^}]*\busesState\b/);
});
