// What the engine remembers about the settings file between saves: the id the file was stamped
// with, and the queue that lets one save finish before the next begins.

const settingsStore = {
  // The store id this process has seen on disk. Held so that a write which
  // somehow starts from a blob without one (a writer basing itself on
  // DEFAULT_HUB_SETTINGS before the boot read landed) RE-STAMPS the same id
  // instead of minting a fresh one: rotating it would tell every surface that the
  // store changed, which is precisely when their mirrors are the only remaining
  // copy of the settings. A new id is minted only when this process has never
  // seen one, i.e. a genuinely new store.
  id: '',
  writeChain: undefined, // given its first value where the engine loads
};

module.exports = { settingsStore };
