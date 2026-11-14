// The queue the saves of the Deck wait in, so one finishes before the next starts.

const deckWrites = {
  chain: undefined, // given its first value where the engine loads
};

module.exports = { deckWrites };
