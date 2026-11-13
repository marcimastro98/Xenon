// The install of the audio helper started from Settings, while it runs: a second tap waits on
// the first.

const helperInstall = {
  running: null,   // one Settings install at a time; a second tap waits on the first
};

module.exports = { helperInstall };
