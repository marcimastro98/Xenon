// Runs one save of the Deck after the one before it has finished.

const { deckWrites } = require('./write-state.js');

function withDeckWrite(fn) {
  const run = deckWrites.chain.then(fn, fn);
  deckWrites.chain = run.catch(() => {});
  return run;
}

module.exports = { withDeckWrite };
