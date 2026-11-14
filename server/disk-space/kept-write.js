'use strict';
// One store of the disk feature written to disk, for when the write fails. On Windows the atomic
// write gives up when another program holds the file open for more than about a second
// (atomic-write.js). What could not be written stays marked as not saved, so the next save
// writes it and the shutdown gives it a last try, and the failure is told once: the store's
// name and the error's code, never the path or the message, which hold the name of the PC's user.

const { writeFileAtomic } = require('../atomic-write.js');

/**
 * @param {string} what the store, as the log line names it
 * @param {{ write?: (file: string, text: string) => Promise<unknown>, log?: (line: string) => void }} [deps] for tests
 * @returns {{ save: (file: string, text: string) => Promise<boolean>, unsaved: () => boolean }} `save` never throws: it
 *   answers whether the text reached the disk; `unsaved` says whether the last save did not
 */
function makeKeptWrite(what, deps = {}) {
  const write = deps.write || writeFileAtomic;
  const log = deps.log || ((line) => console.warn(line));
  const state = { unsaved: false, told: false };

  async function save(file, text) {
    try {
      await write(file, text);
      state.unsaved = false;
      state.told = false;
      return true;
    } catch (error) {
      state.unsaved = true;
      if (!state.told) {
        state.told = true;
        log(`[disk] ${what} could not be saved (${error?.code || 'error'}): kept, the next save tries again`);
      }
      return false;
    }
  }

  return { save, unsaved: () => state.unsaved };
}

module.exports = { makeKeptWrite };
