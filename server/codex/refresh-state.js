// What the engine remembers between two refreshes of the Codex tile.

const codexRefresh = {
  pushTimer: null,
  sig: '',
  linkCache: null,
  linkRepairedAt: 0,
};

module.exports = { codexRefresh };
