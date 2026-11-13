// The three moves the browser side knows, each as a function from texts to texts:
// declarations to a script that loads right before the old one, a stylesheet cut
// into parts linked right after it, and a script written inside a page to a file.
// Nothing here touches the disk, so the same code does a move and redoes it from
// an old revision to compare (browser-extract.mjs).

import { addTags, inlineScripts, runProblems, tagsOf, urlOfFile } from './browser-pages.mjs';
import { headerOf, MAX_LINES, planScriptMove } from './browser-plan.mjs';
import { planStyleSplit } from './browser-styles.mjs';
import { Refusal } from './extract-plan.mjs';

const need = (tree, file) => {
  const text = tree.get(file);
  if (text === null) throw new Refusal([`${file} does not exist`]);
  return text;
};

// Every page that loads the old file gets the new tags next to its tag, and the
// files of the split end up one after the other with nothing between them.
function retag(tree, pages, { old, added, where, before, after }) {
  const files = new Map();
  const reasons = [];
  for (const page of pages) {
    const html = need(tree, page);
    if (!tagsOf(html).some((tag) => tag.file === old)) continue;
    const made = addTags(html, old, added, where);
    const problems = [...runProblems(html, before), ...made.reasons];
    if (problems.length === 0) problems.push(...runProblems(made.html, after));
    reasons.push(...problems.map((problem) => `${page} ${problem}`));
    files.set(page, made.html);
  }
  if (files.size === 0) reasons.push(`no page loads ${old} with a tag: where a new file would load cannot be proven`);
  if (reasons.length) throw new Refusal(reasons);
  return files;
}

function scriptMove(tree, move, { parser, pages, earlier }) {
  const before = earlier.filter((entry) => entry.kind === 'script' && entry.from === move.from).map((entry) => entry.file);
  const run = [...before, move.from];
  const files = retag(tree, pages, { old: move.from, added: [move.file], where: 'before', before: run, after: [...before, move.file, move.from] });
  const plan = planScriptMove({ scripts: run.map((file) => ({ file, text: need(tree, file) })), target: move.file, about: move.about,
    names: move.names, parser });
  files.set(move.file, plan.targetText).set(move.from, plan.newSource);
  return { files, made: [move.file], record: { kind: 'script', from: move.from, file: move.file, about: move.about, names: plan.moved } };
}

function styleMove(tree, move, { pages, earlier }) {
  if (earlier.some((entry) => entry.kind === 'style' && entry.from === move.from)) {
    throw new Refusal([`${move.from} is cut into parts already: a second cut would have to load between them`]);
  }
  // An address inside a stylesheet is read from where the file is, so a part stays beside the old sheet.
  const folder = move.from.slice(0, move.from.lastIndexOf('/') + 1);
  const astray = move.parts.filter((part) => !part.file.endsWith('.css') || part.file.slice(0, part.file.lastIndexOf('/') + 1) !== folder);
  if (astray.length) throw new Refusal(astray.map((part) => `${part.file} must be a .css file in the folder of ${move.from}`));
  const old = need(tree, move.from);
  const plan = planStyleSplit(old, move.parts, move.from);
  const added = plan.parts.map((part) => part.file);
  // The empty line between two sections opens the part after it: a file that ends with one fails `git diff --check`.
  const pieces = [{ file: move.from, text: plan.kept }, ...plan.parts.slice(0, -1)];
  const trailing = pieces.filter((piece) => /(^|\n)[ \t]*\n$/.test(piece.text));
  if (trailing.length) throw new Refusal(trailing.map((piece) => `${piece.file} would end with an empty line: cut one line earlier, so the empty line opens the next part`));
  const files = retag(tree, pages, { old: move.from, added, where: 'after', before: [move.from], after: [move.from, ...added] });
  files.set(move.from, plan.kept);
  for (const part of plan.parts) files.set(part.file, part.text);
  return { files, made: added, record: { kind: 'style', from: move.from, parts: move.parts.map(({ file, at }) => ({ file, at })) } };
}

// Words that make a script behave differently when it is a file of its own.
const INLINE_ONLY = ['document.currentScript', 'document.write', 'import.meta'];

function inlineMove(tree, move) {
  const html = need(tree, move.from);
  const block = inlineScripts(html)[move.nth ?? 0];
  const reasons = [];
  if (!block) throw new Refusal([`${move.from} has no script number ${move.nth ?? 0} written inside it`]);
  if (!block.simple) reasons.push(`the script in ${move.from} is not a bare <script> on its own lines`);
  for (const word of INLINE_ONLY) if (block.code.includes(word)) reasons.push(`the script uses ${word}, which means something else in a file`);
  if (!String(move.about ?? '').trim()) reasons.push('the new script needs one sentence saying what it does (--about)');
  // The code keeps every byte; only the line break after <script> stays behind with the tag.
  const text = headerOf(move.about, false) + block.code.slice(1);
  if (text.split('\n').length - 1 > MAX_LINES) reasons.push(`${move.file} would be ${text.split('\n').length - 1} lines: a new file stays within ${MAX_LINES}`);
  if (reasons.length) throw new Refusal(reasons);
  const tag = `<script src="${urlOfFile(move.file)}"></script>`;
  const after = html.slice(0, block.start) + tag + html.slice(block.end);
  if (after.replace(tag, () => `<script>\n${text.slice(headerOf(move.about, false).length)}</script>`) !== html) {
    throw new Refusal([`${move.from}: putting the code back in place of the new tag does not give the old page`]);
  }
  const files = new Map([[move.from, after], [move.file, text]]);
  return { files, made: [move.file], record: { kind: 'inline', from: move.from, file: move.file, about: move.about, nth: move.nth ?? 0 } };
}

/**
 * Works one move out, from the texts in `tree`.
 * @param {{ get: (file: string) => string | null }} tree the repo's files as text, null for a file that is not there
 * @param {any} move `{ kind: 'script', from, file, about, names }`, `{ kind: 'style', from, parts: [{ file, at }] }`
 *   or `{ kind: 'inline', from, file, about, nth }`
 * @param {{ parser: any, pages: string[], earlier: any[] }} context the pages of the app and the moves done before this one
 * @returns {{ files: Map<string, string>, made: string[], record: any }} every file to write with its new text,
 *   which of them are new, and the line for the list of moves. Throws a Refusal with every reason when the move is not safe.
 */
export function applyMove(tree, move, context) {
  const work = { script: scriptMove, style: styleMove, inline: inlineMove }[move.kind];
  if (!work) throw new Refusal([`unknown kind of move: ${move.kind}`]);
  const done = work(tree, move, context);
  const taken = done.made.filter((file) => tree.get(file) !== null);
  if (taken.length) throw new Refusal(taken.map((file) => `${file} exists already: give the new code its own file`));
  if (new Set(done.made).size !== done.made.length) throw new Refusal(['two parts were given the same file']);
  return done;
}
