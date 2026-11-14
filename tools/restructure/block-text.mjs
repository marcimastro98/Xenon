// The few lines the `block` step writes around lines it moves, and how they are read back. Text only: the
// planner (block.mjs) writes with these, the proof (block-proof.mjs) and the tests that read the engine as
// text (server/test/engine-source.mjs) undo with them.
//
// A block `if (<test>) { ... return; }` inside a long function becomes
//
//       if (<test>) {
//         await <name>({ <what the lines read of the function and of the file> });
//         return;
//       }
//
// (the `return;` is the block's own last line and never moves), the file requires the function on one line above
// the function the block is in, and the lines stand, as they were and with the indentation they had, in a module
// of their own:
//
//   /** @param {any} context ... */
//   async function <name>(context) {
//     const { <the same names> } = context;
//   <the lines>
//   }
//
//   module.exports = { <name> };

import path from 'node:path';

export const PARAM = 'context';
const WIDTH = 120;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wrap(names, open, close, pad) {
  const oneLine = `${open} ${names.join(', ')} ${close.trimStart()}`;
  if (oneLine.length <= WIDTH) return [oneLine];
  const lines = [open];
  let row = pad;
  for (const name of names) {
    if (row.length + name.length + 2 > WIDTH && row !== pad) { lines.push(row.trimEnd()); row = pad; }
    row += `${name}, `;
  }
  lines.push(row.trimEnd(), close);
  return lines;
}

export const TYPE_LINE = `/** @param {any} ${PARAM} what these lines read of the function they stood in, and of its file */`;
export const headLine = (name) => `async function ${name}(${PARAM}) {`;
export const exportLine = (name) => `module.exports = { ${name} };`;
export const takeLines = (names) => wrap(names, '  const {', `  } = ${PARAM};`, '    ');
export const callLines = (name, names, indent) => wrap(names, `${indent}await ${name}({`, `${indent}});`, `${indent}  `);
export const returnLine = (indent) => `${indent}return;`;
export const noteSentence = (handler, source, test) => `The lines of the function stood in ${handler} of ${source}, under \`if (${test})\`, and are written here `
  + 'as they were, indentation included. The function is handed what they read of that function and of the file.';

/** @param {string} source @param {string} target repo-relative @returns {string} the path the old file requires the new module with */
export function specOf(source, target) {
  const spec = path.posix.relative(path.posix.dirname(source), target);
  return spec.startsWith('.') ? spec : `./${spec}`;
}
export const requireLine = (name, spec) => `const { ${name} } = require('${spec}');`;
const namesIn = (text) => text.match(new RegExp(NAME, 'g')) ?? [];
const ONE_LINE_REQUIRE = /^const (?:\{[^}]*\}|[\w$]+) = require\('[^']+'\)(?:\.[\w$]+)?;$/;

/**
 * Writes the require of the new function above the function the block is in: on top of the requires that stand
 * right above it when there are some, so the tables of routes stay next to their function; on a line of its own otherwise.
 * @param {string[]} lines the file, changed in place @param {number} at 0-based first line of the function (its comment included)
 * @param {string} line the require
 * @returns {number} the 0-based line it stands on
 */
export function placeRequire(lines, at, line) {
  let top = at - 1;
  while (top > 0 && ONE_LINE_REQUIRE.test(lines[top - 1])) top -= 1;
  if (lines[at - 1] === '' && top < at - 1) { lines.splice(top, 0, line); return top; }
  lines.splice(at, 0, line, '');
  return at;
}

/**
 * @param {string} moduleText a module the step wrote @param {string} name its function
 * @returns {{ names: string[], body: string[], before: string[], problems: string[] }} the names it takes from its argument, the moved
 *   lines, and the lines above the function; a problem when the module is not written the way the step writes one
 */
export function readModule(moduleText, name) {
  const lines = moduleText.split('\n');
  const head = lines.indexOf(headLine(name));
  const tail = lines.slice(-4);
  const none = { names: [], body: [], before: [], problems: [`the module is not one function ${name}(${PARAM}) with its lines and its export, as the step writes it`] };
  if (head < 1 || lines[head - 1] !== TYPE_LINE || lines.indexOf(headLine(name), head + 1) !== -1) return none;
  if (tail.join('\n') !== ['}', '', exportLine(name), ''].join('\n')) return none;
  if (!lines[head + 1]?.startsWith('  const {')) return none;
  let end = head + 1;
  while (end < lines.length && !lines[end].endsWith(`} = ${PARAM};`)) end += 1;
  if (end >= lines.length - 4) return none;
  const taken = lines.slice(head + 1, end + 1);
  const names = namesIn(taken.join(' ').replace(/^\s*const \{/, '').replace(new RegExp(`\\} = ${PARAM};$`), ''));
  const problems = taken.join('\n') === takeLines(names).join('\n') ? [] : none.problems;
  return { names, body: lines.slice(end + 1, lines.length - 4), before: lines.slice(0, head - 1), problems };
}

/**
 * @param {string} text the old file after the step @param {string} name
 * @returns {{ first: number, last: number, indent: string, names: string[] } | null} the lines of the call (0-based, both
 *   included), or null when the file does not call the function once, with `return;` under it, the way the step writes it
 */
export function readCall(text, name) {
  const lines = text.split('\n');
  const start = new RegExp(`^(\\s*)await ${escaped(name)}\\(\\{`);
  const found = lines.flatMap((line, index) => (start.test(line) ? [index] : []));
  if (found.length !== 1) return null;
  const first = found[0];
  const indent = start.exec(lines[first])[1];
  let end = first;
  while (end < lines.length && !lines[end].endsWith('});')) end += 1;
  if (end >= lines.length || lines[end + 1] !== returnLine(indent)) return null;
  const inside = lines.slice(first, end + 1).join(' ').replace(start, '').replace(/\}\);$/, '');
  return { first, last: end, indent, names: namesIn(inside) };
}

/**
 * Puts the lines back where the call stands, and takes the require of the module out.
 * @param {string} text the old file after the step @param {string} moduleText the module @param {string} name
 * @returns {{ text: string, problems: string[] }} the file as it was before the step
 */
export function undoBlockText(text, moduleText, name) {
  const made = readModule(moduleText, name);
  const call = readCall(text, name);
  if (made.problems.length) return { text, problems: made.problems };
  if (!call) return { text, problems: [`the file does not call ${name} once, followed by \`return;\`, as the step writes it`] };
  const lines = text.split('\n');
  const asks = new RegExp(`^const \\{ ${escaped(name)} \\} = require\\('[^']+'\\);$`);
  const required = lines.flatMap((line, index) => (asks.test(line) ? [index] : []));
  if (required.length !== 1 || required[0] > call.first) return { text, problems: [`the file does not require ${name} on one line above its call`] };
  // A require the step wrote on a line of its own came with a blank line under it.
  const at = required[0];
  const alone = !ONE_LINE_REQUIRE.test(lines[at + 1] ?? '');
  if (alone && lines[at + 1] !== '') return { text, problems: [`the require of ${name} is not where the step writes it`] };
  const back = [...lines.slice(0, at), ...lines.slice(at + (alone ? 2 : 1), call.first), ...made.body, ...lines.slice(call.last + 1)];
  return { text: back.join('\n'), problems: [] };
}

/** @param {string} moduleText @param {string} name @returns {string} the module without the moved lines: what is left when they are back in the file */
export function emptyModuleText(moduleText, name) {
  const made = readModule(moduleText, name);
  return made.problems.length ? moduleText : `${made.before.join('\n')}\n`;
}
