// Proves that functions taken out of a browser script's wrapper (browser-inner-plan.mjs)
// mean what they meant. It reads the texts on its own; from the planner it takes only
// the places it says it wrote to.
//
// The same reading is the standing check (`browser verify`, the tests): a script made
// this way still runs nothing while it loads but constants whose value is written out
// and the one line that leaves its name on `window`, its code still takes nothing from
// the wrapper it left, and the old script still takes the names back before anything
// of it can reach one.

import { isFunction, lineOf, ownReasons } from './browser-inner-judge.mjs';
import { CLOSES, OPENS, readWrapper, SECTION_TITLE, windowNameOf } from './browser-inner-plan.mjs';
import { MAX_LINES } from './browser-plan.mjs';
import { wrapNames } from './module-requires.mjs';

const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;
const blank = (line) => line.trim() === '';
const codeOf = (lines, shell, record) => lines.slice(shell.open + record.line[0], shell.open + record.line[1] + 1);
const namesIn = (list) => list.split(',').map((name) => name.trim()).filter(Boolean);
const same = (a, b) => a.length === b.length && a.every((line, index) => line === b[index]);

function withoutBlankEnd(lines) {
  const kept = [...lines];
  while (kept.length && blank(kept.at(-1))) kept.pop();
  return kept;
}

/**
 * Reads a script made of functions and constants taken out of a wrapper.
 * @param {string} text @param {string} file @param {string} name the name it must leave on window @param {any} parser
 * @returns {{ problems: string[], shell: ReturnType<typeof readWrapper>, functions: Map<string, any>, gives: string[] }}
 *   `functions`: what it declares by name, function declarations and written-out constants (a constant of two names is there twice),
 *   `gives`: the names in its one object
 */
export function readInnerScript(text, file, name, parser) {
  const shell = readWrapper(text, file, parser);
  const functions = new Map();
  if (shell.problems.length) return { problems: shell.problems, shell, functions, gives: [] };
  const problems = [];
  const lines = text.split('\n');
  const head = lines.slice(0, shell.open);
  if (!head[0]?.startsWith('//') || head.some((line) => !(line.startsWith('//') || line === "'use strict';" || line === ''))) {
    problems.push(`${file} must open with a comment saying what it does, and nothing else above its wrapper`);
  }
  if (lines[shell.open] !== OPENS[1] || lines[shell.close] !== CLOSES[0] || lines.length !== shell.close + 2 || lines.at(-1) !== '') {
    problems.push(`${file} must be one \`${OPENS[1]}\` ... \`${CLOSES[0]}\` and end there`);
  }
  if (lines.length - 1 > MAX_LINES) problems.push(`${file} is ${lines.length - 1} lines: a script made of moved functions stays within ${MAX_LINES}`);
  const records = shell.strictInside ? shell.records.slice(1) : shell.records;
  if (shell.strictInside && codeOf(lines, shell, shell.records[0]).join('\n') !== `${shell.indent}'use strict';`) problems.push(`${file}: the line that makes it strict is not written plainly`);
  const last = records.at(-1);
  const object = last && new RegExp(`^window\\.${name} = \\{([^{}]*)\\};$`).exec(codeOf(lines, shell, last).map((line) => line.trim()).join(' '));
  const gives = object ? namesIn(object[1]) : [];
  if (!object || !gives.every((given) => PLAIN_NAME.test(given)) || !same(codeOf(lines, shell, last), wrapNames(gives, `window.${name} = {`, '};').map((line) => shell.indent + line))) {
    problems.push(`${file} must end with \`window.${name} = { ... };\` naming its functions as they are, and nothing else`);
  }
  for (const record of records.slice(0, -1)) {
    if (!isFunction(record) && record.kind !== 'const') {
      problems.push(`${file}:${lineOf(shell, record)} is not a function declaration or a constant: a script made of moved code runs nothing while it loads`);
      continue;
    }
    for (const declared of record.names) functions.set(declared, record);
    // A constant is judged in its new place as it was in the old one: a value written out, of names declared above it here.
    problems.push(...ownReasons(shell, record, `${file}: ${record.names.join(', ')}`).map((reason) => reason.text));
  }
  for (const given of gives) if (!functions.has(given)) problems.push(`${file} leaves ${given} on window.${name}, which is not one of its functions or constants`);
  if (new Set(gives).size !== gives.length) problems.push(`${file} names a function twice in window.${name}`);
  for (const word of ['eval', 'with']) if (shell.words.has(word)) problems.push(`${file} says \`${word}\``);
  return { problems, shell, functions, gives };
}

/**
 * The line of a wrapper that takes functions back from a script made of them.
 * @param {ReturnType<typeof readWrapper>} shell @param {string} text of the script the wrapper is in @param {string} name
 * @returns {{ record: any, takes: string[] }[]} every statement that is `const { ... } = window.<name>;`
 */
export function takersOf(shell, text, name) {
  const lines = text.split('\n');
  const found = [];
  for (const record of shell.records) {
    if (record.kind !== 'const') continue;
    const code = codeOf(lines, shell, record);
    const taken = new RegExp(`^const \\{([^{}]*)\\} = window\\.${name};$`).exec(code.map((line) => line.trim()).join(' '));
    if (!taken) continue;
    const takes = namesIn(taken[1]);
    const plain = takes.every((taking) => PLAIN_NAME.test(taking)) && same(code, wrapNames(takes, 'const {', `} = window.${name};`).map((line) => shell.indent + line));
    found.push({ record, takes: plain ? takes : [] });
  }
  return found;
}

// A function declaration can be called from the wrapper's first line, a const only after its line:
// nothing above the line that takes the functions back may reach one, through any chain of uses.
function earlyUses(shell, taker, source) {
  const reaches = new Set([taker]);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of shell.records) {
      if (reaches.has(record)) continue;
      if ([...record.uses.keys()].some((used) => shell.bindings.has(used) && reaches.has(shell.bindings.get(used).record))) { reaches.add(record); grew = true; }
    }
  }
  return shell.records.slice(0, taker.index).filter((record) => record.kind !== 'function' && reaches.has(record))
    .map((record) => `${source}:${shell.open + record.line[0] + 1} could use ${taker.names.join(', ')} before the line that takes ${taker.names.length === 1 ? 'it' : 'them'} back`);
}

// What must hold between a wrapper and one script made of its functions, on any day.
function pairProblems({ now, text, source, target, made, others }) {
  const problems = [];
  const name = windowNameOf(source, target);
  const takers = takersOf(now, text, name);
  if (takers.length !== 1) return [`${source} must take the functions of ${target} back on one line, \`const { ... } = window.${name};\`: ${takers.length} such lines`];
  const [{ record: taker, takes }] = takers;
  if (!same(takes, made.gives)) problems.push(`${source} takes ${takes.join(', ') || 'nothing plainly'} from window.${name}, and ${target} leaves ${made.gives.join(', ')} there`);
  if (takes.length === 0) problems.push(`${source} takes nothing from ${target}`);
  for (const taken of takes) if (now.twice.has(taken)) problems.push(`${source} declares ${taken} twice`);
  // A word is enough: `window.Name`, `Name`, a string holding it.
  const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
  if ((text.match(word) ?? []).length !== 1) problems.push(`${source} says ${name} more than once: only the line that takes the functions back may name it`);
  if (now.strictFile !== made.shell.strictFile || now.strictInside !== made.shell.strictInside) problems.push(`${target} does not run in the same mode (strict or not) as ${source}, or not by the same line`);
  for (const [fn, record] of made.functions) {
    for (const used of record.uses.keys()) {
      if (made.functions.has(used)) continue;
      const own = now.bindings.get(used);
      if (own) problems.push(`${target}: ${fn} uses ${used}, which the wrapper of ${source} declares (line ${now.open + own.record.line[0] + 1}): out of the wrapper it means something else`);
      else if (others.has(used)) problems.push(`${target}: ${fn} uses ${used}, a function of ${others.get(used)}: out of the wrapper nothing has that name`);
    }
    if (!takes.includes(fn) && now.records.some((record) => record.uses.has(fn))) problems.push(`${source} still uses ${fn}, which it does not take back from ${target}`);
    if (now.records.some((entry) => (entry.uses.get(fn)?.write ?? 0) > 0)) problems.push(`${source} assigns ${fn} again: the ${isFunction(record) ? 'function' : 'constant'} in ${target} would not change with it`);
  }
  problems.push(...earlyUses(now, taker, source));
  return problems;
}

/**
 * @param {object} move
 * @param {string} move.before the old script before @param {string} move.after the old script after @param {string} move.made the new script
 * @param {{ ranges: number[][], glue: { at: number, lines: string[] } }} move.plan where the planner says it took lines out and put its line in
 * @param {any} move.parser @param {string} move.source repo-relative old script @param {string} move.target repo-relative new script
 * @param {{ file: string, text: string }[]} [move.earlier] the scripts made of this wrapper's functions before
 * @returns {string[]} problems, empty when the move is proven
 */
export function proveInnerMove({ before, after, made, plan, parser, source, target, earlier = [] }) {
  const name = windowNameOf(source, target);
  if (!name) return [`${target} is not ${source.replace(/\.js$/, '')}/<what it does>.js`];
  const was = readWrapper(before, source, parser);
  const now = readWrapper(after, source, parser);
  const script = readInnerScript(made, target, name, parser);
  const unread = [...was.problems, ...now.problems, ...script.problems];
  if (unread.length) return unread;
  const problems = [];

  // 1. Every line is accounted for: the old script lost the planned lines and gained one statement, the new script holds those lines.
  const [old, cur, fresh] = [before, after, made].map((text) => text.split('\n'));
  const { at, lines: glue } = plan.glue;
  if (!same(cur.slice(at, at + glue.length), glue)) return ['the line that takes the functions back is not where the plan put it'];
  const gone = new Set(plan.ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i)));
  if (!same(old.filter((_, index) => !gone.has(index)), [...cur.slice(0, at), ...cur.slice(at + glue.length)])) problems.push(`${source} changed by more than the moved lines and the line that takes the functions back`);
  if (glue.filter((line) => !blank(line)).length !== glue.length - (blank(glue.at(-1)) ? 1 : 0) || blank(glue[0])) problems.push('the line that takes the functions back carries empty lines inside it');
  const movedLines = plan.ranges.flatMap(([from, to]) => old.slice(from - 1, to)).filter((line) => !blank(line));
  const body = fresh.slice(script.shell.open + 1, script.shell.close).filter((line) => !blank(line));
  const objectLines = wrapNames(script.gives, `window.${name} = {`, '};').length;
  if (!same(body.slice(script.shell.strictInside ? 1 : 0, body.length - objectLines), movedLines)) problems.push(`${target} does not hold the moved lines unchanged and in order`);

  // 2. Each function or constant of the new script was one of the wrapper, declared once, never assigned again, and the lines taken are its lines.
  //    A constant was a value written out there too, and nothing above its line could reach it while the script loaded.
  const taken = new Set();
  for (const [fn, record] of script.functions) {
    const own = was.bindings.get(fn);
    if (own?.kind !== record.kind || was.twice.has(fn) || own.record.sharesLine || own.record.names.join() !== record.names.join()) {
      problems.push(`${fn} was not a ${isFunction(record) ? 'function' : 'constant'} declared once, on lines of its own, in the wrapper of ${source}`);
      continue;
    }
    if (record.kind === 'const' && fn === record.names[0]) problems.push(...ownReasons(was, own.record, `${record.names.join(', ')} (${source}:${lineOf(was, own.record)})`).map((reason) => reason.text));
    if (!same(withoutBlankEnd(codeOf(old, was, own.record)), withoutBlankEnd(codeOf(fresh, script.shell, record)))) problems.push(`${fn} is not the same text in ${target} as it was in ${source}`);
    // From the comment above the function to the empty lines after it; only the title of a section may stay behind.
    const [first, code, end] = [own.record.range[0], own.record.line[0], own.record.range[1]].map((line) => was.open + line + 1);
    const mine = plan.ranges.find(([from, to]) => from >= first && from <= code && to === end);
    if (!mine || !old.slice(first - 1, mine[0] - 1).every((line) => SECTION_TITLE.test(line))) problems.push(`the lines taken out of ${source} are not the lines of ${fn}`);
    if (was.records.some((entry) => (entry.uses.get(fn)?.write ?? 0) > 0)) problems.push(`${source} assigned ${fn} again`);
    if (own.record.words.has('arguments.callee')) problems.push(`${fn} says arguments.callee`);
    for (const used of record.uses.keys()) {
      if (!script.functions.has(used) && was.bindings.has(used)) problems.push(`${fn} used ${used}, which the wrapper of ${source} declared (line ${was.open + was.bindings.get(used).record.line[0] + 1})`);
    }
    taken.add(fn);
  }
  const held = new Set(script.functions.values()).size;
  if (plan.ranges.length !== held) problems.push(`${plan.ranges.length} runs of lines left ${source} and ${target} holds ${held} functions and constants`);
  for (const word of ['eval', 'with']) if (was.words.has(word)) problems.push(`${source} says \`${word}\`, which reads names nobody can list`);
  if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(before)) problems.push(`${source} already had ${name} as a word`);
  if (was.strictFile !== now.strictFile || was.strictInside !== now.strictInside) problems.push(`${source} changed mode (strict or not)`);

  // 3. The other statements of the wrapper are the same statements in the same order.
  const kept = (shell, skip) => shell.records.filter((record) => !skip(record)).map((record) => `${record.kind} ${record.names.join(',')}`);
  const takers = takersOf(now, after, name);
  if (!same(kept(was, (record) => (isFunction(record) || record.kind === 'const') && record.names.every((declared) => taken.has(declared))), kept(now, (record) => takers.some((taker) => taker.record === record)))) {
    problems.push(`the wrapper of ${source} does not hold the same statements in the same order as before`);
  }

  // 4. What holds from now on holds today.
  const others = new Map(earlier.flatMap((part) => [...readInnerScript(part.text, part.file, windowNameOf(source, part.file), parser).functions.keys()].map((fn) => [fn, part.file])));
  problems.push(...pairProblems({ now, text: after, source, target, made: script, others }));
  return problems;
}

/**
 * The standing check of one wrapped script and the scripts made of its functions.
 * @param {{ source: string, text: string, parts: { file: string, text: string }[], parser: any }} job `parts` in the order a page loads them
 * @returns {string[]}
 */
export function innerStateProblems({ source, text, parts, parser }) {
  const now = readWrapper(text, source, parser);
  if (now.problems.length) return now.problems.map((problem) => `${problem} (functions were taken out of its wrapper: it must stay one)`);
  const problems = [];
  const read = parts.map((part) => {
    const name = windowNameOf(source, part.file);
    return name ? { ...part, made: readInnerScript(part.text, part.file, name, parser) } : { ...part, made: null };
  });
  for (const part of read) {
    if (!part.made) { problems.push(`${part.file} is not ${source.replace(/\.js$/, '')}/<what it does>.js`); continue; }
    if (part.made.problems.length) { problems.push(...part.made.problems); continue; }
    const others = new Map(read.filter((other) => other !== part && other.made).flatMap((other) => [...other.made.functions.keys()].map((fn) => [fn, other.file])));
    problems.push(...pairProblems({ now, text, source, target: part.file, made: part.made, others }));
  }
  return problems;
}
