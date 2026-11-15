// Finds every place in the repo that names a file about to move to another folder, and says what the place is:
// a `require` or `import` (rewritten wherever it stands), a path a test or a tool puts together (rewritten when the
// tool can work out that it ends at the file), a mention in a comment, a list or a document (rewritten), or
// something that stops the move: a path built by code that ships, a line of an installer, a spelling the tool
// cannot follow. Nothing is written here; move-apply.mjs writes what this hands back.

import path from 'node:path';

import { pathValueOf } from './move-values.mjs';

const posix = path.posix;
const JS_FILE = /\.(js|mjs|cjs)$/;
// Text only a person or the operating system runs: a file named there is called by that path on a user's PC.
const RUN_BY_PATH = /\.(ps1|psm1|sh|bat|cmd|vbs|command|nsh|rs|cs|swift|toml|plist|csproj|html|htm|service|desktop|iss|wxs)$/;
// History and the live site keep the names of their day; the map and the move list name old places on purpose,
// and the test of the map's patterns spells paths as examples, not as files. So do four tests of the tools here:
// they write invented files with real names into a folder of their own.
const EXAMPLES = new Set(['structure-map', 'restructure-engine-test-readers', 'restructure-extract-inline', 'restructure-side-copy', 'restructure-browser-built-names']
  .map((name) => `server/test/${name}.test.mjs`));
const KEEPS_OLD_NAMES = (file) => file === 'CHANGELOG.md' || file === 'MAP.md' || file.startsWith('docs/') || EXAMPLES.has(file)
  || file === 'tools/map/features.json' || file === 'tools/restructure/moved.json' || file === 'tools/restructure/move-left.json';
// A mention in the service worker or in the published bridge stays as written: one changed byte makes every browser
// install the worker again, and the bridge changes only with a version of its own. A load or a path there still counts.
const MENTIONS_STAY = (file) => file === 'server/sw.js' || file.startsWith('packages/mcp/');
const SKIPPED = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|mp4|wav|ogg|webm|zip|exe|dll|pdf|lock|bin|node|svg|map)$/i;
/** @param {string} file @returns {boolean} tests, tools and CI: code that never runs on a user's PC */
export const isDevFile = (file) => /^(server\/test\/|packages\/[^/]+\/test\/|tools\/|\.github\/)/.test(file);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseOf = (file) => posix.basename(file, '.js');

/**
 * @param {{from: string, to: string}[]} moves
 * @returns {{ rooted: RegExp, token: RegExp, quick: RegExp, byBase: Map<string, {from: string, to: string}[]> }}
 */
export function patternsFor(moves) {
  const byBase = new Map();
  for (const move of moves) byBase.set(baseOf(move.from), [...(byBase.get(baseOf(move.from)) ?? []), move]);
  const names = [...byBase.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  return {
    byBase,
    // `server/x.js` with either slash, also as a regular expression spells it (`server\/x\.js`).
    rooted: new RegExp(`(?<![A-Za-z0-9_-])((?:[A-Za-z0-9_.-]+(?:\\\\?/|\\\\{1,2}))*)(${names})(\\\\?\\.)js(?![A-Za-z0-9_-])`, 'g'),
    token: new RegExp(`(?<![A-Za-z0-9_-])(${names})\\.js(?![A-Za-z0-9_-])`, 'g'),
    // `require('./x')` spelled inside a regular expression or a string: a test that pins how a file loads another.
    pinned: new RegExp(`require\\\\?\\(\\\\?['"\`](?:\\\\?\\.){1,2}\\\\?/(?:[A-Za-z0-9_.-]+\\\\?/)*(${names})(?:\\\\?\\.js)?\\\\?['"\`]`, 'g'),
    quick: new RegExp(`(?<![A-Za-z0-9_-])(${names})(\\\\?\\.js(?![A-Za-z0-9_-])|['"\`])`),
  };
}

const lineOf = (text, at) => text.slice(0, at).split('\n').length;
const stripJs = (file) => file.replace(/\.js$/, '');
const relative = (fromDir, target) => {
  const spec = posix.relative(fromDir, target);
  return spec.startsWith('.') ? spec : `./${spec}`;
};

/**
 * The new spelling of a relative path that names a moved file, kept with or without its `.js` as it was written.
 * @param {string} file the file the spelling stands in @param {string} spec @param {string} to
 */
export function respell(file, spec, to) {
  return relative(posix.dirname(file), spec.endsWith('.js') ? to : stripJs(to));
}

// Every string of a file with the nodes above it, and the top-level constants and functions a path may be built from.
export function stringsOf(tree, K) {
  const strings = [];
  const consts = new Map();
  const functions = new Map();
  const walk = (node, above) => {
    if (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral) strings.push({ node, above, whole: true });
    else if (node.kind === K.TemplateExpression) strings.push({ node, above, whole: false });
    if (node.kind === K.VariableDeclaration && node.name.kind === K.Identifier && node.initializer) {
      const fn = node.initializer.kind === K.ArrowFunction || node.initializer.kind === K.FunctionExpression;
      (fn ? functions : consts).set(node.name.text, node.initializer);
    }
    if (node.kind === K.FunctionDeclaration && node.name) functions.set(node.name.text, node);
    const next = [node, ...above];
    node.forEachChild((child) => { walk(child, next); });
  };
  walk(tree, []);
  return { strings, consts, functions };
}

// Is this string the thing a `require`, an `import` or a `require.resolve` loads?
export function isLoad(K, node, parent) {
  if (!parent) return false;
  if (parent.kind === K.ImportDeclaration || parent.kind === K.ExportDeclaration) return parent.moduleSpecifier === node;
  if (parent.kind !== K.CallExpression || parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  if (callee.kind === K.ImportKeyword) return true;
  if (callee.kind === K.Identifier) return callee.text === 'require';
  if (callee.kind === K.PropertyAccessExpression) return callee.expression.kind === K.Identifier && callee.expression.text === 'require' && callee.name.text === 'resolve';
  return callee.kind === K.CallExpression && callee.expression.kind === K.Identifier && callee.expression.text === 'createRequire';
}

/**
 * Every relative path a file loads with `require`, `import` or `require.resolve`.
 * @param {string} text @param {any} tree @param {any} K
 * @returns {{start: number, end: number, was: string}[]} the place of each spelling, without its quotes
 */
export function loadsOf(text, tree, K) {
  return stringsOf(tree, K).strings
    .filter(({ node, above, whole }) => whole && /^\.{1,2}(\/|$)/.test(node.text) && isLoad(K, node, above[0]))
    .map(({ node }) => ({ start: node.getStart(tree) + 1, end: node.end - 1, was: node.text }))
    .filter((load) => text.slice(load.start, load.end) === load.was);
}

/**
 * What one JavaScript file says about the files that move.
 * @returns {{ sites: object[], spans: [number, number][] }} `spans` are all strings of the file, for the text pass
 */
function jsSites(file, text, tree, K, patterns, tracked) {
  const { strings, consts, functions } = stringsOf(tree, K);
  const sites = [];
  const spans = [];
  const dir = posix.dirname(file);
  for (const { node, above, whole } of strings) {
    const start = node.getStart(tree);
    spans.push([start, node.end]);
    if (!whole) {
      // A template with a value in it (`${SERVER}/x.js`): only the rooted spelling can be followed.
      const named = tokenSites(file, text.slice(start, node.end), patterns, tracked).filter((site) => !/server[\\/]+$/.test(text.slice(0, start + site.start)));
      sites.push(...named.map((site) => ({ ...site, start: start + site.start, end: start + site.end, line: lineOf(text, start), kind: 'unknown', why: 'a template puts its path together' })));
      continue;
    }
    const value = node.text;
    const last = value.split(/[\\/]/).pop();
    const moves = patterns.byBase.get(last.endsWith('.js') ? last.slice(0, -3) : last);
    if (!moves || text.slice(start + 1, node.end - 1) !== value) continue;
    const dotted = value.startsWith('./') || value.startsWith('../');
    if (!last.endsWith('.js') && !dotted) continue;
    const at = { file, line: lineOf(text, start), start: start + 1, end: node.end - 1, was: value };
    const lexical = dotted ? posix.join(dir, value) : null;
    const named = lexical && moves.find((move) => move.from === lexical || stripJs(move.from) === lexical);
    if (isLoad(K, node, above[0])) {
      if (named) sites.push({ ...at, kind: 'load', move: named, text: respell(file, value, named.to) });
      continue;
    }
    const full = pathValueOf({ K, file, node, above, consts, functions });
    const built = full && moves.find((move) => `/${move.from}` === full);
    if (built) {
      const to = posix.relative(posix.dirname(built.from), built.to);
      sites.push({ ...at, kind: 'path', move: built, text: value.slice(0, value.length - last.length) + to });
    } else if (named && !full) {
      // Read from where the file stands it is the moved file: taken as that. In code that ships this stops the move.
      sites.push({ ...at, kind: 'path', move: named, text: respell(file, value, named.to) });
    } else if (moves.some((move) => posix.normalize(value).endsWith(move.from))) {
      continue; // the whole path from the repo root: the text pass below rewrites it
    } else if (!full && !value.includes('/') && !value.includes('\\')) {
      // A bare `x.js`: it may be joined to any folder. When that folder holds another `x.js` nothing can tell which.
      for (const move of moves) sites.push({ ...at, kind: 'unknown', move, why: `the bare name '${value}', joined to a folder the tool cannot work out` });
    } else if (!full && !another(tracked, [posix.normalize(value), posix.join('server', value), posix.join('server/js', value), lexical], moves)) {
      for (const move of moves) sites.push({ ...at, kind: 'unknown', move, why: `'${value}' names no file the tool can find` });
    }
  }
  const loads = sites.filter((site) => site.kind === 'load');
  for (const match of text.matchAll(patterns.pinned)) {
    const end = match.index + match[0].length;
    const quoted = match[0].includes('\\') || spans.some(([from, to]) => match.index > from && end < to);
    if (!quoted || loads.some((site) => site.start >= match.index && site.end <= end)) continue;
    for (const move of patterns.byBase.get(match[1])) sites.push({ file, line: lineOf(text, match.index), start: match.index, end, was: match[0], kind: 'unknown', move, why: 'a test pins how it is required' });
  }
  return { sites, spans };
}

// Does one of these spellings name a tracked file that is not moving?
const another = (tracked, candidates, moves) => candidates.some((file) => file && tracked.has(file) && !moves.some((move) => move.from === file));

// `server/x.js` written anywhere in a text: in a comment, a list, a document, or inside a longer string.
function rootedSites(file, text, patterns, taken) {
  const sites = [];
  for (const match of text.matchAll(patterns.rooted)) {
    const [all, prefix, base, dot] = match;
    const folders = prefix.replace(/\\\\|\\\/|\\/g, '/');
    if (!/(^|\/)server\/$/.test(folders)) continue;
    const move = (patterns.byBase.get(base) ?? []).find((candidate) => candidate.from === `server/${base}.js`);
    if (!move) continue;
    const start = match.index;
    const end = start + all.length;
    if (taken.some(([from, to, handled]) => handled && start >= from && end <= to)) continue;
    const separator = prefix.slice(prefix.toLowerCase().lastIndexOf('server') + 6);
    const added = posix.relative('server', posix.dirname(move.to)).split('/').join(separator) + separator;
    const inString = taken.some(([from, to]) => start >= from && end <= to);
    sites.push({ file, line: lineOf(text, start), start, end, was: all, kind: inString ? 'string' : 'text', move, text: `${prefix}${added}${base}${dot}js` });
  }
  return sites;
}

// Is this place of an installer, a page or a native source file inside a comment?
export function inComment(file, text, at) {
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  if (/\.(html|htm)$/.test(file) && text.lastIndexOf('<!--', at) > text.lastIndexOf('-->', at)) return true;
  if (/\.(rs|cs|swift|html|htm|nsh|iss)$/.test(file)) return /\/\/|^\s*\/?\*|^\s*;/.test(line);
  if (/\.(bat|cmd)$/.test(file)) return /^\s*(rem\s|::)/i.test(line);
  if (/\.vbs$/.test(file)) return /^\s*'/.test(line);
  return /(^|\s)#/.test(line);
}

// A line of an installer or of native code that says `x.js` in any way: the file is called by path there.
function tokenSites(file, text, patterns, tracked) {
  const sites = [];
  for (const match of text.matchAll(patterns.token)) {
    const before = /[A-Za-z0-9_.\\/$-]*$/.exec(text.slice(Math.max(0, match.index - 120), match.index))[0].replace(/\\/g, '/');
    const folder = before.replace(/^.*?(?=(?:[a-z0-9-]+\/)*$)/, '');
    if (inComment(file, text, match.index)) continue;
    const other = folder && [`server/${folder}${match[1]}.js`, `${folder}${match[1]}.js`].some((candidate) => tracked.has(candidate) && !/^server\/[^/]+$/.test(candidate));
    if (other) continue;
    for (const move of patterns.byBase.get(match[1]) ?? []) {
      sites.push({ file, line: lineOf(text, match.index), start: match.index, end: match.index + match[0].length, was: match[0], kind: 'runs', move, why: 'an installer, a page or native code names it' });
    }
  }
  return sites;
}

/**
 * Every place that names a file of `moves`.
 * @param {{ files: string[], read: (file: string) => string, parser: any, moves: {from: string, to: string}[] }} input
 * @returns {object[]} sites: { file, line, start, end, was, kind, move, text?, why? }. `kind` is `load`, `path`,
 *   `text` or `string` (all four have the new `text`), or `unknown` / `runs` (the move cannot be made).
 */
export function findSites({ files, read, parser, moves }) {
  const patterns = patternsFor(moves);
  const tracked = new Set(files);
  const out = [];
  for (const file of files) {
    if (SKIPPED.test(file) || KEEPS_OLD_NAMES(file)) continue;
    const text = read(file);
    if (text === null || !patterns.quick.test(text)) continue;
    if (RUN_BY_PATH.test(file)) { out.push(...tokenSites(file, text, patterns, tracked)); continue; }
    if (!JS_FILE.test(file)) { out.push(...rootedSites(file, text, patterns, [])); continue; }
    const { sites, spans } = jsSites(file, text, parser.parse(text, file), parser.K, patterns, tracked);
    const handled = new Set(sites.filter((site) => site.text !== undefined).map((site) => site.start - 1));
    out.push(...sites, ...rootedSites(file, text, patterns, spans.map(([from, to]) => [from, to, handled.has(from)])));
  }
  return out.filter((site) => !(site.kind === 'text' && MENTIONS_STAY(site.file)));
}

/**
 * Why a site stops its move, or null when the site can be rewritten.
 * @param {object} site from findSites
 */
export function stops(site) {
  if (site.kind === 'unknown' || site.kind === 'runs') return site.why;
  const ships = !isDevFile(site.file);
  if (site.kind === 'path' && ships) return 'code that ships puts its path together: it is read, started or served by path';
  if (site.kind === 'string' && ships && JS_FILE.test(site.file)) return 'code that ships holds its path in a string';
  if (site.kind === 'text' && ships && /(^|\/)package\.json$|^server\.json$/.test(site.file)) return 'a package file names it';
  return null;
}
