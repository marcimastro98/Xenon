'use strict';

// Right after a start the slow sources take seconds to answer once: PowerShell has to
// load and the sensors their drivers. Who would rather have something now than
// everything later asks through here; the first full read ends all of this.

const FIRST_READING_WAIT_MS = 50;

/**
 * Returns firstReading(reading, known). `reading` is the full read. With `known`, a
 * function giving what can be said without waiting, it resolves to that once `waitMs`
 * has passed, marked `partial`, for as long as no full read has ever landed. Without
 * it, it waits for the read, which still counts as a landed one.
 */
function createFirstReading({ waitMs = FIRST_READING_WAIT_MS } = {}) {
  let landed = false;
  return function firstReading(reading, known) {
    const full = reading.then((value) => {
      landed = true;
      return { value, partial: false };
    });
    if (landed || !known) return full;
    const early = new Promise((resolve) => { setTimeout(resolve, waitMs); })
      .then(async () => ({ value: await known(), partial: true }));
    return Promise.race([full, early]);
  };
}

/**
 * A fact that stays the same while the program runs. Whoever asks during the read
 * shares it. A read that fails or finds nothing is tried again after `retryMs`, never
 * on every call, because the readers here are whole processes.
 */
function createFactReader(read, { retryMs }) {
  let fact = null;
  let pending = null;
  let nextTry = 0;
  async function get() {
    if (fact) return fact;
    if (pending) return pending;
    if (Date.now() < nextTry) return null;
    pending = Promise.resolve().then(read).catch(() => null).then((value) => {
      pending = null;
      if (value) fact = value;
      else nextTry = Date.now() + retryMs;
      return fact;
    });
    return pending;
  }
  return { get, known: () => fact };
}

module.exports = { createFirstReading, createFactReader };
