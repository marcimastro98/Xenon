// The browser side's three numbers on the way to ES modules, each saved and only
// allowed to go down:
//   - the names scripts put in the page's shared scope (a classic script's
//     top-level function, class, var, let or const), per script. A script and the
//     files a recorded split took out of it are one line, so a split changes
//     nothing; a module, or a file whose code sits in a wrapper, has none. A new
//     script with such a name, or a new name in an old one, fails.
//   - inline `on*=` handlers written in a page (they can only call such names).
//   - names two classic scripts of the same page both declare at their top level:
//     the second silently replaces the first.
// And one thing that is never allowed: a file that says it is a module loaded as a
// classic script, or the other way round (the page would stop at its first line).
//
//   npm run browser              check
//   npm run browser -- --update  save the lower numbers after a clean-up
//
// Needs `npm run quality:install` (the scripts are read with the TypeScript parser).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBrowserLedger } from '../restructure/browser-ledger.mjs';
import { BUILT_LIST, readLists } from '../restructure/browser-lists.mjs';
import { saysModule } from '../restructure/browser-module.mjs';
import { inlineScripts, tagsOf } from '../restructure/browser-pages.mjs';
import { openParser, parserAvailable } from '../restructure/parser.mjs';
import { readTopLevel } from '../restructure/top-level.mjs';
import { readCounts, saveCounts, sum } from './baseline-file.mjs';
import { compareCounts } from './ratchet.mjs';
import { REPO_ROOT, trackedFiles } from './repo-files.mjs';

const BASELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline');
/** The three saved lists: where each lives, what it holds, and what to do when a number went up. */
export const CHECKS = {
  scripts: { file: path.join(BASELINE_DIR, 'browser-scripts.json'),
    note: 'Browser scripts that put names in the page\'s shared scope, with the number of names (a script and the files split out of it are one line). Written by tools/quality/browser.mjs: a number only goes down, a script leaves the list when it becomes a module or gets a wrapper, and none is added.',
    fix: 'No new top-level names in a classic script, and a new browser file is a module or one wrapper function.' },
  handlers: { file: path.join(BASELINE_DIR, 'browser-handlers.json'),
    note: 'Inline on*= handlers per page. Written by tools/quality/browser.mjs: a number only goes down.',
    fix: 'Use addEventListener (one listener per region on data-action) instead of a new on*= attribute.' },
  duplicates: { file: path.join(BASELINE_DIR, 'browser-duplicates.json'),
    note: 'Top-level names that two or more classic scripts of the same page declare, with the number of scripts. Written by tools/quality/browser.mjs: the list only gets shorter.',
    fix: 'Two scripts of one page declare the same top-level name: the one that loads later replaces the other. Rename one, or wrap it.' },
};

const PAGE = /^server\/[^/]+\.html$/;
const SCRIPT = /^server\/(?:js|components)\/.+\.js$/;
const VENDOR = /(^|\/)vendor\//;

/** @param {string} file repo-relative @returns {boolean} a script of ours that a page of the app can load */
export function isBrowserScript(file) {
  return SCRIPT.test(file) && !VENDOR.test(file);
}

/** @param {string} html @returns {number} the on*= attributes written in the page's own tags (not in its scripts or comments) */
export function inlineHandlers(html) {
  const tagsOnly = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  let count = 0;
  for (const tag of tagsOnly.matchAll(/<[a-zA-Z][^<>]*>/g)) count += [...tag[0].matchAll(/\son[a-z]+\s*=\s*["']/g)].length;
  return count;
}

/**
 * @param {{ moves: any[] }} ledger the recorded splits
 * @returns {(file: string) => string} the script a file was split out of (through several splits) or the page it was written in, or the file itself
 */
export function familyOf(ledger) {
  const from = new Map(ledger.moves.filter((move) => ['script', 'inline', 'inner'].includes(move.kind)).map((move) => [move.file, move.from]));
  return (file) => { let at = file; for (let hops = 0; from.has(at) && hops < 50; hops += 1) at = from.get(at); return at; };
}

/**
 * @param {string} text a script @param {any} parser
 * @returns {{ module: boolean, names: string[] }} the names a classic script leaves in the shared scope; none for a module
 */
export function sharedNames(text, parser) {
  const sourceFile = parser.parse(text, 'script.js');
  if (saysModule(sourceFile, parser.K)) return { module: true, names: [] };
  return { module: false, names: [...new Set(readTopLevel(sourceFile, parser).flatMap((record) => record.names))] };
}

/**
 * The names declared by more than one of the scripts a page runs in its shared scope.
 * @param {{ file: string, names: string[] }[]} scripts the classic scripts of one page
 * @returns {Record<string, string[]>} name -> the scripts that declare it, only when there are two or more
 */
export function duplicateNames(scripts) {
  const holders = new Map();
  for (const script of scripts) for (const name of script.names) holders.set(name, [...(holders.get(name) ?? []), script.file]);
  return Object.fromEntries([...holders].map(([name, files]) => [name, [...new Set(files)].sort()]).filter(([, files]) => files.length > 1));
}

const tagIsModule = (html, tag) => /\stype="module"/.test(html.slice(tag.start, tag.end));

/**
 * @param {string} page @param {string} html @param {(file: string) => { module: boolean } | null} read @param {string[]} builtFiles the scripts the built list can add to the page
 * @returns {string[]} the scripts the page loads as what they are not: a module by a classic tag (or by a list, which writes classic tags), a classic script as a module
 */
export function mixedLoads(page, html, read, builtFiles = []) {
  const problems = [];
  for (const tag of tagsOf(html)) {
    const known = tag.kind === 'script' && tag.file ? read(tag.file) : null;
    if (known && known.module !== tagIsModule(html, tag)) problems.push(`${page} loads ${tag.file} as a ${known.module ? 'classic script, and the file says it is a module' : 'module, and the file does not say it is one'}`);
  }
  for (const file of builtFiles) if (read(file)?.module) problems.push(`${BUILT_LIST} holds ${file}, a module, in a list written out as classic tags`);
  return problems;
}

// The classic scripts one page runs: its tags, the scripts written inside it, and (for the page of desktop
// widgets) every script a row of the built list can add.
function pageScripts(page, html, read, builtRows) {
  const scripts = [];
  for (const tag of tagsOf(html)) {
    if (tag.kind !== 'script' || !tag.file || tagIsModule(html, tag)) continue;
    const known = read(tag.file);
    if (known && !known.module) scripts.push({ file: tag.file, names: known.names });
  }
  inlineScripts(html).forEach((script, index) => {
    const type = /\stype="([^"]*)"/.exec(html.slice(script.start, html.indexOf('>', script.start) + 1))?.[1];
    if (type && type !== 'text/javascript') return; // a module, an import map or data: nothing lands in the shared scope
    scripts.push({ file: `${page} (script ${index + 1} written in the page)`, names: read(null, script.code).names });
  });
  if (page === 'server/layer-lite.html') {
    for (const file of new Set(builtRows.flatMap((row) => row.js))) { const known = read(file); if (known && !known.module) scripts.push({ file, names: known.names }); }
  }
  return scripts;
}

/**
 * Today's numbers.
 * @param {string} [root] @param {string[]} [files] the tracked files
 * @returns {Promise<{ scripts: Record<string, number>, handlers: Record<string, number>, duplicates: Record<string, number>,
 *   where: Record<string, string[]>, counted: number, modules: string[], classic: string[], mixed: string[] }>}
 *   `scripts` holds the number of such names per script (a script and the files split out of it are one key)
 */
export async function measureBrowser(root = REPO_ROOT, files = trackedFiles(root) ?? []) {
  const text = (file) => readFileSync(path.join(root, file), 'utf8');
  const tracked = new Set(files);
  const parser = await openParser();
  const cache = new Map();
  const read = (file, code) => {
    if (file === null) { try { return sharedNames(code, parser); } catch { return { module: false, names: [] }; } }
    if (!tracked.has(file) || !isBrowserScript(file)) return null;
    if (!cache.has(file)) cache.set(file, sharedNames(text(file), parser));
    return cache.get(file);
  };
  try {
    const family = familyOf(readBrowserLedger(root));
    const scripts = {};
    const modules = [];
    const classic = [];
    const ours = files.filter(isBrowserScript);
    for (const file of ours) {
      const known = read(file);
      if (known.module) modules.push(file);
      else if (known.names.length) { scripts[family(file)] = (scripts[family(file)] ?? 0) + known.names.length; classic.push(file); }
    }
    const pages = files.filter((file) => PAGE.test(file));
    for (const page of pages) {
      const written = pageScripts(page, text(page), read, []).filter((script) => script.file.startsWith(`${page} (`)).reduce((count, script) => count + script.names.length, 0);
      if (written) scripts[page] = (scripts[page] ?? 0) + written;
    }
    const handlers = Object.fromEntries(pages.map((page) => [page, inlineHandlers(text(page))]).filter(([, count]) => count > 0));
    const builtRows = tracked.has(BUILT_LIST) ? Object.values(readLists(text(BUILT_LIST))) : [];
    const where = {};
    const builtFiles = [...new Set(builtRows.flatMap((row) => row.js))];
    const mixed = pages.flatMap((page) => mixedLoads(page, text(page), read, page === 'server/layer-lite.html' ? builtFiles : []));
    for (const page of pages) {
      for (const [name, holders] of Object.entries(duplicateNames(pageScripts(page, text(page), read, builtRows)))) {
        where[name] = [...new Set([...(where[name] ?? []), ...holders])].sort();
      }
    }
    const duplicates = Object.fromEntries(Object.entries(where).map(([name, holders]) => [name, holders.length]));
    return { scripts, handlers, duplicates, where, counted: ours.length, modules, classic, mixed };
  } finally {
    parser.close();
  }
}

/**
 * @param {Awaited<ReturnType<typeof measureBrowser>>} now
 * @param {Record<string, Record<string, number>>} [saved] the saved lists, read from disk when not given
 * @returns {string[]} what got worse, empty when nothing did
 */
export function browserProblems(now, saved = Object.fromEntries(Object.keys(CHECKS).map((key) => [key, readCounts(CHECKS[key].file)]))) {
  const problems = (now.mixed ?? []).map((line) => `modules: ${line}`);
  for (const key of Object.keys(CHECKS)) {
    const { worse } = compareCounts(saved[key], now[key]);
    for (const row of worse) {
      const detail = key === 'duplicates' ? ` (${(now.where[row.key] ?? []).join(' + ')})` : '';
      problems.push(`${key}: ${row.key}${detail}: ${row.now}${row.was ? `, was ${row.was}` : ', new'}. ${CHECKS[key].fix}`);
    }
  }
  return problems;
}

async function main(args) {
  if (!parserAvailable()) { console.error('TypeScript is not installed here. Run: npm run quality:install'); return 1; }
  const now = await measureBrowser();
  if (args.includes('--rebase')) {
    for (const [key, check] of Object.entries(CHECKS)) saveCounts(check.file, check.note, now[key]);
    console.log(`Saved: ${now.classic.length} scripts with ${sum(now.scripts)} names in the shared scope, ${sum(now.handlers)} inline handlers, ${Object.keys(now.duplicates).length} names declared twice.`);
    return 0;
  }
  const problems = browserProblems(now);
  if (problems.length) { console.log(problems.map((line) => `  ${line}`).join('\n')); return 1; }
  if (args.includes('--update')) for (const [key, check] of Object.entries(CHECKS)) saveCounts(check.file, check.note, now[key]);
  console.log(`Browser: nothing got worse. ${now.classic.length} of ${now.counted} scripts put ${sum(now.scripts)} names in the shared scope (${Object.keys(now.scripts).length} scripts before their splits; ${now.modules.length} modules), `
    + `${sum(now.handlers)} inline handlers in the pages, ${Object.keys(now.duplicates).length} names declared by two scripts of one page.${args.includes('--update') ? ' Saved.' : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
