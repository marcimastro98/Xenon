// The clock that reads Voicemeeter while a dashboard shows it, and what was last sent.

const vmWatch = {
  pollTimer: null,
  lastJson: '',
};

module.exports = { vmWatch };
