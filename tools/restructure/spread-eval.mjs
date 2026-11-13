// Works an object out twice, as one literal and as its parts spread together, and
// compares the two results: the same keys in the same order, the same values, the
// same things frozen.
//
// The code is run away from the file it comes from, so every name it takes from
// outside is a stand-in: a value that answers any question (a property, a call)
// with another stand-in, the same one for the same question. Both runs get the
// same stand-ins, so "the same value" can be checked with ===.

import vm from 'node:vm';

/** @returns {(label: string) => any} stand-ins by label: one label, one stand-in */
export function standIns() {
  const made = new Map();
  const labels = new WeakMap();
  const show = (value) => labels.get(value) ?? (value !== null && typeof value === 'object' ? '{…}' : typeof value === 'function' ? 'fn' : JSON.stringify(value) ?? String(value));
  const standIn = (label) => {
    if (made.has(label)) return made.get(label);
    const proxy = new Proxy(() => {}, {
      get(target, key) {
        // A frozen stand-in has to answer with what its target really holds.
        if (Object.hasOwn(target, key)) return Reflect.get(target, key);
        if (key === Symbol.toPrimitive) return () => label;
        if (key === Symbol.iterator) return function* nothing() {};
        return typeof key === 'symbol' ? undefined : standIn(`${label}.${key}`);
      },
      apply: (_target, _self, args) => standIn(`${label}(${args.map(show).join(', ')})`),
      construct: (_target, args) => standIn(`new ${label}(${args.map(show).join(', ')})`),
    });
    made.set(label, proxy);
    labels.set(proxy, label);
    return proxy;
  };
  return standIn;
}

// What two values differ in, as sentences. Stand-ins and plain values have to be the very same; objects and
// lists are walked: same keys in the same order, same frozen state, same kind.
function differences(old, now, where, out) {
  if (Object.is(old, now)) return;
  const walkable = (value) => value !== null && typeof value === 'object';
  if (typeof old === 'function' && typeof now === 'function' && String(old) === String(now)) return;
  if (!walkable(old) || !walkable(now)) { out.push(`${where} is another value`); return; }
  if (Array.isArray(old) !== Array.isArray(now) || Object.getPrototypeOf(old) !== Object.getPrototypeOf(now)) out.push(`${where} is another kind of object`);
  if (Object.isFrozen(old) !== Object.isFrozen(now)) out.push(`${where} is ${Object.isFrozen(now) ? 'frozen now' : 'no longer frozen'}`);
  const keys = Reflect.ownKeys(old);
  const nowKeys = Reflect.ownKeys(now);
  if (keys.length !== nowKeys.length || keys.some((key, index) => key !== nowKeys[index])) { out.push(`${where} has other keys, or the same in another order`); return; }
  for (const key of keys) differences(old[key], now[key], `${where}.${String(key)}`, out);
}

/**
 * @param {object} job
 * @param {string} job.oldCode the statements that declare `name` as one literal
 * @param {string} job.newCode the statements that declare the parts and then `name`
 * @param {string} job.name
 * @param {string[]} job.outside the names the code takes from the file around it
 * @returns {string[]} what is different; empty when the two give the same object
 */
export function sameObjectProblems({ oldCode, newCode, name, outside }) {
  const context = vm.createContext({});
  const builtIn = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', context));
  const names = [...new Set(outside)].filter((used) => used !== name && !builtIn.has(used));
  const standIn = standIns();
  const run = (code) => vm.runInContext(`(function (${names.join(', ')}) {\n${code}\nreturn ${name};\n})`, context)(...names.map(standIn));
  let old;
  let now;
  try {
    old = run(oldCode);
    now = run(newCode);
  } catch (error) {
    return [`${name} could not be worked out with stand-ins for ${names.join(', ')}: ${error.message}`];
  }
  const problems = [];
  if (!Object.isFrozen(old) || !Object.isFrozen(now)) problems.push(`${name} is not frozen ${Object.isFrozen(old) ? 'after' : 'before'} the cut`);
  if (Object.keys(old).join('\n') !== Object.keys(now).join('\n')) problems.push(`Object.keys(${name}) is another list, or in another order`);
  differences(old, now, name, problems);
  return problems;
}
