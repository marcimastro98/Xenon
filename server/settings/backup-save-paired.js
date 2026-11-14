'use strict';

// A backup saved to a file on the PC when a paired device asked for it. The device gets the
// file's name, not the folder (the path holds the name of the PC's user), and the PC writes at
// most one such file a minute: a backup can be several megabytes, and nobody at the PC sees
// the files pile up.

const WAIT_MS = 60 * 1000;

/**
 * @param {{ now?: () => number, waitMs?: number }} [options] for tests
 */
function createPairedBackupSaves({ now = Date.now, waitMs = WAIT_MS } = {}) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    /** @returns {number} the seconds left before the next save may start, 0 when it may */
    wait() {
      const left = last + waitMs - now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
    /** Called when a save starts, so a second request cannot run beside it. */
    started() { last = now(); },
    /**
     * @param {{ ok: boolean, fileName?: string }} saved what the engine answers at the PC
     * @returns {{ ok: boolean, fileName?: string }} the same without the path
     */
    answer(saved) { return { ok: saved.ok === true, fileName: saved.fileName }; },
  };
}

module.exports = { createPairedBackupSaves };
