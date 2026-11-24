'use strict';
// A wait with a ceiling. A tick that holds fans never waits long on a file or a check:
// on a PC busy on every core the antivirus held a read of the service's readings for up
// to 7.6 s (23 Nov 2026), and a fan given no command for five seconds goes back to the PC.
// The ceiling timer stays referenced: someone is awaiting it, and an unref'd one let a process
// with nothing else alive end the wait never (the tests on Node 22, 24 Nov 2026). It lasts at most `ms`.

/**
 * Settles when `promise` does or after `ms`, whichever comes first, and never rejects.
 * @param {Promise<unknown>} promise @param {number} ms
 * @returns {Promise<void>}
 */
function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise.then(() => {}, () => {}), late]).then(() => clearTimeout(timer));
}

module.exports = { within };
