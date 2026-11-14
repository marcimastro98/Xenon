'use strict';
// The limits of the disk space module: how long a scan and a delete may take, and how much is
// listed, hashed and deleted at a time.

const SCAN_TIMEOUT_MS = 15 * 60 * 1000;   // a wedged scan must not hang forever
const CLIENT_DIRS_MAX = 1500;             // treemap payload bound
const CLIENT_FILES_MAX = 200;
const CATEGORY_ITEMS_MAX = 5000;          // per category, size-ordered
const HASH_FILE_MAX = 200 * 1024 * 1024;  // never hash a file beyond this
const HASH_TOTAL_MAX = 2 * 1024 * 1024 * 1024; // …or more than this per scan
const DUPE_GROUPS_MAX = 40;
const DELETE_BATCH_MAX = 16;
// A shell-delete call is bounded, but generously. Recycling a folder on the
// same volume is one rename, but EMPTYING the Bin really deletes per-file: a
// 38 GB Bin is legitimately many minutes of work, and the old 120s bound
// killed the helper mid-operation — every attempt emptied two minutes' worth
// and then reported empty_failed while the Bin visibly shrank.
const SHELL_DELETE_TIMEOUT_MS = 30 * 60 * 1000;
// SHFileOperation answers with these when something INSIDE the tree is held
// open by a running program (an npm debug log, a uv .lock): the move of a
// folder is one rename, so one open file refuses the whole folder. These are
// the signal to descend and recycle the children individually instead.
const IN_USE_RCS = new Set([5 /* ERROR_ACCESS_DENIED */, 32 /* SHARING_VIOLATION */, 120 /* DE_ACCESSDENIEDSRC */]);
const DESCEND_MAX_DEPTH = 4;
const DU_WALK_CAP = 120000;   // bounded remaining-size walk after a partial clear

module.exports = {
  SCAN_TIMEOUT_MS, CLIENT_DIRS_MAX, CLIENT_FILES_MAX, CATEGORY_ITEMS_MAX, HASH_FILE_MAX,
  HASH_TOTAL_MAX, DUPE_GROUPS_MAX, DELETE_BATCH_MAX, SHELL_DELETE_TIMEOUT_MS, IN_USE_RCS,
  DESCEND_MAX_DEPTH, DU_WALK_CAP,
};
