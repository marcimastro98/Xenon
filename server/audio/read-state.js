// The audio command under way and the last problem with the sound levels that was said.

const audioReads = {
  pending: null,
  // When metering is wanted but cannot run — almost always a helper that predates
  // audio-serve — say so ONCE on the same channel instead of leaving the widget
  // with a feed that simply never starts. There is no Settings row to put this on
  // (the grant is the switch), so it has to reach the widget itself.
  levelsProblemSaid: '',
};

module.exports = { audioReads };
