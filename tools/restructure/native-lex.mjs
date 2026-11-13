// Cuts Rust, C# or Swift source into tokens without understanding the language:
// just enough to tell code from comments and strings, so brackets can be matched
// and the items of a file found. Every character of the text is in exactly one token.

/** @typedef {'rust' | 'cs' | 'swift'} Lang */
/** @typedef {{ kind: 'space' | 'comment' | 'string' | 'word' | 'punct' | 'directive', start: number, end: number }} Token */

const WORD = /[A-Za-z0-9_\u0080-￿]/;
const OPEN = { '(': ')', '[': ']', '{': '}' };

/** @param {string} file @returns {Lang} */
export function langOf(file) {
  if (file.endsWith('.rs')) return 'rust';
  if (file.endsWith('.cs')) return 'cs';
  if (file.endsWith('.swift')) return 'swift';
  throw new Error(`Not a Rust, C# or Swift file: ${file}`);
}

/** End of a block comment that starts at `i`; Rust and Swift comments nest, C# ones do not. */
function blockCommentEnd(text, i, nests) {
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text.startsWith('/*', j) && (nests || depth === 0)) { depth += 1; j += 1; } else if (text.startsWith('*/', j)) {
      depth -= 1; j += 1;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

/** End of bracketed code that starts just after an opening bracket, strings and comments skipped. */
function codeEnd(text, i, close, lang) {
  let depth = 0;
  for (let j = i; j < text.length;) {
    const end = triviaOrStringEnd(text, j, lang);
    if (end > j) { j = end; continue; }
    const c = text[j];
    if (OPEN[c]) depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0 && c === close) return j + 1;
      depth -= 1;
    }
    j += 1;
  }
  return text.length;
}

/** A quoted run with backslash escapes; `hole` says where an embedded expression starts, if the language has them. */
function quotedEnd(text, i, quote, lang, hole) {
  for (let j = i; j < text.length;) {
    if (hole && text.startsWith(hole.skip ?? '\u0000', j)) { j += hole.skip.length; continue; }
    if (hole && text.startsWith(hole.open, j)) { j = codeEnd(text, j + hole.open.length, hole.close, lang); continue; }
    if (text[j] === '\\' && !hole?.verbatim) { j += 2; continue; }
    if (text.startsWith(quote, j)) {
      if (hole?.verbatim && text[j + 1] === '"') { j += 2; continue; }
      return j + quote.length;
    }
    j += 1;
  }
  return text.length;
}

function rustStringEnd(text, i) {
  const raw = /^(?:b|c)?r(#*)"/.exec(text.slice(i, i + 40));
  if (raw && !WORD.test(text[i - 1] ?? ' ')) {
    const close = `"${raw[1]}`;
    const end = text.indexOf(close, i + raw[0].length);
    return end < 0 ? text.length : end + close.length;
  }
  const plain = /^(?:b|c)?"/.exec(text.slice(i, i + 2));
  if (plain && !(plain[0].length === 2 && WORD.test(text[i - 1] ?? ' '))) return quotedEnd(text, i + plain[0].length, '"', 'rust');
  if (text[i] !== "'") return i;
  // 'a' and '\n' are characters; 'a alone is a lifetime or a label and stays code.
  if (text[i + 1] === '\\') return quotedEnd(text, i + 1, "'", 'rust');
  const width = text.codePointAt(i + 1) > 0xffff ? 2 : 1;
  return text[i + 1 + width] === "'" ? i + 2 + width : i;
}

function csStringEnd(text, i) {
  const head = /^(\$+@?|@\$?)?("{3,}|")/.exec(text.slice(i, i + 12));
  if (head) {
    const [all, prefix = '', quotes] = head;
    if (quotes.length >= 3) {
      const end = text.indexOf(quotes, i + all.length);
      return end < 0 ? text.length : end + quotes.length;
    }
    const verbatim = prefix.includes('@');
    const hole = prefix.includes('$') ? { open: '{', close: '}', skip: '{{', verbatim } : (verbatim ? { open: '\u0000', close: '', verbatim } : null);
    return quotedEnd(text, i + all.length, '"', 'cs', hole);
  }
  return text[i] === "'" ? quotedEnd(text, i + 1, "'", 'cs') : i;
}

function swiftStringEnd(text, i) {
  const head = /^(#*)("""|")/.exec(text.slice(i, i + 12));
  if (!head) return i;
  const [all, hashes, quotes] = head;
  return quotedEnd(text, i + all.length, `${quotes}${hashes}`, 'swift', { open: `\\${hashes}(`, close: ')' });
}

/** Where the comment or string that starts at `i` ends, or `i` when neither starts there. */
function triviaOrStringEnd(text, i, lang) {
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith('/*', i)) return blockCommentEnd(text, i, lang !== 'cs');
  if (lang === 'rust') return rustStringEnd(text, i);
  return lang === 'cs' ? csStringEnd(text, i) : swiftStringEnd(text, i);
}

/**
 * @param {string} text source with \n line ends
 * @param {Lang} lang
 * @returns {Token[]}
 */
export function lex(text, lang) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let lineHasCode = false;
  const push = (kind, end) => { tokens.push({ kind, start: i, end }); i = end; };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text.slice(i, j).includes('\n')) lineHasCode = false;
      push('space', j);
      continue;
    }
    const isComment = text.startsWith('//', i) || text.startsWith('/*', i);
    const end = triviaOrStringEnd(text, i, lang);
    if (end > i) { if (!isComment) lineHasCode = true; push(isComment ? 'comment' : 'string', end); continue; }
    // C# and Swift lines such as #if, #region, #pragma: kept whole, they travel with the item below them.
    if (c === '#' && lang !== 'rust' && !lineHasCode && /^#[a-z]/.test(text.slice(i, i + 2))) {
      const eol = text.indexOf('\n', i);
      push('directive', eol < 0 ? text.length : eol);
      continue;
    }
    lineHasCode = true;
    if (WORD.test(c)) {
      let j = i + 1;
      while (j < text.length && WORD.test(text[j])) j += 1;
      push('word', j);
    } else push('punct', i + 1);
  }
  return tokens;
}

/** @param {Token} token @returns {boolean} true for what a compiler reads (not space, not a comment) */
export const isCode = (token) => token.kind !== 'space' && token.kind !== 'comment';

/**
 * The index of the token that closes the bracket opened at `at`.
 * @param {string} text @param {Token[]} tokens @param {number} at index of a ( [ or { token
 * @returns {number} index of its closing token, or -1 when it never closes
 */
export function matching(text, tokens, at) {
  let depth = 0;
  for (let k = at; k < tokens.length; k += 1) {
    if (tokens[k].kind !== 'punct') continue;
    const c = text[tokens[k].start];
    if (OPEN[c]) depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** A cursor over the code tokens (comments, spaces and # lines skipped) of one range. */
export function cursor(text, tokens, hi) {
  const real = (k) => k < hi && isCode(tokens[k]) && tokens[k].kind !== 'directive';
  const next = (k) => { let n = k; while (n < hi && !real(n)) n += 1; return n; };
  const str = (k) => (k < hi ? text.slice(tokens[k].start, tokens[k].end) : '');
  const word = (k) => (k < hi && tokens[k].kind === 'word' ? str(k) : '');
  /** First token at bracket depth 0 from `k` on for which `stop` answers true; -1 when none. */
  const find = (k, stop) => {
    for (let n = next(k); n < hi; n = next(n + 1)) {
      if (stop(str(n), n)) return n;
      if (tokens[n].kind === 'punct' && '([{'.includes(str(n))) {
        n = matching(text, tokens, n);
        if (n < 0) return -1;
      }
    }
    return -1;
  };
  return { next, str, word, find, semicolon: (k) => find(k, (s) => s === ';') };
}

/** @param {string} text @param {number} offset @returns {number} the 1-based line of a character */
export function lineOf(text, offset) {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}
