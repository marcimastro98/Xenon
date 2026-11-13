// Puts `__dirname` back in the text of a path module (paths.mjs). The proof of
// such a move uses it, and so do the tests that read engine code as text: they
// keep finding `path.join(__dirname, 'data')` as it was written in the old file.
//
// It looks for the word as text. That is exact because the move refuses lines
// that already hold the word, and writes the one line that declares it itself.

export const HOME = 'SERVER_DIR';
export const OLD_HOME = '__dirname';

/** @param {string} [flags] @returns {RegExp} the new word where it is not part of a longer name */
export function homeWord(flags = '') {
  return new RegExp(String.raw`(?<![\w$])${HOME}(?![\w$])`, flags);
}

/** @param {string} text lines of a path module @returns {string} the same lines as they stood in the old file */
export function oldSpelling(text) {
  return text.replace(homeWord('g'), OLD_HOME);
}

/**
 * @param {string} text a whole path module
 * @returns {string} the module without the line that works out the home folder, and with the old word everywhere else
 */
export function oldPathsText(text) {
  return oldSpelling(text.split('\n').filter((line) => !line.startsWith(`const ${HOME} = `)).join('\n'));
}
