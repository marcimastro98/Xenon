// What the map page says about one file, read from the file itself: the first
// sentence of its opening comment, its functions with their line and the comment
// written above each, what it exports, and the HTTP routes it answers.

/** @type {Record<string, 'slash' | 'hash'>} */
const COMMENT_STYLE = {
  js: 'slash', mjs: 'slash', cjs: 'slash', rs: 'slash', cs: 'slash', swift: 'slash', css: 'slash',
  ps1: 'hash', psm1: 'hash', sh: 'hash', py: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash',
};

/** @type {Record<string, RegExp[]>} */
const SYMBOL_RULES = {
  js: [/^\s{0,4}(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm, /^\s{0,4}(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, /^\s{0,4}(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm],
  ps1: [/^\s*function\s+([A-Za-z][\w-]*)/gim],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z_][\w]*)/gm],
  swift: [/^\s*(?:(?:public|private|internal|fileprivate|static|override|@\w+)\s+)*func\s+([A-Za-z_][\w]*)/gm],
  cs: [/^\s*(?:(?:public|private|internal|protected|static|async|override|unsafe|extern)\s+)+[\w<>[\],.? ]+\s+([A-Z][\w]*)\s*\(/gm],
  sh: [/^\s*(?:function\s+)?([a-z_][\w]*)\s*\(\)\s*\{/gm],
  py: [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm],
};
SYMBOL_RULES.mjs = SYMBOL_RULES.js;
SYMBOL_RULES.cjs = SYMBOL_RULES.js;
SYMBOL_RULES.psm1 = SYMBOL_RULES.ps1;

const ROUTE_RE = /['"`]((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))*) (\/[^'"`\s]*)['"`]/g;
const NOT_A_NAME = /^(if|for|while|switch|catch|return|new)$/;
const LEGAL = /copyright|\(c\)|spdx|licen[cs]e/i;
const MAX_TEXT = 200;
const MAX_SYMBOLS = 300;

/** Banner rules drawn with ───, ===, *** around a comment are not words. @param {string} text */
function undecorate(text) {
  return text.replace(/[─━═]+|[=*~_-]{3,}/g, ' ').replace(/<\/?\w+[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
function sentence(text) {
  const match = /^(.+?[.!?])(?:\s|$)/.exec(text);
  const first = match ? match[1] : text;
  return first.length > MAX_TEXT ? `${first.slice(0, MAX_TEXT - 1).trimEnd()}…` : first;
}

/** @param {string[]} lines @returns {string} */
const toSentence = (lines) => sentence(lines.map(undecorate).filter(Boolean).join(' '));

/**
 * The first sentence of the comment that opens a file, or of its first heading.
 * @param {string} text
 * @param {string} ext
 */
export function summaryOf(text, ext) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (ext === 'md') {
    const heading = lines.find((line) => /^#\s+\S/.test(line));
    return heading ? sentence(heading.replace(/^#\s+/, '')) : '';
  }
  if (ext === 'html') {
    const title = /<title>([^<]+)<\/title>/i.exec(text);
    return title ? sentence(title[1].trim()) : '';
  }
  const style = COMMENT_STYLE[ext];
  if (!style) return '';
  const [open, close] = style === 'slash' ? ['/*', '*/'] : ['<#', '#>'];
  const prefix = style === 'slash' ? '//' : '#';
  const words = [];
  let inBlock = false;
  for (const raw of lines.slice(0, 40)) {
    const line = raw.trim();
    if (!inBlock && (line === '' || /^['"]use strict['"];?$/.test(line) || line.startsWith('#!') || /^#Requires/i.test(line) || line.startsWith('// @ts-'))) {
      if (words.length > 0 && line === '') break;
      continue;
    }
    if (!inBlock && line.startsWith(open)) inBlock = true;
    if (inBlock) {
      if (!LEGAL.test(line)) words.push(line.replace(/^\/\*+|\*+\/$|^<#|#>$|^\*\s?|^\.\w+\s*$/g, ''));
      if (line.includes(close)) { inBlock = false; if (toSentence(words)) break; }
      continue;
    }
    if (!line.startsWith(prefix)) break;
    if (!LEGAL.test(line)) words.push(line.replace(/^\/\/+|^#+/, ''));
  }
  return toSentence(words);
}

/**
 * The comment written just above line `at`, skipping attributes and decorators.
 * @param {string[]} lines
 * @param {number} at zero-based index of the declaration
 * @param {'slash' | 'hash'} style
 */
export function docAbove(lines, at, style) {
  let i = at - 1;
  while (i >= 0 && /^\s*(#\[|\[[A-Z]|@[A-Za-z])/.test(lines[i]) && style === 'slash') i -= 1;
  if (i < 0) return '';
  const found = [];
  if (style === 'slash' && lines[i].trim().endsWith('*/')) {
    for (; i >= 0; i -= 1) {
      found.unshift(lines[i].trim());
      if (lines[i].includes('/*')) break;
    }
    const words = [];
    for (const line of found) {
      const text = line.replace(/^\/\*+|\*+\/$|^\*\s?/g, '').trim();
      if (text.startsWith('@')) break;
      words.push(text);
    }
    return toSentence(words);
  }
  const marker = style === 'slash' ? /^\s*\/\/\/?/ : /^\s*#(?![>\[])/;
  for (; i >= 0 && marker.test(lines[i]); i -= 1) found.unshift(lines[i].replace(marker, '').trim());
  return toSentence(found.filter((line) => !line.startsWith('@')));
}

/**
 * Named functions and classes a file declares: [name, line, what it does?].
 * @param {string} text
 * @param {string} ext
 * @returns {Array<[string, number] | [string, number, string]>}
 */
export function symbolsOf(text, ext) {
  const rules = SYMBOL_RULES[ext];
  if (!rules) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const lineOf = lineIndexer(text);
  const found = new Map();
  for (const rule of rules) {
    for (const match of text.matchAll(rule)) {
      const name = match[1];
      if (NOT_A_NAME.test(name) || found.has(name)) continue;
      const line = lineOf(match.index + match[0].search(/\S/));
      found.set(name, { name, line });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line).slice(0, MAX_SYMBOLS).map(({ name, line }) => {
    const doc = docAbove(lines, line - 1, COMMENT_STYLE[ext] || 'slash');
    return doc ? [name, line, doc] : [name, line];
  });
}

/** @param {string} text @returns {(offset: number) => number} one-based line of an offset */
function lineIndexer(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/**
 * What a browser script hands to the page (`window.Name = …`) and what a module exports.
 * @param {string} text
 */
export function exportsOf(text) {
  const out = new Set();
  for (const match of text.matchAll(/\bwindow\.([A-Z][\w$]*)\s*=(?!=)/g)) out.add(`window.${match[1]}`);
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(match[1]);
  const cjs = /module\.exports\s*=\s*\{([^}]*)\}/.exec(text);
  if (cjs) {
    for (const part of cjs[1].split(',')) {
      const name = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/**
 * The `METHOD /path` keys a file answers: [route, line, what it does?].
 * @param {string} text
 * @returns {Array<[string, number] | [string, number, string]>}
 */
export function routesOf(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const lineOf = lineIndexer(text);
  const seen = new Map();
  for (const match of text.matchAll(ROUTE_RE)) {
    const key = `${match[1]} ${match[2]}`;
    if (seen.has(key)) continue;
    const line = lineOf(match.index);
    const doc = docAbove(lines, line - 1, 'slash');
    seen.set(key, doc ? [key, line, doc] : [key, line]);
  }
  return [...seen.values()];
}

/**
 * @param {string} file repo-relative
 * @param {(file: string) => string | null} read
 */
export function describeFile(file, read) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const readable = COMMENT_STYLE[ext] || ext === 'md' || ext === 'html';
  const text = readable && file.includes('.') ? read(file) : null;
  if (text === null || text.length > 2 * 1024 * 1024) return { p: file };
  const entry = { p: file };
  const summary = summaryOf(text, ext);
  const symbols = symbolsOf(text, ext);
  const isJs = ['js', 'mjs', 'cjs'].includes(ext);
  const exported = isJs ? exportsOf(text) : [];
  const routes = isJs ? routesOf(text) : [];
  if (summary) entry.d = summary;
  if (symbols.length > 0) entry.f = symbols;
  if (exported.length > 0) entry.x = exported;
  if (routes.length > 0) entry.r = routes;
  return entry;
}
