// Whether macOS lets the engine read the whole disk, and the folders the file index is kept out
// of while it does not.

const macDiskAccess = {
  // The roots this machine can actually open, from whatever is saved.
  //
  // Roots are stored in whichever shape the machine that saved them uses, and
  // normalizeSearchSettings deliberately keeps BOTH shapes so a config carried
  // between a PC and a Mac is never destroyed. The consequence is that a saved
  // list can be non-empty and still contain nothing this host can open: the
  // dashboard's own browser-side default wrote "C:\" on every Mac and Linux
  // install, and no POSIX walk can start there. Search then ran with zero roots
  // and reported itself off, and the disk widget — which addresses roots BY INDEX
  // into this same list — resolved root 0 to "C:\" and drew an empty 0-byte disk.
  // Both while Settings displayed a configured folder, so there was nothing the
  // user could do about either.
  //
  // Every consumer must therefore resolve through here, or two of them disagree
  // about which disk is being talked about. The saved list is left untouched, so
  // a config shared with a Windows machine still works there.
  //
  // Three distinct states, and collapsing any two of them breaks something:
  //   absent      nobody has chosen yet          → this platform's default
  //   empty       the user switched it off       → stays off
  //   unusable    saved elsewhere, non-empty     → this platform's default
  // macOS only: is Full Disk Access in force right now? Cached, because
  // usableIndexRoots() is synchronous and on the settings path; refreshed by the
  // timer below, which is also what makes granting the permission take effect
  // without restarting anything. Every other platform is granted by definition —
  // there is no TCC to withhold anything.
  granted: true,
  // The roots we actually withheld, so the UI can say WHY the index is off
  // instead of leaving the user with an empty map and no explanation.
  blockedRoots: [],
};

module.exports = { macDiskAccess };
