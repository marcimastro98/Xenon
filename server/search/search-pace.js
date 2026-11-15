'use strict';

// Spaces out requests to a service that refuses bursts. Each call books the next
// free slot and returns how many ms to wait for it, or null when a request is
// already waiting: a queue would leave a chat turn hanging for longer than a
// failed search costs it.
function createPace(gapMs) {
  let nextSlot = 0;
  return (now) => {
    const wait = Math.max(0, nextSlot - now);
    if (wait > gapMs) return null;
    nextSlot = now + wait + gapMs;
    return wait;
  };
}

module.exports = { createPace };
