// Puts the old variable names back in text the state rewrite changed. The proof
// of a rewrite uses it (undone, the file is the old file byte for byte), and so
// do the tests that read engine code as text: they keep asking for the names the
// code had when they were written.
//
// Nothing here knows where the rewrite happened: it looks for `object.property`
// as text. That is exact because the rewrite refuses a file that already has that
// text, and a variable that a statement at the start of a line assigns.

const escaped = (text) => text.replace(/[$]/g, '\\$&');

/** @param {string} object @param {string} prop @returns {RegExp} every `object.prop` that is not part of a longer name */
export function statePattern(object, prop) {
  return new RegExp(`(?<![\\w$])${escaped(object)}\\.${escaped(prop)}(?![\\w$])`, 'g');
}

/** @param {string} name @returns {RegExp} a line that starts by assigning `name` */
export function assignmentLine(name) {
  return new RegExp(`^${escaped(name)}(?=\\s*=(?![=>]))`, 'gm');
}

/**
 * @param {string} text code after one or more state rewrites
 * @param {{ object: string, props: Record<string, string>, kept: string[] }} state what one rewrite did: old name to
 *   property, and the names whose first value is still given where the `let` stood
 * @returns {string} the same code with the old names, and `let` back in front of the kept first values
 */
export function undoStateText(text, state) {
  let out = text;
  for (const [name, prop] of Object.entries(state.props)) out = out.replace(statePattern(state.object, prop), () => name);
  for (const name of state.kept) out = out.replace(assignmentLine(name), () => `let ${name}`);
  return out;
}
