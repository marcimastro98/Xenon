// Puts a function whose returned object was cut into part functions (returned.mjs)
// back in one piece, as text. The proof of a cut uses it, and so do the tests that
// read engine code as text: they keep finding `function normalizeHubSettings(value) {`
// followed by every key, as it was written when the function returned one literal.
//
// It works on whole lines. That is exact because the cut only takes a function that
// ends with `  return {` ... `  };` `}` on lines of their own, and writes every part
// the same way.

export const RETURN_LINE = '  return {';
export const END_LINE = '  };';
export const CLOSE_LINE = '}';
export const partHead = (name, params) => `function ${name}(${params.join(', ')}) {`;
export const callLine = (name, params) => `    ...${name}(${params.join(', ')}),`;

const escaped = (name) => name.replace(/[$]/g, String.raw`\$&`);
const headOf = (name) => new RegExp(String.raw`^function ${escaped(name)}\(([\w$, ]*)\) \{$`);
const callOf = (name) => new RegExp(String.raw`^    \.\.\.${escaped(name)}\(([\w$, ]*)\),$`);
const listOf = (text) => (text.trim() ? text.split(', ') : []);

/**
 * @param {string} text @param {string} name a function declared at the margin
 * @returns {{ head: number, first: number, last: number, close: number, params: string[], lines: string[] } | null}
 *   0-based lines: `head` the `function name(` line, `first` its `  return {`, `last` the `  };` that closes the object,
 *   `close` the `}` that closes the function; `lines` are the lines of the object. null when it does not end that way
 */
export function returnedLines(text, name) {
  const lines = text.split('\n');
  const head = lines.findIndex((line) => headOf(name).test(line));
  if (head === -1) return null;
  const close = lines.indexOf(CLOSE_LINE, head);
  const first = lines.indexOf(RETURN_LINE, head);
  if (close === -1 || first === -1 || first > close - 2 || lines[close - 1] !== END_LINE) return null;
  return { head, first, last: close - 1, close, params: listOf(headOf(name).exec(lines[head])[1]), lines: lines.slice(first + 1, close - 1) };
}

/**
 * @param {string} text the file that holds the function, its object made of `...part(...)` lines only
 * @param {{ name: string, parts: { name: string }[] }} cut
 * @param {(part: string) => string} partText the text of the file that declares a part today
 * @returns {string} the same text with the keys of every part back inside the returned object, in order
 */
export function undoReturnedText(text, cut, partText) {
  const whole = returnedLines(text, cut.name);
  if (!whole || whole.lines.length !== cut.parts.length) throw new Error(`${cut.name} does not return its recorded parts and nothing else`);
  const keys = cut.parts.flatMap((part, index) => {
    const found = returnedLines(partText(part.name), part.name);
    if (!found || found.first !== found.head + 1) throw new Error(`the part ${part.name} of ${cut.name} was not found as a function that only returns an object`);
    const called = callOf(part.name).exec(whole.lines[index]);
    if (!called || listOf(called[1]).join(', ') !== found.params.join(', ')) throw new Error(`${cut.name} does not return its recorded parts and nothing else`);
    return found.lines;
  });
  const lines = text.split('\n');
  return [...lines.slice(0, whole.first + 1), ...keys, ...lines.slice(whole.last)].join('\n');
}

/**
 * @param {string} text @param {string} name a part
 * @returns {string} the text without the lines of the part's function, and without the one empty line after them
 */
export function dropReturnedPart(text, name) {
  const found = returnedLines(text, name);
  if (!found) throw new Error(`the part ${name} was not found`);
  const lines = text.split('\n');
  const after = lines[found.close + 1] === '' ? found.close + 2 : found.close + 1;
  return [...lines.slice(0, found.head), ...lines.slice(after)].join('\n');
}

/**
 * @param {string} text a file where the function and all its parts are declared
 * @param {{ name: string, parts: { name: string }[] }} cut
 * @returns {string} the file as it was before the cut
 */
export function undoReturnedInPlace(text, cut) {
  return cut.parts.reduce((out, part) => dropReturnedPart(out, part.name), undoReturnedText(text, cut, () => text));
}
