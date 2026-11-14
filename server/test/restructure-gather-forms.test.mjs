// Two shapes `gather` (tools/restructure) used to refuse outright: a property written out with the
// variable's own name (`name: name`), and a variable that is called. The first is rewritten and put
// back exactly; the second is gathered only when every value it is ever given is proven to be a
// function that ignores `this`, and is left a `let` otherwise.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { calledProblems, createFunctionCheck } from '../../tools/restructure/gather-called.mjs';
import { planGather } from '../../tools/restructure/gather-plan.mjs';
import { proveGather } from '../../tools/restructure/gather-proof.mjs';
import { undoGatherText } from '../../tools/restructure/gather-undo.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const SOURCE_FILE = 'server/demo.js';
const file = (...lines) => [...lines, ''].join('\n');
// A factory with these lines as its body.
const thing = (...body) => file("'use strict';", 'function createThing(runner) {', ...body, '}', 'module.exports = { createThing };');
const plan = (text, more = {}) => planGather({ text, parser, source: SOURCE_FILE, factory: 'createThing', object: 'memory', ...more });
const refusal = (text, more) => {
  try { plan(text, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveGather({ before: text, after: made.newSource, plan: made, parser, source: SOURCE_FILE }).join('\n');
const undone = (made) => undoGatherText(made.newSource, { object: 'memory', names: made.names, kept: made.kept, bare: made.bare });

// Runs both texts for real and gives what `use` reads off each.
function ran(texts, use) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-gather-forms-'));
  try {
    const load = createRequire(join(dir, 'x.js'));
    return texts.map((text, index) => {
      writeFileSync(join(dir, `thing${index}.js`), text);
      return use(load(`./thing${index}.js`).createThing);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a property named like the variable whose value only starts with it is a plain use', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = thing('  let limits = null;', '  function set(next) { limits = next; }',
    '  function view(t) { return { limits: limits ? { ...limits, age: t - limits.at } : null, at: t }; }', '  return { set, view };');
  const made = plan(text);
  assert.ok(made.newSource.includes('{ limits: memory.limits ? { ...memory.limits, age: t - memory.limits.at } : null, at: t }'));
  assert.deepEqual(made.long, []);
  assert.equal(proven(text, made), '');
  assert.equal(undone(made), text, 'the tests that read the code as text get the old text back');
  const use = (create) => { const made = create(); const first = made.view(5); made.set({ at: 2 }); return [first, made.view(5)]; };
  const [old, now] = ran([text, made.newSource], use);
  assert.deepEqual(now, old);
  assert.deepEqual(now, [{ limits: null, at: 5 }, { limits: { at: 2, age: 3 }, at: 5 }]);
});

test('`name: name` written out is rewritten in place and put back as it was, next to the short `{ name }`', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = thing('  let limits = 1;', '  let label = 2;', '  function view() { return { label, limits: limits, n: [{ limits }, { limits: limits }] }; }',
    '  function take(from) { ({ limits: limits = 5, label: label } = from); return limits + label; }', '  return { view, take };');
  const made = plan(text);
  assert.ok(made.newSource.includes('return { label: memory.label, limits: memory.limits, n: [{ limits: memory.limits }, { limits: memory.limits }] };'));
  assert.ok(made.newSource.includes('({ limits: memory.limits = 5, label: memory.label } = from); return memory.limits + memory.label;'));
  assert.deepEqual(made.long, [1, 3, 4, 5], 'which of the six written-out properties were written out before');
  assert.equal(proven(text, made), '');
  assert.match(proven(text, { ...made, long: [1, 3, 4] }), /undoing the rewrite does not give the old file back byte for byte/);
  assert.match(proven(text, { ...made, long: [] }), /undoing the rewrite does not give the old file back byte for byte/);
  assert.equal(undone(made), text.replaceAll('limits: limits', 'limits').replace('label: label', 'label'),
    'the tests that read the code as text see the short way, which means the same');
  const use = (create) => { const made = create(); return [made.view(), made.take({ label: 7 }), made.view()]; };
  const [old, now] = ran([text, made.newSource], use);
  assert.deepEqual(now, old);
  assert.deepEqual(now[2], { label: 7, limits: 5, n: [{ limits: 5 }, { limits: 5 }] });
});

test('a short `{ name }` with something between it and what follows is refused: undone, it could not be found', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = thing('  let limits = 1;', '  return { view: () => ({ limits /* now */ }) };');
  assert.match(refusal(text), /server\/demo\.js:4: something stands between the short `\{ limits \}` and the comma, the \} or the first value after it/);
});

test('a called variable is gathered when every value it is given is a function written there that ignores `this`', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = thing('  let run = function first() { return 1; };', "  let stop = runner.bind(null, 'stop');",
    "  function swap() { run = function second(a) { return a * 2; }; stop = (runner).bind({ own: true }, 'again'); }",
    '  return { go: () => run(21), halt: () => stop(), swap };');
  const made = plan(text);
  assert.deepEqual([made.names, made.left], [['run', 'stop'], []]);
  assert.ok(made.newSource.includes('return { go: () => memory.run(21), halt: () => memory.stop(), swap };'));
  assert.equal(proven(text, made), '');
  const use = (create) => {
    const made = create(function seen(word) { return [word, this === null ? 'null' : Object.keys(this ?? {}).join()]; });
    const first = [made.go(), made.halt()];
    made.swap();
    return [first, made.go(), made.halt()];
  };
  const [old, now] = ran([text, made.newSource], use);
  assert.deepEqual(now, old);
  assert.deepEqual(now, [[1, ['stop', 'null']], 42, ['again', 'own']]);
});

test('a called variable named for gathering is refused with the value or the write that is not proven', (t) => {
  if (!parser) return t.skip(SKIP);
  const called = (why) => new RegExp(`cb \\(server/demo\\.js:\\d+\\) is called: as memory\\.cb\\(\\) the function would get memory as \`this\`, and ${why}`);
  const cases = [
    [['  let cb = null;', '  return () => cb();'], called('it can hold nothing: called then, the error would name the property and not the variable')],
    [['  let cb;', '  return { set() { cb = function a() {}; }, fire: () => cb() };'], called('it can hold nothing')],
    [['  let cb = function a() { return 1; };', '  return { off() { cb = undefined; }, fire: () => cb() };'], called('it can hold nothing')],
    [['  let cb = function a() { return this; };', '  return () => cb();'], called('it is given a function that reads `this`, `arguments` or eval')],
    [['  let cb = function a() { return arguments.length; };', '  return () => cb();'], called('it is given a function that reads `this`')],
    [['  let cb = function a() { return () => this; };', '  return () => cb();'], called('it is given a function that reads `this`')],
    [['  let cb = function a() {};', '  return { set(fn) { cb = fn; }, fire: () => cb() };'], called('it is given `fn`, which is not a function written there: what it holds is not known')],
    [['  let cb = runner;', '  return () => cb();'], called('it is given `runner`, which is not a function written there')],
    [['  let cb = function a() {};', '  return { set() { cb = runner(); }, fire: () => cb() };'], called('it is given `runner\\(\\)`, which is not a function written there')],
    [['  let cb = function a() {};', '  return { set() { cb ||= function b() {}; }, fire: () => cb() };'], called('it is written in another way than `name = value`')],
    [['  let cb = function a() {};', '  return { set(list) { [cb] = list; }, fire: () => cb() };'], called('it is written in another way than `name = value`')],
    [['  let cb = function a() {};', '  return { set(from) { ({ cb } = from); }, fire: () => cb() };'], called('it is written in another way than `name = value`')],
    [['  let cb = function a() {};', '  return { set(list) { for (cb of list) break; }, fire: () => cb() };'], called('it is written in another way than `name = value`')],
    [['  let cb = function a() {};', '  return { fire: () => cb`x` };'], /^$/],
    [['  let cb = function a() {};', '  return { set() { cb = () => 2; }, fire: () => cb() };'], /cb \(server\/demo\.js:4\) is given a function without a name of its own/],
  ];
  for (const [body, reason] of cases) assert.match(refusal(thing(...body), { names: ['cb'] }), reason, body.join(' | '));
});

test('when every let is meant, a called variable that is not proven stays a let, and the others are gathered', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = thing('  let calls = 0;', '  let cb = null;', '  function set(fn) { cb = fn; }', '  function fire() { calls += 1; return cb ? cb(calls) : calls; }',
    '  return { set, fire };');
  const made = plan(text);
  assert.deepEqual(made.names, ['calls']);
  assert.equal(made.left.length, 1);
  assert.equal(made.left[0].name, 'cb');
  assert.match(made.left[0].why, /^cb \(server\/demo\.js:6\) is called: as memory\.cb\(\) the function would get memory as `this`, and it can hold nothing/);
  assert.ok(made.newSource.includes('  let cb = null;\n  function set(fn) { cb = fn; }\n  function fire() { memory.calls += 1; return cb ? cb(memory.calls) : memory.calls; }'));
  assert.equal(proven(text, made), '');
  const [old, now] = ran([text, made.newSource], (create) => { const made = create(); const first = made.fire(); made.set((n) => n * 10); return [first, made.fire()]; });
  assert.deepEqual([now, old], [[1, 20], [1, 20]]);

  assert.match(refusal(thing('  let cb = null;', '  return () => cb();')), /cb \(server\/demo\.js:4\) is called: as memory\.cb\(\) the function would get memory as `this`/,
    'with nothing else to gather, the reason is the refusal');
});

test('the proof reads the new file on its own: a called property that can hold anything else is a problem', (t) => {
  if (!parser) return t.skip(SKIP);
  const check = createFunctionCheck(parser);
  const valueOf = (code) => parser.parse(`x = ${code};`, 'value.js').statements[0].expression.right;
  assert.deepEqual(['() => 1', '(() => this)', 'f.bind(null)', 'function a() { return 1; }'].map((code) => check(valueOf(code))), ['', '', '', '']);
  assert.match(check(valueOf('function a() { return eval("this"); }')), /reads `this`, `arguments` or eval/);
  assert.match(check(undefined), /it can hold nothing/);

  const held = (...body) => parser.parse(thing('  const memory = {', ...body), SOURCE_FILE);
  const ask = (tree, kept = []) => calledProblems({ tree, parser, object: 'memory', names: ['cb', 'calls'], kept });
  assert.deepEqual(ask(held('    cb: function a() { return 1; },', '    calls: 0,', '  };', '  return () => memory.cb(memory.calls);')), []);
  assert.deepEqual(ask(held('    cb: null,', '    calls: 0,', '  };', '  function set(fn) { memory.cb = fn; memory.calls = fn; }', '  return { set, fire: () => memory.cb() };')), [
    'memory.cb is called, and it can hold nothing: called then, the error would name the property and not the variable',
    'memory.cb is called, and it is given `fn`, which is not a function written there: what it holds is not known',
  ]);
  const later = held('    cb: undefined, // given its first value further down, where it was declared', '    calls: 0,', '  };',
    "  memory.cb = runner.bind(null, 'x');", '  return () => memory.cb();');
  assert.deepEqual(ask(later, ['cb']), [], 'a first value given further down is the first write');
  assert.equal(ask(later).length, 1);
  assert.deepEqual(ask(held('    cb: function a() {},', '    calls: 0,', '  };', '  return { fire: () => memory.cb(), bump: () => { memory.cb &&= function b() {}; } };')),
    ['memory.cb is called, and it is written in another way than `name = value`']);
});
