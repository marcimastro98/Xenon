'use strict';
// The last sign-in a start of this engine met, kept on disk: a restart later in the same
// session reads it and knows that sign-in was already used up.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../atomic-write.js');
const { DATA_DIR } = require('../engine/paths.js');

const SEEN_FILE = path.join(DATA_DIR, 'sign-in-seen.json');
// The longest id a system hands out is a boot id and a start time, well under this.
const MAX_ID_LENGTH = 128;

/**
 * @param {string} [file]
 * @returns {Promise<string | null>} '' when no sign-in was written down yet (a new install, or a
 *   file that holds something else), null when the file is there and cannot be read: nobody can
 *   say then whether this sign-in already had its tab
 */
async function readSeen(file = SEEN_FILE) {
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? '' : null;
  }
  try {
    const stored = JSON.parse(text);
    return stored && typeof stored.id === 'string' ? stored.id.slice(0, MAX_ID_LENGTH) : '';
  } catch {
    return '';
  }
}

/**
 * Rejects when the file cannot be written; the caller opens nothing then.
 * @param {string} id
 * @param {string} [file]
 */
async function writeSeen(id, file = SEEN_FILE) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ id: String(id).slice(0, MAX_ID_LENGTH) }));
}

module.exports = { readSeen, writeSeen, SEEN_FILE, MAX_ID_LENGTH };
