// Which one system a Rust file is compiled for, when the file says so for the whole of itself.
// Text in, verdict out: tools/check-platform-apis.mjs asks here which files it may leave unread.

// Strip comments before looking for identifiers. Without this the check fires
// on the very comment explaining why a call was gated, which trains people to
// ignore it — the failure mode that makes a linter worse than none.
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// The one shape that counts: `#![cfg(target_os = "linux")]`, alone on its line.
const ONE_SYSTEM = /^\s*#!\[cfg\(\s*target_os\s*=\s*"([a-z0-9_]+)"\s*\)\]\s*$/;

/**
 * The system a file is gated to as a whole, or '' when it is not gated to exactly one.
 *
 * Only an inner attribute that comes before the first item counts: that is the only place Rust
 * applies it to the whole file. And only the plain form naming one system: such a file compiles
 * there and nowhere else, so a name in it cannot be missing on another system. `any(...)` names
 * several systems and the name may exist on one of them only; `not(...)` leaves every other
 * system; `all(...)` and `cfg_attr` are not read at all. A file gated in one of those ways is
 * read like any other, call by call.
 * @param {string} text the file as it is on disk
 * @returns {string}
 */
export function wholeFileSystem(text) {
  const lines = stripComments(text).split(/\r?\n/);
  for (const line of lines) {
    const said = line.trim();
    if (!said) continue;
    if (!said.startsWith('#!')) return '';
    const one = ONE_SYSTEM.exec(line);
    if (one) return one[1];
  }
  return '';
}

const TOP_FN = /^(?:pub(?:\([^)]*\))? )?(?:(?:const|async|unsafe|extern "[^"]*") )*fn /;

/**
 * Whether line `i` is in the body of a function written at the left margin that carries its own
 * `#[cfg(... target_os ...)]`: the attribute holds for every line of that function, so a call in
 * it is already handled (the three `native_handle` of layers/mod.rs, one per system).
 * Only the attribute lines right above the `fn` count, and only a function at the left margin:
 * its body ends at the first `}` at the margin, which rustfmt writes for no other reason.
 * @param {string[]} lines the file, comments stripped
 * @param {number} i
 * @returns {boolean}
 */
export function insideGatedFn(lines, i) {
  let start = i;
  while (start >= 0 && !TOP_FN.test(lines[start])) {
    if (start < i && lines[start].startsWith('}')) return false;
    start--;
  }
  // A function written on one line has closed before line `i`.
  if (start < 0 || (start < i && /[};]\s*$/.test(lines[start]))) return false;
  for (let j = start - 1; j >= 0 && lines[j].trim().startsWith('#'); j--) {
    if (/^#\[cfg[^\]]*target_os/.test(lines[j])) return true;
  }
  return false;
}

/**
 * The module files a file hangs under, nearest first: `a/b/c.rs` under `a/b.rs`, then `a.rs`.
 * A `mod.rs` is never one of them: it is the folder's own file, and the one of layers/ names
 * every system we build for.
 * @param {string} file a path with forward slashes, relative to the source folder
 * @returns {string[]}
 */
export function parentFiles(file) {
  const parts = file.split('/').slice(0, -1);
  const out = [];
  for (let n = parts.length; n > 0; n--) out.push(`${parts.slice(0, n).join('/')}.rs`);
  return out;
}

/**
 * Whether a file is compiled on one system only: it says so itself, or a file it hangs under does
 * (a file cut out of a gated one has no such line of its own, and Rust reads it only where its
 * parent is read).
 * @param {string} file a path with forward slashes, relative to the source folder
 * @param {(file: string) => string | null} read the text of a file by that kind of path, null when there is none
 * @returns {boolean}
 */
export function oneSystemOnly(file, read) {
  for (const candidate of [file, ...parentFiles(file)]) {
    const text = read(candidate);
    if (text !== null && wholeFileSystem(text)) return true;
  }
  return false;
}
