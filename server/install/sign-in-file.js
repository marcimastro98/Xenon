'use strict';
// Whether a file that starts something at sign-in is on disk, and what it holds. Only "not
// there" is an answer of no. A file that cannot be looked at (no permission, a disk error) is
// thrown instead: the engine then opens no tab, where a guess of "no entry" would open one
// beside the app.

const fs = require('node:fs');

// The file, or a folder on the way to it, does not exist.
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

/** @returns {boolean} whether a failed look at a file says the file is not there */
const notThere = (error) => NOT_THERE.has(error?.code);

/**
 * @param {string} file
 * @param {(file: string) => Promise<any>} [access] for tests
 * @returns {Promise<boolean>}
 */
async function fileThere(file, access = fs.promises.access) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (notThere(error)) return false;
    throw error;
  }
}

/**
 * @param {string} file
 * @param {(file: string) => Promise<string>} [readFile] for tests
 * @returns {Promise<string | null>} the text, null when the file is not there
 */
async function textIfThere(file, readFile = (name) => fs.promises.readFile(name, 'utf8')) {
  try {
    return String(await readFile(file));
  } catch (error) {
    if (notThere(error)) return null;
    throw error;
  }
}

module.exports = { fileThere, textIfThere };
