// What the engine remembers between two sweeps of pictures no tile uses any more.

const assetSweep = {
  tileSig: null,
  tileAt: 0,
  // Tile decorations named by a layout the version migration set aside. Without
  // this the first save after an upgrade sweeps them, and the kept layout restores
  // the positions with every picture missing — a backup that is worth less than it
  // looks. Read once and memoized only on success: the file is written at boot and
  // never changes, but a sweep that runs before it exists must not cache "none".
  backupRefs: null,
  slideshowSig: null,
  slideshowAt: 0,
};

module.exports = { assetSweep };
