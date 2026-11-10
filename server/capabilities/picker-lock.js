'use strict';
// The capture engine does one thing at a time: while the user is picking an
// area (a screenshot or text from the screen), any other capture would wait
// behind the picker and time out. One flag for both, so a second press while
// the picker is on screen is answered as "picking" instead.

let busy = false;

function held() {
  return busy;
}

// Runs `fn` holding the flag; the caller checks held() first.
async function hold(fn) {
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

module.exports = { held, hold };
