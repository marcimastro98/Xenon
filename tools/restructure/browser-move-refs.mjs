// Finds every place that names a browser script about to move inside `server/js/`, and says what the place is.
// A browser script has three names: its file (`server/js/x.js`, in lists, tests and notes), its address
// (`js/x.js`, what a page asks the engine for) and the relative path a `require` or an `import` loads. Each place
// gets its new spelling, or stops the move: an address held by code that ships and asks for it after the page
// started (a tab left open across an update would ask for the old one), a path code that ships puts together,
// a line of native code or of the service worker that names it. Nothing is written here.

import path from 'node:path';

import { inComment, isDevFile, isLoad, respell, stringsOf } from './move-refs.mjs';
import { pathValueOf } from './move-values.mjs';

const posix = path.posix;
const JS_FILE = /\.(js|mjs|cjs)$/;
const PAGE = /^server\/[^/]+\.html$/;
// Source text that is not JavaScript and still runs, or is read by what runs: a name there is called by that spelling.
const RUNS = /\.(ps1|psm1|sh|bat|cmd|vbs|command|nsh|rs|cs|swift|toml|plist|csproj|html|htm|service|desktop|iss|wxs)$/;
const SKIPPED = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|mp4|wav|ogg|webm|zip|exe|dll|pdf|lock|bin|node|svg|map)$/i;
// History, the live site and the lists of the move tools keep the names of their day; the map is written again.
const KEEPS_OLD_NAMES = (file) => file === 'CHANGELOG.md' || file === 'MAP.md' || file.startsWith('docs/') || file === 'tools/map/features.json'
  || /^tools\/restructure\/(moved|move-left|browser-moved|browser-move-left)\.json$/.test(file) || file === 'server/test/structure-map.test.mjs';
// One changed byte reinstalls the service worker, and the bridge changes only with a version of its own: a note
// there stays as written. A package and the iCUE widget have a `js/` folder of their own: `js/x.js` there is theirs.
const OWN_JS_FOLDER = /^(packages|widget|icue-widget)\//;
const MENTIONS_STAY = (file) => file === 'server/sw.js' || OWN_JS_FOLDER.test(file);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseOf = (file) => posix.basename(file, '.js');
const stripJs = (file) => file.replace(/\.js$/, '');
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

/** @param {{from: string, to: string}[]} moves */
export function patternsFor(moves) {
  const byBase = new Map(moves.map((move) => [baseOf(move.from), move]));
  const names = [...byBase.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  return {
    byBase,
    // Folders, the name, `.js`; a slash or a dot may be escaped as a regular expression spells them.
    token: new RegExp(`(?<![A-Za-z0-9_-])((?:[A-Za-z0-9_.-]+\\\\?/)*)(${names})(\\\\?\\.)js(?![A-Za-z0-9_-])`, 'g'),
    quick: new RegExp(`(?<![A-Za-z0-9_-])(${names})(\\\\?\\.js(?![A-Za-z0-9_-])|['"\`])`),
  };
}

// The folder a script goes into, read from where it was: `deck` for server/js/x.js -> server/js/deck/x.js.
const added = (move) => posix.relative(posix.dirname(move.from), posix.dirname(move.to));

// What the folders written before a name say the name is: the file from the repo root, the address a page asks
// for, a path relative to the file it stands in, or something else that only looks alike.
function spelling(file, folders, move) {
  const plain = folders.replace(/\\/g, '');
  if (plain === `${posix.dirname(move.from)}/` || plain.endsWith(`/${posix.dirname(move.from)}/`)) return 'rooted';
  if (plain === 'js/' || plain === './js/') return 'address';
  if (!plain.startsWith('.')) return null;
  return posix.join(posix.dirname(file), plain, posix.basename(move.from)) === move.from ? 'relative' : null;
}

// The new spelling of a token: the folder goes in right before the name, with the slash the token uses.
function respelled(match, move) {
  const [, folders, base, dot] = match;
  const slash = /\\\/$/.test(folders) ? '\\/' : '/';
  return `${folders}${added(move).split('/').join(slash)}${slash}${base}${dot}js`;
}

// Is this place of a page inside the `src` of a script tag?
function inScriptSrc(text, at) {
  const tag = text.slice(text.lastIndexOf('<', at), at);
  return /^<script\b[^>]*\bsrc=["'][^"']*$/.test(tag);
}

/**
 * The tokens of one text, each with the kind of place it stands in.
 * @param {string} file @param {string} text @param {ReturnType<typeof patternsFor>} patterns
 * @param {(at: number) => 'string' | 'regex' | 'handled' | null} inside what JavaScript holds the place (null: a comment, or not JavaScript)
 */
function tokenSites(file, text, patterns, inside, lists) {
  const sites = [];
  for (const match of text.matchAll(patterns.token)) {
    const move = patterns.byBase.get(match[2]);
    const kindOfName = move && spelling(file, match[1], move);
    if (!kindOfName || (kindOfName === 'address' && OWN_JS_FOLDER.test(file))) continue;
    const start = match.index;
    const holder = inside(start);
    if (holder === 'handled') continue;
    const site = { file, line: lineOf(text, start), start, end: start + match[0].length, was: match[0], move, text: respelled(match, move) };
    const code = holder === 'string' || holder === 'regex';
    const ships = !isDevFile(file);
    if (file === 'server/sw.js' && code) sites.push({ ...site, kind: 'runs', why: 'the service worker names it' });
    else if (JS_FILE.test(file) && !code) { if (!MENTIONS_STAY(file)) sites.push({ ...site, kind: 'mention' }); }
    else if (JS_FILE.test(file) && kindOfName === 'address') sites.push(ships && !lists.has(file) ? { ...site, kind: 'asks', why: 'code that ships asks for it by address after the page has started' } : { ...site, kind: 'address' });
    else if (JS_FILE.test(file)) sites.push(ships ? { ...site, kind: 'held', why: 'code that ships holds its path in a string' } : { ...site, kind: kindOfName });
    else if (PAGE.test(file) && kindOfName === 'address' && inScriptSrc(text, start)) sites.push({ ...site, kind: 'src' });
    else if (RUNS.test(file) && !inComment(file, text, start)) {
      // A page of a tool serves `server/` as the app does: its script tags follow the move like the app's.
      const follows = !ships && (kindOfName !== 'address' || (/\.html?$/.test(file) && inScriptSrc(text, start)));
      sites.push(follows ? { ...site, kind: kindOfName } : { ...site, kind: 'runs', why: 'a page outside its script tags, an installer or native code names it' });
    } else if (!MENTIONS_STAY(file)) sites.push({ ...site, kind: 'mention' });
  }
  return sites;
}

// The strings of a JavaScript file that are a load or a path put together: handled whole, with the tree.
function literalSites(file, text, tree, K, patterns) {
  const { strings, consts, functions } = stringsOf(tree, K);
  const sites = [];
  const spans = [];
  const dir = posix.dirname(file);
  const walk = (node) => {
    if (node.kind === K.RegularExpressionLiteral) spans.push([node.getStart(tree), node.end, 'regex']);
    node.forEachChild(walk);
  };
  walk(tree);
  for (const { node, above, whole } of strings) {
    const start = node.getStart(tree);
    const span = [start, node.end, 'string'];
    spans.push(span);
    if (!whole) continue;
    const value = node.text;
    const last = value.split(/[\\/]/).pop();
    const move = patterns.byBase.get(last.endsWith('.js') ? last.slice(0, -3) : last);
    if (!move || text.slice(start + 1, node.end - 1) !== value) continue;
    const dotted = value.startsWith('./') || value.startsWith('../');
    const lexical = dotted ? posix.join(dir, value) : null;
    const named = lexical === move.from || lexical === stripJs(move.from);
    const at = { file, line: lineOf(text, start), start: start + 1, end: node.end - 1, was: value, move };
    if (isLoad(K, node, above[0])) {
      if (named) { sites.push({ ...at, kind: 'load', text: respell(file, value, move.to) }); span[2] = 'handled'; }
      continue;
    }
    if (!last.endsWith('.js')) continue;
    const full = pathValueOf({ K, file, node, above, consts, functions });
    if (full === `/${move.from}`) {
      sites.push({ ...at, kind: 'path', text: `${value.slice(0, value.length - last.length)}${added(move)}/${last}` });
      span[2] = 'handled';
    } else if (named && !full) {
      sites.push({ ...at, kind: 'path', text: respell(file, value, move.to) });
      span[2] = 'handled';
    } else if (value === last && !full) {
      // A bare `x.js`, joined to a folder the tool cannot work out. In a test or a tool it is only told, and the
      // tests say whether it was the file; in code that ships it may become an address, so the script stays.
      sites.push(isDevFile(file) ? { ...at, kind: 'bare' } : { ...at, kind: 'bare', why: 'code that ships holds its bare name, and may put it into an address' });
      span[2] = 'handled';
    }
  }
  return { sites, spans };
}

/**
 * Every place that names a script of `moves`.
 * @param {{ files: string[], read: (file: string) => string | null, parser: any, moves: {from: string, to: string}[], lists?: Set<string> }} input
 *   `lists` are the files of the app whose strings are the scripts of a page the engine writes when the page is asked for
 * @returns {object[]} sites: { file, line, start, end, was, kind, move, text?, why? }. `load`, `path`, `src`, `address`, `rooted`,
 *   `relative` and `mention` have the new `text`; `bare` is only told; `asks`, `held` and `runs` stop the move.
 */
export function findBrowserSites({ files, read, parser, moves, lists = new Set() }) {
  if (!moves.length) return [];
  const patterns = patternsFor(moves);
  const out = [];
  for (const file of files) {
    if (SKIPPED.test(file) || KEEPS_OLD_NAMES(file)) continue;
    const text = read(file);
    if (text === null || !patterns.quick.test(text)) continue;
    if (!JS_FILE.test(file)) { out.push(...tokenSites(file, text, patterns, () => null, lists)); continue; }
    const { sites, spans } = literalSites(file, text, parser.parse(text, file), parser.K, patterns);
    const inside = (at) => spans.find(([from, to]) => at >= from && at < to)?.[2] ?? null;
    out.push(...sites, ...tokenSites(file, text, patterns, inside, lists));
  }
  return out;
}

/** @param {object} site from findBrowserSites @returns {string | null} why the site stops its move */
export function stops(site) {
  if (site.why) return site.why;
  if (site.kind === 'path' && !isDevFile(site.file)) return 'code that ships puts its path together: it is read or served by path';
  return null;
}
