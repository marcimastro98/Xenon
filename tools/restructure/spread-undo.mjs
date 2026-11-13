// Puts an object that was cut into parts (spread.mjs) back in one piece, as text.
// The proof of a cut uses it, and so do the tests that read engine code as text:
// they keep finding `const DEFAULT_HUB_SETTINGS = Object.freeze({` followed by
// every key, as it was written when it was one literal.
//
// It works on whole lines. That is exact because the cut only takes a literal
// that opens and closes on lines of their own, and writes every part the same way.

export const headLine = (name) => `const ${name} = Object.freeze({`;
export const END_LINE = '});';
export const spreadLine = (name) => `  ...${name},`;

/**
 * @param {string} text @param {string} name
 * @returns {{ first: number, last: number, lines: string[] } | null} the lines between `const name = Object.freeze({`
 *   and the first `});` at the margin after it; `first` and `last` are the 0-based lines of those two
 */
export function innerLines(text, name) {
  const lines = text.split('\n');
  const first = lines.indexOf(headLine(name));
  if (first === -1) return null;
  const last = lines.indexOf(END_LINE, first);
  return last === -1 ? null : { first, last, lines: lines.slice(first + 1, last) };
}

/**
 * @param {string} text the file that holds `const name = Object.freeze({ ...PART, ... });`
 * @param {{ name: string, parts: { name: string }[] }} spread
 * @param {(part: string) => string} partText the text of the file that declares a part today
 * @returns {string} the same text with the keys of every part back inside the literal, in order
 */
export function undoSpreadText(text, spread, partText) {
  const whole = innerLines(text, spread.name);
  const wanted = spread.parts.map((part) => spreadLine(part.name)).join('\n');
  if (!whole || whole.lines.join('\n') !== wanted) throw new Error(`${spread.name} is not made of its recorded parts and nothing else`);
  const keys = spread.parts.flatMap((part) => {
    const found = innerLines(partText(part.name), part.name);
    if (!found) throw new Error(`the part ${part.name} of ${spread.name} was not found`);
    return found.lines;
  });
  const lines = text.split('\n');
  return [...lines.slice(0, whole.first + 1), ...keys, ...lines.slice(whole.last)].join('\n');
}

/**
 * @param {string} text @param {string} name a part
 * @returns {string} the text without the lines that declare the part, and without the one empty line after them
 */
export function dropPart(text, name) {
  const found = innerLines(text, name);
  if (!found) throw new Error(`the part ${name} was not found`);
  const lines = text.split('\n');
  const after = lines[found.last + 1] === '' ? found.last + 2 : found.last + 1;
  return [...lines.slice(0, found.first), ...lines.slice(after)].join('\n');
}

/**
 * @param {string} text a file where the object and all its parts are declared
 * @param {{ name: string, parts: { name: string }[] }} spread
 * @returns {string} the file as it was before the cut
 */
export function undoSpreadInPlace(text, spread) {
  return spread.parts.reduce((out, part) => dropPart(out, part.name), undoSpreadText(text, spread, () => text));
}
