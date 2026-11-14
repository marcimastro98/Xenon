// The functions of the page a wrapped script may take under another name and carry to
// a script made of its functions: `const el = makeEl;`.
//
// Such a line reads a name of the page while the script loads, and a script made of
// moved code loads earlier than the line ran. That is the same value only when nothing
// can change the name in between. So the name must be on the list
// (browser-page-helpers.json), and the list is held to the code: the function is
// declared once, at the top level of one script, no script and no page assigns the
// name, and that script loads before every script that takes it, on every page.
//
// The list also says what the function does with what it is handed, as
// browser-inner-decides.mjs proves it. The proof is redone here and must give exactly
// what the list says, so a helper that starts writing markup fails the check, and so
// does a line that claims more than the code does.

import { readFileSync } from 'node:fs';

import { readDecisions } from './browser-inner-decides.mjs';
import { tagsOf } from './browser-pages.mjs';

const LIST = JSON.parse(readFileSync(new URL('./browser-page-helpers.json', import.meta.url), 'utf8'));
/** Per script made of moved functions, the functions that left before decisions were kept in their script and hold one (browser-inner-before-rule.json). */
export const MOVED_BEFORE_RULE = new Map(Object.entries(JSON.parse(readFileSync(new URL('./browser-inner-before-rule.json', import.meta.url), 'utf8')).moved));
/** @param {string} file a script made of moved functions @param {string[]} names what one statement declares @returns {boolean} true when it is read without the rule */
export const movedBeforeRule = (file, names) => names.some((name) => MOVED_BEFORE_RULE.get(file)?.includes(name));
/** @type {Map<string, { file: string, helper: { tag: number, writes: Record<string, string[]>, problems: string[] } }>} */
export const PAGE_HELPERS = new Map(Object.entries(LIST.helpers).map(([name, entry]) => [name, { file: entry.file, helper: { ...entry.helper, problems: [] } }]));

/**
 * The proof of the helper a name stands for inside a wrapper: a function or an arrow declared there, a name taken from an
 * earlier script made of the same wrapper, or another name for a helper of the page.
 * @param {any} shell from readWrapper @param {string} name
 * @returns {{ tag: number, writes: Record<string, string[]>, problems: string[] } | null} null when the name is not a helper
 */
export function helperOf(shell, name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const own = shell.bindings.get(name);
  if (!own) return PAGE_HELPERS.get(name)?.helper ?? null;
  if (shell.taken.has(name)) return shell.taken.get(name).helper ?? null;
  if (own.record.helpers?.has(name)) return own.record.helpers.get(name);
  const kind = own.record.fixed?.kinds.get(name);
  return kind && typeof kind === 'object' ? helperOf(shell, kind.same, seen) : null;
}

/** @param {any} shell from readWrapper @returns {Map<string, any>} every name of the wrapper that stands for a proven helper, with the proof */
export function helpersIn(shell) {
  const found = new Map();
  for (const name of shell.bindings.keys()) {
    const helper = helperOf(shell, name);
    if (helper && helper.problems.length === 0) found.set(name, helper);
  }
  return found;
}

/** @param {any} shell from readWrapper @returns {string[]} the helpers of the page its constants read while the script loads */
export function pageHelpersRead(shell) {
  const reads = shell.records.flatMap((record) => record.fixed?.reads ?? []);
  return [...new Set(reads.filter((read) => !shell.bindings.has(read.name) && PAGE_HELPERS.has(read.name)).map((read) => read.name))];
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Holds one line of the list to the code.
 * @param {object} job
 * @param {string} job.name the helper @param {any} job.parser
 * @param {{ file: string, text: string }[]} job.scripts every script and page of ours
 * @param {{ page: string, html: string }[]} job.pages the pages, written and built
 * @param {string[]} job.takers the scripts whose constants read the helper while they load
 * @param {{ file: string, helper: any }} [job.entry] the line of the list (the one on file when not given)
 * @returns {string[]} problems, empty when the line is proven
 */
export function pageHelperProblems({ name, parser, scripts, pages, takers, entry = PAGE_HELPERS.get(name) }) {
  if (!entry) return [`${name} is not on the list of page helpers`];
  const { K } = parser;
  const problems = [];
  const home = scripts.find((script) => script.file === entry.file);
  if (!home) return [`${entry.file}, which the list says declares ${name}, is not a script of ours`];
  const declared = parser.parse(home.text, home.file).statements.filter((node) => node.kind === K.FunctionDeclaration && node.name?.text === name);
  if (declared.length !== 1) return [`${entry.file} does not declare the function ${name} once at its top level`];
  const read = readDecisions(K, declared[0], () => 0);
  problems.push(...read.decides.map((found) => `${name} (${entry.file}) ${found.text}: calls to it are not known to be safe`));
  const proof = read.helpers.get(name);
  const says = JSON.stringify({ tag: entry.helper.tag, writes: entry.helper.writes });
  if (!proof) problems.push(`${name} (${entry.file}) does not create an element whose tag it is handed: the list says it does`);
  else if (JSON.stringify({ tag: proof.tag, writes: proof.writes }) !== says) problems.push(`${name} (${entry.file}) writes ${JSON.stringify(proof.writes)} and the list says ${JSON.stringify(entry.helper.writes)}`);
  const word = escaped(name);
  const declares = new RegExp(`(?:function|var|let|const|class)\\s+${word}(?![\\w$])`, 'g');
  const assigns = new RegExp(`(?:(?<![\\w$.])|\\.)${word}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])`);
  for (const script of scripts) {
    const count = (script.text.match(declares) ?? []).length - (script.file === entry.file ? 1 : 0);
    if (count > 0) problems.push(`${script.file} declares ${name} too: which one a script gets depends on where it runs`);
    if (assigns.test(script.text)) problems.push(`${script.file} assigns ${name}: read earlier, it could be another function`);
  }
  for (const taker of takers) {
    for (const { page, html } of pages) {
      const tags = tagsOf(html).filter((tag) => tag.kind === 'script');
      const at = tags.findIndex((tag) => tag.file === taker);
      if (at === -1) continue;
      const before = tags.slice(0, at).find((tag) => tag.file === entry.file);
      if (!before) problems.push(`${page} loads ${taker} and not ${entry.file} before it: ${name} is not there yet when the script takes it`);
      else if (before.unordered) problems.push(`${page} loads ${entry.file} async, defer or as a module: it is not sure to run before ${taker}`);
    }
  }
  return problems;
}
