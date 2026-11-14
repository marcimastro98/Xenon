// The live voice conversation in progress, if any.

const liveNow = {
  session: null, // { session, capture, timer, teardown }
};

module.exports = { liveNow };
