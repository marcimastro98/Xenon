// The text side of dispatch-move.mjs: what a step writes in the engine file and in feature-routes.js, how a cut
// is recorded, and how the old engine file is had back from the record. No parser: the tests' readers use it too.

const HANDS_OPEN = 'const routeHands = () => ({';
const HANDS_CLOSE = '});';
const FILES_OPEN = 'const TABLE_FILES = () => [';
const FILES_CLOSE = '];';
const WIDTH = 140;
// A file whose table answers its whole addresses, and a file whose tests all still stand in the chain.
export const listLine = (spec) => `  require('${spec}'),`;
export const waitingLine = (spec) => `  inChain(require('${spec}')),`;
const LISTED = /^ {2}(inChain\()?require\('([^']+)'\)\)?,$/;

const count = (lines, line) => lines.reduce((sum, other) => sum + (other === line ? 1 : 0), 0);

/** @param {string[]} names @returns {string[]} the lines between the brackets of `routeHands`: sorted, each line as full as it gets */
export function handsLines(names) {
  const out = [];
  for (const name of [...new Set(names)].sort()) {
    if (out.length && `${out.at(-1)} ${name},`.length <= WIDTH) out[out.length - 1] += ` ${name},`;
    else out.push(`  ${name},`);
  }
  return out;
}

// The lines between an opening line and the first closing line after it.
function between(lines, open, close, what) {
  const from = lines.indexOf(open);
  const to = from < 0 ? -1 : lines.indexOf(close, from + 1);
  if (from < 0 || to < 0 || lines.indexOf(open, from + 1) >= 0) throw new Error(`${what} is not written the way this step writes it`);
  return { from, to, inside: lines.slice(from + 1, to) };
}

/** @param {string[]} lines the engine file @returns {{ from: number, to: number, names: string[] }} what `routeHands` hands over */
export function readHands(lines) {
  const { from, to, inside } = between(lines, HANDS_OPEN, HANDS_CLOSE, 'routeHands');
  const names = inside.join(' ').split(',').map((name) => name.trim()).filter(Boolean);
  if (handsLines(names).join('\n') !== inside.join('\n')) throw new Error('routeHands is not written the way this step writes it');
  return { from, to, names };
}

/**
 * @param {string} listText feature-routes.js
 * @returns {{ from: number, to: number, specs: string[], waiting: string[], all: string[] }} `specs`: the files whose tables answer;
 *   `waiting`: the files it only loads (`inChain`); `all`: both, in the order of the list
 */
export function readListed(listText) {
  const { from, to, inside } = between(listText.split('\n'), FILES_OPEN, FILES_CLOSE, 'TABLE_FILES');
  const read = inside.map((line) => {
    const found = LISTED.exec(line);
    return found && line === (found[1] ? waitingLine : listLine)(found[2]) ? { spec: found[2], waits: Boolean(found[1]) } : null;
  });
  if (read.some((entry) => !entry)) throw new Error('TABLE_FILES holds a line that is not one required file');
  return { from, to, specs: read.filter((entry) => !entry.waits).map((entry) => entry.spec),
    waiting: read.filter((entry) => entry.waits).map((entry) => entry.spec), all: read.map((entry) => entry.spec) };
}

/** @param {string} listText @param {string[]} specs files marked `inChain` @returns {string} feature-routes.js with the mark off those */
export function unmark(listText, specs) {
  const marked = new Map(specs.map((spec) => [waitingLine(spec), listLine(spec)]));
  const lines = listText.split('\n');
  for (const line of marked.keys()) if (count(lines, line) !== 1) throw new Error(`TABLE_FILES does not hold this line once: ${line.trim()}`);
  return lines.map((line) => marked.get(line) ?? line).join('\n');
}

// Takes `size` lines out at `start` and says where they stood: before or after a line there is only one of.
export function cut(lines, start, size) {
  const taken = lines.splice(start, size);
  if (start < lines.length && count(lines, lines[start]) === 1) return { lines: taken, before: lines[start] };
  if (start > 0 && count(lines, lines[start - 1]) === 1) return { lines: taken, after: lines[start - 1] };
  throw new Error(`the lines at ${start + 1} stand next to no line that is the only one of its kind, so they could not be put back`);
}

export function uncut(lines, made) {
  const anchor = made.before ?? made.after;
  if (count(lines, anchor) !== 1) throw new Error(`the line the cut stood next to is not there once: ${anchor}`);
  lines.splice(lines.indexOf(anchor) + (made.before === undefined ? 1 : 0), 0, ...made.lines);
}

/**
 * The engine file as it read before the steps: every cut put back, last step first.
 * @param {string} text @param {{ cuts: any[], hands: string[] }[]} steps as recorded @returns {string}
 */
export function chainBack(text, steps) {
  const lines = text.split('\n');
  for (const step of [...steps].reverse()) {
    const hands = readHands(lines);
    lines.splice(hands.from + 1, hands.to - hands.from - 1, ...handsLines(hands.names.filter((name) => !step.hands.includes(name))));
    for (const made of [...step.cuts].reverse()) uncut(lines, made);
  }
  return lines.join('\n');
}

/** @param {string} listText @param {{ listed: string[] }} step @returns {string} feature-routes.js with the step's files marked `inChain` again */
export function listBack(listText, step) {
  const back = new Map(step.listed.map((spec) => [listLine(spec), waitingLine(spec)]));
  return listText.split('\n').map((line) => back.get(line) ?? line).join('\n');
}
