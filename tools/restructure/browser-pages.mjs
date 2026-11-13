// Reads which page loads which script and stylesheet, in tag order, and writes a
// new tag next to an old one. A classic script only sees what loaded before it,
// and a stylesheet only wins over the ones linked before it, so the order of the
// tags is the thing a split must keep.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Every page the engine serves lives at the root of server/, so a tag's URL
// (`js/x.js`) is the file's path under it.
const PAGE_ROOT = 'server';
const TAG = /<script\b([^>]*)>\s*<\/script>|<link\b([^>]*)>/g;
const attr = (attrs, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** @param {string} root @returns {string[]} repo-relative paths of the tracked pages */
export function listPages(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--', `${PAGE_ROOT}/*.html`], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split('\0').filter(Boolean).sort();
}

/** HTML comments blanked out, every offset kept, so a tag inside a comment is not read as a tag. */
function withoutComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** @param {string} url as written in a tag @returns {string | null} repo-relative file, null for a URL that is not a local file */
export function fileOfUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null;
  const clean = url.split(/[?#]/)[0].replace(/^\//, '');
  if (!clean || clean.split('/').includes('..')) return null;
  return `${PAGE_ROOT}/${clean}`;
}

/**
 * The scripts and stylesheets a page loads, in the order the browser meets them.
 * @param {string} html
 * @returns {{ kind: 'script' | 'style', url: string, file: string | null, start: number, end: number,
 *   line: [number, number], ownLine: boolean, unordered: boolean, plain: boolean }[]}
 *   `line` is the [start, end) offsets of the whole line the tag sits on; `ownLine` is true when
 *   nothing else is on it; `unordered` is true for a script that does not run in tag order;
 *   `plain` is true when the tag says nothing but which file to load (no id, media, async...).
 */
export function tagsOf(html) {
  const clean = withoutComments(html);
  const tags = [];
  for (const match of clean.matchAll(TAG)) {
    const isScript = match[1] !== undefined;
    const attrs = isScript ? match[1] : match[2];
    const url = attr(attrs, isScript ? 'src' : 'href');
    if (!url || (!isScript && attr(attrs, 'rel') !== 'stylesheet')) continue;
    const start = match.index;
    const end = start + match[0].length;
    const lineStart = clean.lastIndexOf('\n', start - 1) + 1;
    const lineBreak = clean.indexOf('\n', end);
    const lineEnd = lineBreak === -1 ? clean.length : lineBreak + 1;
    const ownLine = clean.slice(lineStart, start).trim() === '' && clean.slice(end, lineEnd).trim() === '';
    const plain = attrs.replace(isScript ? /\ssrc="[^"]*"/ : /\s(?:href="[^"]*"|rel="stylesheet")/g, '').replace(/\/$/, '').trim() === '';
    tags.push({ kind: isScript ? 'script' : 'style', url, file: fileOfUrl(url), start, end, line: [lineStart, lineEnd], ownLine, plain,
      unordered: isScript && /\s(?:async|defer)\b|\stype="module"/.test(attrs) });
  }
  return tags;
}

/** @param {string} file repo-relative @returns {string} the URL a page's tag uses for it */
export function urlOfFile(file) {
  if (!file.startsWith(`${PAGE_ROOT}/`)) throw new Error(`${file} is not under ${PAGE_ROOT}/: no page can load it`);
  return file.slice(PAGE_ROOT.length + 1);
}

/**
 * Puts tags for new files right before or right after the tag of an old file,
 * each on its own line, written exactly like the old one.
 * @param {string} html
 * @param {string} oldFile repo-relative file the page already loads
 * @param {string[]} newFiles repo-relative files, in the order they must load
 * @param {'before' | 'after'} where
 * @returns {{ html: string, reasons: string[] }} `html` unchanged when the page does not load the old file
 */
export function addTags(html, oldFile, newFiles, where) {
  const tags = tagsOf(html);
  const mine = tags.filter((tag) => tag.file === oldFile);
  if (mine.length === 0) return { html, reasons: [] };
  const reasons = [];
  if (mine.length > 1) reasons.push(`loads ${oldFile} ${mine.length} times`);
  const tag = mine[0];
  if (!tag.ownLine) reasons.push(`the tag of ${oldFile} shares its line with something else`);
  if (tag.unordered) reasons.push(`the tag of ${oldFile} is async, defer or a module: it does not run in tag order`);
  else if (!tag.plain) reasons.push(`the tag of ${oldFile} carries more than the file to load (an id, media...): a copy of it is not proven safe`);
  const already = newFiles.filter((file) => tags.some((other) => other.file === file));
  if (already.length) reasons.push(`already loads ${already.join(', ')}`);
  if (reasons.length) return { html, reasons };
  const line = html.slice(tag.line[0], tag.line[1]);
  const eol = line.endsWith('\n') ? '' : '\n';
  const oldUrl = tag.url.split(/[?#]/)[0];
  const lead = oldUrl.startsWith('/') ? '/' : '';
  const added = newFiles.map((file) => line.replace(`"${tag.url}"`, `"${lead}${urlOfFile(file)}"`) + eol).join('');
  const at = where === 'before' ? tag.line[0] : tag.line[1];
  return { html: html.slice(0, at) + (where === 'after' ? eol : '') + added + html.slice(at), reasons: [] };
}

/**
 * Checks that the files of one split load one after the other, with nothing between them.
 * @param {string} html
 * @param {string[]} files repo-relative, in the order they must load
 * @returns {string[]} problems, empty when the page loads none of them or all of them in a row
 */
export function runProblems(html, files) {
  const tags = tagsOf(html);
  const wanted = new Set(files);
  const kinds = new Set(tags.filter((tag) => wanted.has(tag.file)).map((tag) => tag.kind));
  const sameKind = tags.filter((tag) => kinds.has(tag.kind));
  const first = sameKind.findIndex((tag) => wanted.has(tag.file));
  if (first === -1) return [];
  const loaded = sameKind.slice(first, first + files.length).map((tag) => tag.file);
  if (loaded.join('\n') === files.join('\n') && sameKind.filter((tag) => wanted.has(tag.file)).length === files.length) return [];
  return [`loads ${sameKind.filter((tag) => wanted.has(tag.file)).map((tag) => path.posix.basename(tag.file)).join(', ') || 'none'}`
    + ` where ${files.map((file) => path.posix.basename(file)).join(', ')} must follow each other with no other tag between`];
}

/**
 * The scripts written inside a page, in order.
 * @param {string} html
 * @returns {{ start: number, end: number, code: string, simple: boolean }[]} `start`..`end` covers both tags;
 *   `simple` is true when the opening tag has no attributes, each tag is alone on its line and the code is whole lines
 */
export function inlineScripts(html) {
  const clean = withoutComments(html);
  const found = [];
  for (const match of clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\ssrc=/.test(match[1]) || match[2].trim() === '') continue;
    const start = match.index;
    const end = start + match[0].length;
    const before = clean.slice(clean.lastIndexOf('\n', start - 1) + 1, start);
    const lineBreak = clean.indexOf('\n', end);
    const after = clean.slice(end, lineBreak === -1 ? clean.length : lineBreak);
    const code = html.slice(start + match[0].indexOf('>') + 1, end - '</script>'.length);
    found.push({ start, end, code, simple: match[1] === '' && before === '' && after.trim() === '' && code.startsWith('\n') && code.endsWith('\n') });
  }
  return found;
}
