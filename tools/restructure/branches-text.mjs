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
// Text only, no parser: the tests that read the engine as text put the bodies back
// with this file (server/test/engine-source.mjs), and the proof of a move does too.

/** What a body may use of the handler besides `req` and `res`, in the order it is handed over. */
export const CONTEXT = Object.freeze(['json', 'err500', 'reqPath', 'urlObj', 'isRemote']);

const WORD = String.raw`[A-Za-z_$][\w$]*`;
const KEY = String.raw`[A-Z]+ /[^'\\]*`;
const CALL = new RegExp(String.raw`^ {4}await (${WORD})\['(${KEY})'\]\(req, res, \{ ${CONTEXT.join(', ')} \}\);$`);
const REQUIRE = new RegExp(String.raw`^const \{ branches: (${WORD}) \} = require\('(\./[^']+)'\);$`);
const HEAD = new RegExp(String.raw`^ {2}'(${KEY})': async \(([^)]*)\) => \{$`);

// Says what the table holds, so the type check reads a call with the handler's five values as a call of any
// of its functions, whichever of them a body takes.
export const TYPE_LINE = '/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */';
export const OPEN_LINE = 'const branches = {';
export const CLOSE_LINE = '};';
export const ENTRY_END = '  },';
export const EXPORT_LINE = 'module.exports = { branches };';

export const callLine = (local, key) => `    await ${local}['${key}'](req, res, { ${CONTEXT.join(', ')} });`;
export const requireLine = (local, spec) => `const { branches: ${local} } = require('${spec}');`;
export const headLine = (key, params) => `  '${key}': async (${params}) => {`;

/** @param {string} line @returns {{ local: string, key: string } | null} */
export const readCall = (line) => { const m = CALL.exec(line); return m ? { local: m[1], key: m[2] } : null; };
/** @param {string} line @returns {{ local: string, spec: string } | null} */
export const readRequire = (line) => { const m = REQUIRE.exec(line); return m ? { local: m[1], spec: m[2] } : null; };
/** @param {string} line @returns {{ key: string, params: string } | null} */
export const readHead = (line) => { const m = HEAD.exec(line); return m ? { key: m[1], params: m[2] } : null; };

/** A line of a body that would be taken for the module's own frame when read back. */
export const frameLine = (line) => line === ENTRY_END || line === CLOSE_LINE || line === OPEN_LINE || line === TYPE_LINE || HEAD.test(line);

/**
 * @param {string} moduleText a module the command wrote
 * @returns {{ head: string[], entries: { key: string, params: string, lines: string[] }[], tail: string[] }}
 *   the lines before the table, every body in order, and the lines after it; throws when the text is not such a module
 */
export function readModule(moduleText) {
  const lines = moduleText.split('\n');
  const open = lines.indexOf(OPEN_LINE);
  if (open === -1) throw new Error('the module has no table of branches');
  if (lines[open - 1] !== TYPE_LINE) throw new Error('the table of branches does not say what it holds on the line above it');
  const entries = [];
  let at = open + 1;
  while (at < lines.length && lines[at] !== CLOSE_LINE) {
    if (lines[at] === '') { at += 1; continue; }
    const head = readHead(lines[at]);
    const end = lines.indexOf(ENTRY_END, at + 1);
    if (!head || end === -1) throw new Error(`line ${at + 1} of the module is not the start of a branch`);
    entries.push({ ...head, lines: lines.slice(at + 1, end) });
    at = end + 1;
  }
  if (at >= lines.length) throw new Error('the table of branches is not closed');
  return { head: lines.slice(0, open - 1), entries, tail: lines.slice(at + 1) };
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
 * @returns {string}
 */
export function putBack(text, { local, bodies, keys, dropRequire = false }) {
  const lines = text.split('\n');
  const out = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const call = readCall(line);
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
  return tables.reduce((out, { local, spec }) => putBack(out, { local, dropRequire: true,
    bodies: new Map(readModule(moduleTextOf(spec)).entries.map((entry) => [entry.key, entry.lines])) }), text);
}
