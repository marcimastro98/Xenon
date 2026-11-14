'use strict';
// The two walks of the Linux index: a root walked for its files, and a skipped folder walked
// for its size alone, both stopping when the scan is replaced and waiting while the index is
// held.

const { fsp, SKIP_DIRS, AGG_DEPTH, isSkippedPath } = require('./linux-index-rules.js');
const path = require('node:path');
const { foldName } = require('./linux-index-query.js');

function makeWalks({ maxEntries, maxAgg, ixState }) {
  const holdEnds = () => new Promise((resume) => { ixState.waitingWalks.push(resume); });

  // false = this walk did not see the whole root (the entry cap stopped it, or
  // the scan was superseded). The caller records which roots those were, so the
  // UI can name the folder search cannot see rather than only saying that some
  // limit was reached.
  // A SKIP_DIRS subtree, measured but not searchable: one row per directory
  // down to AGG_DEPTH below `top` (deeper folders roll into their ancestor),
  // each carrying the bytes and file count directly inside it. Separate from
  // `entries` and its cap, so a big node_modules can never cost search a file
  // and a query can never surface a cache file. false = superseded.
  async function sizeWalk(top, token, out) {
    const rows = new Map();
    const rowFor = (p, n, m) => {
      let r = rows.get(p);
      if (!r) {
        r = { p, n, nl: foldName(n), s: 0, m, d: true, x: true, fc: 0 };
        rows.set(p, r);
        out.push(r);
      }
      return r;
    };
    let topM = 0;
    try { topM = (await fsp.lstat(top)).mtimeMs; } catch { /* keep 0 */ }
    rowFor(top, path.basename(top), topM);
    const stack = [{ dir: top, owner: top, depth: 0 }];
    while (stack.length) {
      if (ixState.held) await holdEnds();
      if (token !== ixState.scanToken || ixState.stopped) return false;
      const { dir, owner, depth } = stack.pop();
      let dirents;
      try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const row = rows.get(owner);
      for (const de of dirents) {
        if (de.isSymbolicLink()) continue;
        const abs = path.join(dir, de.name);
        if (de.isDirectory()) {
          if (isSkippedPath(abs)) continue;
          let child = owner;
          if (depth + 1 <= AGG_DEPTH && out.length < maxAgg) {
            let m = 0;
            try { m = (await fsp.lstat(abs)).mtimeMs; } catch { /* keep 0 */ }
            rowFor(abs, de.name, m);
            child = abs;
          }
          stack.push({ dir: abs, owner: child, depth: depth + 1 });
          continue;
        }
        let size = 0;
        try { size = (await fsp.lstat(abs)).size; } catch { continue; }
        row.s += size;
        row.fc++;
        ixState.stats_.files++;
        ixState.stats_.bytes += size;
      }
    }
    return true;
  }

  async function walkRoot(root, token, acc, aggAcc) {
    // An explicit stack, not recursion: a deep tree would otherwise be bounded
    // by the JS call stack rather than by the entry cap, and blow up on the
    // machines with the most files — exactly the ones this has to survive.
    const stack = [root];
    while (stack.length) {
      if (ixState.held) await holdEnds();
      if (token !== ixState.scanToken || ixState.stopped) return false;
      const dir = stack.pop();
      if (isSkippedPath(dir)) continue;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, races) — skip, never fail the walk
      }
      for (const de of dirents) {
        if (acc.length >= maxEntries) { ixState.capped = true; return false; }
        const abs = path.join(dir, de.name);
        // Symlinks are recorded but never followed: following them is how a
        // walk ends up in a cycle, and how a link into / turns a home-directory
        // index into a whole-filesystem one.
        if (de.isSymbolicLink()) continue;
        const isDir = de.isDirectory();
        if (isDir && isSkippedPath(abs)) continue;
        if (isDir && SKIP_DIRS.has(de.name)) {
          if (!(await sizeWalk(abs, token, aggAcc))) return false;
          continue;
        }
        let size = 0, mtime = 0;
        try {
          const st = await fsp.lstat(abs);
          size = isDir ? 0 : st.size;
          mtime = st.mtimeMs;
        } catch { /* vanished between readdir and lstat — record what we have */ }
        acc.push({ p: abs, n: de.name, nl: foldName(de.name), s: size, m: mtime, d: isDir });
        if (isDir) { ixState.stats_.dirs++; stack.push(abs); } else { ixState.stats_.files++; ixState.stats_.bytes += size; }
      }
    }
    return true;
  }

  return { walkRoot };
}

module.exports = { makeWalks };
