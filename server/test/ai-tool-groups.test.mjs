// Bit's tools by group (ai-tool-groups.js): the core goes on every turn, the rest
// arrives when a request needs it, and no turn ever passes the 128 tools the hub
// and OpenAI accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../ai-tool-groups.js');

const fn = (name) => ({ name, description: name, parameters: { type: 'OBJECT', properties: {} } });
const grouped = Object.values(G.GROUPS).flatMap((g) => g.tools);
const core = ['toggle_mic', 'get_weather', 'set_lights'];
const all = () => core.concat(grouped).map(fn);
const names = (list) => list.map((t) => t.name);

test('every group is small enough for the cache lookback, and no tool sits in two groups', () => {
  for (const [id, g] of Object.entries(G.GROUPS)) {
    assert.ok(g.tools.length > 0 && g.tools.length <= G.GROUP_MAX, id);
    assert.ok(typeof g.about === 'string' && g.about.length > 10, id);
  }
  assert.equal(new Set(grouped).size, grouped.length);
});

test('a turn with no groups gets the core plus use_tools, nothing of the groups', () => {
  const kit = G.kit(all(), []);
  assert.deepEqual(names(kit.tools), core.concat('use_tools'));
  assert.deepEqual(kit.groups(), []);
});

test('use_tools adds the group to the same list, once, and says what came', async () => {
  const kit = G.kit(all(), []);
  const list = kit.tools;
  const out = await kit.call('use_tools', { group: 'recording' }, () => assert.fail('not a real tool'));
  assert.equal(out.fnResult.ok, true);
  assert.deepEqual(out.fnResult.tools, G.GROUPS.recording.tools);
  assert.equal(kit.tools, list, 'the loops read the same array each round');
  assert.deepEqual(names(list).slice(core.length + 1), G.GROUPS.recording.tools);
  const again = await kit.call('use_tools', { group: 'recording' }, () => null);
  assert.equal(again.fnResult.already, true);
  assert.equal(list.length, core.length + 1 + G.GROUPS.recording.tools.length);
  assert.deepEqual(kit.groups(), ['recording']);
  const bad = await kit.call('use_tools', { group: 'nope' }, () => null);
  assert.equal(bad.fnResult.error, 'unknown_group');
  assert.deepEqual(bad.fnResult.groups, Object.keys(G.GROUPS));
});

test('the groups a conversation already loaded come back in the order they were loaded', () => {
  const kit = G.kit(all(), ['games', 'capture', 'games', 'bogus', 7]);
  assert.deepEqual(kit.groups(), ['games', 'capture']);
  assert.deepEqual(names(kit.tools).slice(core.length + 1), G.GROUPS.games.tools.concat(G.GROUPS.capture.tools));
});

test('a tool of a group not loaded yet still runs, and loads its group', async () => {
  const kit = G.kit(all(), []);
  let ran = '';
  await kit.call('record_screen', { a: 1 }, () => { ran = 'record_screen'; return { fnResult: { ok: true } }; });
  assert.equal(ran, 'record_screen');
  assert.deepEqual(kit.groups(), ['recording']);
});

test('loading past the cap drops the oldest group, never the core', async () => {
  const many = core.concat(Array.from({ length: 100 }, (_, i) => 'core_' + i)).concat(grouped).map(fn);
  const kit = G.kit(many, []);
  for (const id of Object.keys(G.GROUPS)) await kit.call('use_tools', { group: id }, () => null);
  assert.ok(kit.tools.length <= G.TOOL_CAP, String(kit.tools.length));
  assert.ok(names(kit.tools).includes('core_99') && names(kit.tools).includes('use_tools'));
  const last = Object.keys(G.GROUPS).pop();
  assert.ok(kit.groups().includes(last), 'the newest group stays');
  assert.ok(!kit.groups().includes(Object.keys(G.GROUPS)[0]), 'the oldest went');
});

test('Voice Live, whose tools are fixed at setup: core first, then whole groups up to the cap', () => {
  const many = core.concat(Array.from({ length: 90 }, (_, i) => 'core_' + i)).concat(grouped).map(fn);
  const live = G.forLive(many);
  assert.ok(live.length <= G.TOOL_CAP);
  assert.ok(!names(live).includes('use_tools'));
  assert.ok(names(live).includes('core_89'));
  for (const g of Object.values(G.GROUPS)) {
    const has = g.tools.filter((n) => names(live).includes(n)).length;
    assert.ok(has === 0 || has === g.tools.length, 'whole groups only');
  }
});

test('cleanGroups keeps only known ids, once each', () => {
  assert.deepEqual(G.cleanGroups(['capture', 'capture', 'x', null, 'games']), ['capture', 'games']);
  assert.deepEqual(G.cleanGroups('capture'), []);
  assert.deepEqual(G.cleanGroups(undefined), []);
});

test('follow converts the list again only after it grew', () => {
  const list = [fn('a')];
  let runs = 0;
  const now = G.follow(list, (l) => { runs++; return l.map((t) => t.name); });
  assert.deepEqual(now(), ['a']);
  assert.deepEqual(now(), ['a']);
  list.push(fn('b'));
  assert.deepEqual(now(), ['a', 'b']);
  assert.equal(runs, 2);
});

// The real list, read from server.js: the core, memory, the per-turn extras
// (Genesis, Guardian, PC control), the integrations, the capability tools and
// the Vitals tools. A new tool lands in the core unless it joins a group, and
// this is what says when the core has grown too big for that.
function realToolNames() {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const body = (head) => { const a = src.indexOf(head); assert.ok(a >= 0, head); return src.slice(a, src.indexOf('\n}', a)); };
  const turn = src.slice(src.indexOf('const AI_FUNCTIONS = buildCoreAiFunctions();'), src.indexOf('const toolKit = AiToolGroups.kit('));
  const parts = [body('function buildCoreAiFunctions('), body('function buildMemoryFunctions('), turn, body('async function addIntegrationAiFunctions(')];
  const literal = parts.flatMap((p) => [...p.matchAll(/name: '([a-z_0-9]+)',\s*description:/g)].map((m) => m[1]));
  const caps = require('../capabilities').aiFunctions({}).map((t) => t.name);
  const vitals = require('../vitals-ai-tools').FUNCTIONS.map((t) => t.name);
  return literal.concat(caps, vitals);
}

test('the real tool list: every grouped name exists, and the worst turn stays within the cap', () => {
  const real = realToolNames();
  assert.ok(real.length > 100, 'the extraction found the tools (' + real.length + ')');
  for (const name of Object.values(G.GROUPS).flatMap((g) => g.tools)) assert.ok(real.includes(name), name + ' is no tool any more');
  const kit = G.kit(real.map(fn), []);
  const biggest = Math.max(...Object.values(G.GROUPS).map((g) => g.tools.length));
  assert.ok(kit.tools.length + biggest <= G.TOOL_CAP,
    'core ' + kit.tools.length + ' + the biggest group ' + biggest + ' passes ' + G.TOOL_CAP + ': put new tools in a group');
});

test('the Anthropic loop (Sparks, Claude) sends a group from the round after use_tools', async () => {
  const anthropic = require('../ai-anthropic.js');
  const kit = G.kit(all(), []);
  const sent = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'use_tools', input: { group: 'games' } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'run_benchmark', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ];
  const ran = [];
  const out = await anthropic.chat({
    model: 'x', geminiTools: kit.tools, history: [{ role: 'user', parts: [{ text: 'bench' }] }], systemText: 's',
    post: async (body) => { sent.push(body.tools.map((t) => t.name)); return replies.shift(); },
    executeTool: (name, args) => kit.call(name, args, async () => { ran.push(name); return { fnResult: { ok: true }, clientActions: [] }; }),
  });
  assert.equal(out.text, 'done');
  assert.ok(!sent[0].includes('run_benchmark'));
  assert.ok(sent[1].includes('run_benchmark') && sent[2].includes('run_benchmark'));
  assert.deepEqual(ran, ['run_benchmark']);
  assert.deepEqual(kit.groups(), ['games']);
});

test('the Deck action catalog stays in the core, since run_deck_action looks action types up in it', () => {
  const grouped = Object.values(G.GROUPS).flatMap((g) => g.tools);
  for (const name of ['deck_action_catalog', 'run_deck_action', 'capture_screen', 'set_lights', 'xenon_knowledge']) assert.ok(!grouped.includes(name), name);
});
