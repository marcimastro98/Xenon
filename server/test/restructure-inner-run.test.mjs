// A run of a factory's body that leaves it whole (tools/restructure, `inner`, inner-constants.mjs): lines side by
// side, kept in their order, with the call of the new module standing where they stood. Each line is then worked
// out at the moment it was, so its value may be worked out (a call, a choice, names taken out of a value). Broken
// by a line that stays, or with the call anywhere else, every line is asked as before; `this`, `arguments` and a
// variable the factory keeps using are refused in a run too. The proof finds the run on its own.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { moveInner } from '../../tools/restructure/inner.mjs';
import { planInner } from '../../tools/restructure/inner-plan.mjs';
import { proveInner } from '../../tools/restructure/inner-proof.mjs';
import { PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const [SOURCE_FILE, TARGET, ABOUT] = ['server/demo.js', 'server/part/places.js', 'Where things are.'];
const file = (...lines) => [...lines, ''].join('\n');
const rewrite = (spec) => (spec.startsWith('.') ? { spec: `../${spec.slice(2)}`, kind: 'file', file: `server/${spec.slice(2)}` }
  : { spec: `node:${spec.replace(/^node:/, '')}`, kind: 'builtin', file: null });
// The factory opens on line 4: its body starts on line 5.
const thing = (...body) => file("'use strict';", "const { sep } = require('path');", '', 'function createThing(runner, limit) {', ...body, '}', '', 'module.exports = { createThing };');

const plan = (text, names) => planInner({ text, parser, source: SOURCE_FILE, target: TARGET, about: ABOUT, factory: 'createThing', make: 'makePlaces', names, rewrite });
const refusal = (text, names) => {
  try { plan(text, names); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (before, made, moduleText = made.moduleText, afterText = made.newSource) => proveInner({ before, after: afterText, moduleText, plan: made, parser,
  source: SOURCE_FILE, target: TARGET, factory: 'createThing', make: 'makePlaces' });

const RUN = ['home', 'big', 'x', 'where', 'last'];
const SOURCE = thing(
  "  const first = runner('first');",
  '  // Asked of the machine once.',
  '  const home = runner(sep);',
  '  const big = limit > 3 ? home : null;',
  '  const { x } = { x: [big] };',
  '  function where() { return [home, big, x, last]; }',
  '  const last = [runner(`last${sep}`)];',
  '',
  "  const then = runner('then');",
  '  return { where, first, home, last, then };',
);

test('lines side by side leave whole, worked-out values too, and the call stands where they stood', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, RUN);
  assert.deepEqual([made.moved, made.returned, made.passed], [RUN, ['home', 'where', 'last'], ['runner', 'limit']]);
  assert.match(made.newSource, /const first = runner\('first'\);\n {2}const \{ home, where, last \} = makePlaces\(\{ runner, limit \}\);\n\n {2}const then = /);
  assert.match(made.moduleText, / {2}\/\/ Asked of the machine once\.\n {2}const home = runner\(sep\);\n {2}const big = [^\n]+\n {2}const \{ x \} = [^\n]+\n {2}function where\(\)[^\n]+\n {2}const last = /);
  assert.deepEqual(proven(SOURCE, made), []);
});

test('the two files ask the same things in the same order as the one did', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, RUN);
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-run-'));
  try {
    mkdirSync(join(root, 'part'));
    writeFileSync(join(root, 'old.js'), SOURCE);
    writeFileSync(join(root, 'demo.js'), made.newSource);
    writeFileSync(join(root, 'part', 'places.js'), made.moduleText);
    const load = createRequire(join(root, 'x.js'));
    const run = (name, limit) => {
      const asked = [];
      const made1 = load(name).createThing((what) => { asked.push(what); return `${what}!`; }, limit);
      return { asked, where: made1.where(), home: made1.home, same: made1.where()[3] === made1.last };
    };
    for (const limit of [2, 5]) assert.deepEqual(run('./demo.js', limit), run('./old.js', limit));
    assert.equal(run('./demo.js', 5).asked.length, 4, 'first, the two of the run, then: each asked once, in that order');
    // A line of the run that throws stops the factory at the same point.
    const failing = (name) => {
      const asked = [];
      try { load(name).createThing((what) => { asked.push(what); if (what.startsWith('last')) throw new Error('no'); return what; }, 5); } catch (error) { asked.push(error.message); }
      return asked;
    };
    assert.deepEqual(failing('./demo.js'), failing('./old.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('broken by a line that stays, or with the call anywhere else, each line is asked as one worked out at another moment', (t) => {
  if (!parser) return t.skip(SKIP);
  const use = ['  function f() { return a; }', '  return { f };'];
  const variants = [
    // The line between them stays: the constant would be worked out before or after it, not where it was.
    [['  const a = runner();', '  const kept = runner();', '  function f() { return a; }', '  return { f, kept };'], ['a', 'f'], /a \(server\/demo\.js:5\) is not a value written out: it calls `runner\(\)`/],
    // What the function is handed is declared below the run: the call has to wait for it.
    [['  const a = runner();', '  function f() { return [a, late]; }', '  const late = [];', '  return { f, late };'], ['a', 'f'],
      /a \(server\/demo\.js:5\) is not a value written out: it calls `runner\(\)`[^\n]*\nside by side as they are, the lines could leave if the call of makePlaces stood where they stand \(server\/demo\.js:5\); it cannot/],
    // A line above the run may use a moved function: the call has to stand above that line.
    [['  const early = f();', '  const a = runner();', '  function f() { return 1; }', '  const b = [a];', '  return { early, f, b };'], ['a', 'f', 'b'],
      /a \(server\/demo\.js:6\) is not a value written out: it calls `runner\(\)`[^\n]*\nside by side as they are/],
    [['  const a = this.place;', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) says `this`, which is createThing's there and would be the new function's/],
    [['  const a = [() => this];', ...use], ['a', 'f'], /an arrow in it says `this`, which is createThing's/],
    [['  const a = new.target ? 1 : 2;', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) says `new\.target`, which is createThing's there/],
    [['  const a = [arguments.length, runner()];', ...use], ['a', 'f'], /a \(server\/demo\.js:5\) says `arguments` in an arrow, which is createThing's/],
    [['  let a = runner();', '  function f() { return a; }', '  return { f, now: () => a };'], ['a', 'f'], /a \(server\/demo\.js:5\) is a variable that line 7 of createThing uses too/],
    [['  const a = runner();', '  function reset() { a = null; }', '  return { reset };'], ['a', 'reset'], /a \(server\/demo\.js:5\) is assigned to in createThing/],
    // What a line of the run takes from the factory is still handed over once: a variable would not follow.
    [['  let n = 1;', '  const bump = () => { n += 1; };', '  const a = runner(n);', ...use.slice(0, 1), '  return { f, bump };'], ['a', 'f'], /a \(server\/demo\.js:7\) uses n, a variable of createThing that can be assigned again/],
  ];
  for (const [body, names, reason] of variants) assert.match(refusal(thing(...body), names), reason, body[0]);
  // The same lines with nothing in the way leave.
  assert.deepEqual(plan(thing('  const a = runner();', ...use), ['a', 'f']).moved, ['a', 'f']);
  // A variable only the run uses leaves with its worked-out first value.
  const counted = thing('  let n = runner();', '  function f() { n += 1; return n; }', '  return { f };');
  assert.deepEqual(proven(counted, plan(counted, ['n', 'f'])), []);
});

test('the proof finds the run on its own: the lines side by side, in their order, the call in their place', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, RUN);
  // The order inside the new function is not the order the lines had.
  const lines = made.moduleText.split('\n');
  const [big, taken] = [lines.findIndex((line) => line.startsWith('  const big =')), lines.findIndex((line) => line.startsWith('  const { x } ='))];
  const swapped = [...lines];
  [swapped[big], swapped[taken]] = [lines[taken], lines[big]];
  assert.notDeepEqual(proven(SOURCE, made, swapped.join('\n')), []);
  // The call stands below a line that stayed: said as written out when it was planned, worked out in the files.
  const apart = thing('  const a = [];', '  function f() { return [a, late]; }', '  const late = [];', '  return { f, late };');
  const planned = plan(apart, ['a', 'f']);
  assert.deepEqual(proven(apart, planned), []);
  const swap = (text) => text.replace('const a = [];', 'const a = runner();');
  assert.match(proven(swap(apart), planned, swap(planned.moduleText)).join('\n'), /a is not a value written out: it calls `runner\(\)`/);
  // A line that stays in the middle of what left.
  const middle = thing('  const a = [];', '  const kept = 1;', '  function f() { return a; }', '  return { f, kept };');
  const holed = plan(middle, ['a', 'f']);
  assert.match(proven(swap(middle), holed, swap(holed.moduleText)).join('\n'), /a is not a value written out: it calls `runner\(\)`/);
  // In a run, `this` is still refused by the proof.
  const whole = thing('  const a = [];', '  function f() { return a; }', '  return { f };');
  const run = plan(whole, ['a', 'f']);
  const mine = (text) => text.replace('const a = [];', 'const a = this.place;');
  const asks = (text) => text.replace('const a = [];', 'const a = process.cwd();');
  assert.deepEqual(proven(asks(whole), run, asks(run.moduleText)), [], 'side by side with the call in place, a call is a value like another');
  assert.match(proven(mine(whole), run, mine(run.moduleText)).join('\n'), /a says `this`, which is createThing's there/);
});

test('the command records the step and verify redoes it from the base', (t) => {
  if (!parser) return t.skip(SKIP);
  const [OLD, NEW] = ['server/remote-control/demo.js', 'server/remote-control/demo-places.js'];
  const root = mkdtempSync(join(tmpdir(), 'xenon-inner-run-repo-'));
  try {
    for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    writeFileSync(join(root, OLD), SOURCE);
    const done = moveInner({ root, parser, source: OLD, target: NEW, about: ABOUT, factory: 'createThing', make: 'makePlaces', names: RUN });
    assert.deepEqual([done.moved, done.returned, done.passed], [RUN, ['home', 'where', 'last'], ['runner', 'limit']]);
    assert.deepEqual(readLedger(root).sources[OLD][0].names, RUN);
    assert.match(readFileSync(join(root, NEW), 'utf8'), /^function makePlaces\(\{ runner, limit \}\) \{$/m);
    const show = (_root, _rev, name) => (name === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD, NEW]] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
