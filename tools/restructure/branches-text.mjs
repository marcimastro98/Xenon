// The lines the `branches` command writes, and how to read them back.
//
// A route of the request handler keeps its test where it is. Its body goes, as it
// is written, into a module of the feature:
//
//   } else if (reqPath === '/x' && req.method === 'GET') {      const branches = {
//     ...the body...                                              'GET /x': async (req, res, { json }) => {
//   } else if ...                                         ->        ...the body...
//                                                                 },
//   } else if (reqPath === '/x' && req.method === 'GET') {      };
//     await xBranches['GET /x'](req, res, { json, ... });
//   } else if ...
//
// A tool the assistant runs is the same with one difference (branches-kinds.mjs):
// its body assigns the result, so its function declares the result, runs the body
// and gives the result back, and the call puts it where the body put it:
//
//   } else if (fnName === 'x') {            'x': async ({ fnArgs }) => {
//       ...the body...              ->          let fnResult;
//   } else if ...                               ...the body...
//                                               return fnResult;
//   } else if (fnName === 'x') {            },
//       fnResult = await xToolsBranches['x']({ fnName, fnArgs, ... });
//
// A body may also use names of the file itself (branches-handler.mjs says which). The
// call hands them over in one more argument, made of plain names and nothing else,
// and the function takes them apart under the same names, so the body stays as written:
//
//     await xBranches['GET /x'](req, res, { json, ... }, { readNotes, saveNotes });
//     'GET /x': async (req, res, { json }, { readNotes, saveNotes }) => {
//
// A route's call may hand over a few more values of the handler, after the five every
// call names, and may give back what its body gives back (branches-kinds.mjs):
//
//     await xBranches['GET /x'](req, res, { json, ..., isRemote, remote, sendPage });
//     return await xBranches['POST /x'](req, res, { json, ... });
//
// Two words of a body mean the folder of the file it stands in, and are written for the
// table's folder (branches-place.mjs): `__dirname` is SERVER_DIR there, which the table
// works out on a line of its own, and `require('./js/x.js')` is `require('../js/x.js')`.
// `oldPlaces` writes both back as they stood.
//
// Text only, no parser: the tests that read the engine as text put the bodies back
// with this file (server/test/engine-source.mjs), and the proof of a move does too.

import path from 'node:path';

import { KINDS, ROUTES } from './branches-kinds.mjs';
import { HOME, OLD_HOME, oldSpelling } from './paths-undo.mjs';

/** What a route's body may use of the handler besides `req` and `res`, in the order it is handed over. */
export const CONTEXT = ROUTES.context;

const WORD = String.raw`[A-Za-z_$][\w$]*`;
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const handed = (kind, extra = []) => [...kind.leading, `{ ${[...kind.context, ...extra].join(', ')} }`].join(', ');
// Any of the kind's extra values, in the kind's order, each at most once.
const handedShape = (kind) => String.raw`${quote(handed(kind)).slice(0, -3)}(${kind.extra.map((name) => `(?:, ${name})?`).join('')}) \}`;
const before = (kind) => `${kind.result ? `${kind.result} = ` : ''}await `;
const beforeShape = (kind) => `${kind.indent}${kind.returns ? '(return )?' : '()'}${quote(before(kind))}`;
const OWN = String.raw`(?:, \{ (${WORD}(?:, ${WORD})*) \})?`;
const CALLS = new Map(KINDS.map((kind) => [kind, new RegExp(String.raw`^${beforeShape(kind)}(${WORD})\['(${kind.key})'\]\(${handedShape(kind)}${OWN}\);$`)]));
const REQUIRE = new RegExp(String.raw`^const \{ branches: (${WORD}) \} = require\('(\./[^']+)'\);$`);
const HEAD = /^ {2}'([^'\\]+)': async \(([^)]*)\) => \{$/;

/** Says what the table holds, so the type check reads a call with every value of the handler as a call of any of its functions. */
export const typeLine = (kind, own = false) => `/** @type {Record<string, ${own ? kind.typeOwn : kind.type}>} */`;
export const TYPE_LINE = typeLine(ROUTES);
export const OPEN_LINE = 'const branches = {';
export const CLOSE_LINE = '};';
export const ENTRY_END = '  },';
export const EXPORT_LINE = 'module.exports = { branches };';
/**
 * The one lint finding a table may silence, for the whole file, and only a table with a body that sets the result of its
 * chain once in a line of its own (branches-scope.mjs): its function declares the result on the line above, which the
 * check would have rewritten as one line. server/test/restructure-lint-line.test.mjs lists the files that carry it.
 */
export const SET_ONCE_LINE = '// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.';

/**
 * @param {string} local @param {string} key @param {typeof ROUTES} [kind] @param {string[]} [own] names of the file handed over
 * @param {string[]} [extra] the kind's extra values the body uses @param {boolean} [returns] the body gives a value back
 */
export const callLine = (local, key, kind = ROUTES, own = [], extra = [], returns = false) => `${kind.indent}${returns && kind.returns ? 'return ' : ''}${before(kind)}${local}['${key}'](${handed(kind, kind.extra.filter((name) => extra.includes(name)))}${own.length ? `, { ${own.join(', ')} }` : ''});`;
/** The one line a table carries when a body of it said `__dirname`: the folder of the file the bodies left, one level up. */
export const HOME_LINE = `const ${HOME} = path.join(${OLD_HOME}, '..');`;
export const requireLine = (local, spec) => `const { branches: ${local} } = require('${spec}');`;
export const headLine = (key, params) => `  '${key}': async (${params}) => {`;
// A body that assigns the result stands between the line that declares it and the line that gives it back.
const firstLine = (kind) => `${kind.indent}let ${kind.result};`;
const lastLine = (kind) => `${kind.indent}return ${kind.result};`;
/** @param {string[]} lines a body as it stood in the file @returns {string[]} the lines of its function in the table */
export const entryLines = (lines, kind = ROUTES) => (kind.result ? [firstLine(kind), ...lines, lastLine(kind)] : lines);

/**
 * @param {string} line
 * @returns {{ local: string, key: string, own: string[], extra: string[], returns: boolean } | null} `own`: the names of the file
 *   handed over; `extra`: the kind's extra values handed over; `returns`: the call gives back what the body gives back
 */
export const readCall = (line, kind = ROUTES) => {
  const m = CALLS.get(kind).exec(line);
  return m ? { local: m[2], key: m[3], own: m[5]?.split(', ') ?? [], extra: m[4] ? m[4].slice(2).split(', ') : [], returns: Boolean(m[1]) } : null;
};
/** @param {string} line @returns {{ local: string, spec: string } | null} */
export const readRequire = (line) => { const m = REQUIRE.exec(line); return m ? { local: m[1], spec: m[2] } : null; };
/** @param {string} line @returns {{ key: string, params: string } | null} */
export const readHead = (line) => { const m = HEAD.exec(line); return m ? { key: m[1], params: m[2] } : null; };

/**
 * @param {string} params the parameters of a body's function as written @param {typeof ROUTES} kind
 * @returns {string[]} the names of the file it is handed: its last parameter, when it has one more than the kind's own
 */
export function ownOf(params, kind) {
  const parts = params === '' ? [] : params.split(/, (?![^{]*\})/);
  const last = parts[kind.leading.length + 1];
  return last ? last.slice(2, -2).split(', ') : [];
}

/** @param {string} params as above @param {typeof ROUTES} kind @returns {string[]} the kind's extra values the function takes */
export function extraOf(params, kind) {
  const context = (params === '' ? [] : params.split(/, (?![^{]*\})/))[kind.leading.length] ?? '';
  const taken = context.startsWith('{ ') ? context.slice(2, -2).split(', ') : [];
  return kind.extra.filter((name) => taken.includes(name));
}

// A made-up folder deep enough that no path of the engine climbs out of it.
const DEEP = '/a/b/c/d/e/f';
const dotted = (spec) => (spec.startsWith('.') ? spec : `./${spec}`);
/** @param {string} spec a path as a file requires it @param {string} table the path the same file requires a table with @returns {string} the same file, asked from the table */
export const movedSpec = (spec, table) => dotted(path.posix.relative(path.posix.join(DEEP, path.posix.dirname(table)), path.posix.join(DEEP, spec)));
/** @param {string} spec a path as a table requires it @param {string} table as above @returns {string} the same file, asked from the file the table's bodies left */
export const oldSpec = (spec, table) => dotted(path.posix.relative(DEEP, path.posix.join(DEEP, path.posix.dirname(table), spec)));

const LOADS = /(?<![\w$.])require\('(\.{1,2}\/[^'\\]*)'\)/g;
/**
 * @param {string[]} lines a body as its table holds it @param {{ home: boolean, spec: string }} table whether the table works out
 *   SERVER_DIR, and the path the file requires it with
 * @returns {string[]} the lines as they stood in the file: every required path asked from there, `__dirname` where the table says SERVER_DIR
 */
export function oldPlaces(lines, { home, spec }) {
  return lines.map((line) => {
    const back = line.replace(LOADS, (_all, asked) => `require('${oldSpec(asked, spec)}')`);
    return home ? oldSpelling(back) : back;
  });
}

const typeLines = (kind) => [typeLine(kind), typeLine(kind, true)];
/** A line of a body that would be taken for the module's own frame when read back. */
export const frameLine = (line) => line === ENTRY_END || line === CLOSE_LINE || line === OPEN_LINE || KINDS.some((kind) => typeLines(kind).includes(line)) || HEAD.test(line);

/**
 * @param {string} moduleText a module the command wrote
 * @returns {{ head: string[], entries: { key: string, params: string, lines: string[] }[], tail: string[], kind: typeof ROUTES, setOnce: boolean, home: boolean }}
 *   the lines before the table, every body in order as the table holds it (`oldPlaces` gives it as it stood in the file),
 *   the lines after the table, which chain the table belongs to (said by the line above it), whether it carries the lint
 *   line of a result set once, and whether it works out SERVER_DIR;
 *   throws when the text is not such a module
 */
export function readModule(moduleText) {
  const lines = moduleText.split('\n');
  const open = lines.indexOf(OPEN_LINE);
  if (open === -1) throw new Error('the module has no table of branches');
  const kind = KINDS.find((known) => typeLines(known).includes(lines[open - 1]));
  if (!kind) throw new Error('the table of branches does not say what it holds on the line above it');
  const entries = [];
  let at = open + 1;
  while (at < lines.length && lines[at] !== CLOSE_LINE) {
    if (lines[at] === '') { at += 1; continue; }
    const head = readHead(lines[at]);
    const end = lines.indexOf(ENTRY_END, at + 1);
    if (!head || end === -1) throw new Error(`line ${at + 1} of the module is not the start of a branch`);
    const body = lines.slice(at + 1, end);
    if (kind.result && (body.length < 2 || body[0] !== firstLine(kind) || body.at(-1) !== lastLine(kind))) {
      throw new Error(`the function of ${head.key} does not declare ${kind.result} first and give it back last`);
    }
    entries.push({ ...head, lines: kind.result ? body.slice(1, -1) : body });
    at = end + 1;
  }
  if (at >= lines.length) throw new Error('the table of branches is not closed');
  const head = lines.slice(0, open - 1);
  return { head, entries, tail: lines.slice(at + 1), kind, setOnce: head.includes(SET_ONCE_LINE), home: head.includes(HOME_LINE) };
}

/**
 * Puts bodies back where their calls stand.
 * @param {string} text the file with the handler
 * @param {object} job
 * @param {string} job.local the name the file requires the table under
 * @param {Map<string, string[]>} job.bodies key to the lines of its body
 * @param {Set<string>} [job.keys] only these; every call of `local` when left out
 * @param {boolean} [job.dropRequire] also take away the line that requires the table, and the blank line that
 *   came with it when it was the last such line
 * @param {typeof ROUTES} [job.kind] which chain the table belongs to
 * @returns {string}
 */
export function putBack(text, { local, bodies, keys, dropRequire = false, kind = ROUTES }) {
  const lines = text.split('\n');
  const out = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const call = readCall(line, kind);
    if (call && call.local === local && (!keys || keys.has(call.key))) {
      if (!bodies.has(call.key)) throw new Error(`the module has no body for ${call.key}`);
      out.push(...bodies.get(call.key));
      continue;
    }
    if (dropRequire && readRequire(line)?.local === local) {
      const alone = !(out.length && readRequire(out.at(-1))) && !readRequire(lines[at + 1] ?? '');
      if (alone && lines[at + 1] === '') at += 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The file as it read before any body left it: every call replaced by its body, every table's require gone.
 * @param {string} text @param {(spec: string) => string} moduleTextOf the text of a required module, by the path as written
 * @returns {string}
 */
export function undoBranchesText(text, moduleTextOf) {
  const tables = text.split('\n').map(readRequire).filter(Boolean);
  return tables.reduce((out, { local, spec }) => {
    const table = readModule(moduleTextOf(spec));
    return putBack(out, { local, dropRequire: true, kind: table.kind, bodies: new Map(table.entries.map((entry) => [entry.key, oldPlaces(entry.lines, { home: table.home, spec })])) });
  }, text);
}
