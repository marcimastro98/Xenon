// Plans taking declarations out of a classic browser script into a new script that
// loads right before it, and proves the plan from the texts alone: the moved lines
// are the same lines in the same order, the old script lost exactly those lines,
// and the page still declares the same names.

import { analyzeRun, assignedAtHome, orderProblems, runsOnLoad, stayReasons } from './browser-analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { lineStarts, sliceLines } from './top-level.mjs';

export const MAX_LINES = 300;
const WRAP = 100;

/** @param {string} about one sentence @param {boolean} strict @returns {string} the first lines of a new script */
export function headerOf(about, strict) {
  const lines = [];
  let line = '//';
  for (const word of String(about).trim().split(/\s+/)) {
    if (line.length + 1 + word.length > WRAP && line !== '//') { lines.push(line); line = '//'; }
    line += ` ${word}`;
  }
  lines.push(line);
  return `${lines.join('\n')}\n${strict ? "'use strict';\n" : ''}\n`;
}

const withoutBlankEnds = (text) => text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:[ \t]*\n)+$/, '\n');

// The lines a run of declarations takes with it: from the comment above the first
// to the last line of code, plus the blank lines after it when a blank line stays
// above, so the old script keeps one blank line where the run was and none at its end.
function runRange(lines, top, lastCode) {
  const blank = (line) => line >= 1 && line <= lines.length && lines[line - 1].trim() === '';
  const lastLine = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  let end = lastCode;
  while (end < lastLine && blank(end + 1)) end += 1;
  let start = top;
  if (end === lastLine) while (blank(start - 1)) start -= 1;
  else if (!(top === 1 || blank(top - 1))) end = lastCode;
  return [start, end];
}

// Where a run starts: at the comment that stands alone above its first declaration
// (a section title, with blank lines around it), when there is one, else at the
// comment attached to it. What lies between two statements is only comments.
function topOf(lines, record, previous) {
  let top = previous ? previous.line[1] + 1 : 1;
  while (top < record.range[0] && lines[top - 1].trim() === '') top += 1;
  return /^\s*\/[/*]/.test(lines[top - 1]) ? top : record.range[0];
}

/**
 * Turns a pick list into names: a name stands for itself, `first..last` for every
 * declaration from one to the other that may move (the ones that stay are skipped).
 * @param {any[]} records of the old script @param {string[]} picks @param {(record: any) => boolean} mayMove
 * @returns {{ names: string[], skipped: string[], unknown: string[] }}
 */
export function resolvePicks(records, picks, mayMove) {
  const indexOf = (name) => records.findIndex((record) => record.names.includes(name));
  const chosen = new Set();
  const skipped = [];
  const unknown = [];
  for (const pick of picks) {
    const [from, to] = pick.includes('..') ? pick.split('..') : [pick, pick];
    const [first, last] = [indexOf(from), indexOf(to)];
    if (first === -1 || last === -1 || last < first) { unknown.push(pick); continue; }
    for (const record of records.slice(first, last + 1)) {
      if (from === to || mayMove(record)) chosen.add(record);
      else skipped.push(record.names.join(', ') || `line ${record.line[0]}`);
    }
  }
  return { names: [...chosen].sort((a, b) => a.order - b.order).flatMap((record) => record.names), skipped, unknown };
}

/**
 * @param {object} job
 * @param {{ file: string, text: string }[]} job.scripts the scripts already taken out of the old one, in load order, then the old one
 * @param {string} job.target repo-relative new script
 * @param {string} job.about one sentence: the new script's first comment
 * @param {string[]} job.names declarations to move
 * @param {any} job.parser
 * @returns {{ moved: string[], ranges: number[][], header: string, targetText: string, newSource: string }}
 *   throws a Refusal with every reason when the move is not safe
 */
export function planScriptMove({ scripts, target, about, names, parser }) {
  const source = scripts[scripts.length - 1];
  const run = analyzeRun(scripts, parser);
  const own = run.records.filter((record) => record.fileIndex === scripts.length - 1);
  const reasons = [];
  const picked = new Set();
  for (const name of names) {
    const record = own.find((entry) => entry.names.includes(name));
    if (!record) reasons.push(`${source.file} declares no ${name} at its top level`);
    else picked.add(record);
  }
  if (!String(about ?? '').trim()) reasons.push('the new script needs one sentence saying what it does (--about)');
  for (const record of picked) reasons.push(...stayReasons(record, run));
  if (reasons.length) throw new Refusal(reasons);
  // A function takes its `window.name = name;` along: the two say one thing.
  const going = new Set([...picked].flatMap((record) => record.names));
  for (const record of own) if (going.has(record.echo) && stayReasons(record, run).length === 0) picked.add(record);

  // A comment between two declarations that both move goes with the second one.
  const moved = [...picked].sort((a, b) => a.order - b.order);
  const sourceLines = source.text.split('\n');
  const runs = [];
  for (const record of moved) {
    const previous = own[own.indexOf(record) - 1];
    const last = runs[runs.length - 1];
    if (previous && picked.has(previous) && last) last[1] = record.line[1];
    else runs.push([topOf(sourceLines, record, previous), record.line[1]]);
  }
  const ranges = runs.map(([top, lastCode]) => runRange(sourceLines, top, lastCode));
  const starts = lineStarts(source.text);
  const pieces = ranges.map(([from, to]) => sliceLines(source.text, starts, from, to));
  const header = headerOf(about, run.strict[scripts.length - 1]);
  const targetText = header + pieces.map(withoutBlankEnds).join('\n');
  const gone = new Set(ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i - 1)));
  const newSource = sourceLines.filter((_, index) => !gone.has(index)).join('\n');

  const made = { moved: moved.flatMap((record) => record.names), ranges, header, targetText, newSource };
  const after = [...scripts.slice(0, -1), { file: target, text: targetText }, { file: source.file, text: newSource }];
  const problems = proveScriptMove({ before: scripts, after, plan: made, parser });
  if (problems.length) throw new Refusal(problems);
  return made;
}

const declared = (run) => run.records.flatMap((record) => record.names.map((name) => `${record.kind} ${name}`)).sort();
const codeLines = (text) => text.split('\n').filter((line) => line.trim() !== '');

/**
 * The proof of one move, from the texts before and after. Written apart from the
 * planner, so a mistake there shows up here.
 * @param {object} move
 * @param {{ file: string, text: string }[]} move.before the run before: earlier new scripts, then the old script
 * @param {{ file: string, text: string }[]} move.after the run after: earlier new scripts, the new one, the old script
 * @param {{ ranges: number[][], header: string }} move.plan
 * @param {any} move.parser
 * @returns {string[]} problems, empty when the move is proven
 */
export function proveScriptMove({ before, after, plan, parser }) {
  const problems = [];
  const old = before[before.length - 1].text.split('\n');
  const target = after[after.length - 2];
  const source = after[after.length - 1];

  // 1. The old script is the old text without the moved lines, and nothing else changed in it.
  const gone = new Set();
  for (const [from, to] of plan.ranges) for (let line = from; line <= to; line += 1) gone.add(line - 1);
  if (source.text !== old.filter((_, index) => !gone.has(index)).join('\n')) problems.push(`${source.file} changed outside the moved lines`);

  // 2. The new script is its header and then the moved lines, unchanged and in the old order. Only blank lines between them differ.
  if (!target.text.startsWith(plan.header)) problems.push(`${target.file} does not start with the planned header`);
  const movedLines = codeLines(old.filter((_, index) => gone.has(index)).join('\n'));
  if (codeLines(target.text.slice(plan.header.length)).join('\n') !== movedLines.join('\n')) {
    problems.push(`${target.file} is not the moved lines, unchanged and in their old order`);
  }
  if (!target.text.endsWith('\n') || target.text.endsWith('\n\n')) problems.push(`${target.file} must end with exactly one line break`);
  const length = target.text.split('\n').length - 1;
  if (length > MAX_LINES) problems.push(`${target.file} would be ${length} lines: a new file stays within ${MAX_LINES}, move fewer declarations`);

  // 3. The page declares the same names as before, each once, and runs the same code in the same mode.
  const [was, now] = [analyzeRun(before, parser), analyzeRun(after, parser)];
  if (declared(was).join('\n') !== declared(now).join('\n')) problems.push('the scripts do not declare the same top-level names as before');
  if (now.duplicates.size) problems.push(`declared twice after the move: ${[...now.duplicates].join(', ')}`);
  if (now.strict[now.strict.length - 2] !== was.strict[was.strict.length - 1]) problems.push(`${target.file} does not run in the same mode (strict or not) as ${source.file}`);
  // A function's `window.name = name;` is left out on both sides: it changes nothing wherever it runs.
  const loadTime = (run) => run.records.filter((record) => record.loadTime && !record.directive && !record.echo)
    .map((record) => `${record.kind} ${record.names.join(',')}`).join('\n');
  if (loadTime(was) !== loadTime(now)) problems.push('code that runs while the page loads changed place or order');
  if (now.records.some((record) => record.fileIndex === after.length - 2 && runsOnLoad(record, now))) {
    problems.push(`${target.file} would run code while it loads`);
  }

  // 4. Nothing in a new script needs, for its first value, something that is not there yet.
  problems.push(...orderProblems(now, (record) => record.fileIndex < after.length - 1));

  // 5. A `let` stays in one script with code that assigns it.
  const [homeWas, homeNow] = [assignedAtHome(was), assignedAtHome(now)];
  for (const [name, writers] of homeNow) {
    if (writers.length === 0 && homeWas.get(name).length > 0) {
      const who = homeWas.get(name).map((record) => record.names.join(', ') || `line ${record.line[0]}`).join(', ');
      problems.push(`${name} would be in ${now.bindings.get(name).record.file} with nothing there that assigns it: keep it in one script with ${who}`);
    }
  }
  return problems;
}
