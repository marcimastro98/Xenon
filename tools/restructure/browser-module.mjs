// Turns one classic script into an ES module: the way out of the page's shared
// scope, a leaf at a time. Two things change for a script that becomes a module:
// it runs after every classic script of the page, once the page is read to its
// end, and its top-level names are its own. So a script is converted only where
// neither can be seen:
//   - pages load it with a plain tag, and after that tag come only modules and
//     the end of the page: it already ran last, with the whole page above it;
//   - nothing else loads it: no list of files a page is built from, no loader in
//     a script, no `require` (each of them would run it as a classic script);
//   - no other file has one of its top-level names as a word;
//   - it is strict already, and uses nothing that means something else in a module.
// The conversion is `type="module"` on its tags and `export {};` as its last line,
// so that the file says what it is. It is recorded like every other move, and
// `browser verify` redoes it from the revision before.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { uncheckedPages } from './browser-check-pages.mjs';
import { followsAlone, mentionsOf, withOneSearch, withoutComments } from './browser-consumers.mjs';
import { tagsOf } from './browser-pages.mjs';
import { Refusal } from './extract-plan.mjs';
import { readTopLevel } from './top-level.mjs';

export const MODULE_LINE = 'export {};\n';
const OURS = /^server\/(?:js|components)\/.+\.js$/;
const VENDOR = /(^|\/)vendor\//;
const TEST = /(^|\/)test\//;
// Where a name of a page's script can be read from: the pages and scripts of the app, what the online
// demo adds to the dashboard, and the code the native app runs inside a page.
const READERS = ['server', 'tools/demo', 'tools/build-demo.mjs', 'apps/native/src-tauri/src'];
const READER_FILE = /\.(?:js|mjs|html|rs)$/;
// Words that mean something else in a module, or that ask when the script runs. The page's `readyState` is the
// one read off `document` or on its own (taken out of it); a socket, a stream or a video has one too, and that
// one says nothing about the page.
const OTHER_MEANING = [
  ['document.currentScript', /\bdocument\s*\.\s*currentScript\b/, 'it is null in a module'],
  ['document.write', /\bdocument\s*\.\s*write\b/, 'a module runs when the page is already read'],
  ['the page\'s readyState', /\breadyState\b(?:(?<=\bdocument\s*(?:\.\s*|\[\s*['"])readyState)|(?<![.\w$]\s*readyState))/, 'a module never sees the page still loading'],
];
const LOADS_IN_NODE = /\brequire\s*\(|\bimport\b/;

const classicTag = (url) => `<script src="${url}"></script>`;
const moduleTag = (url) => `<script type="module" src="${url}"></script>`;
const isModuleTag = (html, tag) => /\stype="module"/.test(html.slice(tag.start, tag.end));

/** @param {any} sourceFile @param {any} K @returns {boolean} whether the file says it is a module (an import or an export at its top level) */
export function saysModule(sourceFile, K) {
  return sourceFile.statements.some((node) => [K.ImportDeclaration, K.ExportDeclaration, K.ExportAssignment].includes(node.kind)
    || (node.modifiers ?? []).some((modifier) => modifier.kind === K.ExportKeyword));
}

/**
 * Why a script's place in one page keeps it a classic script (or, once converted, what is wrong with its tag).
 * @param {string} html @param {string} file repo-relative @param {string} page the page's name, for the message
 * @param {boolean} [converted] true when the page must load it as a module already
 * @returns {string[]} empty when the page does not load it, or loads it last and plainly
 */
export function placeProblems(html, file, page, converted = false) {
  const tags = tagsOf(html).filter((tag) => tag.kind === 'script');
  const mine = tags.filter((tag) => tag.file === file);
  if (mine.length === 0) return [];
  if (mine.length > 1) return [`${page} loads it ${mine.length} times`];
  const [tag] = mine;
  const problems = [];
  const written = html.slice(tag.start, tag.end);
  const wanted = converted ? moduleTag(tag.url) : classicTag(tag.url);
  if (written !== wanted) problems.push(`${page} loads it with ${written}, not with ${wanted}`);
  const waits = tags.find((other) => other.start < tag.start && /\sdefer\b/.test(html.slice(other.start, other.end)) && !isModuleTag(html, other));
  if (waits) problems.push(`${page} loads ${waits.url} with defer before it: as a module it would run after that script, not before`);
  const rest = withoutComments(html, 'page.html').slice(tag.end).replace(/<script type="module" src="[^"]*"><\/script>/g, '').replace(/<\/(?:body|html)>/g, '');
  if (rest.trim() !== '') {
    const next = tags.find((other) => other.start > tag.start && !isModuleTag(html, other));
    problems.push(next ? `${page} loads ${next.url} after it as a classic script: a module runs after every classic script of the page`
      : `${page} goes on after its tag: a module runs once the whole page is read`);
  }
  return problems;
}

// `this` outside every function: the window in a classic script, nothing in a module. An arrow function has no `this` of its own.
function readsOuterThis(K, node) {
  if (node.kind === K.ThisKeyword) return true;
  const own = [K.FunctionDeclaration, K.FunctionExpression, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor, K.ClassDeclaration, K.ClassExpression];
  if (own.includes(node.kind)) return false;
  let found = false;
  node.forEachChild((child) => { if (!found && readsOuterThis(K, child)) found = true; });
  return found;
}

/**
 * What in a script's own code would run differently as a module, and the names it would stop sharing.
 * @param {string} text @param {string} file @param {any} parser
 * @returns {{ problems: string[], names: string[] }}
 */
export function codeProblems(text, file, parser) {
  const { K } = parser;
  const sourceFile = parser.parse(text, file);
  if (saysModule(sourceFile, K)) return { problems: [`${file} is a module already`], names: [] };
  const problems = [];
  const first = sourceFile.statements[0];
  const strict = Boolean(first && first.kind === K.ExpressionStatement && first.expression.kind === K.StringLiteral && first.expression.text === 'use strict');
  if (!strict) problems.push(`${file} does not start with 'use strict': a module is always strict, so its code would run under other rules`);
  const code = withoutComments(text, file);
  for (const [word, used, why] of OTHER_MEANING) if (used.test(code)) problems.push(`${file} uses ${word}: ${why}`);
  if (sourceFile.statements.some((node) => readsOuterThis(K, node))) problems.push(`${file} reads \`this\` outside any function: the window in a classic script, nothing in a module`);
  if (!text.endsWith('\n')) problems.push(`${file} does not end with a line break`);
  return { problems, names: [...new Set(readTopLevel(sourceFile, parser).flatMap((record) => record.names))] };
}

const indexes = new Map();
// Every word of the files a page's names can be read from, with the files that have it. Read once per run.
function wordIndex(root) {
  if (indexes.has(root)) return indexes.get(root);
  const run = spawnSync('git', ['ls-files', '-z', '--', ...READERS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  const index = new Map();
  for (const file of run.stdout.split('\0').filter((name) => READER_FILE.test(name) && !TEST.test(name) && !VENDOR.test(name))) {
    const text = withoutComments(readFileSync(path.join(root, file), 'utf8'), file);
    for (const word of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (!index.has(word)) index.set(word, []);
      index.get(word).push(file);
    }
  }
  indexes.set(root, index);
  return index;
}

/**
 * @param {string} root @param {string} file repo-relative script @param {string[]} names its top-level names
 * @returns {string[]} one line per name another file has as a word (a search by word: it may be another thing of the same name)
 */
export function readElsewhere(root, file, names) {
  const index = wordIndex(root);
  return names.flatMap((name) => {
    const others = (index.get(name) ?? []).filter((other) => other !== file);
    return others.length ? [`${others[0]}${others.length > 1 ? ` and ${others.length - 1} more` : ''} has the word ${name}: it must stay a shared name until they import it`] : [];
  });
}

/**
 * Every reason a script cannot become a module today, each with its kind: `split`, `loader`, `page`, `place`, `code` or `names`.
 * @param {{ root: string, parser: any, file: string, ledger: { moves: any[] }, pages: { page: string, html: string }[] }} job
 *   `pages`: every page of the app with its text, the ones the engine builds from a list too (browser-state.mjs)
 * @returns {{ reasons: { kind: string, text: string }[], names: string[] }}
 */
export function moduleReasons({ root, parser, file, ledger, pages }) {
  const reasons = [];
  const say = (kind, texts) => reasons.push(...[texts].flat().map((text) => ({ kind, text })));
  if (!OURS.test(file) || VENDOR.test(file)) { say('page', `${file} is not a script of ours that a page loads`); return { reasons, names: [] }; }
  let text;
  try { text = readFileSync(path.join(root, file), 'utf8'); } catch { say('page', `${file} does not exist`); return { reasons, names: [] }; }
  const split = ledger.moves.find((move) => ['script', 'inline', 'inner'].includes(move.kind) && (move.from === file || move.file === file));
  if (split) say('split', split.kind === 'inline' ? `it was written inside ${split.from}, which must load it with a plain tag` : `it is one of the scripts ${split.from} is split into: they share their names through the page's scope`);
  for (const mention of mentionsOf(root, file)) {
    const where = `${mention.file}:${mention.lines.slice(0, 3).join(',')}`;
    if (mention.kind === 'list') say('loader', `${mention.file} holds it in a list a page is built from: the engine writes that tag as a classic script`);
    else if (mention.kind === 'page') say('page', uncheckedPages([mention.file]).map((page) => `the page check never opens ${page}`));
    else if (mention.kind === 'code' && !followsAlone(mention.file)) say('loader', `${where} names it in code: a loader or a require would run it as a classic script`);
    else if (mention.kind === 'test') {
      const lines = readFileSync(path.join(root, mention.file), 'utf8').split('\n');
      if (mention.lines.some((line) => LOADS_IN_NODE.test(lines[line - 1]))) say('loader', `${where} loads it in Node, where it runs as a classic script`);
    }
  }
  const loaders = pages.filter(({ html }) => tagsOf(html).some((tag) => tag.file === file));
  if (loaders.length === 0) say('page', 'no page loads it with a tag');
  for (const { page, html } of loaders) say('place', placeProblems(html, file, page));
  const code = codeProblems(text, file, parser);
  say('code', code.problems);
  say('names', readElsewhere(root, file, code.names));
  return { reasons, names: code.names };
}

/**
 * The conversion as texts: every page's tag for the script, and the script with its last line.
 * @param {{ get: (file: string) => string | null }} tree @param {{ kind: 'module', file: string }} move
 * @param {{ parser: any, pages: string[] }} context
 * @returns {{ files: Map<string, string>, made: string[], record: any }} Throws a Refusal when the script's code or place forbids it.
 */
export function moduleMove(tree, move, { parser, pages }) {
  const text = tree.get(move.file);
  if (text === null) throw new Refusal([`${move.file} does not exist`]);
  const code = codeProblems(text, move.file, parser);
  const reasons = [...code.problems];
  const files = new Map();
  for (const page of pages) {
    const html = tree.get(page);
    const tag = html === null ? null : tagsOf(html).find((entry) => entry.kind === 'script' && entry.file === move.file);
    if (!tag) continue;
    const problems = placeProblems(html, move.file, page);
    reasons.push(...problems);
    if (problems.length === 0) files.set(page, html.slice(0, tag.start) + moduleTag(tag.url) + html.slice(tag.end));
  }
  if (files.size === 0 && reasons.length === 0) reasons.push(`no page loads ${move.file} with a tag`);
  if (reasons.length) throw new Refusal(reasons);
  files.set(move.file, text + MODULE_LINE);
  return { files, made: [], record: { kind: 'module', file: move.file, names: code.names } };
}

/**
 * What must stay true of a converted script as long as the repo lives.
 * @param {string} file @param {string} text @param {{ page: string, html: string }[]} pages @param {any} parser
 * @returns {string[]} problems
 */
export function moduleStateProblems(file, text, pages, parser) {
  const problems = [];
  if (!saysModule(parser.parse(text, file), parser.K)) problems.push(`${file} is recorded as a module and has no import or export left`);
  const loaders = pages.filter(({ html }) => tagsOf(html).some((tag) => tag.file === file));
  if (loaders.length === 0) problems.push(`no page loads ${file}`);
  for (const { page, html } of loaders) problems.push(...placeProblems(html, file, page, true).map((problem) => `${file}: ${problem}`));
  return problems;
}

/**
 * Every script of ours with the reasons that keep it a classic script, for the list of what can be converted next.
 * @param {{ root: string, parser: any, ledger: { moves: any[] }, pages: { page: string, html: string }[] }} job
 * @returns {{ file: string, module: boolean, names: string[], reasons: { kind: string, text: string }[] }[]}
 */
export function candidates({ root, parser, ledger, pages }) {
  const run = spawnSync('git', ['ls-files', '-z', '--', 'server/js', 'server/components'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  const done = new Set(ledger.moves.filter((move) => move.kind === 'module').map((move) => move.file));
  const files = run.stdout.split('\0').filter((file) => OURS.test(file) && !VENDOR.test(file)).sort();
  // Who names each script is asked of the whole repo: one search for all of them, not one each.
  return withOneSearch(root, files, () => files.map((file) => (done.has(file)
    ? { file, module: true, names: [], reasons: [] } : { file, module: false, ...moduleReasons({ root, parser, file, ledger, pages }) })));
}
