// Says whether loading a file does the same at whatever moment it happens: the file is
// loaded here, alone, in a world that holds the JavaScript language and nothing else, and
// everything it reaches for outside itself is written down.
//
// A new module is required before the first line that may use it while the old file is
// still loading. When it needs a module the old file loads further down, that module would
// load earlier than it does today, and the move is refused (analyze.mjs, extract-plan.mjs)
// unless this proves that the moment makes no difference.
//
// The world is a fresh one (node:vm). The language is all there (`Math`, `JSON`, `Set`...).
// Every other name Node gives a program (`process`, `Buffer`, `setTimeout`, `console`,
// `fetch`...) is there as a stand-in that does nothing but record that it was used, so a
// file that only asks `typeof process` gets the answer it gets in the engine, and a file
// that reads `process.platform` while it loads is caught. `require` runs a relative .js
// file in the same world; of Node's own modules it lends the ones whose loading shows
// nowhere (the list of bare-requires.mjs), as names to keep: `const { join } = require('path')`
// is fine, calling `join` while the file loads is not. `module` gives `exports` and nothing else.
//
// A file passes when, from its first line to its last and through every file it asks for:
//   - it used no stand-in, called nothing of Node, asked for no package and no missing file;
//   - it read neither the clock (`Date.now()`, `new Date()`) nor `Math.random()`;
//   - it left every object of the language and the list of global names as they were
//     (compared slot by slot before and after, so a change undone by a `catch` still shows);
//   - it did not ask for a file that was still loading (a circle of requires is entered at
//     another point when one of its files loads earlier);
//   - it finished.
// What such a file did while loading came from its own text and the texts it asked for:
// it is the same whichever line of the engine loads it first.
//
// Not seen: a file of the engine that changes the language itself (`Array.prototype.x =`)
// or what another file exports, between the two places; the order of work left to a
// Promise among several files. And this reads the repo's own code: it is not a cage for
// code that tries to get out (an error thrown by `require` here is an object of Node's).

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { INERT } from './bare-requires.mjs';
import { REPO_ROOT } from './parser.mjs';

// Runs in the new world before any file: puts the stand-ins in, guards the clock and the
// dice, remembers the shape of everything, and hands back what a file is loaded with.
const PREPARE = `(function (touch, hostNames) {
  'use strict';
  const world = globalThis;
  const stands = new WeakSet();
  const stand = (name, callable) => {
    const told = () => { touch(name); };
    const made = new Proxy(callable ? function () {} : {}, {
      get() { told(); }, set() { told(); return true; }, has() { told(); return false; }, apply() { told(); },
      construct() { told(); return {}; }, defineProperty() { told(); return true; }, deleteProperty() { told(); return true; },
      ownKeys() { told(); return []; }, getOwnPropertyDescriptor() { told(); },
    });
    stands.add(made);
    return made;
  };
  for (const [name, callable] of hostNames) Object.defineProperty(world, name, { value: stand(name, callable), writable: true, configurable: true, enumerable: false });

  // A module of Node: any of its names can be taken and kept, none can be called, built or changed while a file loads.
  const lent = new Map();
  const lend = (name) => {
    if (!lent.has(name)) {
      const told = (how) => { touch(how); };
      const made = new Proxy(function () {}, {
        get(target, key) { return typeof key === 'symbol' ? undefined : lend(name + '.' + key); },
        apply() { told(name + '()'); }, construct() { told('new ' + name + '()'); return {}; },
        set(target, key) { told(name + '.' + String(key) + ' ='); return true; },
        defineProperty(target, key) { told(name + '.' + String(key) + ' ='); return true; },
        deleteProperty(target, key) { told('delete ' + name + '.' + String(key)); return true; },
      });
      stands.add(made);
      lent.set(name, made);
    }
    return lent.get(name);
  };

  const RealDate = Date;
  const GuardedDate = new Proxy(RealDate, {
    construct(target, args, newTarget) { if (args.length === 0) touch('the clock (new Date())'); return Reflect.construct(target, args, newTarget); },
    apply(target, self, args) { touch('the clock (Date())'); return Reflect.apply(target, self, args); },
  });
  RealDate.now = () => { touch('the clock (Date.now())'); return 0; };
  RealDate.prototype.constructor = GuardedDate;
  world.Date = GuardedDate;
  Math.random = () => { touch('Math.random()'); return 0.5; };

  const FIELDS = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
  const shapeOf = (object) => {
    const keys = Reflect.ownKeys(object);
    return { proto: Object.getPrototypeOf(object), open: Object.isExtensible(object), keys, slots: keys.map((key) => Object.getOwnPropertyDescriptor(object, key)) };
  };
  const before = new Map();
  const queue = [[world, 'the list of global names']];
  while (queue.length) {
    const [object, label] = queue.pop();
    if (object === null || (typeof object !== 'object' && typeof object !== 'function') || before.has(object) || stands.has(object)) continue;
    const shape = shapeOf(object);
    before.set(object, { label, shape });
    queue.push([shape.proto, label + ' (its prototype)']);
    shape.keys.forEach((key, at) => {
      const name = object === world ? String(key) : label + '.' + String(key);
      for (const field of ['value', 'get', 'set']) queue.push([shape.slots[at][field], name]);
    });
  }
  const same = (was, now) => was.proto === now.proto && was.open === now.open && was.keys.length === now.keys.length
    && was.keys.every((key, at) => key === now.keys[at] && FIELDS.every((field) => Object.is(was.slots[at][field], now.slots[at][field])));

  return {
    lend,
    changed() {
      const labels = [];
      for (const [object, { label, shape }] of before) if (!same(shape, shapeOf(object))) labels.push(label);
      return labels;
    },
    // What one file is loaded with: its own module and a require, both made here so that they are objects of this world.
    parts(ask) {
      const held = { exports: {} };
      const only = (word, key) => { if (key !== 'exports') touch(word + '.' + String(key)); };
      const module = new Proxy(held, {
        get(target, key) { only('module', key); return target[key]; },
        set(target, key, value) { only('module', key); target[key] = value; return true; },
        has(target, key) { only('module', key); return key in target; },
      });
      const require = new Proxy(function (spec) { return ask(spec); }, {
        get(target, key) { touch('require.' + String(key)); }, set(target, key) { touch('require.' + String(key)); return true; },
      });
      return { module, require, held };
    },
  };
})`;

function emptyWorld(touch) {
  const sandbox = {};
  const world = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
  const language = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', world));
  const hostNames = Object.getOwnPropertyNames(globalThis).filter((name) => !language.has(name) || name === 'console')
    .map((name) => [name, typeof globalThis[name] === 'function']);
  return { sandbox, world, kit: vm.runInContext(PREPARE, world)(touch, hostNames) };
}

/**
 * @param {object} job
 * @param {(file: string) => string | null} job.read the text of a repo-relative file, null when there is none
 * @returns {(file: string) => string} why the file cannot be said to load the same at any moment, '' when it can
 */
export function createAloneTest({ read }) {
  const verdicts = new Map();
  return (file) => {
    if (!verdicts.has(file)) verdicts.set(file, loadAlone(file, read));
    return verdicts.get(file);
  };
}

/** @returns {(file: string) => string} the test over the files of this repo */
export function repoAloneTest() {
  const texts = new Map();
  return createAloneTest({ read: (file) => {
    if (!texts.has(file)) {
      const full = path.join(REPO_ROOT, file);
      texts.set(file, existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null);
    }
    return texts.get(file);
  } });
}

function loadAlone(file, read) {
  const reasons = [];
  let current = file;
  const { sandbox, world, kit } = emptyWorld((what) => { reasons.push(`${current} uses ${what} while it loads`); });
  const done = new Map();
  const loading = new Set();
  const load = (name) => {
    if (done.has(name)) return done.get(name).exports;
    const text = read(name);
    if (loading.has(name)) reasons.push(`${name} is asked for while it is still loading: a circle of requires`);
    else if (text === null) reasons.push(`${name} is no file here`);
    else if (!name.endsWith('.js')) reasons.push(`${name} is not a .js file`);
    if (reasons.length) throw new Error(reasons[0]);
    const asker = current;
    const ask = (spec) => {
      const builtin = typeof spec === 'string' ? spec.replace(/^node:/, '') : '';
      if (INERT.has(builtin)) return kit.lend(builtin);
      const base = typeof spec === 'string' && spec.startsWith('.') ? path.posix.join(path.posix.dirname(name), spec) : null;
      const found = base === null ? null : [base, `${base}.js`].find((candidate) => read(candidate) !== null);
      if (!found) {
        reasons.push(`${name} asks for ${JSON.stringify(spec)} while it loads, which is neither a file next to it nor a module of Node that does nothing when loaded`);
        throw new Error(reasons[0]);
      }
      const exports = load(found);
      current = name;
      return exports;
    };
    const { module, require, held } = kit.parts(ask);
    const run = vm.runInContext(`(function (exports, require, module) {${text}\n})`, world, { filename: name });
    loading.add(name);
    current = name;
    run.call(held.exports, held.exports, require, module);
    loading.delete(name);
    done.set(name, held);
    current = asker;
    return held.exports;
  };
  // The start is a global for the length of one call, and is gone before the first line of the file runs.
  sandbox.__start = () => { delete sandbox.__start; load(file); };
  try {
    vm.runInContext('__start()', world, { timeout: 5000 });
  } catch (error) {
    if (!reasons.length) reasons.push(`${file} does not finish when it is loaded alone: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  if (!reasons.length) reasons.push(...kit.changed().map((label) => `loading ${file} changes ${label}`));
  return reasons[0] ?? '';
}
