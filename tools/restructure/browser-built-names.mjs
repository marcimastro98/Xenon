// A script's name put together from pieces: `../js/${name}.js` over a list of names, or name + '.js' handed to
// a join of path parts. The name of the file is then nowhere in the text as letters in a row, and a search for
// "capture-gallery.js" walks past the test that reads it. Here the two halves are looked for apart: a place
// where a name ending in .js is built, and the script's name without the ending as a string of its own.
//
// What this cannot see: a name built in another file (a helper that adds '.js' to what it is handed), or pieces
// smaller than the whole name ('capture-' + kind). Those still need a line in browser-consumers.json.

import path from 'node:path';

// `...${name}.js`: what stands in the template before the last piece says which folder, when it says one.
const TEMPLATE = /`([^`]*)\$\{[^}`]*\}\.js`/g;
// name + '.js'
const ADDED = /\+\s*(['"`])\.js\1/;
/** The strings a search of the repo must find for a file to be one that builds names (git grep -F). */
export const BUILT_HINTS = ['}.js', "'.js'", '".js"', '`.js`'];

const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const foldersOf = (lead) => lead.slice(lead.lastIndexOf('}') + 1).split('/').filter((part) => part && part !== '.' && part !== '..').join('/');

/**
 * @param {string} text a file's text, comments blanked out
 * @returns {string[] | null} null when no name ending in .js is built in it; else the folders the built names are
 *   written under ('js', 'js/i18n'), with '' for a place that names no folder: the folder is then looked for apart
 */
export function builtFolders(text) {
  const folders = [...text.matchAll(TEMPLATE)].map((match) => foldersOf(match[1]));
  if (ADDED.test(text)) folders.push('');
  return folders.length ? [...new Set(folders)] : null;
}

// A built name that says no folder (name + '.js', a join of path parts) is this script's only when the text says the
// script's own folder somewhere as a piece of a path: 'js', '../js/', "settings". The word `save` in a text
// that builds names for another tree is then nobody's reader.
const namesFolder = (text, file) => new RegExp(`['"\`/]${escaped(path.posix.basename(path.posix.dirname(file)))}['"\`/]`).test(text);

/**
 * @param {string} text a file's text, comments blanked out
 * @param {string} file repo-relative script (`server/js/capture-gallery/capture-gallery.js`)
 * @returns {number[]} the lines where the script's name stands without its ending as a whole string, in a text
 *   that builds names ending in .js under a folder the script could be in; none when the text builds no such name
 */
export function builtMentions(text, file) {
  const folders = builtFolders(text);
  const under = `/${path.posix.dirname(file)}`;
  if (!folders?.some((folder) => (folder ? under.endsWith(`/${folder}`) : namesFolder(text, file)))) return [];
  const name = new RegExp(`(['"\`])${escaped(path.posix.basename(file, '.js'))}\\1`, 'g');
  return [...new Set([...text.matchAll(name)].map((match) => text.slice(0, match.index).split('\n').length))];
}
