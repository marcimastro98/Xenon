// Reads which names a Rust item uses, by its words alone (no type knowledge): enough
// to tell which imports a file needs once its items are spread over several files.
// It errs towards one import too many, which the compiler reports as a warning,
// never towards one too few on code this PC cannot compile.

import { cursor, matching } from './native-lex.mjs';
import { useLeaves } from './native-use.mjs';

/**
 * @typedef {object} Words how an item uses names
 * @property {Set<string>} used names it certainly refers to (`name::`, `name(`, `name!`, or a bare name it never binds)
 * @property {Set<string>} dotted names after a dot: fields and methods
 * @property {Set<string>} pathed names after `::`: associated functions, variants, constants
 * @property {Set<string>} bound names it declares itself (`name:`, `let name`)
 * @property {Set<string>} all every word
 */

const BINDERS = new Set(['let', 'mut', 'for', 'ref', 'fn', 'struct', 'enum', 'union', 'trait', 'type', 'const', 'static', 'mod']);

/**
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {{ start: number, end: number }} item
 * @returns {Words}
 */
export function wordsOf(text, tokens, item) {
  let lo = 0;
  while (lo < tokens.length && tokens[lo].start < item.start) lo += 1;
  let hi = lo;
  while (hi < tokens.length && tokens[hi].start < item.end) hi += 1;
  const c = cursor(text, tokens, hi);
  const words = { used: new Set(), dotted: new Set(), pathed: new Set(), bound: new Set(), all: new Set() };
  const bare = new Set();
  let before = '';
  let beforeTwo = '';
  for (let k = c.next(lo); k < hi; k = c.next(k + 1)) {
    const w = c.word(k);
    // A constant written inside a format string: format!("{NAME}").
    if (tokens[k].kind === 'string') for (const named of c.str(k).matchAll(/\{([A-Z_][A-Z0-9_]*)[}:]/g)) { words.all.add(named[1]); bare.add(named[1]); }
    if (w && !/^\d/.test(w)) {
      const after = c.next(k + 1);
      const colon = c.str(after) === ':';
      const doubleColon = colon && text[tokens[after].end] === ':' && c.str(c.next(after + 1)) === ':';
      words.all.add(w);
      // (`0..MAX` is a range, not a field; `fn name(` declares the name)
      if (before === '.' && beforeTwo !== '.') words.dotted.add(w);
      else if (before === 'fn') words.bound.add(w);
      else if (before === ':' && beforeTwo === ':') words.pathed.add(w);
      else if (doubleColon || c.str(after) === '(' || c.str(after) === '!') words.used.add(w);
      else if (/^[A-Z]/.test(w)) bare.add(w);
      else if (colon || BINDERS.has(before) || (before === '|' && beforeTwo !== '|')) words.bound.add(w);
      else bare.add(w);
    }
    beforeTwo = before;
    before = c.str(k);
  }
  // A bare lower-case name the item also declares is its own variable; a type or a CONSTANT is not.
  for (const w of bare) if (!words.bound.has(w) || /^[A-Z]/.test(w)) words.used.add(w);
  return words;
}

/**
 * The names an item reaches in the module above its file with `super::name`.
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {{ start: number, end: number }} item
 * @returns {Set<string>}
 */
export function namesAbove(text, tokens, item) {
  let lo = 0;
  while (lo < tokens.length && tokens[lo].start < item.start) lo += 1;
  let hi = lo;
  while (hi < tokens.length && tokens[hi].start < item.end) hi += 1;
  const c = cursor(text, tokens, hi);
  const names = new Set();
  for (let k = c.next(lo); k < hi; k = c.next(k + 1)) {
    if (c.word(k) !== 'super') continue;
    const colon = c.next(k + 1);
    const second = c.next(colon + 1);
    if (c.str(colon) === ':' && c.str(second) === ':' && c.word(c.next(second + 1))) names.add(c.word(c.next(second + 1)));
  }
  return names;
}

/**
 * Where an item says `pub(super)`: the offset of each `super`. One module further down the same words
 * would stop one module short, so the splitter writes `pub(in super::super)` there: the same place as before.
 * @param {string} text @param {import('./native-lex.mjs').Token[]} tokens
 * @param {{ start: number, end: number }} item
 * @returns {number[]}
 */
export function superVisibilities(text, tokens, item) {
  let lo = 0;
  while (lo < tokens.length && tokens[lo].start < item.start) lo += 1;
  let hi = lo;
  while (hi < tokens.length && tokens[hi].start < item.end) hi += 1;
  const c = cursor(text, tokens, hi);
  const found = [];
  for (let k = c.next(lo); k < hi; k = c.next(k + 1)) {
    if (c.word(k) !== 'pub') continue;
    const paren = c.next(k + 1);
    const inner = c.next(paren + 1);
    if (c.str(paren) === '(' && c.word(inner) === 'super' && c.str(c.next(inner + 1)) === ')') found.push(tokens[inner].start);
  }
  return found;
}

/**
 * The names a file reaches through a module it names: `crate::NAME`, `use super::{A, B}`.
 * @param {string} text a Rust file @param {import('./native-lex.mjs').Token[]} tokens
 * @param {Set<string>} through how the file may call that module: `crate`, `super`, its own name
 * @returns {Set<string>}
 */
export function reachedThrough(text, tokens, through) {
  const c = cursor(text, tokens, tokens.length);
  const names = new Set();
  for (let k = c.next(0); k < tokens.length; k = c.next(k + 1)) {
    if (!through.has(c.word(k))) continue;
    const colon = c.next(k + 1);
    const second = c.next(colon + 1);
    if (c.str(colon) !== ':' || c.str(second) !== ':') continue;
    const after = c.next(second + 1);
    if (c.word(after)) names.add(c.word(after));
    if (c.str(after) !== '{') continue;
    const close = matching(text, tokens, after);
    for (const leaf of useLeaves(text.slice(tokens[after].start, tokens[close].end))) if (leaf.path.length === 0) names.add(leaf.name);
  }
  return names;
}

/** @param {Words[]} list @returns {Words} the words of several items together */
export function mergeWords(list) {
  const merged = { used: new Set(), dotted: new Set(), pathed: new Set(), bound: new Set(), all: new Set() };
  for (const words of list) for (const key of Object.keys(merged)) for (const w of words[key]) merged[key].add(w);
  return merged;
}

// Traits are imported for their methods, so their own name never shows in the code.
// The methods each one is imported for in this codebase; a plan can add more.
export const TRAIT_METHODS = {
  Write: ['write', 'write_all', 'flush', 'write_fmt', 'write_str', 'writeln', 'by_ref'],
  Read: ['read', 'read_to_end', 'read_to_string', 'read_exact', 'take', 'bytes'],
  BufRead: ['lines', 'read_line', 'read_until', 'split'],
  Seek: ['seek', 'stream_position', 'rewind'],
  Manager: ['get_webview_window', 'webview_windows', 'state', 'try_state', 'manage', 'app_handle', 'path', 'get_window', 'get_webview', 'package_info', 'config',
    'get_focused_window', 'webviews', 'unmanage', 'resources_table', 'asset_protocol_scope', 'add_capability'],
  Emitter: ['emit', 'emit_to', 'emit_filter'],
  Listener: ['listen', 'listen_any', 'once', 'unlisten'],
  CommandExt: ['creation_flags', 'raw_arg', 'pre_exec', 'exec', 'process_group', 'arg0', 'uid', 'gid'],
  OpenOptionsExt: ['mode', 'custom_flags', 'share_mode', 'access_mode', 'attributes'],
  PermissionsExt: ['mode', 'set_mode', 'from_mode'],
  MetadataExt: ['file_attributes', 'mode', 'uid', 'ino', 'dev', 'mtime', 'size', 'nlink', 'file_size', 'last_write_time'],
  FileTypeExt: ['is_symlink_dir', 'is_symlink_file', 'is_fifo', 'is_socket', 'is_block_device', 'is_char_device'],
  OsStrExt: ['encode_wide', 'as_bytes', 'from_bytes'],
  OsStringExt: ['from_wide', 'from_vec', 'into_vec'],
  AsRawFd: ['as_raw_fd'], AsRawHandle: ['as_raw_handle'], FromRawFd: ['from_raw_fd'], IntoRawFd: ['into_raw_fd'], AsFd: ['as_fd'],
  FromStr: ['from_str'], Hasher: ['finish', 'write_u64', 'write'], Hash: ['hash'],
  Interface: ['cast', 'as_raw', 'into_raw', 'from_raw', 'from_raw_borrowed'],
  Any: ['type_id', 'downcast_ref', 'downcast'],
};

/**
 * @param {string} trait @param {Words} words @param {Record<string, string[]>} [more] a plan's own methods per trait
 * @returns {boolean | null} whether the file calls one of the trait's methods; null when the trait is not known
 */
export function callsTrait(trait, words, more = {}) {
  const methods = more[trait] ?? TRAIT_METHODS[trait];
  if (!methods) return null;
  return methods.some((m) => words.dotted.has(m) || words.pathed.has(m) || words.used.has(m));
}

/** @param {string[][]} sets cfg lists @returns {string[]} the cfg lines every list has */
export function commonCfg(sets) {
  if (sets.length === 0) return [];
  return sets[0].filter((cfg) => sets.every((set) => set.includes(cfg)));
}

/**
 * True when the cfg lists are two halves of everything: `cfg(x)` and `cfg(not(x))`.
 * @param {string[][]} sets one cfg list per variant of an item
 */
export function coversEverything(sets) {
  if (sets.some((set) => set.length === 0)) return true;
  if (sets.length !== 2 || sets[0].length !== 1 || sets[1].length !== 1) return false;
  const inner = (cfg) => /^# ?\[ ?cfg ?\((.*)\) ?\]$/.exec(cfg)?.[1].replace(/\s+/g, '') ?? '';
  const [a, b] = [inner(sets[0][0]), inner(sets[1][0])];
  return a === `not(${b})` || b === `not(${a})`;
}
