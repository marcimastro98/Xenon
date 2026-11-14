// Words that point at code which is no longer there.
//
//   node tools/restructure/stale-pointers.mjs                  comments and Markdown of the repo
//   node tools/restructure/stale-pointers.mjs --docs <folder>  Markdown of a folder outside git, read against this repo
//   node tools/restructure/stale-pointers.mjs --root <repo>    another checkout
//
// Two kinds of line come out:
//   gone    a `path/file.js` that no tracked file answers to, or a `file.js:NN` past the end of the file
//   moved   a name next to the file the ledgers say it left (extracted.json, extracted-browser.json)
// It reads comments of server/, tools/ and packages/ and every Markdown file, CHANGELOG.md only under
// [Unreleased]. It cannot judge a sentence that tells history ("was cut out of x.js"), a file a test
// makes up, a file of the user's own machine, or a name written without its file: those a person reads.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = 'js|mjs|cjs|ps1|sh|rs|cs|swift|css|html|md|yml|vbs|nsi|nsh';
const PATH_RE = new RegExp(`(?<![\\w/.@*<>{}$-])((?:\\.{1,2}/)*(?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${EXT}))(?::(\\d+))?(?![\\w/*<{-])`, 'g');
const FILE_RE = new RegExp(`\\.(?:${EXT})$`);
// Folders whose files are made when the app runs or is built: a path under them is not in git and is not stale.
const NOT_TRACKED = /^(server\/data|node_modules|dist|target|build|\.claude|xenon-creator-output|WidgetBuilder)\//;
// Folders of other repositories that comments here speak of (the hub, Codex): nothing to check them against.
const ELSEWHERE = /^(src|xenon-supporter-hub|codex-rs|\.agents)\//;
// server/shared is a link to packages/core, made at install: a path through it is written `shared/...`.
const throughLink = (mention) => mention.replace(/^(server\/)?shared\//, 'packages/core/');

/** Every `path/file.ext` and `file.ext:NN` of a text, with the line it stands on. */
export function mentionsOf(text) {
  const found = [];
  String(text).split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PATH_RE)) {
      const before = line.slice(0, match.index);
      if (/[a-z]+:\/\/\S*$/i.test(before) || /(^|[\s(`'"])[\w-]+(\.[\w-]+)+\/\S*$/.test(before)) continue; // inside a URL
      // `media.js/ai.js` is two files written as one word, and `-frame/-extras.js` is the tail of a name cut short.
      const parts = match[1].split('/');
      if (parts.some((part) => part.startsWith('-')) || (parts.length > 1 && /^[\w-]+(\.[\w-]+)*\.(org|com|io|dev|net|app)$/.test(parts[0]))) continue;
      const names = parts.slice(0, -1).some((part) => FILE_RE.test(part)) ? parts : [match[1]];
      for (const text of names) found.push({ line: index + 1, at: match.index, text, lineNo: match[2] ? Number(match[2]) : null });
    }
  });
  return found;
}

/** The comment text of a script, line for line (code lines become empty), so line numbers hold. */
export function commentsOf(source) {
  let inBlock = false;
  return String(source).split('\n').map((line) => {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return line;
      inBlock = false;
      return line.slice(0, end);
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return line;
    if (trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      return line;
    }
    const tail = line.lastIndexOf(' // ');
    if (tail < 0) return '';
    const quotes = (line.slice(0, tail).match(/['"`]/g) || []).length;
    return quotes % 2 ? '' : ' '.repeat(tail) + line.slice(tail);
  }).join('\n');
}

/** The tracked files a mention can mean, seen from the file that holds it. */
export function answersTo(mention, from, tracked) {
  const clean = throughLink(mention.replace(/^\.\//, ''));
  const near = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  if (tracked.has(near)) return [near];
  if (clean.startsWith('../')) return [];
  if (tracked.has(clean)) return [clean];
  const tail = `/${clean}`;
  return [...tracked].filter((file) => file.endsWith(tail));
}

/** name -> where it lives now, for every file something was taken out of. */
export function movedNames(ledger, browserLedger) {
  const steps = [];
  for (const [from, entries] of Object.entries(ledger.sources || {})) for (const entry of entries) steps.push({ from, file: entry.file, names: entry.names || [] });
  for (const move of browserLedger.moves || []) if (move.from && move.file) steps.push({ from: move.from, file: move.file, names: move.names || [] });
  const left = new Map();
  for (const step of steps) {
    if (!step.names.length) continue;
    if (!left.has(step.from)) left.set(step.from, new Map());
    for (const name of step.names) left.get(step.from).set(name, step.file);
  }
  // A name that left its second home too is told where it is today, not where it stopped on the way.
  const home = (file, name, seen = new Set()) => {
    const next = left.get(file)?.get(name);
    return next && !seen.has(next) ? home(next, name, seen.add(file)) : file;
  };
  const out = new Map();
  for (const [from, names] of left) out.set(from, new Map([...names.keys()].map((name) => [name, home(from, name)])));
  return out;
}

// A plain word such as `start` is in every sentence: a name counts when it is written as code
// (in backticks, or called) or cannot be an English word (a capital or underscore inside it).
function namedIn(window, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  if (new RegExp(`\`${escaped}(\\(\\))?\`|(?<![\\w.$])${escaped}\\(`).test(window)) return true;
  return /[a-z0-9][A-Z_]|_[a-z]/.test(name) && new RegExp(`(?<![\\w.$-])${escaped}(?![\\w$-])`).test(window);
}

// The lines a name is looked for in: the line of the file and `reach` lines each way, never past an empty line
// (a paragraph of a document is about one thing, the next one is about another).
function around(lines, at, reach) {
  let from = at;
  let to = at;
  while (from > 0 && at - from < reach && lines[from - 1].trim()) from -= 1;
  while (to < lines.length - 1 && to - at < reach && lines[to + 1].trim()) to += 1;
  return lines.slice(from, to + 1).join('\n');
}

/**
 * @param {{ file: string, text: string }[]} texts what to read, already cut down to comments where it is code
 * @param {{ tracked: Set<string>, moved: Map<string, Map<string, string>>, read: (file: string) => string | null }} repo
 */
export function stalePointers(texts, repo) {
  const out = [];
  const lengths = new Map();
  const linesOf = (file) => {
    if (!lengths.has(file)) lengths.set(file, (repo.read(file) ?? '').split('\n').length);
    return lengths.get(file);
  };
  for (const { file, text } of texts) {
    const lines = text.split('\n');
    for (const mention of mentionsOf(text)) {
      const plain = mention.text.replace(/^(\.{1,2}\/)+/, '');
      if (NOT_TRACKED.test(plain) || ELSEWHERE.test(plain)) continue;
      const answers = answersTo(mention.text, file, repo.tracked);
      if (!answers.length) {
        const base = path.posix.basename(mention.text);
        // A bare name nothing answers to is a file of the user's machine; `x.js` and `a/b.md` are made up to show a shape.
        if (!mention.text.includes('/') || /^\w\.\w+$/.test(base)) continue;
        const same = [...repo.tracked].filter((other) => path.posix.basename(other) === base);
        out.push({ file, line: mention.line, kind: 'gone', what: mention.text, now: same.slice(0, 3).join(' | ') });
        continue;
      }
      if (mention.lineNo && answers.length === 1 && mention.lineNo > linesOf(answers[0])) {
        out.push({ file, line: mention.line, kind: 'gone', what: `${mention.text}:${mention.lineNo}`, now: `${answers[0]} has ${linesOf(answers[0])} lines` });
      }
      const window = around(lines, mention.line - 1, repo.reach ?? 1);
      for (const answer of answers) {
        for (const [name, home] of repo.moved.get(answer) ?? []) {
          if (home === answer || home === file || !namedIn(window, name)) continue;
          if (window.includes(home) || window.includes(path.posix.basename(home))) continue; // the new home is named too
          out.push({ file, line: mention.line, kind: 'moved', what: `${name} in ${mention.text}`, now: home });
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((row) => !seen.has(`${row.file}:${row.line}:${row.what}`) && seen.add(`${row.file}:${row.line}:${row.what}`));
}

const SCRIPTS = /^(server|tools|packages)\/.*\.(js|mjs|cjs)$|^\.github\/.*\.yml$/;
const SKIP = /(^|\/)(node_modules|vendor)\/|\.min\.js$|^server\/data\//;

// CHANGELOG.md tells history: only what is not released yet can name a wrong file.
function unreleased(text) {
  const start = text.indexOf('## [Unreleased]');
  if (start < 0) return '';
  const end = text.indexOf('\n## [', start + 5);
  const head = text.slice(0, start).replace(/[^\n]/g, '');
  return head + text.slice(start, end < 0 ? undefined : end);
}

function markdownUnder(folder) {
  return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
}

function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const root = path.resolve(option('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const docs = option('--docs');
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean));
  const read = (file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);
  const json = (file) => JSON.parse(read(file) ?? '{}');
  const moved = movedNames(json('tools/restructure/extracted.json'), json('tools/restructure/extracted-browser.json'));
  const texts = [];
  if (docs) {
    // A local doc speaks from the root of the repo, whatever folder it is kept in.
    for (const name of markdownUnder(docs)) texts.push({ file: name, text: readFileSync(path.join(docs, name), 'utf8') });
  } else {
    for (const file of tracked) {
      if (SKIP.test(file)) continue;
      if (file === 'CHANGELOG.md') texts.push({ file, text: unreleased(read(file) ?? '') });
      else if (file.endsWith('.md')) texts.push({ file, text: read(file) ?? '' });
      else if (SCRIPTS.test(file)) texts.push({ file, text: commentsOf(read(file) ?? '') });
    }
  }
  // A document is written in paragraphs: the name and its file are often several lines apart.
  const rows = stalePointers(texts, { tracked, moved, read, reach: docs ? 6 : 1 });
  for (const row of rows) console.log(`${row.file}:${row.line}  ${row.kind}  ${row.what}${row.now ? `  ->  ${row.now}` : ''}`);
  console.log(`${rows.length} pointers to read (${rows.filter((row) => row.kind === 'gone').length} gone, ${rows.filter((row) => row.kind === 'moved').length} moved) in ${texts.length} files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
