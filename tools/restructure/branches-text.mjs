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
// Text only, no parser: the tests that read the engine as text put the bodies back
// with this file (server/test/engine-source.mjs), and the proof of a move does too.

import { KINDS, ROUTES } from './branches-kinds.mjs';

/** What a route's body may use of the handler besides `req` and `res`, in the order it is handed over. */
export const CONTEXT = ROUTES.context;

const WORD = String.raw`[A-Za-z_$][\w$]*`;
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const handed = (kind) => [...kind.leading, `{ ${kind.context.join(', ')} }`].join(', ');
const before = (kind) => `${kind.indent}${kind.result ? `${kind.result} = ` : ''}await `;
const CALLS = new Map(KINDS.map((kind) => [kind, new RegExp(String.raw`^${quote(before(kind))}(${WORD})\['(${kind.key})'\]\(${quote(handed(kind))}\);$`)]));
const REQUIRE = new RegExp(String.raw`^const \{ branches: (${WORD}) \} = require\('(\./[^']+)'\);$`);
const HEAD = /^ {2}'([^'\\]+)': async \(([^)]*)\) => \{$/;

/** Says what the table holds, so the type check reads a call with every value of the handler as a call of any of its functions. */
export const typeLine = (kind) => `/** @type {Record<string, ${kind.type}>} */`;
export const TYPE_LINE = typeLine(ROUTES);
export const OPEN_LINE = 'const branches = {';
export const CLOSE_LINE = '};';
export const ENTRY_END = '  },';
export const EXPORT_LINE = 'module.exports = { branches };';

export const callLine = (local, key, kind = ROUTES) => `${before(kind)}${local}['${key}'](${handed(kind)});`;
export const requireLine = (local, spec) => `const { branches: ${local} } = require('${spec}');`;
export const headLine = (key, params) => `  '${key}': async (${params}) => {`;
// A body that assigns the result stands between the line that declares it and the line that gives it back.
const firstLine = (kind) => `${kind.indent}let ${kind.result};`;
const lastLine = (kind) => `${kind.indent}return ${kind.result};`;
/** @param {string[]} lines a body as it stood in the file @returns {string[]} the lines of its function in the table */
export const entryLines = (lines, kind = ROUTES) => (kind.result ? [firstLine(kind), ...lines, lastLine(kind)] : lines);

/** @param {string} line @returns {{ local: string, key: string } | null} */
export const readCall = (line, kind = ROUTES) => { const m = CALLS.get(kind).exec(line); return m ? { local: m[1], key: m[2] } : null; };
/** @param {string} line @returns {{ local: string, spec: string } | null} */
export const readRequire = (line) => { const m = REQUIRE.exec(line); return m ? { local: m[1], spec: m[2] } : null; };
/** @param {string} line @returns {{ key: string, params: string } | null} */
export const readHead = (line) => { const m = HEAD.exec(line); return m ? { key: m[1], params: m[2] } : null; };

/** A line of a body that would be taken for the module's own frame when read back. */
export const frameLine = (line) => line === ENTRY_END || line === CLOSE_LINE || line === OPEN_LINE || KINDS.some((kind) => line === typeLine(kind)) || HEAD.test(line);

/**
 * @param {string} moduleText a module the command wrote
 * @returns {{ head: string[], entries: { key: string, params: string, lines: string[] }[], tail: string[], kind: typeof ROUTES }}
 *   the lines before the table, every body in order as it stood in the file, the lines after the table, and which
 *   chain the table belongs to (said by the line above it); throws when the text is not such a module
 */
export function readModule(moduleText) {
  const lines = moduleText.split('\n');
  const open = lines.indexOf(OPEN_LINE);
  if (open === -1) throw new Error('the module has no table of branches');
  const kind = KINDS.find((known) => lines[open - 1] === typeLine(known));
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
  return { head: lines.slice(0, open - 1), entries, tail: lines.slice(at + 1), kind };
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
    return putBack(out, { local, dropRequire: true, kind: table.kind, bodies: new Map(table.entries.map((entry) => [entry.key, entry.lines])) });
  }, text);
}
