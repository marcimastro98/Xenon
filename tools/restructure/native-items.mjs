// Finds the items of a Rust, C# or Swift file (functions, types, constants, blocks),
// each with the comments above it, so a file can be cut between items and nowhere else.
// The items of a range follow each other with nothing left between them.

import { cursor, lex, lineOf, matching } from './native-lex.mjs';
import { csItem, swiftItem } from './native-items-members.mjs';

/**
 * @typedef {object} Item
 * @property {number} lead where the comments and blank lines above the item start
 * @property {number} start where the item itself starts (its first attribute or word)
 * @property {number} end one past the item's last line
 * @property {string} kind fn, struct, impl, use, field, method, ...
 * @property {string} name
 * @property {string} key kind and name, what a plan calls the item
 * @property {string[]} cfg its #[cfg(...)] attributes, spaces squeezed
 * @property {string} vis its visibility as written, '' when none
 * @property {number} [visAt] where its visibility stands or would stand (Rust)
 * @property {number} line the 1-based line of `start`
 * @property {number} lines how many lines `lead`..`end` covers
 * @property {number} [open] token index of the bracket that opens its body
 * @property {number} [close] token index of the bracket that closes its body
 */

const RUST_NAMED = new Set(['fn', 'struct', 'enum', 'union', 'trait', 'mod', 'type', 'const', 'static']);
const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

/** Reads one Rust item that starts at token `s`: where it ends, what it is, its cfg and visibility. */
function rustItem(text, tokens, s, hi) {
  const c = cursor(text, tokens, hi);
  const cfg = [];
  let k = s;
  while (c.str(k) === '#') {
    let bracket = c.next(k + 1);
    const inner = c.str(bracket) === '!';
    if (inner) bracket = c.next(bracket + 1);
    const close = matching(text, tokens, bracket);
    if (inner) return { last: close, kind: 'inner', name: '', cfg, vis: '' };
    const attr = squeeze(text.slice(tokens[k].start, tokens[close].end));
    if (/^# ?\[ ?cfg ?\(/.test(attr)) cfg.push(attr);
    k = c.next(close + 1);
  }
  let vis = '';
  const visAt = tokens[k]?.start;
  if (c.word(k) === 'pub') {
    const after = c.next(k + 1);
    const close = c.str(after) === '(' ? matching(text, tokens, after) : k;
    vis = squeeze(text.slice(tokens[k].start, tokens[close].end));
    k = c.next(close + 1);
  }
  for (;;) {
    const w = c.word(k);
    const after = c.next(k + 1);
    if (w === 'default' || w === 'unsafe' || w === 'async') k = after;
    else if (w === 'const' && ['fn', 'unsafe', 'async', 'extern'].includes(c.word(after))) k = after;
    else if (w === 'extern') {
      const target = tokens[after]?.kind === 'string' ? c.next(after + 1) : after;
      if (c.word(target) === 'fn') k = target;
      else if (c.word(target) === 'crate') return { last: c.semicolon(k), kind: 'extern crate', name: c.word(c.next(target + 1)), cfg, vis, visAt };
      else return { last: matching(text, tokens, target), kind: 'extern', name: c.str(after), cfg, vis, visAt, open: target };
    } else break;
  }
  const kind = c.word(k);
  const second = c.next(k + 1);
  const bodyOrSemicolon = () => {
    const stop = c.find(k, (t) => t === ';' || t === '{');
    return c.str(stop) === '{' ? { last: matching(text, tokens, stop), open: stop } : { last: stop };
  };
  if (kind === 'use') return { last: c.semicolon(k), kind, name: squeeze(text.slice(tokens[second].start, tokens[c.semicolon(k)].start)), cfg, vis, visAt };
  if (kind === 'impl') {
    const body = bodyOrSemicolon();
    const head = squeeze(text.slice(tokens[second].start, tokens[body.open ?? body.last].start));
    return { ...body, kind, name: head.replace(/^<[^>]*>\s*/, '').replace(/\s+where\s.*$/, ''), cfg, vis };
  }
  if (RUST_NAMED.has(kind)) {
    const nameAt = c.word(second) === 'mut' ? c.next(second + 1) : second;
    const ends = kind === 'type' || kind === 'const' || kind === 'static' ? { last: c.semicolon(k) } : bodyOrSemicolon();
    return { ...ends, kind, name: c.word(nameAt), cfg, vis, visAt };
  }
  if (c.str(second) === '!') {
    let bracket = c.next(second + 1);
    const name = kind === 'macro_rules' ? c.word(bracket) : kind;
    if (tokens[bracket].kind === 'word') bracket = c.next(bracket + 1);
    const close = matching(text, tokens, bracket);
    const semi = c.next(close + 1);
    return { last: c.str(semi) === ';' ? semi : close, kind: kind === 'macro_rules' ? 'macro' : 'call', name, cfg, vis, visAt, open: bracket };
  }
  throw new Error(`Cannot tell what starts at line ${lineOf(text, tokens[s].start)}: ${text.slice(tokens[s].start, tokens[s].start + 60)}`);
}

const READERS = { rust: rustItem, cs: csItem, swift: swiftItem };

/**
 * The items between two token indexes, in order.
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {import('./native-lex.mjs').Lang} lang
 * @param {number} lo first token of the range @param {number} hi one past its last token
 * @returns {Item[]}
 */
export function itemsBetween(text, tokens, lang, lo, hi) {
  const c = cursor(text, tokens, hi);
  /** @type {Item[]} */
  const items = [];
  let lead = lo < tokens.length ? tokens[lo].start : text.length;
  for (let s = c.next(lo); s < hi;) {
    const read = READERS[lang](text, tokens, s, hi);
    if (!(read.last >= s)) throw new Error(`An item that starts at line ${lineOf(text, tokens[s].start)} never ends.`);
    let end = tokens[read.last].end;
    let k = read.last + 1;
    const sameLine = (t) => t && t.kind === 'space' && !text.slice(t.start, t.end).includes('\n');
    const after = sameLine(tokens[k]) ? k + 1 : k;
    if (after < hi && tokens[after].kind === 'comment' && text.startsWith('//', tokens[after].start)) { end = tokens[after].end; k = after + 1; }
    if (k < hi && tokens[k].kind === 'space') {
      const newline = text.indexOf('\n', tokens[k].start);
      end = newline >= 0 && newline < tokens[k].end ? newline + 1 : tokens[k].end;
    }
    const start = tokens[s].start;
    items.push({
      lead, start, end, kind: read.kind, name: read.name, key: squeeze(`${read.kind} ${read.name}`), cfg: read.cfg ?? [], vis: read.vis ?? '', visAt: read.visAt,
      line: lineOf(text, start), lines: text.slice(lead, end).split('\n').length - 1, open: read.open, close: read.open === undefined ? undefined : matching(text, tokens, read.open),
    });
    lead = end;
    s = c.next(k);
  }
  return items;
}

/**
 * A whole file as its items. What stands before the first item and belongs to the file
 * (its //! lines, or a first comment block followed by a blank line) is `header`;
 * what follows the last item is `trailer`.
 * @param {string} text source with \n line ends @param {import('./native-lex.mjs').Lang} lang
 */
export function fileItems(text, lang) {
  const tokens = lex(text, lang);
  const items = itemsBetween(text, tokens, lang, 0, tokens.length);
  let header = 0;
  if (items.length > 0) {
    const first = items[0];
    const above = text.slice(0, first.start);
    const inner = [...above.matchAll(/^[ \t]*(?:\/\/!|\/\*!)[^\n]*\n/gm)].pop();
    const block = /^(?:[ \t]*\/\/[^\n]*\n)+[ \t]*\n/.exec(above);
    if (inner) header = inner.index + inner[0].length;
    else if (block) header = block[0].length;
    first.lead = header;
    first.lines = text.slice(first.lead, first.end).split('\n').length - 1;
  }
  const trailerFrom = items.length > 0 ? items[items.length - 1].end : 0;
  return { tokens, items, header: text.slice(0, header), trailer: text.slice(trailerFrom) };
}

/**
 * The items inside the body of `item` (the members of a class, the contents of a mod block).
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {import('./native-lex.mjs').Lang} lang @param {Item} item
 * @returns {Item[]}
 */
export function bodyItems(text, tokens, lang, item) {
  if (item.open === undefined || item.close === undefined || item.close < 0) return [];
  return itemsBetween(text, tokens, lang, item.open + 1, item.close);
}
