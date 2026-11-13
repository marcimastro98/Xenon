// Which Rust code the compiler on this Windows PC never looks at: what stands under
// a #[cfg(...)] that is false here (macOS, Linux, release-only). A move of such code
// is wired by its words alone, so the split says which items hold some: those are
// the ones only the other systems' builds can prove.

/** @typedef {true | false | 'both'} Seen true, false, or built both ways (`test`) */

/** Reads one predicate, e.g. `all(unix, not(target_os = "macos"))`, as it holds on Windows. */
function holds(text) {
  const tokens = text.match(/"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g) ?? [];
  let at = 0;
  /** @returns {Seen} */
  const read = () => {
    const name = tokens[at];
    at += 1;
    if (tokens[at] === '(') {
      at += 1;
      /** @type {Seen[]} */
      const inner = [];
      while (at < tokens.length && tokens[at] !== ')') {
        inner.push(read());
        if (tokens[at] === ',') at += 1;
      }
      at += 1;
      if (name === 'not') return inner[0] === 'both' ? 'both' : !inner[0];
      const decides = name === 'any';
      if (inner.includes(decides)) return decides;
      return inner.includes('both') ? 'both' : !decides;
    }
    let value;
    if (tokens[at] === '=') { value = tokens[at + 1].slice(1, -1); at += 2; }
    if (name === 'windows' || name === 'desktop' || name === 'debug_assertions') return true;
    if (name === 'unix' || name === 'mobile') return false;
    if (name === 'target_os' || name === 'target_family') return value === 'windows';
    // test: `cargo check --all-targets` builds with and without it. Anything else (a feature, an architecture) is taken as built.
    return name === 'test' ? 'both' : true;
  };
  return tokens.length === 0 ? true : read();
}

/**
 * @param {string} predicate what stands inside `cfg( ... )`
 * @returns {boolean} whether `cargo check --all-targets` on Windows compiles what stands under it
 */
export function seenOnWindows(predicate) {
  return holds(predicate) !== false;
}

/**
 * @param {string} text a piece of Rust
 * @returns {string[]} the predicates of its #[cfg(...)] attributes that are false on Windows
 */
export function unseenOnWindows(text) {
  const out = [];
  for (const found of text.matchAll(/#\s*!?\[\s*cfg\s*\(/g)) {
    let depth = 1;
    let end = found.index + found[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') depth -= 1;
      end += 1;
    }
    const predicate = text.slice(found.index + found[0].length, end - 1).replace(/\s+/g, ' ').trim();
    if (!seenOnWindows(predicate)) out.push(predicate);
  }
  return [...new Set(out)];
}
