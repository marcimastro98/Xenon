'use strict';
// koffi async call as a promise, with a ceiling: a USB call that never returns
// leaves its worker thread busy but frees the caller.

const OP_TIMEOUT_MS = 2000;

function boundedCall(fn, ...args) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('HID call timed out')), OP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  const run = new Promise((resolve, reject) => {
    fn.async(...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
  return Promise.race([run.finally(() => clearTimeout(timer)), guard]);
}

module.exports = { boundedCall };
