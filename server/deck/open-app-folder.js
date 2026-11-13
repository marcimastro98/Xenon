// Finds the program to start when an "open app" key points at a folder, newest version first.

const fs = require('node:fs');
const path = require('node:path');

// Sort 'app-1.2.3'-style names newest-first by their numeric parts.
function _compareAppDirDesc(a, b) {
  const va = (a.match(/\d+/g) || []).map(Number);
  const vb = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] || 0) - (va[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Resolve a FOLDER the user pointed an "open app" key at to the executable that
// should actually launch — so pointing at an app's install directory just works.
// Handled shapes (newest version first; re-resolved on every tap so updates don't
// break the key):
//   1. Squirrel layout (Discord/Slack/Teams classic): a dir with Update.exe and
//      'app-X.Y.Z' subfolders → newest app-*/<Name>.exe.
//   2. A versioned dir itself (…/Discord/app-1.2.3) → an exe named after the parent.
//   3. A plain app dir holding exactly one executable.
// Returns '' when the path isn't a directory or no single clear target exists.
function resolveExecInDir(dir) {
  try {
    const d = String(dir || '').trim();
    if (!d) return '';
    let st;
    try { st = fs.statSync(d); } catch { return ''; }
    if (!st.isDirectory()) return '';
    const names = fs.readdirSync(d);
    const exes = names.filter((n) => /\.exe$/i.test(n));
    const leaf = path.basename(d).toLowerCase();
    const parentLeaf = path.basename(path.dirname(d)).toLowerCase();

    // 1) Squirrel: Update.exe + app-* subfolders → newest version's <leaf>.exe.
    if (exes.some((n) => n.toLowerCase() === 'update.exe')) {
      const appDirs = names
        .filter((n) => { try { return /^app-[\d.]+$/i.test(n) && fs.statSync(path.join(d, n)).isDirectory(); } catch { return false; } })
        .sort(_compareAppDirDesc);
      for (const ad of appDirs) {
        const inner = path.join(d, ad);
        let innerExes;
        try { innerExes = fs.readdirSync(inner).filter((n) => /\.exe$/i.test(n) && n.toLowerCase() !== 'update.exe'); }
        catch { continue; }                                    // unreadable; try next version
        const match = innerExes.find((n) => n.toLowerCase() === leaf + '.exe');  // e.g. Discord/app-*/Discord.exe
        if (match) return path.join(inner, match);
        if (innerExes.length === 1) return path.join(inner, innerExes[0]);
      }
    }

    // 2) An exe named after this folder, or after its parent (versioned-dir case).
    const named = exes.find((n) => n.toLowerCase() === leaf + '.exe')
      || exes.find((n) => n.toLowerCase() === parentLeaf + '.exe');
    if (named) return path.join(d, named);

    // 3) Exactly one launchable executable → unambiguous.
    const launchable = exes.filter((n) => n.toLowerCase() !== 'update.exe');
    if (launchable.length === 1) return path.join(d, launchable[0]);
    return '';
  } catch { return ''; }
}

module.exports = { _compareAppDirDesc, resolveExecInDir };
