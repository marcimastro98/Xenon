// Comment lines a step took out of server/ and put back nowhere.
//
//   node tools/restructure/lost-comments.mjs          the working tree against HEAD
//   node tools/restructure/lost-comments.mjs <rev>    one commit
//
// `verify` proves that every moved line is unchanged and that no name lost its declaration.
// It does not look at a comment that was deleted: a require line the tool takes out goes with
// the comment block right above it, and when that block is the header of the file the header
// is gone and every proof still passes. This check reads the diff instead: a comment line
// that was removed must come back somewhere among the added lines, in any file. It exits 1
// when one did not, so it can stand in a routine: it is the `comments` step of the gate,
// right after `verify`. A hand edit that rewrites a comment starts the gate `--from carry`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The text of a line without its indent, its comment mark and its runs of spaces: a comment
// that moved to another indent, or was joined to its neighbour, is still the same comment.
const bare = (line) => line.replace(/^\s*(\/\/|\*)?\s*/, '').replace(/\s+/g, ' ').trim();
const isComment = (line) => /^\s*\/\//.test(line);

// A step that turns variables into fields of one object writes the new name in the comments
// too: the same line with one or two words changed is the same comment, kept.
function renamedIn(text, addedWords) {
  const words = text.split(' ');
  if (words.length < 4) return false;
  return addedWords.some((other) => other.length === words.length && words.filter((word, i) => word !== other[i]).length <= 2);
}

// The removed comment lines of a unified diff that no added line holds. A line of three
// letters or fewer (a bare `//`, a rule of dashes cut short) says nothing and is skipped.
// A comment that names a file move.mjs moved comes back with the new path: `renames` is that list.
export function lostComments(diffText, renames = []) {
  const added = new Set();
  const removed = [];
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.add(bare(line.slice(1)));
    else if (line.startsWith('-')) removed.push(line.slice(1).replace(/\r$/, ''));
  }
  const allAdded = [...added].join(' ');
  const addedWords = [...added].map((text) => text.split(' '));
  return removed.filter((line) => {
    if (!isComment(line)) return false;
    const text = renames.reduce((now, move) => now.split(move.from).join(move.to), bare(line));
    return text.length > 3 && !added.has(text) && !allAdded.includes(text) && !renamedIn(text, addedWords);
  });
}

// The diff of the working tree against HEAD, new files included as added lines.
function workingDiff(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  let text = git(['diff', 'HEAD', '-U0', '--', 'server']);
  for (const name of git(['ls-files', '--others', '--exclude-standard', 'server']).split('\n').filter(Boolean)) {
    text += `\n${readFileSync(join(root, name), 'utf8').split('\n').map((line) => `+${line}`).join('\n')}`;
  }
  return text;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rev = process.argv[2];
  const text = rev
    ? execFileSync('git', ['show', rev, '-U0', '--format=', '--', 'server'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    : workingDiff(root);
  const list = join(root, 'tools', 'restructure', 'moved.json');
  const lost = lostComments(text, existsSync(list) ? JSON.parse(readFileSync(list, 'utf8')).moves : []);
  console.log(`${rev || 'Working tree'}: ${lost.length} comment lines taken out and not put back.`);
  for (const line of lost) console.log(`    ${line.trim().slice(0, 110)}`);
  if (lost.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
